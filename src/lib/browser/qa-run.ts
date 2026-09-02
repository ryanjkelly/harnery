// One-command page-QA matrix runner: planner, deterministic gates per
// context, interaction assertions, manifest-required critique, and the QA
// snapshot — executed as child `browse` processes through a bounded pool, and
// reported as one fail-closed machine-readable result.
//
// The runner never builds a shell string: every child is an argv array handed
// to an injectable exec function (default: node:child_process execFile with a
// closed stdin, bounded output, and an explicit timeout). Every child that
// fails, times out, or dies silently becomes a named blocker or a failed
// outcome in the result — nothing is filtered away.
//
// Toolkit tier: this module must not import src/core (layering check).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename, join } from "node:path";
import { type CritiqueProvider, DEFAULT_CRITIQUE_RUBRIC } from "./critique.js";
import { type JudgedContext, judgePageReviewPack, toCritiqueRecords } from "./page-review-judge.js";
import {
  finalizePageReviewPack,
  gateHitsFromEnvelope,
  PAGE_REVIEW_FINDINGS_FILENAME,
  PAGE_REVIEW_PACK_DIRNAME,
  PAGE_REVIEW_PACK_SCHEMA,
  PAGE_REVIEW_REVIEW_FILENAME,
  type PageReviewContextRecord,
  type PageReviewCritiqueRecord,
  type PageReviewGateRecord,
  readPackContext,
  readPackDom,
  readPackFullPage,
  readPackSignature,
} from "./page-review-pack.js";
import type { QaManifest } from "./qa-plan.js";
import { type PersistedCritique, QA_CRITIQUE_CONTRACT_VERSION, rubricDigest } from "./qa-reuse.js";
import {
  computeJobDigest,
  computeVerdict,
  mergeCoverage,
  QA_RUN_RESULT_SCHEMA_VERSION,
  QA_RUN_STATUS_SCHEMA_VERSION,
  type QaRunBlocker,
  type QaRunCommandOutcome,
  type QaRunContext,
  type QaRunCritiqueLatency,
  type QaRunCritiqueOutcome,
  type QaRunCritiquePool,
  type QaRunHostSample,
  type QaRunJob,
  type QaRunResult,
  type QaRunReviewPack,
  type QaRunStage,
  type QaRunStatusDocument,
  type QaRunStatusState,
} from "./qa-run-contracts.js";
import { type QaSnapshotStoreOptions, saveQaSnapshot } from "./qa-snapshot.js";

/** Set on the runner's own environment before the host's critique provider is
 * loaded for the judge stage, unless the job permits metered critique: the
 * provider must stay on subscription-backed headless harnesses and surface
 * exhaustion instead of falling back to a metered API. */
export const QA_RUN_HEADLESS_ONLY_ENV = "HARNERY_CRITIQUE_HEADLESS_ONLY";

/** Result document written into the run's output directory. */
export const QA_RUN_RESULT_FILENAME = "page-qa-result.json";

/** Pointer document written into the parent output directory after every
 * run, naming the newest run's directory and verdict. Consumers resolve the
 * current result through this pointer instead of guessing at loose files. */
export const QA_RUN_LATEST_FILENAME = "latest.json";

export interface QaRunLatestPointerInput {
  run_id: string;
  dir: string;
  completed_at: string;
  verdict: QaRunResult["verdict"];
}

/**
 * Publish the parent directory's latest-result pointer without allowing an
 * older completion to replace a newer one. Both runner and manual evidence
 * use this writer so every producer preserves the same ordering invariant.
 */
export function writeLatestPointer(outParent: string, input: QaRunLatestPointerInput): string {
  const pointerPath = join(outParent, QA_RUN_LATEST_FILENAME);
  let pointerIsNewer = true;
  try {
    const existing = JSON.parse(readFileSync(pointerPath, "utf8")) as {
      completed_at?: unknown;
    };
    if (typeof existing.completed_at === "string") {
      const existingCompletedAt = Date.parse(existing.completed_at);
      const candidateCompletedAt = Date.parse(input.completed_at);
      pointerIsNewer =
        Number.isNaN(existingCompletedAt) || candidateCompletedAt >= existingCompletedAt;
    }
  } catch {
    // No readable pointer yet: this result becomes the first one.
  }

  if (pointerIsNewer) {
    const pointer = {
      schema_version: 1,
      ...input,
      result: join(input.dir, QA_RUN_RESULT_FILENAME),
    };
    const pointerTmp = join(outParent, `.${QA_RUN_LATEST_FILENAME}.${input.run_id}.tmp`);
    writeFileSync(pointerTmp, `${JSON.stringify(pointer, null, 2)}\n`);
    renameSync(pointerTmp, pointerPath);
  }
  return pointerPath;
}

/** Live status document beside the result (QaRunStatusDocument): written at
 * start, every stage boundary, and on a heartbeat timer, so a disconnected
 * client can tell a running job from a dead one without guessing. */
export const QA_RUN_STATUS_FILENAME = "run-status.json";

/** The effective validated job, written into the run directory so a
 * reconnecting client can re-derive the job digest (`qa-verify --job`). */
export const QA_RUN_JOB_FILENAME = "job.json";

const STATUS_HEARTBEAT_MS = 15_000;

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_RUN_DEADLINE_MS = 900_000;
const DEFAULT_COMMAND_CONCURRENCY = 2;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

/** The planner's deterministic vocabulary is an executable contract, not a
 * report-only hint. A job may add checks, but these arguments always run for
 * every manifest context. `console` is enforced from the browse envelope
 * because browse captures diagnostics without a separate fail flag. */
const MANIFEST_DETERMINISTIC_ARGS: Readonly<Record<string, readonly string[]>> = {
  console: [],
  overflow: ["--check-overflow", "--check-overflow-fail"],
  truncation: ["--check-truncation", "--check-truncation-fail"],
  placeholder: ["--check-placeholder", "--check-placeholder-fail"],
};

export interface QaRunExecOptions {
  /** Hard per-command timeout in milliseconds. */
  timeoutMs: number;
  /** Complete child environment (already layered by the runner). */
  env: NodeJS.ProcessEnv;
}

export interface QaRunExecResult {
  /** Process exit code; null when the command never completed normally. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failure / timeout / signal description. Presence means the
   * command's outcome cannot be trusted. */
  error?: string;
}

/** Injectable child-process executor. `argv[0]` is the executable. */
export type QaRunExec = (argv: string[], options: QaRunExecOptions) => Promise<QaRunExecResult>;

/** Grace between the timeout's SIGTERM and the follow-up SIGKILL. A child
 * that catches SIGTERM (Bun installs a handler by default) gets this long to
 * exit before the kill is made non-negotiable. */
