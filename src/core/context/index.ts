/**
 * Context continuity: durable, structured state around native adapter
 * compaction. Harnery does not decide when a adapter compacts. It records
 * context telemetry when the adapter exposes it, checkpoints external work
 * state before compaction, and renders a verified recovery briefing after it.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter } from "../adapter.ts";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";
import { resolveBinName } from "../config.ts";
import type { HarneryInboxMessageRecordV1 } from "../inbox/contract.ts";
import { peerInbox } from "../inbox/peer-messages.ts";
import { project } from "../inbox/service.ts";
import { stateFileMode } from "../storage/modes.ts";
import type { RepoSnapshot } from "./observation.ts";
import { repoComparisonProblems } from "./observation.ts";

export type { RepoObservation, RepoSnapshot } from "./observation.ts";
export { repoComparisonProblems } from "./observation.ts";

export const CONTEXT_SCHEMA_VERSION = 1 as const;
export const MAX_CAPSULE_BYTES = 32 * 1024;
const MAX_SNAPSHOT_PATHS = 15;
const MAX_SNAPSHOT_PATH_CHARS = 500;
const MAX_OBSERVATION_DETAIL_CHARS = 500;
const MAX_RECOVERY_INPUT_BODY_BYTES = 160;

export type ContextSampleSource = "hook" | "native_event" | "result" | "transcript" | "estimate";
export type ContextSampleConfidence = "exact" | "reported" | "estimated";
export type ContextPhase = "observing" | "checkpointed" | "recovered" | "degraded";
export type CheckpointReason = "manual" | "pressure" | "pre_compact" | "session_end";

export interface ContextSample {
  session_id: string;
  adapter: Adapter;
  model?: string;
  used_tokens?: number;
  window_tokens?: number;
  used_percent?: number;
  source: ContextSampleSource;
  confidence: ContextSampleConfidence;
  observed_at: string;
}

export interface ContextContinuityState {
  schema_version: typeof CONTEXT_SCHEMA_VERSION;
  session_id: string;
  instance_id: string;
  phase: ContextPhase;
  generation: number;
  latest_capsule?: string;
  latest_context?: ContextSample;
  updated_at: string;
  recovered_at?: string;
  compaction_completed_at?: string;
  degraded_reason?: string;
}

export interface ContinuityCapsule {
  schema_version: typeof CONTEXT_SCHEMA_VERSION;
  capsule_id: string;
  generation: number;
  created_at: string;
  reason: CheckpointReason;
  session: {
    session_id: string;
    instance_id: string;
    adapter: Adapter;
    model?: string;
  };
  context?: ContextSample;
  work: {
    task?: string;
    continuation_note?: string;
    files_held: string[];
    files_held_truncated?: boolean;
  };
  repo: RepoSnapshot;
}

export interface ExtractContextSampleOptions {
  sessionId: string;
  adapter: Adapter;
  model?: string;
  source?: ContextSampleSource;
  confidence?: ContextSampleConfidence;
  observedAt?: string;
}

export interface CheckpointContextInput {
  sessionId: string;
  instanceId: string;
  adapter: Adapter;
  cwd: string;
  reason: CheckpointReason;
  model?: string;
  continuationNote?: string;
}

export interface CheckpointContextResult {
  capsule: ContinuityCapsule;
  path: string;
  state: ContextContinuityState;
  reused: boolean;
}

export interface RecoverContextResult {
  state: ContextContinuityState;
  capsule: ContinuityCapsule | null;
  briefing: string;
  recovered: boolean;
}

/**
 * Authority for accepting exactly the capsule supplied during preparation.
 * It is returned by prepareContextRecovery, not reconstructed from latest state.
 */
export interface PreparedContextCheckpoint {
  session_id: string;
  instance_id: string;
  generation: number;
  capsule_id: string;
}

export interface PreparedContextRecovery {
  checkpoint: Readonly<PreparedContextCheckpoint>;
  state: ContextContinuityState;
  capsule: ContinuityCapsule;
  briefing: string;
}

interface HeartbeatSnapshot {
  model?: string;
  task?: string;
  files_touched?: string[];
}

