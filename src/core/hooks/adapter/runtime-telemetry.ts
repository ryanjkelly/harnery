import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { Adapter } from "../../adapter.ts";
import { transcriptPathCandidates } from "../resolve/transcript.ts";

const DEFAULT_TAIL_BYTES = 256 * 1024;
const DEFAULT_MAX_SAMPLE_AGE_MS = 30_000;
const SESSION_CACHE_LIMIT = 128;

export type RuntimeContextTelemetry =
  | {
      state: "observed";
      used_tokens: number;
      limit_tokens: number;
      measured_at: string;
      method: "codex_transcript_token_count";
      source_event: string;
      source_witness: string;
      runtime_version?: string;
      bytes_read: number;
      io_duration_ms: number;
    }
  | {
      state: "partial";
      reason: RuntimeContextMissingReason;
      used_tokens?: number;
      measured_at?: string;
      bytes_read: number;
      io_duration_ms: number;
    }
  | {
      state: "unsupported";
      reason: RuntimeContextUnsupportedReason;
      bytes_read: 0;
      io_duration_ms: number;
    };

export type RuntimeContextMissingReason =
  | "codex_transcript_ambiguous"
  | "codex_transcript_session_mismatch"
  | "codex_transcript_unreadable"
  | "codex_transcript_turn_not_found"
  | "codex_transcript_turn_not_terminal"
  | "codex_transcript_token_count_missing"
  | "codex_transcript_sample_stale"
  | "context_used_tokens_not_reported"
  | "context_limit_tokens_not_reported"
  | "context_limit_tokens_invalid"
  | "claude_context_limit_tokens_not_reported"
  | "claude_transcript_session_mismatch"
  | "claude_transcript_turn_not_found"
  | "claude_transcript_unreadable";

export type RuntimeContextUnsupportedReason =
  | "runtime_context_telemetry_unavailable"
  | "runtime_session_id_not_reported"
  | "runtime_turn_id_not_reported"
  | "runtime_adapter_not_supported";

export interface RuntimeContextRequest {
  adapter: Adapter;
  session_id?: string;
  turn_id?: string;
  transcript_path?: string;
  /** Status callers may request the newest session sample without claiming turn attribution. */
  mode: "turn" | "status";
}

export interface RuntimeTelemetryOptions {
  codexRoots?: string[];
  maxTailBytes?: number;
  maxSampleAgeMs?: number;
}

interface TailRead {
  text: string;
  bytes: number;
}

interface ParsedRuntimeRow {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  uuid?: string;
  parent_uuid?: string;
  prompt_id?: string;
  session_id?: string;
  /** CC stamps the effective effort level at the row's top level. */
  effort?: string;
  payload?: Record<string, unknown>;
}

interface CodexTokenSample {
  used_tokens?: number;
  limit_tokens?: number;
  measured_at?: string;
  ordinal?: number;
}

const codexTranscriptCache = new Map<string, string>();

/**
 * Read privacy-safe context telemetry from a local runtime transcript.
 *
 * The returned union contains only numeric measurements, timestamps, bounded
 * I/O counters, and a privacy-safe witness. Transcript bodies and paths never
 * cross this interface.
 */
export function readRuntimeContextTelemetry(
  request: RuntimeContextRequest,
  options: RuntimeTelemetryOptions = {},
): RuntimeContextTelemetry {
  const startedAt = performance.now();
  if (!request.session_id) return unsupported("runtime_session_id_not_reported", startedAt);
  if (request.mode === "turn" && !request.turn_id) {
    return unsupported("runtime_turn_id_not_reported", startedAt);
  }
  if (request.adapter === "codex") return readCodexContext(request, options, startedAt);
  if (request.adapter === "claude-code") return readClaudeContext(request, options, startedAt);
  return unsupported("runtime_adapter_not_supported", startedAt);
}

