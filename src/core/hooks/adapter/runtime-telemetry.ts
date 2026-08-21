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
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
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
        payload: objectValue(row.payload) ?? objectValue(row.message) ?? undefined,
      });
    } catch {
      // The first line may be cut by the bounded tail or a writer may be mid-flush.
    }
  }
  return rows;
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

  // Turn hooks are latency-sensitive and current Codex Stop payloads provide
  // transcript_path. Discovery is reserved for status and explicit fixtures;
  // a missing path must not trigger a recursive home scan in the hot path.
  if (request.mode === "turn" && options.codexRoots === undefined) {
    return { state: "missing" };
  }

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

function unsupported(
  reason: RuntimeContextUnsupportedReason,
  startedAt: number,
): RuntimeContextTelemetry {
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