/** Parse the context-window shapes exposed by current adapter hook/status data. */
export function extractContextSample(
  payload: Record<string, unknown>,
  options: ExtractContextSampleOptions,
): ContextSample | null {
  const contextValue = payload.context_window;
  const context = record(contextValue);
  const usage = record(context?.current_usage) ?? record(payload.usage);

  const windowTokens =
    number(context?.context_window_size) ??
    number(context?.window_tokens) ??
    number(payload.context_window_size) ??
    (typeof contextValue === "number" ? finiteNonNegative(contextValue) : undefined);

  const reportedUsed =
    number(context?.used_tokens) ?? number(context?.input_tokens) ?? number(payload.used_tokens);
  const usageParts = usage
    ? [
        number(usage.input_tokens),
        number(usage.cache_read_input_tokens),
        number(usage.cache_creation_input_tokens),
      ]
    : [];
  const hasUsageParts = usageParts.some((part) => part !== undefined);
  const usedTokens =
    reportedUsed ??
    (hasUsageParts
      ? usageParts.reduce<number>((total, part) => total + (part ?? 0), 0)
      : undefined);

  let usedPercent = number(context?.used_percentage) ?? number(payload.used_percentage);
  if (usedPercent === undefined && usedTokens !== undefined && windowTokens && windowTokens > 0) {
    usedPercent = (usedTokens / windowTokens) * 100;
  }
  if (usedPercent !== undefined) usedPercent = clamp(usedPercent, 0, 100);

  if (usedTokens === undefined && windowTokens === undefined && usedPercent === undefined)
    return null;

  const model =
    options.model ??
    (typeof payload.model === "string" ? payload.model : undefined) ??
    string(record(payload.model)?.id) ??
    string(record(payload.model)?.display_name);

  return {
    session_id: options.sessionId,
    adapter: options.adapter,
    model,
    used_tokens: usedTokens,
    window_tokens: windowTokens,
    used_percent: usedPercent === undefined ? undefined : round(usedPercent, 2),
    source: options.source ?? "hook",
    confidence: options.confidence ?? "reported",
    observed_at: options.observedAt ?? new Date().toISOString(),
  };
}

/** Persist a latest context sample. Identical measurements are a no-op. */
export function recordContextSample(
  coordRoot: string,
  instanceId: string,
  sample: ContextSample,
): { state: ContextContinuityState; changed: boolean } {
  const current = readContextState(coordRoot, sample.session_id);
  const state =
    current?.instance_id === instanceId
      ? current
      : {
          ...newState({ sessionId: sample.session_id, instanceId, now: sample.observed_at }),
          generation: current?.generation ?? 0,
        };
  const changed = !sameMeasurement(state.latest_context, sample);
  if (!changed) return { state, changed: false };
  const next: ContextContinuityState = {
    ...state,
    instance_id: instanceId,
    latest_context: sample,
    updated_at: sample.observed_at,
  };
  writeState(coordRoot, next);
  return { state: next, changed: true };
}

/**
 * Snapshot external work state. Repeated PreCompact events reuse the existing
 * checkpoint until a matching recovery completes; manual checkpoints always
 * create a new generation.
 */
export function checkpointContext(
  coordRoot: string,
  input: CheckpointContextInput,
): CheckpointContextResult {
  const now = new Date().toISOString();
  const previous = readContextState(coordRoot, input.sessionId);
  const current =
    previous?.instance_id === input.instanceId
      ? previous
      : {
          ...newState({ sessionId: input.sessionId, instanceId: input.instanceId, now }),
          generation: previous?.generation ?? 0,
        };
  if (input.reason === "pre_compact" && current.phase === "checkpointed") {
    const existing = readLatestCapsule(coordRoot, input.sessionId);
    if (existing && capsuleMatchesState(current, existing, input) && current.latest_capsule) {
      return {
        capsule: existing,
        path: join(coordRoot, ".harnery", current.latest_capsule),
        state: current,
        reused: true,
      };
    }
  }

  const heartbeat = readHeartbeat(coordRoot, input.instanceId);
  const generation = current.generation + 1;
  const capsule: ContinuityCapsule = {
    schema_version: CONTEXT_SCHEMA_VERSION,
    capsule_id: randomUUID(),
    generation,
    created_at: now,
    reason: input.reason,
    session: {
      session_id: input.sessionId,
      instance_id: input.instanceId,
      adapter: input.adapter,
      model: input.model ?? current.latest_context?.model ?? heartbeat?.model,
    },
    context: current.latest_context,
    work: buildWorkSnapshot(heartbeat, input.continuationNote),
    repo: snapshotRepo(input.cwd),
  };

  const relativePath = capsuleRelativePath(input.sessionId, generation);
  const absolutePath = join(coordRoot, ".harnery", relativePath);
  writeBoundedJson(absolutePath, capsule, MAX_CAPSULE_BYTES);
  const next: ContextContinuityState = {
    ...current,
    instance_id: input.instanceId,
    phase: "checkpointed",
    generation,
    latest_capsule: relativePath,
    updated_at: now,
    recovered_at: undefined,
    compaction_completed_at: undefined,
    degraded_reason: undefined,
  };
  writeState(coordRoot, next);
  return { capsule, path: absolutePath, state: next, reused: false };
}

