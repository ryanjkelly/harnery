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

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename, join } from "node:path";
import type { QaManifest } from "./qa-plan.js";
import {
  computeJobDigest,
  computeVerdict,
  mergeCoverage,
  QA_RUN_RESULT_SCHEMA_VERSION,
  type QaRunBlocker,
  type QaRunCommandOutcome,
  type QaRunContext,
  type QaRunCritiqueOutcome,
  type QaRunHostSample,
  type QaRunJob,
  type QaRunResult,
  type QaRunStage,
} from "./qa-run-contracts.js";

/** Set on critique children unless the job permits metered critique: the
 * host's critique provider must stay on subscription-backed headless
 * harnesses and surface exhaustion instead of falling back to a metered API. */
export const QA_RUN_HEADLESS_ONLY_ENV = "HARNERY_CRITIQUE_HEADLESS_ONLY";

/** Result document written into the run's output directory. */
export const QA_RUN_RESULT_FILENAME = "page-qa-result.json";

/** Pointer document written into the parent output directory after every
 * run, naming the newest run's directory and verdict. Consumers resolve the
 * current result through this pointer instead of guessing at loose files. */
export const QA_RUN_LATEST_FILENAME = "latest.json";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
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

/** Default executor: execFile with argv arrays only (never a shell string),
 * closed stdin, bounded output buffers, and the policy timeout. */
export const defaultQaRunExec: QaRunExec = (argv, options) =>
  new Promise((resolvePromise) => {
    const [command, ...args] = argv;
    if (!command) {
      resolvePromise({ exitCode: null, stdout: "", stderr: "", error: "empty argv" });
      return;
    }
    const child = execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        maxBuffer: EXEC_MAX_BUFFER,
        env: options.env,
        killSignal: "SIGTERM",
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (!err) {
          resolvePromise({ exitCode: 0, stdout: out, stderr: errOut });
          return;
        }
        const failure = err as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (typeof failure.code === "number") {
          // Completed with a nonzero exit code: a real outcome, not an error.
          resolvePromise({ exitCode: failure.code, stdout: out, stderr: errOut });
          return;
        }
        const reason =
          failure.killed || failure.signal
            ? `killed by ${failure.signal ?? "signal"} (timeout ${options.timeoutMs}ms)`
            : failure.message || "spawn failed";
        resolvePromise({ exitCode: null, stdout: out, stderr: errOut, error: reason });
      },
    );
    child.stdin?.end();
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
}

