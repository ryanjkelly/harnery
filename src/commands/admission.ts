// `admission`: inspect the machine-wide admission queues, or run an arbitrary
// command while holding a slot on a named resource. The queue mechanics live
// in src/lib/admission.ts and the durable job record in src/lib/durable-job.ts;
// this command owns flag parsing, human/JSON rendering, and exit-code
// propagation for the wrapped child process.
//
// `run --detach` splits the work in two: the client mints a job record and
// launches a detached supervisor, then returns. The supervisor holds the
// admission slot, runs the command, and writes the terminal record. Losing the
// client after that point interrupts nothing.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { type Command, Option } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveBinName } from "../core/config.ts";
import {
  type AdmissionEntry,
  type AdmissionStatus,
  AdmissionTimeoutError,
  acquireAdmission,
  admissionBaseDir,
  admissionStatus,
  listAdmissionResources,
} from "../lib/admission.ts";
import {
  type AdmissionHistoryGroup,
  type AdmissionHistoryRecord,
  type AdmissionReleaseResult,
  readAdmissionHistory,
  resolveAdmissionHistoryDir,
  summarizeAdmissionHistory,
} from "../lib/admission-history.ts";
import {
  classifyJob,
  createJobDir,
  DURABLE_JOB_HEARTBEAT_MS,
  DURABLE_JOB_LOG_FILENAME,
  DURABLE_JOB_SCHEMA_VERSION,
  type DurableJobDocument,
  type DurableJobReport,
  type DurableJobStatus,
  formatJobAge,
  jobExitCode,
  listJobs,
  readJobDocument,
  writeJobDocument,
  writeJobStatus,
} from "../lib/durable-job.ts";
import { coordEnv } from "../lib/env.ts";

interface AdmissionStatusOpts {
  resource?: string;
  json?: boolean;
}

interface AdmissionRunOpts {
  resource: string;
  capacity?: string;
  timeout?: string;
  label?: string;
  detach?: boolean;
  json?: boolean;
}

interface AdmissionSuperviseOpts {
  jobDir: string;
  timeout?: string;
}

interface AdmissionWaitOpts {
  timeout?: string;
  json?: boolean;
}

interface AdmissionHistoryOpts {
  resource?: string;
  since?: string;
  label?: string;
  list?: boolean;
  limit?: string;
  json?: boolean;
}

interface AdmissionJobsOpts {
  json?: boolean;
  limit?: string;
}

const LABEL_MAX_CHARS = 80;
const WAIT_POLL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MINUTES = 120;
const DEFAULT_JOBS_LIMIT = 20;

/**
 * Root for durable detached job records. A sibling of the admission queue root
 * rather than a child of it, so job directories are never mistaken for
 * admission resources by anything listing that directory.
 */
export function jobsBaseDir(): string {
  return coordEnv("JOBS_DIR") ?? `${admissionBaseDir()}-jobs`;
}

/** Parse "30m", "24h", or "7d" into milliseconds; undefined means invalid. */
function parseLookback(raw: string): number | undefined {
  const match = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return amount > 0 ? amount * unitMs : undefined;
}

function describeHistoryGroup(group: AdmissionHistoryGroup): string {
  const outcomes = Object.entries(group.outcomes)
    .filter(([outcome]) => outcome !== "released")
    .map(([outcome, count]) => `${count} ${outcome}`);
  const hold =
    group.hold_ms !== null
      ? `held p50 ${formatJobAge(group.hold_ms.p50)}, p90 ${formatJobAge(group.hold_ms.p90)}`
      : "no completed holds";
  return (
    `  ${group.label || "(no label)"}: ${group.count} run(s), ${group.queued} queued; ` +
    `waited p50 ${formatJobAge(group.wait_ms.p50)}, p90 ${formatJobAge(group.wait_ms.p90)}, ` +
    `max ${formatJobAge(group.wait_ms.max)}, total ${formatJobAge(group.wait_ms.total)}; ${hold}` +
    (outcomes.length > 0 ? `; ${outcomes.join(", ")}` : "")
  );
}