/** Prepare a briefing without claiming that a adapter has accepted it yet. */
export function prepareContextRecovery(
  coordRoot: string,
  input: { sessionId: string; instanceId: string; cwd: string },
): PreparedContextRecovery | null {
  const now = new Date().toISOString();
  const current =
    readContextState(coordRoot, input.sessionId) ??
    newState({ sessionId: input.sessionId, instanceId: input.instanceId, now });
  // A reused provider ID does not transfer the prior task's context.
  if (current.instance_id !== input.instanceId) return null;
  const capsule = readLatestCapsule(coordRoot, input.sessionId);
  if (!capsule || !capsuleMatchesState(current, capsule, input)) {
    const degraded: ContextContinuityState = {
      ...current,
      instance_id: input.instanceId,
      phase: "degraded",
      updated_at: now,
      degraded_reason: capsule
        ? "continuity checkpoint does not match the requesting instance and state"
        : "post-compaction signal arrived without a continuity checkpoint",
    };
    writeState(coordRoot, degraded);
    return null;
  }

  const liveRepo = snapshotRepo(input.cwd);
  const briefing = [
    renderRecoveryBriefing(capsule, liveRepo),
    renderRecoveryInput(coordRoot, input.instanceId),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    state: current,
    capsule,
    briefing,
    checkpoint: Object.freeze({
      session_id: input.sessionId,
      instance_id: input.instanceId,
      generation: capsule.generation,
      capsule_id: capsule.capsule_id,
    }),
  };
}

/** Recovery lists input without surfacing it again or changing its receipts. */
function renderRecoveryInput(coordRoot: string, instanceId: string): string {
  const readCommand = `${resolveBinName(coordRoot)} agents inbox list ${instanceId}`;
  try {
    const records = peerInbox(coordRoot).records(instanceId);
    if (
      records.some(
        (record) =>
          (record.kind !== "message" && record.kind !== "surfaced") ||
          typeof record.message_id !== "string" ||
          Buffer.byteLength(record.message_id) > 128,
      )
    ) {
      throw new Error("inbox input cannot be listed safely");
    }
    const { surfaced } = project(records);
    const messages = records.filter(
      (record): record is HarneryInboxMessageRecordV1 =>
        record.kind === "message" && record.recipient_instance_id === instanceId,
    );
    const pending = messages.filter((message) => !surfaced.has(message.message_id));
    const recent = messages.filter((message) => surfaced.has(message.message_id)).slice(-10);
    if (pending.length === 0 && recent.length === 0) return "";
    const lines = [
      "Coordination input after compaction (surfaced does not mean read):",
      ...pending
        .slice(0, 25)
        .map((message) => inputLine(message.message_id, "pending", message.body)),
      ...recent.map((message) =>
        inputLine(message.message_id, "previously surfaced", message.body),
      ),
    ];
    if (pending.length > 25)
      lines.push(`${pending.length - 25} more pending messages are not listed.`);
    lines.push(
      `Recovery did not acknowledge these messages. Read pending input with \`${readCommand}\`.`,
    );
    return lines.join("\n");
  } catch {
    return `Coordination input could not be read. Check \`${readCommand}\` before continuing.`;
  }
}