/**
 * Locate a Codex rollout transcript for a session when the hook payload
 * carries no transcript_path. Codex omits the path on its hook events, which
 * leaves transcript-backed evidence unavailable unless Harnery resolves the
 * rollout itself. Discovery reuses the telemetry scanner's roots (native
 * ~/.codex plus WSL-mounted Windows homes) and its process cache, and returns
 * undefined on zero or ambiguous matches.
 *
 * Callers on repeated hook paths must retain the verified result in their
 * owner-only session state. The process cache bounds repeated reads inside one
 * process, but hook processes are intentionally short-lived.
 */
export function discoverCodexSessionTranscript(
  sessionId: string | undefined,
  transcriptPath?: string,
  options: RuntimeTelemetryOptions = {},
): string | undefined {
  if (!sessionId || !/^[0-9a-f][0-9a-f-]{14,62}[0-9a-f]$/i.test(sessionId)) return undefined;
  const resolution = resolveCodexTranscript(
    { adapter: "codex", session_id: sessionId, transcript_path: transcriptPath, mode: "status" },
    options,
  );
  return resolution.state === "found" ? resolution.path : undefined;
}

/** Status compatibility wrapper: exact pairs render; partial values do not. */
export function readRuntimeContextUsage(
  adapter: Adapter,
  sessionId: string,
  options: RuntimeTelemetryOptions = {},
): { used: number; window: number } | null {
  const result = readRuntimeContextTelemetry(
    { adapter, session_id: sessionId, mode: "status" },
    options,
  );
  return result.state === "observed"
    ? { used: result.used_tokens, window: result.limit_tokens }
    : null;
}

export function clearRuntimeTelemetryCachesForTest(): void {
  codexTranscriptCache.clear();
}

export type RuntimeTuningMissingReason =
  | "codex_transcript_ambiguous"
  | "codex_transcript_session_mismatch"
  | "codex_transcript_unreadable"
  | "codex_transcript_turn_context_missing"
  | "claude_transcript_unreadable"
  | "claude_transcript_assistant_row_missing";

/**
 * Privacy-safe tuning identity read from a local runtime transcript.
 *
 * `observed` means the newest identity-bearing row was read: a Codex
 * `turn_context` row or a CC assistant row with a real model id. An observed
 * result with NO `effort` is itself evidence — CC omits the field exactly when
 * the model has no effort dial — so callers must distinguish it from
 * `partial`/`unsupported`, where nothing was established.
 */
export type RuntimeTuningTelemetry =
  | {
      state: "observed";
      model?: string;
      effort?: string;
      speed?: string;
      measured_at?: string;
      method: "codex_transcript_turn_context" | "claude_transcript_assistant_row";
      source_event: string;
      bytes_read: number;
      io_duration_ms: number;
    }
  | {
      state: "partial";
      reason: RuntimeTuningMissingReason;
      bytes_read: number;
      io_duration_ms: number;
    }
  | {
      state: "unsupported";
      reason: RuntimeContextUnsupportedReason;
      bytes_read: 0;
      io_duration_ms: number;
    };

export interface RuntimeTuningRequest {
  adapter: Adapter;
  session_id?: string;
  transcript_path?: string;
}

/**
 * Read the newest observed tuning (effort, and speed where reported) for a
 * session from its local runtime transcript.
 *
 * Codex: the newest `turn_context` row carries the EFFECTIVE per-turn effort,
 * including `-c model_reasoning_effort` overrides (the config default is
 * deliberately not consulted — it is the default, not the effective value).
 * CC: the newest assistant row carries effort at the row's top level and
 * speed inside `message.usage`; model, effort, and speed are read from the
 * SAME row so a mid-session model swap cannot blend two rows' values.
 *
 * Same bounded tail-read and privacy posture as `readRuntimeContextTelemetry`:
 * only tokens, timestamps, and I/O counters cross this interface.
 */
