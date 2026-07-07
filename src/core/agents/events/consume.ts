/**
 * Incremental consumer for the canonical event stream at
 * `.harnery/events.ndjson`.
 *
 * A small `.harnery/.events-cursor` file persists the last-projected event_id;
 * subsequent runs skip everything up to and including that id and return only
 * the new tail.
 *
 * Read strategy: the global cursor is advanced on every agent's turn.stop, so
 * it almost always sits within the last few KB of the stream. We exploit that
 * with a bounded **tail read** (reading only the last `tailBytes` of the file
 * and locating the cursor there) which turns an O(file-size) read into
 * O(window). If the cursor is older than the window (a long-idle system, or a
 * cursor that's been rotated out) we fall back to a wider read that is itself
 * capped (`fallbackCapBytes`): the stream is an append-only ledger that grows
 * without bound, so a whole-file `readFileSync` throws V8's max-string-length
 * error ("Cannot create a string longer than 0x1fffffe8 characters") once it
 * passes ~512MB, which would abort the projection. Events older than the cap are
 * stale for coord-state purposes, so a bounded replay is the correct fallback.
 *
 * Idempotency: projectors are idempotent by `event_id`. The
 * cursor file makes this cheap (we never replay an already-projected event by
 * accident) and the projector tolerates the rare full-replay (cursor rotated
 * out) without double-applying.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { coordEnv } from "../../../lib/env.ts";

const STREAM_REL = ".harnery/events.ndjson";
const CURSOR_REL = ".harnery/.events-cursor";
const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024; // 2 MiB, thousands of events of headroom
/** Cap for the fall-through read when the cursor misses the tail window. Well
 * under V8's ~512MB max string length so it never throws on the unbounded
 * ledger; comfortably larger than any realistic cursor drift (the global cursor
 * advances on every agent's turn.stop, so it sits near EOF in practice). */
const DEFAULT_FALLBACK_CAP_BYTES = 64 * 1024 * 1024; // 64 MiB

export interface CanonicalEvent {
  schema_version: number;
  event_id: string;
  event_type: string;
  ts: string;
  instance_id: string;
  session_id: string;
  parent_session_id?: string;
  turn_id?: string;
  parent_turn_id?: string;
  harness: string;
  source: string;
  data: Record<string, unknown>;
}

export interface ConsumeResult {
  events: CanonicalEvent[];
  /** event_id of the last event the caller successfully projected. */
  lastEventId: string | null;
  /** Total bytes in the stream file at read time (for diagnostics). */
  streamBytes: number;
}

export interface ConsumeOpts {
  /** Ignore the cursor and return everything, useful for backfill. */
  replayAll?: boolean;
  /**
   * Tail-window size in bytes for the fast-path read. Defaults to
   * `HARNERY_AGENT_COORD_TAIL_BYTES` env or 2 MiB. Mainly a test seam; production
   * callers should leave it unset.
   */
  tailBytes?: number;
  /**
   * Cap in bytes for the fall-through read (cursor missed the tail window).
   * Defaults to `HARNERY_AGENT_COORD_FALLBACK_CAP_BYTES` env or 64 MiB. Bounds
   * the read so the unbounded ledger can never overflow V8's max string length.
   * Mainly a test seam; production callers should leave it unset.
   */
  fallbackCapBytes?: number;
}

/**
 * Read all events after the persisted cursor, in chronological (file) order.
 */