function inputLine(messageId: string, status: string, body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  let excerpt = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > MAX_RECOVERY_INPUT_BODY_BYTES) break;
    excerpt += character;
    bytes += size;
  }
  return `- ${messageId} (${status}): ${excerpt}${excerpt.length < text.length ? " [excerpt]" : ""}`;
}

/**
 * Advance continuity only after the adapter accepted the prepared briefing.
 * A foreign or superseded checkpoint refuses without writing, and repeating
 * the same accepted checkpoint is an exact no-op. The write is a
 * compare-and-write: if the state changed after it was read, for example
 * because a newer checkpoint landed, completion refuses instead of
 * overwriting it.
 */
export function completeContextRecovery(
  coordRoot: string,
  input: {
    sessionId: string;
    instanceId: string;
    checkpoint: Readonly<PreparedContextCheckpoint>;
  },
): ContextContinuityState | null {
  const path = statePath(coordRoot, input.sessionId);
  const observed = readText(path);
  if (observed === null) return null;
  const current = parseJson<ContextContinuityState>(observed);
  const { checkpoint } = input;
  if (
    !current ||
    checkpoint.session_id !== input.sessionId ||
    checkpoint.instance_id !== input.instanceId ||
    checkpoint.generation !== current.generation ||
    (current.phase !== "checkpointed" && current.phase !== "recovered")
  )
    return null;
  const capsule = readLatestCapsule(coordRoot, input.sessionId);
  if (
    !capsule ||
    !capsuleMatchesState(current, capsule, input) ||
    capsule.capsule_id !== checkpoint.capsule_id
  )
    return null;
  if (current.phase === "recovered") return current;
  const now = new Date().toISOString();
  const recovered: ContextContinuityState = {
    ...current,
    phase: "recovered",
    updated_at: now,
    recovered_at: now,
    degraded_reason: undefined,
  };
  return writeBoundedJson(path, recovered, MAX_CAPSULE_BYTES, observed) ? recovered : null;
}

/** Record that the adapter, rather than Harnery, reported compaction complete. */
export function markContextCompactionCompleted(
  coordRoot: string,
  input: { sessionId: string; instanceId: string; observedAt?: string },
): ContextContinuityState {
  const now = input.observedAt ?? new Date().toISOString();
  const current =
    readContextState(coordRoot, input.sessionId) ??
    newState({ sessionId: input.sessionId, instanceId: input.instanceId, now });
  if (current.instance_id !== input.instanceId) return current;
  const next: ContextContinuityState = {
    ...current,
    instance_id: input.instanceId,
    phase: current.latest_capsule ? current.phase : "degraded",
    compaction_completed_at: now,
    updated_at: now,
    degraded_reason: current.latest_capsule
      ? current.degraded_reason
      : "post-compaction signal arrived without a continuity checkpoint",
  };
  writeState(coordRoot, next);
  return next;
}

/** Convenience API for callers whose injection is synchronous and guaranteed. */
export function recoverContext(
  coordRoot: string,
  input: { sessionId: string; instanceId: string; cwd: string },
): RecoverContextResult {
  const prepared = prepareContextRecovery(coordRoot, input);
  if (!prepared) {
    const state = readContextState(coordRoot, input.sessionId)!;
    return { state, capsule: null, briefing: "", recovered: false };
  }
  const recovered = completeContextRecovery(coordRoot, {
    sessionId: input.sessionId,
    instanceId: input.instanceId,
    checkpoint: prepared.checkpoint,
  });
  if (!recovered) {
    return {
      state: readContextState(coordRoot, input.sessionId) ?? prepared.state,
      capsule: null,
      briefing: "",
      recovered: false,
    };
  }
  return {
    state: recovered,
    capsule: prepared.capsule,
    briefing: prepared.briefing,
    recovered: true,
  };
}

export function readContextState(
  coordRoot: string,
  sessionId: string,
): ContextContinuityState | null {
  return readJson<ContextContinuityState>(statePath(coordRoot, sessionId));
}

export function readLatestCapsule(coordRoot: string, sessionId: string): ContinuityCapsule | null {
  const state = readContextState(coordRoot, sessionId);
  if (!state?.latest_capsule) return null;
  return readJson<ContinuityCapsule>(join(coordRoot, ".harnery", state.latest_capsule));
}