export function readRuntimeTuning(
  request: RuntimeTuningRequest,
  options: RuntimeTelemetryOptions = {},
): RuntimeTuningTelemetry {
  const startedAt = performance.now();
  if (request.adapter === "codex") {
    if (!request.session_id) return unsupported("runtime_session_id_not_reported", startedAt);
    return readCodexTuning(request, options, startedAt);
  }
  if (request.adapter === "claude-code") return readClaudeTuning(request, options, startedAt);
  return unsupported("runtime_adapter_not_supported", startedAt);
}

function readCodexTuning(
  request: RuntimeTuningRequest,
  options: RuntimeTelemetryOptions,
  startedAt: number,
): RuntimeTuningTelemetry {
  const resolved = resolveCodexTranscript(
    {
      adapter: "codex",
      session_id: request.session_id,
      transcript_path: request.transcript_path,
      mode: "status",
    },
    options,
  );
  if (resolved.state === "missing") {
    return unsupported("runtime_context_telemetry_unavailable", startedAt);
  }
  if (resolved.state === "ambiguous") {
    return tuningPartial("codex_transcript_ambiguous", 0, startedAt);
  }
  if (resolved.state === "mismatch") {
    return tuningPartial("codex_transcript_session_mismatch", 0, startedAt);
  }
  const tail = readTail(resolved.path, options.maxTailBytes ?? DEFAULT_TAIL_BYTES);
  if (!tail) return tuningPartial("codex_transcript_unreadable", 0, startedAt);
  const fromTail = newestTurnContextTuning(parseRuntimeRows(tail.text), tail.bytes, startedAt);
  if (fromTail) return fromTail;
  // `turn_context` is written at the START of a turn, so one long turn pushes
  // it past the bounded tail. The front of the file is then the reliable
  // place, but not a fixed-size head: a real interactive rollout opens with
  // hundreds of KB of session_meta, instruction, and world_state rows before
  // the first turn_context (observed live: 272KB in a desktop session). Scan
  // forward in bounded chunks and keep the LAST match inside the cap; rows
  // between the cap and the tail window stay unscanned, and the stop-time
  // re-read heals any staleness that gap could cause.
  const forward = scanForwardTurnContext(resolved.path, TUNING_FORWARD_SCAN_MAX_BYTES);
  if (forward.row) {
    const fromForward = newestTurnContextTuning(
      [forward.row],
      tail.bytes + forward.bytes,
      startedAt,
    );
    if (fromForward) return fromForward;
  }
  return tuningPartial(
    "codex_transcript_turn_context_missing",
    tail.bytes + forward.bytes,
    startedAt,
  );
}

/** Forward-scan budget for the first turn_context; generous against
 * instruction/world_state bloat while still bounding a runaway file. */
const TUNING_FORWARD_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const TUNING_FORWARD_CHUNK_BYTES = 256 * 1024;

/** Stream the file from the start in bounded chunks, returning the last
 * parseable `turn_context` row inside the budget and the bytes read. */
function scanForwardTurnContext(
  path: string,
  maxBytes: number,
): { row?: ParsedRuntimeRow; bytes: number } {
  let fd: number | undefined;
  let bytesRead = 0;
  let remainder = "";
  let match: ParsedRuntimeRow | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(TUNING_FORWARD_CHUNK_BYTES);
    while (bytesRead < maxBytes) {
      const read = readSync(fd, buffer, 0, buffer.length, bytesRead);
      if (read <= 0) break;
      bytesRead += read;
      const text = remainder + buffer.subarray(0, read).toString("utf8");
      const lines = text.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"turn_context"')) continue;
        const rows = parseRuntimeRows(line);
        const row = rows.find((candidate) => candidate.type === "turn_context");
        if (row) match = row;
      }
      if (read < buffer.length) break;
    }
    return { row: match, bytes: bytesRead };
  } catch {
    return { row: match, bytes: bytesRead };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function newestTurnContextTuning(
  rows: ParsedRuntimeRow[],
  bytesRead: number,
  startedAt: number,
): RuntimeTuningTelemetry | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.type !== "turn_context") continue;
    const effort = row.payload?.effort;
    const model = row.payload?.model;
    if (typeof effort !== "string" || effort.length === 0) continue;
    return {
      state: "observed",
      effort,
      ...(typeof model === "string" && model.length > 0 ? { model } : {}),
      ...(row.timestamp ? { measured_at: row.timestamp } : {}),
      method: "codex_transcript_turn_context",
      source_event: "codex.rollout_turn_context",
      bytes_read: bytesRead,
      io_duration_ms: elapsed(startedAt),
    };
  }
  return undefined;
}