export function consumeSince(coordRoot: string, opts: ConsumeOpts = {}): ConsumeResult {
  const streamPath = join(coordRoot, STREAM_REL);
  if (!existsSync(streamPath)) {
    return { events: [], lastEventId: null, streamBytes: 0 };
  }

  const cursor = opts.replayAll ? null : readCursor(coordRoot);
  const fileSize = statSync(streamPath).size;
  const windowBytes = resolveTailBytes(opts.tailBytes);

  // Tail fast-path: a cursor exists and the file is larger than the window.
  // Read only the trailing window, drop the (likely partial) first line, and
  // look for the cursor. A hit returns just the new events without ever
  // touching the bulk of the file.
  if (cursor !== null && fileSize > windowBytes) {
    const tail = readTailUtf8(streamPath, fileSize, windowBytes);
    const firstNl = tail.indexOf("\n");
    const usable = firstNl >= 0 ? tail.slice(firstNl + 1) : "";
    const parsed = eventsAfterCursor(parseLines(usable), cursor);
    if (parsed.foundCursor) {
      return {
        events: parsed.events,
        lastEventId: parsed.events.at(-1)?.event_id ?? cursor,
        streamBytes: fileSize,
      };
    }
    // Cursor older than the tail window → fall through to a full read.
  }

  // Bounded fall-through: first run, replayAll, small file, or cursor not found
  // in the tail. This must NEVER read the whole file: the stream grows without
  // bound and a >512MB readFileSync throws V8's max-string-length error, which
  // would abort the projection. Read at most `cap` bytes from the tail; when we
  // start mid-file, drop the (likely partial) first line.
  const cap = resolveFallbackCap(opts.fallbackCapBytes);
  const readBytes = Math.min(fileSize, cap);
  let text = readTailUtf8(streamPath, fileSize, readBytes);
  if (readBytes < fileSize) {
    const firstNl = text.indexOf("\n");
    text = firstNl >= 0 ? text.slice(firstNl + 1) : "";
  }
  const all = parseLines(text);
  const parsed = eventsAfterCursor(all, cursor);
  if (parsed.foundCursor) {
    return {
      events: parsed.events,
      lastEventId: parsed.events.at(-1)?.event_id ?? cursor,
      streamBytes: fileSize,
    };
  }

  // The cursor names an event older than the capped window (or rotated out), so
  // replay what the window holds (safer than silent state drift; the projector
  // is idempotent by event_id). lastEventId null keeps the cursor put.
  return { events: all, lastEventId: null, streamBytes: fileSize };
}

function resolveFallbackCap(override?: number): number {
  if (override !== undefined && override > 0) return override;
  const env = coordEnv("AGENT_COORD_FALLBACK_CAP_BYTES");
  const n = env ? Number(env) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FALLBACK_CAP_BYTES;
}

function resolveTailBytes(override?: number): number {
  if (override !== undefined && override > 0) return override;
  const env = coordEnv("AGENT_COORD_TAIL_BYTES");
  const n = env ? Number(env) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TAIL_BYTES;
}

/** Read the trailing `windowBytes` of a file as UTF-8 without loading the rest. */
function readTailUtf8(streamPath: string, fileSize: number, windowBytes: number): string {
  const start = Math.max(0, fileSize - windowBytes);
  const len = fileSize - start;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(streamPath, "r");
  try {
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

function parseLines(raw: string): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CanonicalEvent);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * Events strictly after `cursor` (or all events when `cursor` is null). When a
 * non-null cursor isn't present in `all`, returns `foundCursor: false` so the
 * caller can decide between a wider read and a full replay.
 */
function eventsAfterCursor(
  all: CanonicalEvent[],
  cursor: string | null,
): { events: CanonicalEvent[]; foundCursor: boolean } {
  if (cursor === null) return { events: all, foundCursor: true };
  const idx = all.findIndex((e) => e.event_id === cursor);
  if (idx < 0) return { events: [], foundCursor: false };
  return { events: all.slice(idx + 1), foundCursor: true };
}

export function readCursor(coordRoot: string): string | null {
  const path = join(coordRoot, CURSOR_REL);
  if (!existsSync(path)) return null;
  try {
    const v = readFileSync(path, "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeCursor(coordRoot: string, eventId: string): void {
  const path = join(coordRoot, CURSOR_REL);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, eventId, "utf8");
  } catch {
    /* swallow; next run replays */
  }
}