export const QA_RUN_KILL_GRACE_MS = 5_000;

/** After the group SIGKILL, how long to wait for stdio to drain before
 * destroying the streams and settling anyway. An escaped grandchild (setsid)
 * can hold the pipes open forever; the result must not wait on it. */
const KILL_DRAIN_MS = 2_000;

/** Default executor: spawn with argv arrays only (never a shell string),
 * closed stdin, bounded output buffers, and the policy timeout.
 *
 * Timeout enforcement is escalated and group-wide, via `spawn` rather than
 * `execFile` for two live-verified reasons. First, a child that catches
 * SIGTERM while awaiting its own grandchildren turns a single polite kill
 * into an unbounded wait (a critique command outlived its 120s cap by 10x).
 * Second, `execFile` resolves only when the child's stdio closes, and an
 * orphaned grandchild inheriting the pipe keeps it open after the child is
 * dead — so even a delivered kill did not settle the call. The child is
 * therefore spawned detached into its own process group; at the deadline the
 * whole group gets SIGTERM, then SIGKILL after a grace, and the result
 * settles on exit with whatever output drained, never waiting on a pipe an
 * orphan still holds. A timed-out command reports an error even if the child
 * then exits 0 — a result produced after the deadline cannot be trusted. */
export const defaultQaRunExec: QaRunExec = (argv, options) =>
  new Promise((resolvePromise) => {
    const [command, ...args] = argv;
    if (!command) {
      resolvePromise({ exitCode: null, stdout: "", stderr: "", error: "empty argv" });
      return;
    }
    // Windows has no process groups; the direct-child kill is the best
    // available fallback there.
    const groupKill = process.platform !== "win32";
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(groupKill ? { detached: true } : {}),
    });

    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: QaRunExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      resolvePromise(result);
    };

    const signalGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (!pid) return;
      if (groupKill) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          // Group already gone, or the leader died before setpgid: fall
          // through to the direct child so the kill still lands somewhere.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Nothing left to kill.
      }
    };

    const collect = (chunk: Buffer | string, sink: "stdout" | "stderr"): void => {
      const text = String(chunk);
      outBytes += text.length;
      if (sink === "stdout") stdout += text;
      else stderr += text;
      if (outBytes > EXEC_MAX_BUFFER && !overflowed) {
        overflowed = true;
        signalGroup("SIGKILL");
      }
    };
    child.stdout?.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => collect(chunk, "stderr"));

    child.on("error", (err) => {
      settle({ exitCode: null, stdout, stderr, error: err.message || "spawn failed" });
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (timedOut) {
        settle({
          exitCode: null,
          stdout,
          stderr,
          error: `timed out after ${options.timeoutMs}ms (process group killed)`,
        });
      } else if (overflowed) {
        settle({
          exitCode: null,
          stdout,
          stderr,
          error: `output exceeded ${EXEC_MAX_BUFFER} bytes (process group killed)`,
        });
      } else if (signal) {
        settle({ exitCode: null, stdout, stderr, error: `killed by ${signal}` });
      } else {
        settle({ exitCode: code, stdout, stderr });
      }
    };

    // "close" is the clean path: process exited AND stdio drained. "exit"
    // arms the drain failsafe so an orphan holding the pipes cannot postpone
    // the result forever.
    child.on("close", (code, signal) => finish(code, signal));
    child.on("exit", (code, signal) => {
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, KILL_DRAIN_MS);
      drainTimer.unref?.();
    });

    termTimer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
    }, options.timeoutMs);
    killTimer = setTimeout(() => signalGroup("SIGKILL"), options.timeoutMs + QA_RUN_KILL_GRACE_MS);
    termTimer.unref?.();
    killTimer.unref?.();
  });

export interface QaRunMatrixOptions {
  /** A validated job (see validateQaRunJob — the runner trusts its shape). */
  job: QaRunJob;
  /** PARENT directory for run output. Every invocation creates its own
   * `run-<run_id>/` beneath it for artifacts and the result document, and
   * maintains `latest.json` in the parent — a reused parent can therefore
   * never present an older run's result as the current one. */
  outParent: string;
  /** argv prefix that reaches the host CLI's browse command, e.g.
   * `[process.execPath, cliScript, "browse"]`. */
  browseArgv: string[];
  /** Injectable executor (tests). Default: execFile via defaultQaRunExec. */
  exec?: QaRunExec;
  /** Extra child-environment overrides layered over process.env. */
  childEnv?: NodeJS.ProcessEnv;
  /** Progress callback for human-facing per-stage lines. */
  onLog?: (message: string) => void;
  /** Run ID override (tests). Default: crypto.randomUUID(). */
  runId?: string;
  /** Working-tree revision probe supplied by the caller (the CLI probes git
   * once). Ignored when the job itself pins tested_revision. */
  revisionProbe?: { tested_revision?: string; worktree_dirty?: boolean };
  /** Machine-wide admission gate. When present the runner acquires a slot
   * before any browser work, records the wait as wall_time_ms.queue (never
   * part of total), and finalizes an incomplete result with an "admission"
   * blocker when acquisition fails — the evidence trail survives a full
   * queue. The returned function releases the slot; the runner calls it at
   * finalize, and a crashed runner's slot is reclaimed by dead-PID pruning. */
  admission?: {
    resource: string;
    acquire: (onWait: (message: string) => void) => Promise<() => void>;
    /** Snapshot of the other holders of the resource, sampled alongside host
     * pressure so an incomplete run names what it was competing with. */
    holders?: () => Array<{ label: string; pid: number }>;
  };
  /** Host-injected vision call for the judge stage. The judge runs in this
   * process over the pack on disk, after every capture browser has closed. */
  critiqueProvider?: CritiqueProvider;
  /** Lazy alternative to `critiqueProvider`; called once, after the
   * headless-only environment has been applied. */
  critiqueProviderLoader?: () => Promise<CritiqueProvider | undefined>;
  /** QA snapshot store override (tests, host-managed cache locations). */
  snapshotStore?: QaSnapshotStoreOptions;
  /** Renders the command a reader can run to judge the pack later; shown in
   * the pack's review.md when the judge did not run. */
  reviewPackJudgeCommand?: (packDir: string) => string;
}

interface TimedExec {
  res: QaRunExecResult;
  wallTimeMs: number;
}

/** One-line tail excerpt of a failed child's output for blockers and
 * failures, preferring stderr and falling back to stdout (browse prints its
 * JSON error envelope there). Without this, a blocker like "planner exited 1"
 * gives the reader nothing to act on. */