function readClaudeTuning(
  request: RuntimeTuningRequest,
  options: RuntimeTelemetryOptions,
  startedAt: number,
): RuntimeTuningTelemetry {
  const readablePath = transcriptPathCandidates(request.transcript_path).find((candidate) =>
    existsSync(candidate),
  );
  if (!readablePath) return unsupported("runtime_context_telemetry_unavailable", startedAt);
  const tail = readTail(readablePath, options.maxTailBytes ?? DEFAULT_TAIL_BYTES);
  if (!tail) return tuningPartial("claude_transcript_unreadable", 0, startedAt);
  const rows = parseRuntimeRows(tail.text);
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.type !== "assistant") continue;
    const model = row.payload?.model;
    if (typeof model !== "string" || model.length === 0 || model.startsWith("<")) continue;
    const usage = objectValue(row.payload?.usage);
    const speed = usage?.speed;
    return {
      state: "observed",
      model,
      ...(row.effort ? { effort: row.effort } : {}),
      ...(typeof speed === "string" && speed.length > 0 ? { speed } : {}),
      ...(row.timestamp ? { measured_at: row.timestamp } : {}),
      method: "claude_transcript_assistant_row",
      source_event: "claude-code.transcript_assistant_row",
      bytes_read: tail.bytes,
      io_duration_ms: elapsed(startedAt),
    };
  }
  return tuningPartial("claude_transcript_assistant_row_missing", tail.bytes, startedAt);
}

function tuningPartial(
  reason: RuntimeTuningMissingReason,
  bytesRead: number,
  startedAt: number,
): RuntimeTuningTelemetry {
  return {
    state: "partial",
    reason,
    bytes_read: bytesRead,
    io_duration_ms: elapsed(startedAt),
  };
}

function readCodexContext(
  request: RuntimeContextRequest,
  options: RuntimeTelemetryOptions,
  startedAt: number,
): RuntimeContextTelemetry {
  const resolved = resolveCodexTranscript(request, options);
  if (resolved.state === "missing") {
    return unsupported("runtime_context_telemetry_unavailable", startedAt);
  }
  if (resolved.state === "ambiguous") {
    return partial("codex_transcript_ambiguous", 0, startedAt);
  }
  if (resolved.state === "mismatch") {
    return partial("codex_transcript_session_mismatch", 0, startedAt);
  }

  const tail = readTail(resolved.path, options.maxTailBytes ?? DEFAULT_TAIL_BYTES);
  if (!tail) return partial("codex_transcript_unreadable", 0, startedAt);
  const rows = parseRuntimeRows(tail.text);
  if (request.mode === "status") {
    const token = newestCodexToken(rows);
    return codexObservation(request, token, undefined, tail.bytes, options, startedAt);
  }

  const turnId = request.turn_id!;
  const terminalIndex = findCodexTurnTerminal(rows, turnId);
  if (terminalIndex < 0) {
    const sawStart = rows.some(
      (row) =>
        row.type === "event_msg" &&
        row.payload?.type === "task_started" &&
        row.payload.turn_id === turnId,
    );
    return partial(
      sawStart ? "codex_transcript_turn_not_terminal" : "codex_transcript_turn_not_found",
      tail.bytes,
      startedAt,
    );
  }

  const terminal = rows[terminalIndex]!;
  const token = tokenBeforeTerminal(rows, terminalIndex);
  return codexObservation(request, token, terminal, tail.bytes, options, startedAt);
}

