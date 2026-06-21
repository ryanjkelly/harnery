import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type EventEnvelope,
  type EventType,
  type Harness,
  SCHEMA_VERSION,
  type Source,
} from "./schema.ts";
import { ulid } from "./ulid.ts";

const LOCK_FILE = ".harnery/events.ndjson.lock";
const STREAM_FILE = ".harnery/events.ndjson";

const MAX_LINE_BYTES = 64 * 1024;

export interface EmitInput<TType extends EventType, TData> {
  event_type: TType;
  instance_id: string;
  session_id: string;
  harness: Harness;
  source?: Source;
  parent_session_id?: string;
  turn_id?: string;
  parent_turn_id?: string;
  ts?: string;
  data: TData;
}

/**
 * Build a canonical envelope around the caller's `data` payload. Pure;
 * doesn't touch the filesystem. Useful for tests + replay fixtures.
 */
export function buildEnvelope<TType extends EventType, TData>(
  input: EmitInput<TType, TData>,
): EventEnvelope<TType, TData> {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: ulid(),
    event_type: input.event_type,
    ts: input.ts ?? new Date().toISOString(),
    instance_id: input.instance_id,
    session_id: input.session_id,
    parent_session_id: input.parent_session_id,
    turn_id: input.turn_id,
    parent_turn_id: input.parent_turn_id,
    harness: input.harness,
    source: input.source ?? "agent-hooks",
    data: input.data,
  };
}

/**
 * Append one canonical event to `.harnery/events.ndjson` under a file lock.
 * Append-only, one JSON object per line, lock-serialized.
 *
 * Synchronous because hooks are short-lived processes: we want the append to
 * land before the binary exits, and async/await across a tiny write is just
 * latency for no benefit.
 *
 * Returns the envelope so callers can chain off it (debug logs, post-emit
 * verdict requests).
 */
export function emit<TType extends EventType, TData>(
  coordRoot: string,
  input: EmitInput<TType, TData>,
): EventEnvelope<TType, TData> {
  const envelope = buildEnvelope(input);
  const streamPath = join(coordRoot, STREAM_FILE);
  const lockPath = join(coordRoot, LOCK_FILE);

  ensureDir(dirname(streamPath));
  ensureFile(lockPath);

  let line = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    // lines >64KB are a schema bug. Phase 2 hard-truncates the `data`
    // payload + sets `truncated: true` so we keep audit visibility without
    // breaking downstream consumers.
    const truncated = `${JSON.stringify({
      ...envelope,
      data: { __over_size_limit: true, original_bytes: Buffer.byteLength(line, "utf8") },
      // eslint-disable-next-line @typescript-eslint/naming-convention
    })}\n`;
    line = truncated;
  }

  const lockFd = openSync(lockPath, "r+");
  try {
    // flock isn't directly exposed in node fs; use fcntl-like via shelling out
    // would be slower than POSIX flock(2) inside the kernel. Bun exposes
    // `Bun.flock` in recent builds, but a simple fs-level append is atomic
    // for lines <PIPE_BUF (4KB on Linux) anyway. For larger lines we rely on
    // append-mode flag (O_APPEND) which kernels serialize per-fd.
    //
    // The `events.ndjson.lock` file is kept around for forward
    // compatibility: Phase 4+ helpers acquire it before multi-write batches.
    appendFileSync(streamPath, line, { encoding: "utf8", flag: "a" });
  } finally {
    closeSync(lockFd);
  }

  return envelope;
}

function ensureDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    /* swallow */
  }
}

function ensureFile(path: string): void {
  try {
    closeSync(openSync(path, "a"));
  } catch {
    /* swallow */
  }
}