function hostSample(): QaRunHostSample {
  return {
    captured_at: new Date().toISOString(),
    loadavg_1m: loadavg()[0] ?? 0,
    free_mem_bytes: freemem(),
    total_mem_bytes: totalmem(),
    cpu_count: cpus().length,
  };
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

interface EnvelopeCritique {
  tiles?: number;
  provider?: boolean;
  outcome?: string;
  findings?: Array<{ severity?: string; category?: string; description?: string }>;
  provider_meta?: Record<string, unknown>;
  error?: string;
}

function providerLabel(critique: EnvelopeCritique | undefined): string {
  const meta = critique?.provider_meta;
  if (meta) {
    for (const key of ["provider", "route", "model"]) {
      const value = meta[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return critique?.provider ? "host" : "none";
}

/**
 * Execute the whole QA matrix for one validated job and return the result
 * (also written to `<outDir>/page-qa-result.json`). Stages: plan →
 * deterministic gates (bounded pool) → interactions (serial) → critique (one
 * context at a time; the critique provider owns tile concurrency) → snapshot.
 * The verdict is computeVerdict over everything recorded — fail-closed.
 */
export async function runQaMatrix(options: QaRunMatrixOptions): Promise<QaRunResult> {
  const { job, outParent, browseArgv } = options;
  const exec = options.exec ?? defaultQaRunExec;
  const log = options.onLog ?? (() => {});
  const timeoutMs = job.policy?.command_timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const concurrency = job.policy?.command_concurrency ?? DEFAULT_COMMAND_CONCURRENCY;

  const runId = options.runId ?? randomUUID();
  const outDir = join(outParent, `run-${runId}`);
  mkdirSync(outDir, { recursive: true });
  const startedAtIso = new Date().toISOString();
  const hostStart = hostSample();
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

  const startedAt = Date.now();
  const wall = { plan: 0, gates: 0, interactions: 0, critique: 0, snapshot: 0, total: 0 };
  const blockers: QaRunBlocker[] = [];
  const commands: QaRunCommandOutcome[] = [];
  const critique: QaRunCritiqueOutcome[] = [];
  const stagesRun: QaRunStage[] = [];
  let manifest: QaManifest | null = null;
  let contexts: QaRunContext[] = [];
  let snapshot: QaRunResult["snapshot"] = { saved: false };

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
      run: {
        run_id: runId,
        started_at: startedAtIso,
        completed_at: new Date().toISOString(),
        ...revision,
        job_digest: jobDigest,
        out_dir: outDir,
      },
      host: { start: hostStart, finish: hostSample() },
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
    // Pointer in the parent: temp-file + rename so a reader never sees a
    // torn write. Last completed run wins, which is correct — each run's own
    // directory remains the authoritative record.
    const pointer = {
      schema_version: 1,
      run_id: runId,
      dir: basename(outDir),
      result: join(basename(outDir), QA_RUN_RESULT_FILENAME),
      completed_at: result.run.completed_at,
      verdict: result.verdict,
    };
    const pointerTmp = join(outParent, `.${QA_RUN_LATEST_FILENAME}.${runId}.tmp`);
    writeFileSync(pointerTmp, `${JSON.stringify(pointer, null, 2)}\n`);
    renameSync(pointerTmp, join(outParent, QA_RUN_LATEST_FILENAME));
    return result;
  };

  // Base render arguments shared by every per-context invocation.
  const contextRenderArgs = (ctx: QaRunContext): string[] => [
    "--viewport",
    ctx.viewport,
    ...(ctx.theme === "dark" ? ["--color-scheme", "dark"] : []),
    ...(ctx.args ?? []),
  ];

  // ------------------------------------------------------------------ plan
  const planArgv = [
    ...browseArgv,
    job.target,
    "--qa-plan",
    "--json",
    "--no-screenshot",
    ...(job.qa_hints?.scopes ?? []).flatMap((selector) => ["--qa-scope", selector]),
    ...(job.qa_hints?.states?.length ? ["--qa-states", job.qa_hints.states.join(",")] : []),
  ];
  log(`plan: ${job.target}`);
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
  const gatesStart = Date.now();
  await runPool(contexts, concurrency, async (ctx, index) => {
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
  // context index, so a straight push preserves it.
  commands.push(...gateOutcomes);

  // ---------------------------------------------------------- interactions
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

  // -------------------------------------------------------------- critique
  const visual = manifest.checks.visual;
  const cleanSoFar =
    blockers.length === 0 && commands.every((command) => command.outcome === "passed");
  const critiqueStart = Date.now();
  const savedSnapshots = new Map<string, string>();
  if (cleanSoFar && visual !== "none") {
    const critiqueEnv: NodeJS.ProcessEnv = job.policy?.allow_metered_critique
      ? { ...baseEnv }
      : { ...baseEnv, [QA_RUN_HEADLESS_ONLY_ENV]: "1" };
    const scopeSelectors =
      visual === "full-page" ? [undefined] : manifest.scopes.map((s) => s.selector);
    for (const ctx of contexts) {
      let tilesTotal = 0;
      let tilesReviewed = 0;
      let tilesReused = 0;
      let provider = "none";
      let contextOutcome: QaRunCritiqueOutcome["outcome"] = "passed";
      const findings: QaRunCritiqueOutcome["findings"] = [];
      for (const [scopeIndex, selector] of scopeSelectors.entries()) {
        const suffix = scopeSelectors.length > 1 ? `-scope${scopeIndex}` : "";
        const outPrefix = join(outDir, `${ctx.id}-critique${suffix}`);
        const argv = [
          ...browseArgv,
          job.target,
          ...contextRenderArgs(ctx),
          "--out",
          outPrefix,
          ...(selector !== undefined ? ["--check-critique", selector] : ["--check-critique"]),
          "--check-critique-fail",
          ...(manifest.baseline_source !== "none" ? ["--qa-reuse"] : []),
          ...(job.mode === "signoff"
            ? ["--qa-snapshot", "--qa-theme", ctx.theme, "--qa-state", ctx.state]
            : []),
        ];
        log(`critique ${ctx.id}${selector !== undefined ? ` [${selector}]` : ""}`);
        const { res, wallTimeMs } = await timedExec(argv, critiqueEnv);
        const jsonPath = `${outPrefix}.json`;
        const envelope = readEnvelope(jsonPath);
        const envelopeCritique = envelope?.critique as EnvelopeCritique | undefined;
        const failures: string[] = [];
        let commandOutcome: QaRunCommandOutcome["outcome"];
        if (res.error || (res.exitCode !== 0 && res.exitCode !== 2) || !envelope) {
          commandOutcome = "unknown";
          const excerpt = execErrorExcerpt(res);
          const base = res.error
            ? res.error
            : !envelope
              ? `exit code ${res.exitCode ?? "null"}, missing JSON artifact ${jsonPath}`
              : `exit code ${res.exitCode ?? "null"}`;
          const reason = excerpt ? `${base}: ${excerpt}` : base;
          failures.push(reason);
          blockers.push({
            stage: "critique",
            context_id: ctx.id,
            reason: `critique command did not complete: ${reason}`,
          });
          contextOutcome = "unknown";
        } else {
          tilesTotal += envelopeCritique?.tiles ?? 0;
          const reuse = envelope.qaReuse as
            | { tiles_reused?: number; tiles_reviewed?: number }
            | undefined;
          tilesReused += reuse?.tiles_reused ?? 0;
          tilesReviewed += reuse?.tiles_reviewed ?? envelopeCritique?.tiles ?? 0;
          provider = providerLabel(envelopeCritique);
          for (const finding of envelopeCritique?.findings ?? []) {
            findings.push({
              severity: finding.severity ?? "unknown",
              summary: finding.category
                ? `${finding.category}: ${finding.description ?? ""}`
                : (finding.description ?? ""),
              ...(selector !== undefined ? { selector } : {}),
            });
          }
          if (envelopeCritique?.outcome === "pass" && res.exitCode === 0) {
            commandOutcome = "passed";
          } else if (envelopeCritique?.outcome === "fail") {
            commandOutcome = "failed";
            failures.push(`critique found ${envelopeCritique.findings?.length ?? 0} defect(s)`);
            contextOutcome = "failed";
          } else {
            // "skipped" (no provider / exhausted headless list) or anything
            // unrecognized: the review did not happen, so nothing is proven.
            commandOutcome = "unknown";
            const detail = envelopeCritique?.error ?? "critique reported no conclusive outcome";
            failures.push(detail);
            blockers.push({
              stage: "critique",
              context_id: ctx.id,
              reason: job.policy?.allow_metered_critique
                ? `critique did not complete: ${detail}`
                : `critique did not complete under the headless-only policy ` +
                  `(${QA_RUN_HEADLESS_ONLY_ENV}=1; permit metered fallback with ` +
                  `policy.allow_metered_critique / --allow-metered): ${detail}`,
            });
            if (contextOutcome !== "failed") contextOutcome = "unknown";
          }
          if (job.mode === "signoff") {
            const saved = (envelope.qaPlan as { snapshotSaved?: { path?: string } } | undefined)
              ?.snapshotSaved;
            if (saved?.path) savedSnapshots.set(ctx.id, saved.path);
          }
        }
        commands.push({
          context_id: ctx.id,
          check_id: "critique",
          argv,
          exit_code: res.exitCode,
          outcome: commandOutcome,
          failures,
          artifacts: gatherArtifacts(outPrefix),
          wall_time_ms: wallTimeMs,
        });
      }
      critique.push({
        context_id: ctx.id,
        provider,
        tiles_total: tilesTotal,
        tiles_reviewed: tilesReviewed,
        tiles_reused: tilesReused,
        outcome: contextOutcome,
        findings,
      });
      if (job.mode === "signoff" && contextOutcome === "passed" && !savedSnapshots.has(ctx.id)) {
        blockers.push({
          stage: "snapshot",
          context_id: ctx.id,
          reason: "signoff critique passed but no QA snapshot was persisted for the context",
        });
      }
    }
  }
  wall.critique = Date.now() - critiqueStart;
  if (cleanSoFar && visual !== "none") stagesRun.push("critique");

  // -------------------------------------------------------------- snapshot
  // Critique invocations carry --qa-snapshot in signoff mode. When the
  // manifest requires no visual pass (visual === "none"), a passing signoff
  // still needs its baseline persisted, so a dedicated snapshot pass runs.
  const snapshotStart = Date.now();
  if (job.mode === "signoff" && visual === "none" && blockers.length === 0) {
    const stillClean = commands.every((command) => command.outcome === "passed");
    if (stillClean) {
      for (const ctx of contexts) {
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