function codexObservation(
  request: RuntimeContextRequest,
  token: CodexTokenSample | undefined,
  terminal: ParsedRuntimeRow | undefined,
  bytesRead: number,
  options: RuntimeTelemetryOptions,
  startedAt: number,
): RuntimeContextTelemetry {
  if (!token) return partial("codex_transcript_token_count_missing", bytesRead, startedAt);
  if (token.used_tokens === undefined) {
    return partial("context_used_tokens_not_reported", bytesRead, startedAt);
  }
  if (token.limit_tokens === undefined) {
    return partial("context_limit_tokens_not_reported", bytesRead, startedAt, token);
  }
  if (token.limit_tokens <= 0) {
    return partial("context_limit_tokens_invalid", bytesRead, startedAt, token);
  }
  if (!token.measured_at || !Number.isFinite(Date.parse(token.measured_at))) {
    return partial("codex_transcript_token_count_missing", bytesRead, startedAt);
  }
  if (terminal?.timestamp) {
    const age = Date.parse(terminal.timestamp) - Date.parse(token.measured_at);
    if (age < 0 || age > (options.maxSampleAgeMs ?? DEFAULT_MAX_SAMPLE_AGE_MS)) {
      return partial("codex_transcript_sample_stale", bytesRead, startedAt, token);
    }
  }
  const witness = [
    request.session_id,
    request.turn_id ?? "status",
    token.ordinal ?? "unknown",
    token.measured_at,
    token.used_tokens,
    token.limit_tokens,
  ].join("\0");
  return {
    state: "observed",
    used_tokens: token.used_tokens,
    limit_tokens: token.limit_tokens,
    measured_at: token.measured_at,
    method: "codex_transcript_token_count",
    source_event: "codex.rollout_token_count",
    source_witness: createHash("sha256").update(witness).digest("hex"),
    bytes_read: bytesRead,
    io_duration_ms: elapsed(startedAt),
  };
}

function readClaudeContext(
  request: RuntimeContextRequest,
  options: RuntimeTelemetryOptions,
  startedAt: number,
): RuntimeContextTelemetry {
  const readablePath = transcriptPathCandidates(request.transcript_path).find((candidate) =>
    existsSync(candidate),
  );
  if (!readablePath) return unsupported("runtime_context_telemetry_unavailable", startedAt);
  const tail = readTail(readablePath, options.maxTailBytes ?? DEFAULT_TAIL_BYTES);
  if (!tail) return partial("claude_transcript_unreadable", 0, startedAt);
  const rows = parseRuntimeRows(tail.text);
  const sessionRows = rows.filter(
    (row) => row.session_id === undefined || row.session_id === request.session_id,
  );
  if (rows.some((row) => row.session_id !== undefined) && sessionRows.length === 0) {
    return partial("claude_transcript_session_mismatch", tail.bytes, startedAt);
  }
  const candidateRows =
    request.mode === "turn"
      ? claudeAssistantRowsForTurn(sessionRows, request.turn_id!)
      : sessionRows.filter((row) => row.type === "assistant");
  if (request.mode === "turn" && candidateRows.length === 0) {
    return partial("claude_transcript_turn_not_found", tail.bytes, startedAt);
  }
  for (let index = candidateRows.length - 1; index >= 0; index--) {
    const row = candidateRows[index]!;
    if (row.type !== "assistant") continue;
    const message = row.payload;
    const usage = objectValue(message?.usage);
    if (!usage) continue;
    const used = sumNumbers(
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
    );
    if (used === undefined) {
      return partial("context_used_tokens_not_reported", tail.bytes, startedAt);
    }
    return partial("claude_context_limit_tokens_not_reported", tail.bytes, startedAt, {
      used_tokens: used,
      measured_at: row.timestamp,
    });
  }
  return partial("context_used_tokens_not_reported", tail.bytes, startedAt);
}

