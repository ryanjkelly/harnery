// `qa-run <target>`: run the whole page-QA matrix (planner, deterministic
// gates, interactions, critique, snapshot) in one command. The agent's loop
// collapses to: build the job, run this, read page-qa-result.json.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { QA_RUN_RESULT_FILENAME, runQaMatrix } from "../lib/browser/qa-run.ts";
import {
  QA_RUN_JOB_SCHEMA_VERSION,
  type QaRunJob,
  validateQaRunJob,
} from "../lib/browser/qa-run-contracts.ts";

interface QaRunOpts {
  job?: string;
  mode: string;
  concurrency?: string;
  allowMetered?: boolean;
  outDir?: string;
  json?: boolean;
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
        ...(revisionProbe ? { revisionProbe } : {}),
        onLog: (message) => emit.log(message, "info"),
      });

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