export function renderRecoveryBriefing(capsule: ContinuityCapsule, liveRepo: RepoSnapshot): string {
  const lines = [
    `[harnery context continuity] Recovered generation ${capsule.generation} after native context compaction.`,
  ];
  if (capsule.work.task) lines.push(`Task: ${capsule.work.task}`);
  if (capsule.work.continuation_note) {
    lines.push(`Continuation note: ${capsule.work.continuation_note}`);
  }
  if (capsule.work.files_held.length > 0) {
    lines.push(`Files held: ${capsule.work.files_held.join(", ")}`);
  }

  const unknown = repoComparisonProblems(capsule.repo, liveRepo, [
    "checkpoint",
    "current repository",
  ]);
  if (unknown.length > 0) {
    lines.push(
      `Repository could not be verified against the checkpoint: ${unknown.join("; ")}. Re-check before editing.`,
    );
    return lines.join("\n");
  }

  const drift: string[] = [];
  if (capsule.repo.branch !== liveRepo.branch) {
    drift.push(`branch changed ${capsule.repo.branch} -> ${liveRepo.branch}`);
  }
  if (capsule.repo.head !== liveRepo.head) {
    drift.push(`HEAD changed ${capsule.repo.head?.slice(0, 8)} -> ${liveRepo.head?.slice(0, 8)}`);
  }
  const beforeDirty = new Set(capsule.repo.dirty_paths);
  const afterDirty = new Set(liveRepo.dirty_paths);
  const added = [...afterDirty].filter((path) => !beforeDirty.has(path));
  const cleared = [...beforeDirty].filter((path) => !afterDirty.has(path));
  if (added.length > 0) drift.push(`new dirty paths: ${added.slice(0, 5).join(", ")}`);
  if (cleared.length > 0) drift.push(`paths no longer dirty: ${cleared.slice(0, 5).join(", ")}`);
  lines.push(
    drift.length > 0
      ? `Repository changed since checkpoint: ${drift.join("; ")}. Re-check before editing.`
      : "Repository state matches the checkpoint.",
  );
  return lines.join("\n");
}

export function snapshotRepo(cwd: string): RepoSnapshot {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok || !root.out.trim()) {
    return {
      cwd: clampString(cwd, 2_000) ?? cwd,
      observation: "unavailable",
      observation_detail: `top-level: ${root.ok ? "empty result" : root.reason}`,
      dirty_paths: [],
    };
  }
  const status = git(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const reads = [
    ["status", status],
    ["branch", branch],
    ["HEAD", head],
  ] as const;
  const details = reads.flatMap(([label, read]) =>
    !read.ok
      ? [`${label}: ${read.reason}`]
      : label !== "status" && !read.out.trim()
        ? [`${label}: empty result`]
        : [],
  );
  const dirty = status.ok
    ? status.out
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
    : [];
  const truncated =
    dirty.length > MAX_SNAPSHOT_PATHS ||
    dirty.some((path) => path.length > MAX_SNAPSHOT_PATH_CHARS);
  if (truncated) details.push("dirty path list is truncated");
  return {
    cwd: clampString(cwd, 2_000) ?? cwd,
    observation: reads.some(([, read]) => !read.ok && read.reason === "timed_out")
      ? "unavailable"
      : details.length > 0
        ? "partial"
        : "ok",
    ...(details.length > 0
      ? {
          observation_detail: clampString(details.join("; "), MAX_OBSERVATION_DETAIL_CHARS),
        }
      : {}),
    root: clampString(root.out.trim(), 2_000),
    branch: branch.ok ? branch.out.trim() || undefined : undefined,
    head: head.ok ? head.out.trim() || undefined : undefined,
    dirty_paths: dirty
      .slice(0, MAX_SNAPSHOT_PATHS)
      .map((path) => path.slice(0, MAX_SNAPSHOT_PATH_CHARS)),
    ...(truncated ? { dirty_paths_truncated: true } : {}),
  };
}