function execErrorExcerpt(res: QaRunExecResult, maxLength = 240): string | undefined {
  const source = res.stderr.trim().length > 0 ? res.stderr : res.stdout;
  const flat = source.trim().replace(/\s+/g, " ");
  if (flat.length === 0) return undefined;
  return flat.length > maxLength ? `…${flat.slice(-maxLength)}` : flat;
}

/** Fixed-size promise pool: at most `limit` workers in flight, items claimed
 * in order, results written by index so completion order never matters. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        const item = items[index] as T;
        await worker(item, index);
      }
    },
  );
  await Promise.all(lanes);
}

function readEnvelope(jsonPath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Best-effort: a missing or unparseable artifact is handled by the caller.
  }
  return undefined;
}

function gatherArtifacts(outPrefix: string): QaRunCommandOutcome["artifacts"] {
  const artifacts: QaRunCommandOutcome["artifacts"] = {};
  const png = `${outPrefix}.png`;
  const html = `${outPrefix}.html`;
  const json = `${outPrefix}.json`;
  if (existsSync(png)) artifacts.png = png;
  if (existsSync(html)) artifacts.html = html;
  if (existsSync(json)) artifacts.json = json;
  return artifacts;
}

/** Best-effort extraction of failing-check details from a browse JSON
 * envelope. The exit-code entry the caller records is the guaranteed
 * minimum; these lines add human-readable specifics when parseable. */
function parseGateFailures(envelope: Record<string, unknown> | undefined): string[] {
  if (!envelope) return [];
  const failures: string[] = [];
  const overflow = envelope.overflow as
    | { hasHorizontalOverflow?: boolean; overflowPx?: number }
    | undefined;
  if (overflow?.hasHorizontalOverflow) {
    failures.push(`overflow: +${overflow.overflowPx ?? "?"}px horizontal overflow`);
  }
  const asserts = envelope.asserts as
    | Array<{ op?: string; selector?: string; outcome?: string; actual?: string }>
    | undefined;
  for (const entry of asserts ?? []) {
    if (entry.outcome === "fail") {
      failures.push(`assert ${entry.op ?? "?"} ${entry.selector ?? "?"} → "${entry.actual ?? ""}"`);
    }
  }
  const visibility = envelope.visibility as
    | Array<{ selector?: string; found?: boolean; cssVisible?: boolean; visibleRatio?: number }>
    | undefined;
  for (const entry of visibility ?? []) {
    if (entry.found === false) failures.push(`visibility ${entry.selector ?? "?"}: not found`);
    else if (entry.cssVisible === false) {
      failures.push(`visibility ${entry.selector ?? "?"}: CSS-hidden`);
    }
  }
  const critique = envelope.critique as
    | { outcome?: string; findings?: Array<{ severity?: string; description?: string }> }
    | undefined;
  if (critique?.outcome === "fail") {
    for (const finding of critique.findings ?? []) {
      failures.push(`critique [${finding.severity ?? "?"}]: ${finding.description ?? ""}`);
    }
  }
  return failures;
}