/** Join assistant rows to the native CC prompt id through the transcript's
 * parent UUID chain. No UUID or prompt value crosses the reader boundary. */
function claudeAssistantRowsForTurn(rows: ParsedRuntimeRow[], turnId: string): ParsedRuntimeRow[] {
  const byUuid = new Map(rows.filter((row) => row.uuid).map((row) => [row.uuid!, row] as const));
  return rows.filter((row) => {
    if (row.type !== "assistant") return false;
    let parentUuid = row.parent_uuid;
    const seen = new Set<string>();
    for (let depth = 0; parentUuid && depth < 64 && !seen.has(parentUuid); depth += 1) {
      seen.add(parentUuid);
      const parent = byUuid.get(parentUuid);
      if (!parent) return false;
      if (parent.type === "user" && parent.prompt_id) return parent.prompt_id === turnId;
      parentUuid = parent.parent_uuid;
    }
    return false;
  });
}

function newestCodexToken(rows: ParsedRuntimeRow[]): CodexTokenSample | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const token = codexToken(rows[index]!);
    if (token) return token;
  }
  return undefined;
}

function tokenBeforeTerminal(
  rows: ParsedRuntimeRow[],
  terminalIndex: number,
): CodexTokenSample | undefined {
  for (let index = terminalIndex - 1; index >= 0; index--) {
    const row = rows[index]!;
    const type = row.payload?.type;
    if (type === "task_started" || type === "task_complete") break;
    const token = codexToken(row);
    if (token) return token;
  }
  return undefined;
}

function codexToken(row: ParsedRuntimeRow): CodexTokenSample | undefined {
  if (row.type !== "event_msg" || row.payload?.type !== "token_count") return undefined;
  const info = objectValue(row.payload.info);
  const usage = objectValue(info?.last_token_usage);
  return {
    used_tokens: safeInteger(usage?.input_tokens),
    limit_tokens: safeInteger(info?.model_context_window),
    measured_at: timestamp(row.timestamp),
    ordinal: safeInteger(row.ordinal),
  };
}

function findCodexTurnTerminal(rows: ParsedRuntimeRow[], turnId: string): number {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (
      row.type === "event_msg" &&
      row.payload?.type === "task_complete" &&
      row.payload.turn_id === turnId
    ) {
      return index;
    }
  }
  return -1;
}

