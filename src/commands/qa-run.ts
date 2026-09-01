// `qa-run <target>`: run the whole page-QA matrix (planner, deterministic
// gates, interactions, critique, snapshot) in one command. The agent's loop
// collapses to: build the job, run this, read page-qa-result.json.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Command, Option } from "commander";
import type { EmitContext } from "../commander.ts";
import { recordQaSignal } from "../core/agents/qa-signal.ts";
import { resolveBinName } from "../core/config.ts";
import { acquireAdmission, admissionStatus } from "../lib/admission.ts";
import {
  QA_RUN_JOB_FILENAME,
  QA_RUN_RESULT_FILENAME,
  QA_RUN_STATUS_FILENAME,
  type QaRunMatrixOptions,
  runQaMatrix,
} from "../lib/browser/qa-run.ts";
import {
  QA_RUN_JOB_SCHEMA_VERSION,
  QA_RUN_STATUS_SCHEMA_VERSION,
  type QaRunJob,
  type QaRunStatusDocument,
  validateQaRunJob,
} from "../lib/browser/qa-run-contracts.ts";
import { coordEnv } from "../lib/env.ts";

/** Machine-wide admission resource that qa-run queues on by default. */
export const QA_ADMISSION_RESOURCE = "browser-qa";

/** Default concurrent browser-QA runs per machine. */
export const QA_ADMISSION_DEFAULT_CAPACITY = 2;

/** Base directory for admission queue state. tmpdir clears on reboot, which
 * is correct — stale queue state must not outlive the boot. */
export function admissionBaseDir(): string {
  return coordEnv("ADMISSION_DIR") ?? join(tmpdir(), "harnery-admission");
}

interface QaRunOpts {
  job?: string;
  mode: string;
  concurrency?: string;
  allowMetered?: boolean;
  outDir?: string;
  json?: boolean;
  detach?: boolean;
  /** Commander --no-queue: true by default, false when the flag is passed. */
  queue: boolean;
  queueTimeout?: string;
  queueCapacity?: string;
  runId?: string;
}