function describeHistoryRecord(record: AdmissionHistoryRecord): string {
  const bits = [
    record.outcome,
    `waited ${formatJobAge(record.wait_ms)}`,
    ...(record.hold_ms !== undefined ? [`held ${formatJobAge(record.hold_ms)}`] : []),
    ...(record.exit_code !== undefined && record.exit_code !== null
      ? [`exit ${record.exit_code}`]
      : []),
    ...(record.signal ? [`signal ${record.signal}`] : []),
  ];
  const behind = record.waited_behind?.length
    ? ` (behind: ${record.waited_behind.join(", ")})`
    : "";
  return `  ${record.ended_at} ${record.resource} ${record.label || "(no label)"}: ${bits.join(", ")}${behind}`;
}

/** Parse an integer flag with a bounded range; undefined means invalid. */
function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

function describeEntry(entry: AdmissionEntry): string {
  const since = entry.acquired_at ?? entry.created_at;
  return `${entry.label || "(no label)"} (pid ${entry.pid}) since ${since}`;
}

function logResourceStatus(emit: EmitContext, status: AdmissionStatus): void {
  emit.log(
    `${status.resource}: ${status.holders.length} holder(s), ${status.waiters.length} waiter(s)`,
    "info",
  );
  for (const holder of status.holders) emit.log(`  holding: ${describeEntry(holder)}`, "info");
  for (const waiter of status.waiters) emit.log(`  waiting: ${describeEntry(waiter)}`, "info");
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

/** One-line job summary shared by `jobs`, `wait`, and `status`. */
function describeJobReport(report: DurableJobReport, nowMs: number): string {
  const label = report.label || "(no label)";
  const resource = report.resource ?? "(no resource)";
  const bits: string[] = [`${report.state}`, `resource ${resource}`];
  if (report.terminal) {
    bits.push(
      report.signal !== null
        ? `killed by ${report.signal}`
        : `exit ${report.exit_code ?? "unknown"}`,
    );
  } else if (report.state === "dead") {
    bits.push(`pid ${report.pid ?? "unknown"} not running`);
  } else {
    bits.push(`pid ${report.pid ?? "unknown"}`);
  }
  if (report.heartbeat_age_ms !== null) {
    bits.push(`heartbeat ${formatJobAge(report.heartbeat_age_ms)} ago`);
  }
  const startedMs = report.started_at !== null ? Date.parse(report.started_at) : Number.NaN;
  if (!Number.isNaN(startedMs)) bits.push(`age ${formatJobAge(nowMs - startedMs)}`);
  return `job ${report.job_id ?? "(no id)"}: ${bits.join(", ")} — ${label}`;
}

export function registerAdmissionCommand(program: Command, emit: EmitContext): void {
  const admission = program
    .command("admission")
    .description(
      "Machine-wide admission control for heavy jobs: inspect the per-resource " +
        "slot queues, run a command while holding a slot, or launch it as a " +
        "durable detached job that survives losing its client.",
    )
    .enablePositionalOptions();

  // ------------------------------------------------------------------ status
  admission
    .command("status")
    .description(
      "Show holders and waiters per admission resource, plus any detached jobs " +
        "still in flight. Queues prune dead-PID, expired, and torn entries as a " +
        "side effect of being listed.",
    )
    .option("--resource <name>", "Show one resource instead of all of them.")
    .option("--json", "Emit { resources: [...], jobs: [...] } as JSON.")
    .addHelpText("after", "\nExit codes: 0 always (reporting only) · 1 usage error.")
    .action((opts: AdmissionStatusOpts) => {
      const dir = admissionBaseDir();
      const resources = opts.resource !== undefined ? [opts.resource] : listAdmissionResources(dir);
      const statuses = resources.map((resource) => admissionStatus({ dir, resource }));
      const nowMs = Date.now();
      const liveJobs = listJobs(jobsBaseDir())
        .map((entry) => entry.report)
        .filter((report): report is DurableJobReport => report !== null && !report.terminal)
        .filter(
          (report) =>
            report.state !== "dead" &&
            (opts.resource === undefined || report.resource === opts.resource),
        );
      if (opts.json) {
        emit.data({
          resources: statuses.map((status) => ({
            resource: status.resource,
            holders: status.holders,
            waiters: status.waiters,
          })),
          jobs: liveJobs,
        });
        return;
      }
      const active = statuses.filter(
        (status) => status.holders.length > 0 || status.waiters.length > 0,
      );
      if (active.length === 0 && liveJobs.length === 0) {
        emit.log(
          opts.resource !== undefined
            ? `no admission activity on ${opts.resource}`
            : "no admission activity",
          "info",
        );
        return;
      }
      for (const status of active) logResourceStatus(emit, status);
      if (liveJobs.length > 0) {
        emit.log(`detached jobs in flight: ${liveJobs.length}`, "info");
        for (const report of liveJobs) emit.log(`  ${describeJobReport(report, nowMs)}`, "info");
      }
    });

  // --------------------------------------------------------------------- run
  admission
    .command("run")
    .description(
      "Acquire one slot on an admission resource, run <command...> with inherited " +
        "stdio (no shell — the first token is the executable), then release the " +
        "slot and propagate the child's exit code. Everything after -- reaches " +
        "the child untouched. With --detach the command instead becomes a durable " +
        "job supervised by a detached process.",
    )
    .passThroughOptions()
    .requiredOption("--resource <name>", 'Admission resource to queue on, e.g. "browser-qa".')
    .option("--capacity <n>", "Concurrent holders this machine should allow (1-32; default 1).")
    .option("--timeout <minutes>", "Maximum admission wait before giving up (1-1440; default 60).")
    .option(
      "--label <text>",
      "Holder description shown in status listings (default: the command itself).",
    )
    .option(
      "--detach",
      "Launch the command as a durable job: a detached supervisor holds the slot, " +
        "runs the command, and records the outcome on disk. Prints the job id and " +
        "job directory and returns immediately; losing the client no longer kills " +
        "the job. Reconnect with admission wait <job-dir>.",
    )
    .option("--json", "With --detach, print the job envelope as JSON.")
    .argument("<command...>", "Command to run while holding the slot.")
    .addHelpText(
      "after",
      "\nExit codes (foreground): the child's exit code · 4 admission timeout · " +
        "1 usage error, spawn failure, or child killed by a signal." +
        "\nExit codes (--detach): 0 once the job is launched · 1 usage error or " +
        "launch failure. The job's own outcome comes from admission wait.",
    )
    .action(async (commandArgs: string[], opts: AdmissionRunOpts) => {
      const capacity = parseBoundedInt(opts.capacity, 1, 1, 32);
      if (capacity === undefined) {
        emit.error({
          code: "admission_usage",
          message: "--capacity must be an integer between 1 and 32",
        });
        process.exitCode = 1;
        return;
      }
      const timeoutMinutes = parseBoundedInt(opts.timeout, 60, 1, 1440);
      if (timeoutMinutes === undefined) {
        emit.error({
          code: "admission_usage",
          message: "--timeout must be an integer number of minutes between 1 and 1440",
        });
        process.exitCode = 1;
        return;
      }
      const joined = commandArgs.join(" ");
      const label =
        opts.label ??
        (joined.length > LABEL_MAX_CHARS ? `${joined.slice(0, LABEL_MAX_CHARS - 3)}...` : joined);

      if (opts.detach) {
        launchDetachedJob(emit, {
          commandArgs,
          resource: opts.resource,
          capacity,
          label,
          timeoutMinutes,
          json: opts.json === true,
        });
        return;
      }

      const dir = admissionBaseDir();
      let lastWaitMessage = "";
      let handle: Awaited<ReturnType<typeof acquireAdmission>>;
      try {
        handle = await acquireAdmission(
          { dir, resource: opts.resource, capacity },
          {
            label,
            timeoutMs: timeoutMinutes * 60_000,
            onWait: (info) => {
              const holders = info.holders.map((holder) => holder.label).join(", ") || "none";
              const message =
                `queued for a ${opts.resource} slot: position ${info.position}, ` +
                `capacity ${capacity}, holder(s): ${holders}`;
              if (message !== lastWaitMessage) {
                lastWaitMessage = message;
                emit.log(message, "info");
              }
            },
          },
        );
      } catch (err: unknown) {
        if (err instanceof AdmissionTimeoutError) {
          emit.error({
            code: "admission_timeout",
            message: err.message,
            hint: `${resolveBinName()} admission status --resource ${opts.resource} lists current holders`,
          });
          process.exitCode = 4;
          return;
        }
        throw err;
      }

      const [executable, ...childArgs] = commandArgs;
      const result: AdmissionReleaseResult = {};
      try {
        const outcome = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolvePromise, rejectPromise) => {
          const child = spawn(executable as string, childArgs, {
            stdio: "inherit",
            shell: false,
          });
          child.on("error", rejectPromise);
          child.on("exit", (code, signal) => resolvePromise({ code, signal }));
        });
        result.exitCode = outcome.code;
        result.signal = outcome.signal;
        if (outcome.signal !== null) {
          emit.error({
            code: "admission_child_signal",
            message: `${executable} was terminated by signal ${outcome.signal}`,
          });
          process.exitCode = 1;
          return;
        }
        process.exitCode = outcome.code ?? 1;
      } catch (err: unknown) {
        emit.error({
          code: "admission_spawn_error",
          message: `cannot run ${executable}: ${describeError(err)}`,
        });
        result.exitCode = 1;
        process.exitCode = 1;
      } finally {
        handle.release(result);
      }
    });

  // ----------------------------------------------------------------- history
  admission
    .command("history")
    .description(
      "Report finished slot use: how long work queued for each resource, what it " +
        "waited behind, how long holders kept their slots, and which tickets timed " +
        "out or were abandoned by a process that died. Grouped by resource and " +
        "label, most total wait first; --list shows individual records.",
    )
    .option("--resource <name>", "Report one resource instead of all of them.")
    .option("--since <window>", "Look back this far: 30m, 24h, 7d (default 24h).")
    .option("--label <text>", "Keep records whose label contains this text.")
    .option("--list", "List individual records, newest first, after the summary.")
    .option("--limit <n>", "With --list, how many records to show (1-500; default 20).")
    .option("--json", "Emit { history_dir, since, groups: [...], records: [...] } as JSON.")
    .addHelpText(
      "after",
      "\nHistory is written to $XDG_STATE_HOME/harnery/admission-history (default " +
        "~/.local/state/harnery/admission-history); HARNERY_ADMISSION_HISTORY_DIR " +
        "moves it and HARNERY_ADMISSION_HISTORY=off stops recording." +
        "\nExit codes: 0 always (reporting only) · 1 usage error.",
    )
    .action((opts: AdmissionHistoryOpts) => {
      const lookbackMs = parseLookback(opts.since ?? "24h");
      if (lookbackMs === undefined) {
        emit.error({
          code: "admission_usage",
          message: "--since must look like 30m, 24h, or 7d",
        });
        process.exitCode = 1;
        return;
      }
      const limit = parseBoundedInt(opts.limit, 20, 1, 500);
      if (limit === undefined) {
        emit.error({
          code: "admission_usage",
          message: "--limit must be an integer between 1 and 500",
        });
        process.exitCode = 1;
        return;
      }
      const historyDir = resolveAdmissionHistoryDir(admissionBaseDir());
      const sinceMs = Date.now() - lookbackMs;
      const records = readAdmissionHistory(historyDir, {
        ...(opts.resource !== undefined ? { resource: opts.resource } : {}),
        ...(opts.label !== undefined ? { labelContains: opts.label } : {}),
        sinceMs,
      });
      const groups = summarizeAdmissionHistory(records);
      const newest = [...records].reverse().slice(0, limit);
      if (opts.json) {
        emit.data({
          history_dir: historyDir,
          since: new Date(sinceMs).toISOString(),
          groups,
          records: opts.list ? newest : [],
        });
        return;
      }
      if (historyDir === null) {
        emit.log("admission history recording is off (HARNERY_ADMISSION_HISTORY=off)", "info");
        return;
      }
      if (records.length === 0) {
        emit.log(`no admission history since ${new Date(sinceMs).toISOString()}`, "info");
        return;
      }
      let resource = "";
      for (const group of groups.sort((a, b) => a.resource.localeCompare(b.resource))) {
        if (group.resource !== resource) {
          resource = group.resource;
          const inResource = groups.filter((candidate) => candidate.resource === resource);
          const total = inResource.reduce((sum, candidate) => sum + candidate.wait_ms.total, 0);
          emit.log(
            `${resource}: ${inResource.reduce((sum, candidate) => sum + candidate.count, 0)} ` +
              `run(s), ${formatJobAge(total)} total queue wait`,
            "info",
          );
        }
        emit.log(describeHistoryGroup(group), "info");
      }
      if (opts.list) {
        emit.log(`latest ${newest.length} record(s):`, "info");
        for (const record of newest) emit.log(describeHistoryRecord(record), "info");
      }
    });

  // --------------------------------------------------------------- supervise
  admission
    .command("supervise", { hidden: true })
    .description("Internal: run one durable job record to completion (detach child plumbing).")
    .addOption(
      new Option("--job-dir <dir>", "Job directory to supervise.").makeOptionMandatory().hideHelp(),
    )
    .addOption(new Option("--timeout <minutes>", "Maximum admission wait.").hideHelp())
    .action(async (opts: AdmissionSuperviseOpts) => {
      await superviseJob(emit, opts);
    });

  // -------------------------------------------------------------------- wait
  admission
    .command("wait <job-dir>")
    .description(
      "Reconnect to a detached job and block until it settles. Polls the job " +
        "record every 2s: the record is authoritative, so a client that died and " +
        "came back sees exactly the same outcome.",
    )
    .option(
      "--timeout <minutes>",
      `Maximum time to wait for the job to settle (1-1440; default ${DEFAULT_WAIT_TIMEOUT_MINUTES}).`,
    )
    .option("--json", "Print the job report as JSON.")
    .addHelpText(
      "after",
      "\nExit codes: the job's own exit code once completed · 1 usage error or an " +
        "unreadable job record · 4 the job is dead (non-terminal state, dead " +
        "supervisor PID) · 5 the wait timed out while the job was still running.",
    )
    .action(async (jobDir: string, opts: AdmissionWaitOpts) => {
      const timeoutMinutes = parseBoundedInt(opts.timeout, DEFAULT_WAIT_TIMEOUT_MINUTES, 1, 1440);
      if (timeoutMinutes === undefined) {
        emit.error({
          code: "admission_usage",
          message: "--timeout must be an integer number of minutes between 1 and 1440",
        });
        process.exitCode = 1;
        return;
      }
      const deadline = Date.now() + timeoutMinutes * 60_000;
      let lastState = "";
      while (true) {
        const outcome = classifyJob(jobDir);
        if (!outcome.ok) {
          emit.error({ code: "admission_job_unreadable", message: outcome.error });
          process.exitCode = 1;
          return;
        }
        const report = outcome.report;
        const settled = report.terminal || report.state === "dead";
        if (settled) {
          if (opts.json) emit.data(report);
          emit.log(describeJobReport(report, Date.now()), report.terminal ? "info" : "warn");
          if (!report.terminal) emit.log(`log: ${report.log_path}`, "warn");
          for (const warning of report.warnings) emit.log(`warning: ${warning}`, "warn");
          const exit = jobExitCode(report);
          if (exit !== 0) process.exitCode = exit;
          return;
        }
        // Progress prints on state transitions only; a job that runs for an
        // hour should not scroll a line every two seconds.
        if (report.state !== lastState) {
          lastState = report.state;
          emit.log(describeJobReport(report, Date.now()), "info");
        }
        if (Date.now() >= deadline) {
          if (opts.json) emit.data(report);
          emit.log(`wait timed out after ${timeoutMinutes}m; job is still ${report.state}`, "warn");
          process.exitCode = 5;
          return;
        }
        await sleep(WAIT_POLL_MS);
      }
    });

  // -------------------------------------------------------------------- jobs
  admission
    .command("jobs")
    .description(
      "List recent detached jobs, newest first: id, resource, state, label, age, " +
        "and exit code. A job whose supervisor PID is gone before it completed " +
        "lists as dead.",
    )
    .option("--json", "Emit { dir, jobs: [...] } as JSON.")
    .option("--limit <n>", `Maximum jobs to list (1-500; default ${DEFAULT_JOBS_LIMIT}).`)
    .addHelpText("after", "\nExit codes: 0 always (reporting only) · 1 usage error.")
    .action((opts: AdmissionJobsOpts) => {
      const limit = parseBoundedInt(opts.limit, DEFAULT_JOBS_LIMIT, 1, 500);
      if (limit === undefined) {
        emit.error({
          code: "admission_usage",
          message: "--limit must be an integer between 1 and 500",
        });
        process.exitCode = 1;
        return;
      }
      const base = jobsBaseDir();
      const entries = listJobs(base).slice(0, limit);
      if (opts.json) {
        emit.data({ dir: base, jobs: entries });
        return;
      }
      if (entries.length === 0) {
        emit.log(`no detached jobs under ${base}`, "info");
        return;
      }
      const nowMs = Date.now();
      for (const entry of entries) {
        if (entry.report === null) {
          emit.log(`job ${entry.job_id}: unreadable (${entry.error ?? "no status"})`, "warn");
          continue;
        }
        emit.log(describeJobReport(entry.report, nowMs), entry.report.terminal ? "info" : "warn");
      }
    });
}