function parseRuntimeRows(text: string): ParsedRuntimeRow[] {
  const rows: ParsedRuntimeRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      const row = objectValue(value);
      if (!row) continue;
      rows.push({
        timestamp: timestamp(row.timestamp),
        ordinal: safeInteger(row.ordinal),
        type: typeof row.type === "string" ? row.type : undefined,
        uuid: stringValue(row.uuid),
        parent_uuid: stringValue(row.parentUuid),
        prompt_id: stringValue(row.promptId) ?? stringValue(row.prompt_id),
        session_id: stringValue(row.sessionId) ?? stringValue(row.session_id),
        ...(typeof row.effort === "string" && row.effort.length > 0 ? { effort: row.effort } : {}),
        payload: objectValue(row.payload) ?? objectValue(row.message) ?? undefined,
      });
    } catch {
      // The first line may be cut by the bounded tail or a writer may be mid-flush.
    }
  }
  return rows;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readTail(path: string, maxBytes: number): TailRead | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const bytes = Math.max(0, Math.min(size, Math.max(1, Math.floor(maxBytes))));
    const start = size - bytes;
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, start);
    const text = buffer.subarray(0, read).toString("utf8");
    return {
      text: start > 0 ? text.slice(Math.max(0, text.indexOf("\n") + 1)) : text,
      bytes: read,
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type TranscriptResolution =
  | { state: "found"; path: string }
  | { state: "missing" }
  | { state: "ambiguous" }
  | { state: "mismatch" };

function resolveCodexTranscript(
  request: RuntimeContextRequest,
  options: RuntimeTelemetryOptions,
): TranscriptResolution {
  const sessionId = request.session_id!;
  const cached = codexTranscriptCache.get(sessionId);
  if (cached && existsSync(cached)) return { state: "found", path: cached };

  const supplied = transcriptPathCandidates(request.transcript_path).filter((candidate) =>
    existsSync(candidate),
  );
  const verifiedSupplied = supplied.filter((candidate) => transcriptMatches(candidate, sessionId));
  if (verifiedSupplied.length === 1) return cacheTranscript(sessionId, verifiedSupplied[0]!);
  if (verifiedSupplied.length > 1) return { state: "ambiguous" };
  if (supplied.length > 0) return { state: "mismatch" };

  const matches = codexRoots(options)
    .flatMap((root) => findTranscriptMatches(root, sessionId))
    .filter((path, index, values) => values.indexOf(path) === index);
  if (matches.length === 1) return cacheTranscript(sessionId, matches[0]!);
  if (matches.length > 1) return { state: "ambiguous" };
  return { state: "missing" };
}

function cacheTranscript(sessionId: string, path: string): TranscriptResolution {
  codexTranscriptCache.delete(sessionId);
  codexTranscriptCache.set(sessionId, path);
  while (codexTranscriptCache.size > SESSION_CACHE_LIMIT) {
    codexTranscriptCache.delete(codexTranscriptCache.keys().next().value!);
  }
  return { state: "found", path };
}

function codexRoots(options: RuntimeTelemetryOptions): string[] {
  if (options.codexRoots) return options.codexRoots;
  const roots = [resolve(homedir(), ".codex", "sessions")];
  try {
    if (existsSync("/mnt/c/Users")) {
      for (const user of readdirSync("/mnt/c/Users")) {
        roots.push(`/mnt/c/Users/${user}/.codex/sessions`);
      }
    }
  } catch {
    // Non-WSL hosts do not expose this mount.
  }
  return roots;
}

function findTranscriptMatches(root: string, sessionId: string): string[] {
  if (!existsSync(root)) return [];
  const matches: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > 4) continue;
    let names: string[];
    try {
      names = readdirSync(current.path);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(current.path, name);
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) stack.push({ path, depth: current.depth + 1 });
        else if (transcriptMatches(path, sessionId)) matches.push(path);
      } catch {
        // A concurrently removed partition is simply unavailable.
      }
    }
  }
  return matches;
}

function transcriptMatches(path: string, sessionId: string): boolean {
  return basename(path).endsWith(`-${sessionId}.jsonl`);
}

/** Narrow return: this exact shape is a member of both telemetry unions. */
function unsupported(
  reason: RuntimeContextUnsupportedReason,
  startedAt: number,
): {
  state: "unsupported";
  reason: RuntimeContextUnsupportedReason;
  bytes_read: 0;
  io_duration_ms: number;
} {
  return { state: "unsupported", reason, bytes_read: 0, io_duration_ms: elapsed(startedAt) };
}

function partial(
  reason: RuntimeContextMissingReason,
  bytesRead: number,
  startedAt: number,
  sample?: Pick<CodexTokenSample, "used_tokens" | "measured_at">,
): RuntimeContextTelemetry {
  return {
    state: "partial",
    reason,
    ...(sample?.used_tokens !== undefined ? { used_tokens: sample.used_tokens } : {}),
    ...(sample?.measured_at ? { measured_at: sample.measured_at } : {}),
    bytes_read: bytesRead,
    io_duration_ms: elapsed(startedAt),
  };
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function sumNumbers(...values: unknown[]): number | undefined {
  const numbers = values.map(safeInteger);
  return numbers.some((value) => value !== undefined)
    ? numbers.reduce<number>((total, value) => total + (value ?? 0), 0)
    : undefined;
}