export function registerQaRunCommand(program: Command, emit: EmitContext): void {
  program
    .command("qa-run <target>")
    .description(
      "Run the whole page-QA matrix in one command: QA planner, deterministic " +
        "gates per viewport/theme/state through a bounded process pool, serial " +
        "interaction assertions, manifest-required vision critique, and the QA " +
        "snapshot. Writes page-qa-result.json with a fail-closed verdict.",
    )
    .option(
      "--job <file>",
      "QA job document (JSON). Validated before any browser starts — secret-bearing " +
        "fields are refused, and the job may widen but never narrow the planner's coverage. " +
        "Absent: a minimal implicit job for <target> is used.",
    )
    .option(
      "--mode <mode>",
      "signoff persists a QA snapshot on a passing run; review never does.",
      "signoff",
    )
    .option(
      "--concurrency <n>",
      "Concurrent deterministic captures (1-8; default 2). Interactions and critique " +
        "always run serially.",
    )
    .option(
      "--allow-metered",
      "Permit the critique provider's metered-API fallback. Default: subscription-backed " +
        "headless harnesses only — exhaustion becomes an incomplete blocker, never a metered call.",
    )
    .option(
      "--out-dir <dir>",
      "PARENT output directory (default: .qa-run under the current directory). Every " +
        "invocation writes into its own run-<run_id>/ beneath it and updates the parent's " +
        "latest.json pointer — prior runs are never overwritten and never pass as current.",
    )
    .option("--json", "Print the full QaRunResult JSON to stdout.")
    .option(
      "--detach",
      "Launch the run as a detached background process whose authoritative state " +
        "lives on disk (job.json, run-status.json, runner.log, the result document). " +
        "The command prints the run directory and returns immediately; a client " +
        "disconnect no longer touches the job. Reconnect with qa-status <run-dir> --wait.",
    )
    .option(
      "--no-queue",
      "Skip machine-wide admission control. Default: the run waits for one of the " +
        "browser-qa slots so simultaneous heavy runs take turns instead of thrashing " +
        "the host; the wait is recorded as wall_time_ms.queue, never in total.",
    )
    .option(
      "--queue-timeout <minutes>",
      "Maximum admission wait before the run finalizes incomplete with an " +
        '"admission" blocker (default 20).',
    )
    .option(
      "--queue-capacity <n>",
      "Concurrent browser-qa runs this machine should allow (1-8; default " +
        "HARNERY_QA_ADMISSION_CAPACITY or 2). Advisory — the smallest capacity among " +
        "concurrent waiters effectively governs.",
    )
    .addOption(
      new Option(
        "--run-id <uuid>",
        "Internal: pre-minted run ID (detach child plumbing).",
      ).hideHelp(),
    )
    .addHelpText(
      "after",
      "\nExit codes: 0 verdict passed · 1 usage or job-validation error · " +
        "2 verdict failed · 4 verdict incomplete.",
    )
    .action(async (target: string, opts: QaRunOpts, command: Command) => {
      if (opts.mode !== "signoff" && opts.mode !== "review") {
        emit.error({
          code: "qa_run_invalid_mode",
          message: '--mode must be "signoff" or "review"',
        });
        process.exitCode = 1;
        return;
      }
      const modeExplicit = command.getOptionValueSource("mode") === "cli";

      let jobDocument: unknown;
      if (opts.job) {
        let rawText: string;
        try {
          rawText = readFileSync(opts.job, "utf8");
        } catch (err: unknown) {
          emit.error({
            code: "qa_run_job_unreadable",
            message: `cannot read --job file ${opts.job}: ${err instanceof Error ? err.message : String(err)}`,
          });
          process.exitCode = 1;
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch (err: unknown) {
          emit.error({
            code: "qa_run_job_invalid_json",
            message: `--job file ${opts.job} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          });
          process.exitCode = 1;
          return;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const raw = parsed as Record<string, unknown>;
          // The CLI target argument is authoritative; a job file may omit
          // target and mode. An explicit --mode overrides the job's mode.
          jobDocument = {
            ...raw,
            target,
            ...(raw.mode === undefined || modeExplicit ? { mode: opts.mode } : {}),
          };
        } else {
          jobDocument = parsed;
        }
      } else {
        jobDocument = { schema_version: QA_RUN_JOB_SCHEMA_VERSION, target, mode: opts.mode };
      }

      // All validation errors print at once, before any browser starts.
      const validation = validateQaRunJob(jobDocument);
      if (!validation.ok) {
        for (const message of validation.errors) emit.log(`job: ${message}`, "error");
        emit.error({
          code: "qa_run_invalid_job",
          message: `job validation failed with ${validation.errors.length} error${validation.errors.length === 1 ? "" : "s"}`,
        });
        process.exitCode = 1;
        return;
      }

      const policy = { ...validation.job.policy };
      if (opts.concurrency !== undefined) {
        const n = Number.parseInt(opts.concurrency, 10);
        if (!Number.isInteger(n) || n < 1 || n > 8) {
          emit.error({
            code: "qa_run_invalid_concurrency",
            message: "--concurrency must be an integer between 1 and 8",
          });
          process.exitCode = 1;
          return;
        }
        policy.command_concurrency = n;
      }
      if (opts.allowMetered) policy.allow_metered_critique = true;
      const job: QaRunJob = { ...validation.job, policy };

      const outParent = resolve(opts.outDir ?? ".qa-run");
      const cliScript = process.argv[1];
      if (!cliScript) {
        emit.error({
          code: "qa_run_no_cli_script",
          message: "cannot resolve the host CLI script path for child browse invocations",
        });
        process.exitCode = 1;
        return;
      }
      // Children run the same host CLI, so they inherit the host's browse
      // wiring (critique provider, cookie jar, profiles) unchanged.
      const browseArgv = [process.execPath, cliScript, "browse"];

      // ----------------------------------------------------- queue settings
      let queueCapacity = QA_ADMISSION_DEFAULT_CAPACITY;
      const capacityEnv = coordEnv("QA_ADMISSION_CAPACITY");
      if (capacityEnv !== undefined) {
        const n = Number.parseInt(capacityEnv, 10);
        if (Number.isInteger(n) && n >= 1 && n <= 8) queueCapacity = n;
      }
      if (opts.queueCapacity !== undefined) {
        const n = Number.parseInt(opts.queueCapacity, 10);
        if (!Number.isInteger(n) || n < 1 || n > 8) {
          emit.error({
            code: "qa_run_invalid_queue_capacity",
            message: "--queue-capacity must be an integer between 1 and 8",
          });
          process.exitCode = 1;
          return;
        }
        queueCapacity = n;
      }
      let queueTimeoutMs = 20 * 60_000;
      if (opts.queueTimeout !== undefined) {
        const n = Number.parseInt(opts.queueTimeout, 10);
        if (!Number.isInteger(n) || n < 1 || n > 240) {
          emit.error({
            code: "qa_run_invalid_queue_timeout",
            message: "--queue-timeout must be an integer between 1 and 240 (minutes)",
          });
          process.exitCode = 1;
          return;
        }
        queueTimeoutMs = n * 60_000;
      }

      // ------------------------------------------------------------- detach
      if (opts.detach) {
        const runId = randomUUID();
        const runDir = join(outParent, `run-${runId}`);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, QA_RUN_JOB_FILENAME), `${JSON.stringify(job, null, 2)}\n`);
        const logPath = join(runDir, "runner.log");
        const logFd = openSync(logPath, "a");
        // The child is this same command minus --detach plus the pre-minted
        // run ID, detached from the terminal with its output on disk: a
        // client disconnect kills nothing and loses nothing.
        const childArgv = [
          cliScript,
          "qa-run",
          target,
          ...(opts.job ? ["--job", resolve(opts.job)] : []),
          "--mode",
          job.mode,
          ...(opts.concurrency !== undefined ? ["--concurrency", opts.concurrency] : []),
          ...(opts.allowMetered ? ["--allow-metered"] : []),
          "--out-dir",
          outParent,
          "--run-id",
          runId,
          ...(opts.queue === false ? ["--no-queue"] : []),
          ...(opts.queueTimeout !== undefined ? ["--queue-timeout", opts.queueTimeout] : []),
          ...(opts.queueCapacity !== undefined ? ["--queue-capacity", opts.queueCapacity] : []),
        ];
        const child = spawn(process.execPath, childArgv, {
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.unref();
        closeSync(logFd);
        const launching: QaRunStatusDocument = {
          schema_version: QA_RUN_STATUS_SCHEMA_VERSION,
          run_id: runId,
          pid: child.pid ?? 0,
          state: "launching",
          stage: null,
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        writeFileSync(
          join(runDir, QA_RUN_STATUS_FILENAME),
          `${JSON.stringify(launching, null, 2)}\n`,
        );
        const binName = resolveBinName();
        emit.log(`detached run ${runId} (pid ${child.pid ?? "unknown"})`, "info");
        emit.log(`run dir: ${runDir}`, "info");
        emit.log(`log: ${logPath}`, "info");
        emit.log(`reconnect: ${binName} qa-status ${runDir} --wait`, "info");
        if (opts.json) {
          emit.data({
            detached: true,
            run_id: runId,
            pid: child.pid ?? null,
            run_dir: runDir,
            log: logPath,
          });
        }
        return;
      }

      // ---------------------------------------------------------- admission
      let admission: QaRunMatrixOptions["admission"];
      if (opts.queue !== false) {
        const dir = admissionBaseDir();
        admission = {
          resource: QA_ADMISSION_RESOURCE,
          acquire: async (onWait) => {
            let lastMessage = "";
            const handle = await acquireAdmission(
              { dir, resource: QA_ADMISSION_RESOURCE, capacity: queueCapacity },
              {
                label: `qa-run ${target}`,
                timeoutMs: queueTimeoutMs,
                onWait: (info) => {
                  const holders = info.holders.map((holder) => holder.label).join(", ") || "none";
                  const message =
                    `queued for a ${QA_ADMISSION_RESOURCE} slot: position ${info.position}, ` +
                    `capacity ${queueCapacity}, holder(s): ${holders}`;
                  if (message !== lastMessage) {
                    lastMessage = message;
                    onWait(message);
                  }
                },
              },
            );
            return handle.release;
          },
          holders: () =>
            admissionStatus({ dir, resource: QA_ADMISSION_RESOURCE }).holders.map((holder) => ({
              label: holder.label,
              pid: holder.pid,
            })),
        };
      }

      // One git probe for the identity block. Failure is not an error: a
      // target outside any repository legitimately records "unknown".
      let revisionProbe: { tested_revision?: string; worktree_dirty?: boolean } | undefined;
      if (job.tested_revision === undefined) {
        try {
          const head = execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          const porcelain = execFileSync("git", ["status", "--porcelain"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
          revisionProbe = { tested_revision: head, worktree_dirty: porcelain.trim().length > 0 };
        } catch {
          revisionProbe = undefined;
        }
      }

      const result = await runQaMatrix({
        job,
        outParent,
        browseArgv,
        ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
        ...(revisionProbe ? { revisionProbe } : {}),
        ...(admission ? { admission } : {}),
        onLog: (message) => emit.log(message, "info"),
      });

      // Publish the verdict for `agents status`, so an operator reading a
      // session sees the runner clock instead of inferring QA time from
      // session age. Best-effort by contract: never throws.
      recordQaSignal(result);

      if (opts.json) emit.data(result);
      const resultPath = join(result.run.out_dir, QA_RUN_RESULT_FILENAME);
      for (const blocker of result.blockers) {
        emit.log(
          `blocker [${blocker.stage}${blocker.context_id ? ` ${blocker.context_id}` : ""}]: ${blocker.reason}`,
          "warn",
        );
      }
      emit.log(
        `verdict: ${result.verdict} — run ${result.run.run_id}, ` +
          `${result.contexts.length} context${result.contexts.length === 1 ? "" : "s"}, ` +
          `${result.commands.length} command${result.commands.length === 1 ? "" : "s"}, ` +
          `${result.blockers.length} blocker${result.blockers.length === 1 ? "" : "s"}; result: ${resultPath}`,
        result.verdict === "passed" ? "info" : "warn",
      );
      if (result.verdict === "failed") process.exitCode = 2;
      else if (result.verdict === "incomplete") process.exitCode = 4;
    });
}
