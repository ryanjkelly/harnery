/**
 * Context continuity: durable, structured state around native harness
 * compaction. Harnery does not decide when a harness compacts. It records
 * context telemetry when the harness exposes it, checkpoints external work
 * state before compaction, and renders a verified recovery briefing after it.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Harness } from "../hooks/events/schema.ts";

export const CONTEXT_SCHEMA_VERSION = 1 as const;
export const MAX_CAPSULE_BYTES = 32 * 1024;
const MAX_SNAPSHOT_PATHS = 15;
const MAX_SNAPSHOT_PATH_CHARS = 500;

export type ContextSampleSource = "hook" | "native_event" | "result" | "transcript" | "estimate";
export type ContextSampleConfidence = "exact" | "reported" | "estimated";
export type ContextPhase = "observing" | "checkpointed" | "recovered" | "degraded";
export type CheckpointReason = "manual" | "pressure" | "pre_compact" | "session_end";

export interface ContextSample {
  session_id: string;
  harness: Harness;
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

export interface RepoSnapshot {
  cwd: string;
  root?: string;
  branch?: string;
  head?: string;
  dirty_paths: string[];
  dirty_paths_truncated?: boolean;
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
    harness: Harness;
    model?: string;
  };
  context?: ContextSample;
  work: {
    task?: string;
    turn_summary?: string;
    continuation_note?: string;
    files_held: string[];
    files_held_truncated?: boolean;
    last_tool?: string;
    last_tool_target?: string;
  };
  repo: RepoSnapshot;
}

export interface ExtractContextSampleOptions {
  sessionId: string;
  harness: Harness;
  model?: string;
  source?: ContextSampleSource;
  confidence?: ContextSampleConfidence;
  observedAt?: string;
}

export interface CheckpointContextInput {
  sessionId: string;
  instanceId: string;
  harness: Harness;
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

export interface PreparedContextRecovery {
  state: ContextContinuityState;
  capsule: ContinuityCapsule;
  briefing: string;
}

interface HeartbeatSnapshot {
  model?: string;
  task?: string;
  turn_summary?: string;
  files_touched?: string[];
  last_tool?: string;
  last_tool_target?: string;
}

/** Parse the context-window shapes exposed by current harness hook/status data. */
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
    harness: options.harness,
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
    current ?? newState({ sessionId: sample.session_id, instanceId, now: sample.observed_at });
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
  const current =
    readContextState(coordRoot, input.sessionId) ??
    newState({ sessionId: input.sessionId, instanceId: input.instanceId, now });
  if (input.reason === "pre_compact" && current.phase === "checkpointed") {
    const existing = readLatestCapsule(coordRoot, input.sessionId);
    if (existing && current.latest_capsule) {
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
      harness: input.harness,
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

/** Prepare a briefing without claiming that a harness has accepted it yet. */
export function prepareContextRecovery(
  coordRoot: string,
  input: { sessionId: string; instanceId: string; cwd: string },
): PreparedContextRecovery | null {
  const now = new Date().toISOString();
  const current =
    readContextState(coordRoot, input.sessionId) ??
    newState({ sessionId: input.sessionId, instanceId: input.instanceId, now });
  const capsule = readLatestCapsule(coordRoot, input.sessionId);
  if (!capsule) {
    const degraded: ContextContinuityState = {
      ...current,
      instance_id: input.instanceId,
      phase: "degraded",
      updated_at: now,
      degraded_reason: "post-compaction signal arrived without a continuity checkpoint",
    };
    writeState(coordRoot, degraded);
    return null;
  }

  const liveRepo = snapshotRepo(input.cwd);
  const briefing = renderRecoveryBriefing(capsule, liveRepo);
  return { state: current, capsule, briefing };
}

/** Advance continuity only after the harness context channel accepted the briefing. */
export function completeContextRecovery(
  coordRoot: string,
  input: { sessionId: string; instanceId: string },
): ContextContinuityState {
  const now = new Date().toISOString();
  const current =
    readContextState(coordRoot, input.sessionId) ??
    newState({ sessionId: input.sessionId, instanceId: input.instanceId, now });
  const recovered: ContextContinuityState = {
    ...current,
    instance_id: input.instanceId,
    phase: "recovered",
    updated_at: now,
    recovered_at: now,
    degraded_reason: undefined,
  };
  writeState(coordRoot, recovered);
  return recovered;
}

/** Record that the harness, rather than Harnery, reported compaction complete. */
export function markContextCompactionCompleted(
  coordRoot: string,
  input: { sessionId: string; instanceId: string; observedAt?: string },
): ContextContinuityState {
  const now = input.observedAt ?? new Date().toISOString();
  const current =
    readContextState(coordRoot, input.sessionId) ??
    newState({ sessionId: input.sessionId, instanceId: input.instanceId, now });
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
  const recovered = completeContextRecovery(coordRoot, input);
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
  if (capsule.work.turn_summary) lines.push(`Last progress: ${capsule.work.turn_summary}`);
  if (capsule.work.continuation_note) {
    lines.push(`Continuation note: ${capsule.work.continuation_note}`);
  }
  if (capsule.work.files_held.length > 0) {
    lines.push(`Files held: ${capsule.work.files_held.join(", ")}`);
  }
  if (capsule.work.last_tool) {
    lines.push(
      `Last tool: ${capsule.work.last_tool}${capsule.work.last_tool_target ? ` (${capsule.work.last_tool_target})` : ""}`,
    );
  }

  const drift: string[] = [];
  if (capsule.repo.branch && liveRepo.branch && capsule.repo.branch !== liveRepo.branch) {
    drift.push(`branch changed ${capsule.repo.branch} -> ${liveRepo.branch}`);
  }
  if (capsule.repo.head && liveRepo.head && capsule.repo.head !== liveRepo.head) {
    drift.push(`HEAD changed ${capsule.repo.head.slice(0, 8)} -> ${liveRepo.head.slice(0, 8)}`);
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
  if (!root) return { cwd, dirty_paths: [] };
  const status = git(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const dirty = status
    ? status
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => clampString(line.slice(3).trim(), MAX_SNAPSHOT_PATH_CHARS) ?? "")
        .filter(Boolean)
    : [];
  return {
    cwd: clampString(cwd, 2_000) ?? cwd,
    root: clampString(root, 2_000),
    branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head: git(cwd, ["rev-parse", "HEAD"]),
    dirty_paths: dirty.slice(0, MAX_SNAPSHOT_PATHS),
    ...(dirty.length > MAX_SNAPSHOT_PATHS ? { dirty_paths_truncated: true } : {}),
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
    turn_summary: clampString(heartbeat?.turn_summary, 3_000),
    continuation_note: clampString(continuationNote, 3_000),
    files_held: files.slice(0, MAX_SNAPSHOT_PATHS),
    ...(files.length > MAX_SNAPSHOT_PATHS ? { files_held_truncated: true } : {}),
    last_tool: clampString(heartbeat?.last_tool, 200),
    last_tool_target: clampString(heartbeat?.last_tool_target, 1_000),
  };
}

function readHeartbeat(coordRoot: string, instanceId: string): HeartbeatSnapshot | null {
  return readJson<HeartbeatSnapshot>(join(coordRoot, ".harnery", "active", `${instanceId}.json`));
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

function writeBoundedJson(path: string, value: unknown, maxBytes: number): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`context continuity record exceeds ${maxBytes} bytes (${bytes})`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2_000 });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function sameMeasurement(a: ContextSample | undefined, b: ContextSample): boolean {
  if (!a) return false;
  return (
    a.harness === b.harness &&
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