function buildWorkSnapshot(
  heartbeat: HeartbeatSnapshot | null,
  continuationNote: string | undefined,
): ContinuityCapsule["work"] {
  const files = Array.isArray(heartbeat?.files_touched)
    ? heartbeat.files_touched
        .map((path) => clampString(path, MAX_SNAPSHOT_PATH_CHARS) ?? "")
        .filter(Boolean)
    : [];
  return {
    task: clampString(heartbeat?.task, 1_000),
    continuation_note: clampString(continuationNote, 3_000),
    files_held: files.slice(0, MAX_SNAPSHOT_PATHS),
    ...(files.length > MAX_SNAPSHOT_PATHS ? { files_held_truncated: true } : {}),
  };
}

function readHeartbeat(coordRoot: string, instanceId: string): HeartbeatSnapshot | null {
  const row = readLiveCoordinationRow(coordRoot, instanceId);
  if (!row) return null;
  return {
    model: row.model,
    task: row.task,
    files_touched: row.files_touched,
  };
}

function newState(input: {
  sessionId: string;
  instanceId: string;
  now: string;
}): ContextContinuityState {
  return {
    schema_version: CONTEXT_SCHEMA_VERSION,
    session_id: input.sessionId,
    instance_id: input.instanceId,
    phase: "observing",
    generation: 0,
    updated_at: input.now,
  };
}

/** The capsule is the one the state names, written for the requesting task. */
function capsuleMatchesState(
  state: ContextContinuityState,
  capsule: ContinuityCapsule,
  input: { sessionId: string; instanceId: string },
): boolean {
  return (
    state.instance_id === input.instanceId &&
    capsule.session.instance_id === input.instanceId &&
    capsule.generation === state.generation &&
    state.latest_capsule === capsuleRelativePath(input.sessionId, capsule.generation)
  );
}

function writeState(coordRoot: string, state: ContextContinuityState): void {
  writeBoundedJson(statePath(coordRoot, state.session_id), state, MAX_CAPSULE_BYTES);
}

function statePath(coordRoot: string, sessionId: string): string {
  return join(contextDir(coordRoot, sessionId), "state.json");
}

function capsuleRelativePath(sessionId: string, generation: number): string {
  return join(
    "context",
    sessionKey(sessionId),
    "capsules",
    `${String(generation).padStart(6, "0")}.json`,
  );
}

function contextDir(coordRoot: string, sessionId: string): string {
  return join(coordRoot, ".harnery", "context", sessionKey(sessionId));
}

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

/**
 * Atomically replace a record. With `expected`, the replacement happens only
 * while the file still holds exactly those bytes, so a concurrent writer's
 * newer record is never overwritten by a decision made on older state.
 */
function writeBoundedJson(
  path: string,
  value: unknown,
  maxBytes: number,
  expected?: string,
): boolean {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`context continuity record exceeds ${maxBytes} bytes (${bytes})`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(temp, text, { encoding: "utf8", mode: stateFileMode() });
  if (expected !== undefined && readText(path) !== expected) {
    unlinkSync(temp);
    return false;
  }
  renameSync(temp, path);
  return true;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function readJson<T>(path: string): T | null {
  const text = readText(path);
  return text === null ? null : parseJson<T>(text);
}

type GitReadResult =
  | { ok: true; out: string }
  | { ok: false; reason: "not_repository" | "failed" | "timed_out" | "spawn_error" };

function git(cwd: string, args: string[]): GitReadResult {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2_000 });
    if (result.error) {
      return {
        ok: false,
        reason:
          (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
            ? "timed_out"
            : "spawn_error",
      };
    }
    if (result.status === 0) return { ok: true, out: result.stdout.trimEnd() };
    return {
      ok: false,
      reason: /not a git repository/i.test(result.stderr) ? "not_repository" : "failed",
    };
  } catch {
    return { ok: false, reason: "spawn_error" };
  }
}

function sameMeasurement(a: ContextSample | undefined, b: ContextSample): boolean {
  if (!a) return false;
  return (
    a.adapter === b.adapter &&
    a.model === b.model &&
    a.used_tokens === b.used_tokens &&
    a.window_tokens === b.window_tokens &&
    a.used_percent === b.used_percent &&
    a.source === b.source &&
    a.confidence === b.confidence
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? finiteNonNegative(value) : undefined;
}

function finiteNonNegative(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clampString(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : value.slice(0, max);
}