// ---------------------------------------------------------------------------
// Detach: client half
// ---------------------------------------------------------------------------

interface LaunchOptions {
  commandArgs: string[];
  resource: string;
  capacity: number;
  label: string;
  timeoutMinutes: number;
  json: boolean;
}

function launchDetachedJob(emit: EmitContext, options: LaunchOptions): void {
  const cliScript = process.argv[1];
  if (!cliScript) {
    emit.error({
      code: "admission_no_cli_script",
      message: "cannot resolve the host CLI script path to launch a detached supervisor",
    });
    process.exitCode = 1;
    return;
  }
  const jobId = randomUUID();
  const base = jobsBaseDir();
  let jobDir: string;
  let logFd: number;
  try {
    jobDir = createJobDir(base, jobId);
    const document: DurableJobDocument = {
      schema_version: DURABLE_JOB_SCHEMA_VERSION,
      job_id: jobId,
      resource: options.resource,
      capacity: options.capacity,
      label: options.label,
      argv: options.commandArgs,
      cwd: process.cwd(),
      created_at: nowIso(),
    };
    writeJobDocument(jobDir, document);
    logFd = openSync(join(jobDir, DURABLE_JOB_LOG_FILENAME), "a");
  } catch (err: unknown) {
    emit.error({
      code: "admission_job_setup_failed",
      message: `cannot create a job record under ${base}: ${describeError(err)}`,
    });
    process.exitCode = 1;
    return;
  }

  // The supervisor is this same CLI, detached from the terminal with its
  // output on disk: the client may die at any moment after this point.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      [
        cliScript,
        "admission",
        "supervise",
        "--job-dir",
        jobDir,
        "--timeout",
        String(options.timeoutMinutes),
      ],
      { detached: true, stdio: ["ignore", logFd, logFd] },
    );
    child.unref();
  } catch (err: unknown) {
    closeSync(logFd);
    emit.error({
      code: "admission_supervisor_spawn_failed",
      message: `cannot launch the job supervisor: ${describeError(err)}`,
    });
    process.exitCode = 1;
    return;
  }
  closeSync(logFd);

  const startedAt = nowIso();
  const launching: DurableJobStatus = {
    schema_version: DURABLE_JOB_SCHEMA_VERSION,
    job_id: jobId,
    pid: child.pid ?? 0,
    state: "launching",
    started_at: startedAt,
    updated_at: startedAt,
  };
  writeJobStatus(jobDir, launching);

  const logPath = join(jobDir, DURABLE_JOB_LOG_FILENAME);
  const binName = resolveBinName();
  emit.log(`detached job ${jobId} (supervisor pid ${child.pid ?? "unknown"})`, "info");
  emit.log(`job dir: ${jobDir}`, "info");
  emit.log(`log: ${logPath}`, "info");
  emit.log(`reconnect: ${binName} admission wait ${jobDir}`, "info");
  if (options.json) {
    emit.data({
      detached: true,
      job_id: jobId,
      pid: child.pid ?? null,
      job_dir: jobDir,
      log: logPath,
      resource: options.resource,
    });
  }
}