function diagnosticSummary(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    for (const key of ["text", "message", "errorText", "failure", "url"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return JSON.stringify(entry);
}

/** `console` in the planner contract covers every browser diagnostic that the
 * browse envelope records. Keep the first three details actionable and name
 * any remainder without allowing an unbounded page log to bloat the result. */
function parseConsoleFailures(envelope: Record<string, unknown> | undefined): string[] {
  if (!envelope) return [];
  const failures: string[] = [];
  const groups: Array<[string, unknown]> = [
    ["console", envelope.consoleErrors],
    ["page", envelope.pageErrors],
    ["request", envelope.failedRequests],
  ];
  for (const [label, value] of groups) {
    if (!Array.isArray(value) || value.length === 0) continue;
    for (const entry of value.slice(0, 3)) failures.push(`${label}: ${diagnosticSummary(entry)}`);
    if (value.length > 3) failures.push(`${label}: ${value.length - 3} additional failure(s)`);
  }
  return failures;
}

/**
 * Lift per-backend vision latency out of the envelope's provider_meta. The
 * shape is host-owned (`providers[name].latency_ms = {count, p50, p95}`), so
 * read defensively: a malformed entry or one with zero calls is dropped.
 * Without this the runner kept only the provider label, and a slow tile was
 * visible in `ps` and nowhere in the result document.
 */
function critiqueLatency(
  providerMeta: Record<string, unknown> | undefined,
): Record<string, QaRunCritiqueLatency> | undefined {
  const providers = providerMeta?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  const out: Record<string, QaRunCritiqueLatency> = {};
  for (const [name, state] of Object.entries(providers as Record<string, unknown>)) {
    const lat = (state as { latency_ms?: unknown } | null)?.latency_ms as
      | { count?: unknown; p50?: unknown; p95?: unknown }
      | undefined;
    if (!lat || typeof lat !== "object") continue;
    const { count, p50, p95 } = lat;
    if (typeof count !== "number" || count <= 0) continue;
    if (typeof p50 !== "number" || typeof p95 !== "number") continue;
    out[name] = { count, p50, p95 };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Execute the whole QA matrix for one validated job and return the result
 * (also written to `<outDir>/page-qa-result.json`). Stages: plan →
 * deterministic gates (bounded pool) → interactions (serial) → capture (each
 * context rendered once into the run's page review pack through the same
 * pool, browser closed) → critique (one in-process pool of vision calls over
 * every tile of every context, no browser open) → snapshot (persisted from
 * the pack's files in signoff). The verdict is computeVerdict over
 * everything recorded — fail-closed.
 */
export async function runQaMatrix(options: QaRunMatrixOptions): Promise<QaRunResult> {
  const { job, outParent, browseArgv } = options;
  const exec = options.exec ?? defaultQaRunExec;
  const log = options.onLog ?? (() => {});
  const timeoutMs = job.policy?.command_timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const concurrency = job.policy?.command_concurrency ?? DEFAULT_COMMAND_CONCURRENCY;

  const hostSample = (): QaRunHostSample => {
    const holders = options.admission?.holders?.() ?? undefined;
    return {
      captured_at: new Date().toISOString(),
      loadavg_1m: loadavg()[0] ?? 0,
      free_mem_bytes: freemem(),
      total_mem_bytes: totalmem(),
      cpu_count: cpus().length,
      // Exclude this run itself: a holder list that names the sampler tells
      // the reader nothing about contention.
      ...(holders ? { competing: holders.filter((holder) => holder.pid !== process.pid) } : {}),
    };
  };
  const stageHostSamples: Partial<Record<QaRunStage, QaRunHostSample>> = {};

  const runId = options.runId ?? randomUUID();
  const outDir = join(outParent, `run-${runId}`);
  mkdirSync(outDir, { recursive: true });
  const startedAtIso = new Date().toISOString();
  writeFileSync(join(outDir, QA_RUN_JOB_FILENAME), `${JSON.stringify(job, null, 2)}\n`);

  // Live status: state + stage + heartbeat, written atomically so a client
  // that lost its terminal can distinguish this run being alive from dead.
  let statusState: QaRunStatusState = "running";
  let statusStage: QaRunStage | null = null;
  let statusQueue: QaRunStatusDocument["queue"];
  let statusVerdict: QaRunStatusDocument["verdict"];
  const writeStatus = (): void => {
    const status: QaRunStatusDocument = {
      schema_version: QA_RUN_STATUS_SCHEMA_VERSION,
      run_id: runId,
      pid: process.pid,
      state: statusState,
      stage: statusStage,
      started_at: startedAtIso,
      updated_at: new Date().toISOString(),
      ...(statusQueue ? { queue: statusQueue } : {}),
      ...(statusVerdict ? { verdict: statusVerdict } : {}),
    };
    try {
      const tmp = join(outDir, `.${QA_RUN_STATUS_FILENAME}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
      renameSync(tmp, join(outDir, QA_RUN_STATUS_FILENAME));
    } catch {
      // Status is advisory; the result document is the authoritative record.
    }
  };
  const heartbeat = setInterval(writeStatus, STATUS_HEARTBEAT_MS);
  heartbeat.unref();

  /** Enter a stage: record the host pressure it starts under and refresh the
   * live status document in one place. */
  const enterStage = (stage: QaRunStage): void => {
    statusStage = stage;
    stageHostSamples[stage] = hostSample();
    writeStatus();
  };

  const revision: Pick<
    QaRunResult["run"],
    "tested_revision" | "revision_source" | "worktree_dirty"
  > =
    job.tested_revision !== undefined
      ? { tested_revision: job.tested_revision, revision_source: "job" }
      : options.revisionProbe?.tested_revision !== undefined
        ? {
            tested_revision: options.revisionProbe.tested_revision,
            revision_source: "git",
            ...(options.revisionProbe.worktree_dirty !== undefined
              ? { worktree_dirty: options.revisionProbe.worktree_dirty }
              : {}),
          }
        : { revision_source: "unknown" };
  const jobDigest = computeJobDigest(job);
  const wall: QaRunResult["wall_time_ms"] = {
    plan: 0,
    gates: 0,
    interactions: 0,
    capture: 0,
    critique: 0,
    snapshot: 0,
    total: 0,
  };

  // ------------------------------------------------------------- admission
  // Queue wait happens before the runner clock starts: wall_time_ms.total
  // stays pure runner time and the wait is reported as wall_time_ms.queue.
  let releaseAdmission: (() => void) | undefined;
  let admissionFailure: string | undefined;
  if (options.admission) {
    statusState = "queued";
    statusQueue = {
      resource: options.admission.resource,
      waiting_since: new Date().toISOString(),
    };
    writeStatus();
    const queueStart = Date.now();
    try {
      releaseAdmission = await options.admission.acquire((message) => {
        log(message);
        writeStatus();
      });
    } catch (err: unknown) {
      admissionFailure = err instanceof Error ? err.message : String(err);
    }
    wall.queue = Date.now() - queueStart;
    statusQueue = undefined;
  }
  statusState = "running";
  writeStatus();

  const hostStart = hostSample();
  const startedAt = Date.now();
  const blockers: QaRunBlocker[] = [];
  // Overall deadline: the clock starts after admission (pure runner time) and
  // is consulted before every command, so the worst overshoot is one command
  // timeout plus the kill grace. Exceeding it fails closed as incomplete.
  const runDeadlineMs = job.policy?.run_deadline_ms ?? DEFAULT_RUN_DEADLINE_MS;
  let deadlineHit = false;
  const pastDeadline = (): boolean => {
    if (deadlineHit) return true;
    if (Date.now() - startedAt < runDeadlineMs) return false;
    deadlineHit = true;
    blockers.push({
      stage: "deadline",
      reason:
        `run deadline of ${runDeadlineMs}ms exceeded — remaining commands were skipped and ` +
        "the result finalized as incomplete (raise policy.run_deadline_ms for a legitimately " +
        "larger matrix)",
    });
    log(`deadline: ${runDeadlineMs}ms exceeded, skipping remaining commands`);
    return true;
  };
  const commands: QaRunCommandOutcome[] = [];
  const critique: QaRunCritiqueOutcome[] = [];
  const stagesRun: QaRunStage[] = [];
  let manifest: QaManifest | null = null;
  let contexts: QaRunContext[] = [];
  let snapshot: QaRunResult["snapshot"] = { saved: false };
  let critiquePool: QaRunCritiquePool | undefined;
  let reviewPack: QaRunReviewPack | undefined;

  const baseEnv: NodeJS.ProcessEnv = { ...process.env, ...options.childEnv };

  const timedExec = async (argv: string[], env: NodeJS.ProcessEnv): Promise<TimedExec> => {
    const started = Date.now();
    let res: QaRunExecResult;
    try {
      res = await exec(argv, { timeoutMs, env });
    } catch (err: unknown) {
      res = {
        exitCode: null,
        stdout: "",
        stderr: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { res, wallTimeMs: Date.now() - started };
  };

  const finalize = (): QaRunResult => {
    wall.total = Date.now() - startedAt;
    // Prefix semantics: the last stage the run progressed THROUGH cleanly.
    // Stages are pushed in execution order; the first blocked stage ends the
    // clean prefix, so a gate-blocked run reports "plan" even though the
    // (empty) interactions stage technically executed afterwards.
    const blockedStages = new Set(blockers.map((blocker) => blocker.stage));
    let lastCompletedStage: QaRunStage | null = null;
    for (const stage of stagesRun) {
      if (blockedStages.has(stage)) break;
      lastCompletedStage = stage;
    }
    const result: QaRunResult = {
      schema_version: QA_RUN_RESULT_SCHEMA_VERSION,
      evidence_source: "runner",
      run: {
        run_id: runId,
        started_at: startedAtIso,
        completed_at: new Date().toISOString(),
        ...revision,
        job_digest: jobDigest,
        out_dir: outDir,
      },
      host: {
        start: hostStart,
        finish: hostSample(),
        ...(Object.keys(stageHostSamples).length > 0 ? { stages: stageHostSamples } : {}),
      },
      last_completed_stage: lastCompletedStage,
      target: job.target,
      ...(revision.tested_revision !== undefined
        ? { tested_revision: revision.tested_revision }
        : {}),
      mode: job.mode,
      qa_plan: manifest,
      contexts,
      commands,
      critique,
      ...(critiquePool ? { critique_pool: critiquePool } : {}),
      ...(reviewPack ? { review_pack: reviewPack } : {}),
      snapshot,
      wall_time_ms: { ...wall },
      blockers,
      verdict: computeVerdict({
        mode: job.mode,
        blockers,
        commands,
        critique,
        snapshotSaved: snapshot.saved,
      }),
    };
    writeFileSync(join(outDir, QA_RUN_RESULT_FILENAME), `${JSON.stringify(result, null, 2)}\n`);
    writeLatestPointer(outParent, {
      run_id: runId,
      dir: basename(outDir),
      completed_at: result.run.completed_at,
      verdict: result.verdict,
    });
    statusState = "completed";
    statusStage = null;
    statusVerdict = result.verdict;
    writeStatus();
    clearInterval(heartbeat);
    releaseAdmission?.();
    return result;
  };

  if (admissionFailure !== undefined) {
    blockers.push({
      stage: "admission",
      reason: `no admission slot for browser work: ${admissionFailure}`,
    });
    return finalize();
  }

  // Base render arguments shared by every per-context invocation.
  const contextRenderArgs = (ctx: QaRunContext): string[] => [
    "--viewport",
    ctx.viewport,
    ...(ctx.theme === "dark" ? ["--color-scheme", "dark"] : []),
    ...(ctx.args ?? []),
  ];

  // The planner's tile ceiling and every critique child must agree on the
  // per-context band cap, or the predicted cost and the real coverage drift.
  const critiqueMaxTilesArgs =
    job.policy?.critique_max_tiles !== undefined
      ? ["--check-critique-max-tiles", String(job.policy.critique_max_tiles)]
      : [];

  // ------------------------------------------------------------------ plan
  const planArgv = [
    ...browseArgv,
    job.target,
    "--qa-plan",
    "--json",
    "--no-screenshot",
    ...critiqueMaxTilesArgs,
    ...(job.qa_hints?.scopes ?? []).flatMap((selector) => ["--qa-scope", selector]),
    ...(job.qa_hints?.states?.length ? ["--qa-states", job.qa_hints.states.join(",")] : []),
  ];
  log(`plan: ${job.target}`);
  enterStage("plan");
  const planStart = Date.now();
  const plan = await timedExec(planArgv, baseEnv);
  wall.plan = Date.now() - planStart;
  stagesRun.push("plan");
  let planEnvelope: Record<string, unknown> | undefined;
  if (!plan.res.error && plan.res.exitCode === 0) {
    try {
      const parsed: unknown = JSON.parse(plan.res.stdout);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        planEnvelope = parsed as Record<string, unknown>;
      }
    } catch {
      // handled below as a plan blocker
    }
  }
  const qaPlanReport = planEnvelope?.qaPlan as { manifest?: QaManifest } | undefined;
  manifest = qaPlanReport?.manifest ?? null;
  const planUsable = manifest !== null && !manifest.incomplete && plan.res.exitCode === 0;
  commands.push({
    context_id: "plan",
    check_id: "plan",
    argv: planArgv,
    exit_code: plan.res.exitCode,
    outcome: planUsable ? "passed" : "unknown",
    failures: planUsable
      ? []
      : [plan.res.error, execErrorExcerpt(plan.res)].filter((entry): entry is string =>
          Boolean(entry),
        ),
    artifacts: {},
    wall_time_ms: plan.wallTimeMs,
  });
  if (plan.res.error) {
    blockers.push({ stage: "plan", reason: `planner command did not complete: ${plan.res.error}` });
  } else if (plan.res.exitCode !== 0) {
    const excerpt = execErrorExcerpt(plan.res);
    blockers.push({
      stage: "plan",
      reason: `planner exited ${plan.res.exitCode}${excerpt ? `: ${excerpt}` : ""}`,
    });
  } else if (!manifest) {
    blockers.push({
      stage: "plan",
      reason: "planner envelope carried no parseable qaPlan.manifest",
    });
  } else if (manifest.incomplete) {
    blockers.push({
      stage: "plan",
      reason: `planner manifest is incomplete: ${manifest.incomplete.reason}`,
    });
  }
  if (!planUsable || !manifest) {
    // Stop before any further browser work: an untrusted plan cannot gate.
    contexts = manifest ? mergeCoverage(manifest, job) : [];
    return finalize();
  }

  // ----------------------------------------------------------------- gates
  contexts = mergeCoverage(manifest, job);
  const unsupportedDeterministic = manifest.checks.deterministic.filter(
    (check) => MANIFEST_DETERMINISTIC_ARGS[check] === undefined,
  );
  if (unsupportedDeterministic.length > 0) {
    for (const check of unsupportedDeterministic) {
      blockers.push({
        stage: "gates",
        reason:
          `planner requires deterministic check "${check}" but qa-run has no executable ` +
          "mapping for it — coverage cannot be narrowed",
      });
    }
    return finalize();
  }
  const manifestGateArgs = manifest.checks.deterministic.flatMap(
    (check) => MANIFEST_DETERMINISTIC_ARGS[check] ?? [],
  );
  const enforceConsole = manifest.checks.deterministic.includes("console");
  const checks = job.checks ?? [];
  const gateOutcomes = new Array<QaRunCommandOutcome>(contexts.length);
  enterStage("gates");
  const gatesStart = Date.now();
  await runPool(contexts, concurrency, async (ctx, index) => {
    if (pastDeadline()) return;
    const applicable = checks.filter(
      (check) => check.contexts === undefined || check.contexts.includes(ctx.id),
    );
    const checkId =
      [
        ...manifest.checks.deterministic.map((check) => `manifest:${check}`),
        ...applicable.map((check) => check.id),
      ].join("+") || "capture";
    const outPrefix = join(outDir, ctx.id);
    const argv = [
      ...browseArgv,
      job.target,
      ...contextRenderArgs(ctx),
      "--out",
      outPrefix,
      ...manifestGateArgs,
      ...applicable.flatMap((check) => check.args),
    ];
    log(`gate ${ctx.id}: ${checkId}`);
    const { res, wallTimeMs } = await timedExec(argv, baseEnv);
    const jsonPath = `${outPrefix}.json`;
    const failures: string[] = [];
    let outcome: QaRunCommandOutcome["outcome"];
    const envelope = existsSync(jsonPath) ? readEnvelope(jsonPath) : undefined;
    const consoleFailures = enforceConsole ? parseConsoleFailures(envelope) : [];
    if (!res.error && res.exitCode === 0 && existsSync(jsonPath)) {
      if (consoleFailures.length > 0) {
        outcome = "failed";
        failures.push(...consoleFailures);
      } else {
        outcome = "passed";
      }
    } else if (!res.error && res.exitCode === 2 && existsSync(jsonPath)) {
      outcome = "failed";
      failures.push(`exit code 2 (${jsonPath})`);
      failures.push(...parseGateFailures(envelope), ...consoleFailures);
    } else {
      outcome = "unknown";
      const excerpt = execErrorExcerpt(res);
      const base = res.error
        ? res.error
        : !existsSync(jsonPath)
          ? `exit code ${res.exitCode ?? "null"}, missing JSON artifact ${jsonPath}`
          : `exit code ${res.exitCode ?? "null"}`;
      const reason = excerpt ? `${base}: ${excerpt}` : base;
      failures.push(reason);
      blockers.push({
        stage: "gates",
        context_id: ctx.id,
        reason: `gate command did not complete: ${reason}`,
      });
    }
    gateOutcomes[index] = {
      context_id: ctx.id,
      check_id: checkId,
      argv,
      exit_code: res.exitCode,
      outcome,
      failures,
      artifacts: gatherArtifacts(outPrefix),
      wall_time_ms: wallTimeMs,
    };
  });
  wall.gates = Date.now() - gatesStart;
  stagesRun.push("gates");
  // Manifest order regardless of completion order: outcomes were written by
  // context index, so a straight push preserves it. Deadline-skipped slots
  // are empty: the single deadline blocker is their record.
  commands.push(...gateOutcomes.filter((outcome) => outcome !== undefined));

  // ---------------------------------------------------------- interactions
  enterStage("interactions");
  const interactionsStart = Date.now();
  const declaredStates = new Set((job.interaction_states ?? []).map((state) => state.name));
  const manifestStates = [
    ...new Set(
      manifest.contexts.map((context) => context.state).filter((state) => state !== "default"),
    ),
  ];
  for (const state of manifestStates) {
    if (!declaredStates.has(state)) {
      blockers.push({
        stage: "interactions",
        reason:
          `manifest requires interaction state "${state}" but the job declares no matching ` +
          "interaction_states entry — job coverage may never be narrower than the manifest",
      });
    }
  }
  for (const state of job.interaction_states ?? []) {
    if (pastDeadline()) break;
    const outPrefix = join(outDir, `interaction-${state.name}`);
    const argv = [
      ...browseArgv,
      job.target,
      "--out",
      outPrefix,
      ...state.setup,
      ...state.assertions.flatMap((assertion) => ["--assert", assertion]),
      "--assert-fail",
    ];
    log(`interaction ${state.name}`);
    const { res, wallTimeMs } = await timedExec(argv, baseEnv);
    const jsonPath = `${outPrefix}.json`;
    const failures: string[] = [];
    let outcome: QaRunCommandOutcome["outcome"];
    if (!res.error && res.exitCode === 0 && existsSync(jsonPath)) {
      outcome = "passed";
    } else if (!res.error && res.exitCode === 2 && existsSync(jsonPath)) {
      outcome = "failed";
      failures.push(`exit code 2 (${jsonPath})`);
      failures.push(...parseGateFailures(readEnvelope(jsonPath)));
    } else {
      outcome = "unknown";
      const excerpt = execErrorExcerpt(res);
      const base = res.error
        ? res.error
        : !existsSync(jsonPath)
          ? `exit code ${res.exitCode ?? "null"}, missing JSON artifact ${jsonPath}`
          : `exit code ${res.exitCode ?? "null"}`;
      const reason = excerpt ? `${base}: ${excerpt}` : base;
      failures.push(reason);
      blockers.push({
        stage: "interactions",
        context_id: state.name,
        reason: `interaction command did not complete: ${reason}`,
      });
    }
    commands.push({
      context_id: state.name,
      check_id: `interaction:${state.name}`,
      argv,
      exit_code: res.exitCode,
      outcome,
      failures,
      artifacts: gatherArtifacts(outPrefix),
      wall_time_ms: wallTimeMs,
    });
  }
  wall.interactions = Date.now() - interactionsStart;
  stagesRun.push("interactions");

  // -------------------------------------------------------------- capture
  // Each context is rendered ONCE into the run's page review pack (full-page
  // screenshot, tiles as PNG files, DOM, signature) through the same bounded
  // pool the gates used, and its browser closes before any vision call.
  const visual = manifest.checks.visual;
  const cleanSoFar =
    blockers.length === 0 && commands.every((command) => command.outcome === "passed");
  const packDir = join(outDir, PAGE_REVIEW_PACK_DIRNAME);
  const capturedRecords: PageReviewContextRecord[] = [];
  const judgeCommand = options.reviewPackJudgeCommand?.(packDir);
  // Gate rectangles ride along from each gate's JSON artifact so the pack's
  // inspection plan can point a runt, a contrast miss, or a clipped element
  // at the tiles that show it. A missing or unparseable artifact simply
  // contributes no hits; the gate's `failures` still carry the text.
  const gateRecords = (): PageReviewGateRecord[] =>
    commands
      .filter((command) => command.check_id !== "plan" && command.check_id !== "review-pack")
      .map((command) => {
        const hits = command.artifacts.json
          ? gateHitsFromEnvelope(readEnvelope(command.artifacts.json))
          : [];
        return {
          context_id: command.context_id,
          check_id: command.check_id,
          outcome: command.outcome,
          failures: command.failures,
          ...(hits.length > 0 ? { hits } : {}),
        };
      });
  const finalizePack = (
    stage: QaRunStage,
    critiqueRecords: PageReviewCritiqueRecord[] | null,
    pool?: { concurrency: number; wall_time_ms: number; provider: string },
  ): void => {
    try {
      finalizePageReviewPack({
        packDir,
        target: job.target,
        ...(revision.tested_revision !== undefined
          ? { tested_revision: revision.tested_revision }
          : {}),
        contexts: capturedRecords,
        gates: gateRecords(),
        critique: critiqueRecords,
        ...(pool ? { pool } : {}),
        ...(judgeCommand ? { judgeCommand } : {}),
        createdAt: startedAtIso,
      });
      reviewPack = {
        schema: PAGE_REVIEW_PACK_SCHEMA,
        dir: packDir,
        review: join(packDir, PAGE_REVIEW_REVIEW_FILENAME),
        findings: join(packDir, PAGE_REVIEW_FINDINGS_FILENAME),
      };
    } catch (err: unknown) {
      blockers.push({
        stage,
        reason: `page review pack could not be finalized: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  // The provider is loaded once, before capture, so the capture children can
  // clamp band height to the routed model's vision budget (what browse does
  // for --check-critique) and the judge reuses the same instance.
  const priorHeadlessOnly = process.env[QA_RUN_HEADLESS_ONLY_ENV];
  const restoreHeadlessOnly = (): void => {
    if (priorHeadlessOnly === undefined) delete process.env[QA_RUN_HEADLESS_ONLY_ENV];
    else process.env[QA_RUN_HEADLESS_ONLY_ENV] = priorHeadlessOnly;
  };
  let provider: CritiqueProvider | undefined;
  const runsVisual = cleanSoFar && visual !== "none";
  if (runsVisual) {
    if (!job.policy?.allow_metered_critique) process.env[QA_RUN_HEADLESS_ONLY_ENV] = "1";
    try {
      provider =
        options.critiqueProvider ??
        (options.critiqueProviderLoader ? await options.critiqueProviderLoader() : undefined);
    } catch (err: unknown) {
      provider = undefined;
      log(`critique provider failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const bandArgs =
    provider?.tileBudgetPx !== undefined
      ? ["--check-critique-band", String(Math.max(200, Math.min(1400, provider.tileBudgetPx)))]
      : [];
  const scopeArgs =
    visual === "full-page"
      ? []
      : manifest.scopes.flatMap((s) => ["--review-pack-scope", s.selector]);

  enterStage("capture");
  const captureStart = Date.now();
  if (runsVisual) {
    const captureOutcomes = new Array<QaRunCommandOutcome>(contexts.length);
    const captureRecords = new Array<PageReviewContextRecord | undefined>(contexts.length);
    await runPool(contexts, concurrency, async (ctx, index) => {
      if (pastDeadline()) return;
      const outPrefix = join(outDir, `${ctx.id}-capture`);
      const argv = [
        ...browseArgv,
        job.target,
        ...contextRenderArgs(ctx),
        "--out",
        outPrefix,
        "--no-screenshot",
        "--review-pack",
        packDir,
        "--review-pack-context",
        ctx.id,
        "--qa-theme",
        ctx.theme,
        "--qa-state",
        ctx.state,
        ...(visual === "scoped" ? ["--no-review-pack-bands"] : []),
        ...scopeArgs,
        ...critiqueMaxTilesArgs,
        ...bandArgs,
      ];
      log(
        `capture ${ctx.id}${scopeArgs.length > 0 ? ` [${manifest.scopes.map((s) => s.selector).join(",")}]` : ""}`,
      );
      const { res, wallTimeMs } = await timedExec(argv, baseEnv);
      const jsonPath = `${outPrefix}.json`;
      const envelope = readEnvelope(jsonPath);
      const report = envelope?.reviewPack as { context_id?: string } | undefined;
      const failures: string[] = [];
      let outcome: QaRunCommandOutcome["outcome"];
      let record: PageReviewContextRecord | undefined;
      if (!res.error && res.exitCode === 0 && envelope && report?.context_id) {
        try {
          record = readPackContext(packDir, report.context_id);
          outcome = "passed";
        } catch (err: unknown) {
          outcome = "unknown";
          const reason = `pack context unreadable: ${err instanceof Error ? err.message : String(err)}`;
          failures.push(reason);
          blockers.push({ stage: "capture", context_id: ctx.id, reason });
        }
      } else {
        outcome = "unknown";
        const excerpt = execErrorExcerpt(res);
        const base = res.error
          ? res.error
          : !envelope
            ? `exit code ${res.exitCode ?? "null"}, missing JSON artifact ${jsonPath}`
            : !report?.context_id
              ? `exit code ${res.exitCode ?? "null"}, envelope carries no reviewPack record`
              : `exit code ${res.exitCode ?? "null"}`;
        const reason = excerpt ? `${base}: ${excerpt}` : base;
        failures.push(reason);
        blockers.push({
          stage: "capture",
          context_id: ctx.id,
          reason: `capture command did not complete: ${reason}`,
        });
      }
      captureOutcomes[index] = {
        context_id: ctx.id,
        check_id: "review-pack",
        argv,
        exit_code: res.exitCode,
        outcome,
        failures,
        artifacts: gatherArtifacts(outPrefix),
        wall_time_ms: wallTimeMs,
      };
      captureRecords[index] = record;
    });
    commands.push(...captureOutcomes.filter((outcome) => outcome !== undefined));
    capturedRecords.push(
      ...captureRecords.filter((record): record is PageReviewContextRecord => Boolean(record)),
    );
    // The pack is readable from here on even if the judge never runs.
    if (capturedRecords.length > 0) finalizePack("capture", null);
  }
  wall.capture = Date.now() - captureStart;
  if (runsVisual) stagesRun.push("capture");

  // -------------------------------------------------------------- critique
  // One pool of vision calls across every captured context, from disk. No
  // browser is open during this stage.
  enterStage("critique");
  const critiqueStart = Date.now();
  const judgedById = new Map<string, JudgedContext>();
  if (runsVisual && capturedRecords.length > 0 && !pastDeadline()) {
    const judged = await judgePageReviewPack({
      packDir,
      provider,
      rubric: DEFAULT_CRITIQUE_RUBRIC,
      ...(job.policy?.critique_pool !== undefined ? { concurrency: job.policy.critique_pool } : {}),
      contextIds: capturedRecords.map((record) => record.id),
      ...(manifest.baseline_source !== "none"
        ? {
            reuse: {
              target: job.target,
              ...(options.snapshotStore ? { store: options.snapshotStore } : {}),
            },
          }
        : {}),
      deadlineAt: startedAt + runDeadlineMs,
      onLog: log,
    });
    const latency = critiqueLatency(judged.provider_meta);
    critiquePool = {
      concurrency: judged.pool.concurrency,
      tiles_total: judged.tiles_total,
      tiles_reviewed: judged.tiles_reviewed,
      tiles_reused: judged.tiles_reused,
      wall_time_ms: judged.pool.wall_time_ms,
      provider: judged.pool.provider,
      ...(latency ? { latency_ms: latency } : {}),
    };
    for (const row of judged.contexts) {
      judgedById.set(row.context_id, row);
      let contextOutcome: QaRunCritiqueOutcome["outcome"] =
        row.outcome === "pass" ? "passed" : row.outcome === "fail" ? "failed" : "unknown";
      if (row.outcome === "skipped") {
        const detail = row.error ?? "critique reported no conclusive outcome";
        blockers.push({
          stage: "critique",
          context_id: row.context_id,
          reason: job.policy?.allow_metered_critique
            ? `critique did not complete: ${detail}`
            : `critique did not complete under the headless-only policy ` +
              `(${QA_RUN_HEADLESS_ONLY_ENV}=1; permit metered fallback with ` +
              `policy.allow_metered_critique / --allow-metered): ${detail}`,
        });
      } else if (row.outcome === "incomplete") {
        blockers.push({
          stage: "critique",
          context_id: row.context_id,
          reason:
            `judge did not review ${row.tiles_unjudged} of ${row.tiles_total} tile(s) before the ` +
            "run deadline; nothing is proven for them",
        });
      }
      // A capped capture holds the top of the page and nothing below it.
      // Signoff cannot rest on that; review mode keeps the row honest via
      // `coverage` and leaves the verdict to the tiles that were seen.
      if (job.mode === "signoff" && row.coverage.capped && contextOutcome !== "failed") {
        contextOutcome = "unknown";
        blockers.push({
          stage: "critique",
          context_id: row.context_id,
          reason:
            `critique coverage capped: ${row.coverage.bands_reviewed} of ${row.coverage.bands_total} bands ` +
            `reviewed (${row.coverage.reviewed_height_px} of ${row.coverage.page_height_px} px); raise ` +
            "policy.critique_max_tiles to review the whole page in signoff mode",
        });
      }
      const scopeById = new Map(row.record.tiles.map((tile) => [tile.id, tile.scope]));
      critique.push({
        context_id: row.context_id,
        provider: row.provider,
        tiles_total: row.tiles_total,
        tiles_reviewed: row.tiles_reviewed,
        tiles_reused: row.tiles_reused,
        outcome: contextOutcome,
        findings: row.findings.map((finding) => {
          const selector = scopeById.get(finding.tile_id);
          return {
            severity: finding.severity,
            summary: `${finding.category}: ${finding.description}`,
            tile: `${row.context_id}/${finding.tile_id}`,
            ...(selector !== undefined ? { selector } : {}),
          };
        }),
        coverage: row.coverage,
      });
    }
    finalizePack("critique", toCritiqueRecords(judged), judged.pool);
  }
  if (runsVisual) restoreHeadlessOnly();
  wall.critique = Date.now() - critiqueStart;
  if (runsVisual) stagesRun.push("critique");

  // -------------------------------------------------------------- snapshot
  // Signoff persists each context's baseline from the pack's own files (no
  // browser). The critique rides along only when the whole tile set was
  // freshly judged, uncapped, and unscoped — a partial or scoped review must
  // never become the next baseline's finding record. When the manifest
  // required no visual pass, a dedicated browse --qa-snapshot pass still runs.
  enterStage("snapshot");
  const snapshotStart = Date.now();
  const savedSnapshots = new Map<string, string>();
  if (job.mode === "signoff" && runsVisual) {
    for (const record of capturedRecords) {
      if (pastDeadline()) break;
      const row = judgedById.get(record.id);
      const persistCritique =
        row !== undefined &&
        (row.outcome === "pass" || row.outcome === "fail") &&
        !record.coverage.capped &&
        row.tiles_reused === 0 &&
        row.tiles_unjudged === 0 &&
        record.scopes.length === 0;
      const persisted: PersistedCritique | undefined =
        persistCritique && row
          ? {
              contract_version: QA_CRITIQUE_CONTRACT_VERSION,
              rubric_digest: rubricDigest(DEFAULT_CRITIQUE_RUBRIC),
              outcome: row.outcome as "pass" | "fail",
              findings: row.findings.map(({ tile_id: _tileId, ...finding }) => finding),
              tiles: record.tiles.map((tile) => ({
                index: tile.index,
                label: tile.label,
                x: tile.x,
                scrollY: tile.scrollY,
                width: tile.width,
                height: tile.height,
              })),
            }
          : undefined;
      try {
        const saved = saveQaSnapshot(
          job.target,
          { viewport: record.viewport, theme: record.theme, state: record.state },
          {
            signature: readPackSignature(packDir, record),
            domHtml: readPackDom(packDir, record),
            screenshotPng: readPackFullPage(packDir, record),
            ...(persisted ? { critique: persisted } : {}),
          },
          options.snapshotStore ?? {},
        );
        savedSnapshots.set(record.id, saved.path);
        log(`snapshot ${record.id}: saved${persisted ? " with critique" : ""}`);
      } catch (err: unknown) {
        blockers.push({
          stage: "snapshot",
          context_id: record.id,
          reason: `snapshot could not be persisted from the pack: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    for (const row of critique) {
      if (row.outcome === "passed" && !savedSnapshots.has(row.context_id)) {
        blockers.push({
          stage: "snapshot",
          context_id: row.context_id,
          reason: "signoff critique passed but no QA snapshot was persisted for the context",
        });
      }
    }
  } else if (job.mode === "signoff" && visual === "none" && blockers.length === 0) {
    const stillClean = commands.every((command) => command.outcome === "passed");
    if (stillClean) {
      for (const ctx of contexts) {
        if (pastDeadline()) break;
        const outPrefix = join(outDir, `${ctx.id}-snapshot`);
        const argv = [
          ...browseArgv,
          job.target,
          ...contextRenderArgs(ctx),
          "--out",
          outPrefix,
          "--qa-snapshot",
          "--qa-theme",
          ctx.theme,
          "--qa-state",
          ctx.state,
        ];
        log(`snapshot ${ctx.id}`);
        const { res, wallTimeMs } = await timedExec(argv, baseEnv);
        const envelope = readEnvelope(`${outPrefix}.json`);
        const saved = (envelope?.qaPlan as { snapshotSaved?: { path?: string } } | undefined)
          ?.snapshotSaved;
        const ok = !res.error && res.exitCode === 0 && Boolean(saved?.path);
        if (ok && saved?.path) savedSnapshots.set(ctx.id, saved.path);
        else {
          blockers.push({
            stage: "snapshot",
            context_id: ctx.id,
            reason: `snapshot command did not persist a baseline${res.error ? `: ${res.error}` : ` (exit code ${res.exitCode ?? "null"})`}`,
          });
        }
        commands.push({
          context_id: ctx.id,
          check_id: "snapshot",
          argv,
          exit_code: res.exitCode,
          outcome: ok ? "passed" : "unknown",
          failures: ok ? [] : [res.error ?? `exit code ${res.exitCode ?? "null"}`],
          artifacts: gatherArtifacts(outPrefix),
          wall_time_ms: wallTimeMs,
        });
      }
    }
  }
  wall.snapshot = Date.now() - snapshotStart;
  if (job.mode === "signoff") stagesRun.push("snapshot");

  if (job.mode === "signoff") {
    const allSaved = contexts.length > 0 && contexts.every((ctx) => savedSnapshots.has(ctx.id));
    const lastPath = [...savedSnapshots.values()].pop();
    snapshot = { saved: allSaved, ...(lastPath ? { path: lastPath } : {}) };
  }

  return finalize();
}