// ---------------------------------------------------------------------------
// Detach: supervisor half
// ---------------------------------------------------------------------------

/**
 * Own one job record end to end: queue for the slot, run the command with its
 * output on disk, then write the terminal record. Exported for tests, which
 * drive it in-process against a temporary job directory.
 */
export async function superviseJob(emit: EmitContext, opts: AdmissionSuperviseOpts): Promise<void> {
  const jobDir = opts.jobDir;
  const document = readJobDocument(jobDir);
  if (!document || document.argv.length === 0) {
    emit.error({
      code: "admission_job_document_unreadable",
      message: `${jobDir} carries no usable job document`,
    });
    process.exitCode = 1;
    return;
  }
  const timeoutMinutes = parseBoundedInt(opts.timeout, 60, 1, 1440) ?? 60;
  const startedAt = nowIso();
  const status: DurableJobStatus = {
    schema_version: DURABLE_JOB_SCHEMA_VERSION,
    job_id: document.job_id,
    pid: process.pid,
    state: "queued",
    started_at: startedAt,
    updated_at: startedAt,
    queue: { resource: document.resource, waiting_since: startedAt },
  };
  writeJobStatus(jobDir, status);

  const finish = (state: { exitCode: number | null; signal: string | null }): void => {
    writeJobStatus(jobDir, {
      schema_version: DURABLE_JOB_SCHEMA_VERSION,
      job_id: document.job_id,
      pid: process.pid,
      state: "completed",
      started_at: startedAt,
      updated_at: nowIso(),
      exit_code: state.exitCode,
      signal: state.signal,
    });
  };

  let handle: Awaited<ReturnType<typeof acquireAdmission>>;
  try {
    handle = await acquireAdmission(
      {
        dir: admissionBaseDir(),
        resource: document.resource,
        capacity: document.capacity,
      },
      {
        label: document.label,
        timeoutMs: timeoutMinutes * 60_000,
        onWait: () => {
          writeJobStatus(jobDir, { ...status, updated_at: nowIso() });
        },
      },
    );
  } catch (err: unknown) {
    if (err instanceof AdmissionTimeoutError) {
      emit.error({ code: "admission_timeout", message: err.message });
      finish({ exitCode: 4, signal: null });
      process.exitCode = 4;
      return;
    }
    finish({ exitCode: 1, signal: null });
    throw err;
  }

  const runningAt = nowIso();
  const running: DurableJobStatus = {
    schema_version: DURABLE_JOB_SCHEMA_VERSION,
    job_id: document.job_id,
    pid: process.pid,
    state: "running",
    started_at: startedAt,
    updated_at: runningAt,
  };
  writeJobStatus(jobDir, running);
  // The heartbeat is what lets a reader tell a wedged supervisor from a busy
  // one; a dead supervisor stops writing and the record classifies as dead.
  const heartbeat = setInterval(() => {
    writeJobStatus(jobDir, { ...running, updated_at: nowIso() });
  }, DURABLE_JOB_HEARTBEAT_MS);
  heartbeat.unref?.();

  const [executable, ...childArgs] = document.argv;
  const result: AdmissionReleaseResult = {};
  let logFd: number | undefined;
  try {
    logFd = openSync(join(jobDir, DURABLE_JOB_LOG_FILENAME), "a");
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, rejectPromise) => {
        const child = spawn(executable as string, childArgs, {
          stdio: ["ignore", logFd as number, logFd as number],
          shell: false,
          ...(document.cwd ? { cwd: document.cwd } : {}),
        });
        child.on("error", rejectPromise);
        child.on("exit", (code, signal) => resolvePromise({ code, signal }));
      },
    );
    result.exitCode = outcome.code;
    result.signal = outcome.signal;
    finish({ exitCode: outcome.code, signal: outcome.signal });
    process.exitCode = outcome.signal !== null ? 1 : (outcome.code ?? 1);
  } catch (err: unknown) {
    emit.error({
      code: "admission_spawn_error",
      message: `cannot run ${executable}: ${describeError(err)}`,
    });
    finish({ exitCode: 1, signal: null });
    result.exitCode = 1;
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    if (logFd !== undefined) closeSync(logFd);
    handle.release(result);
  }
}
