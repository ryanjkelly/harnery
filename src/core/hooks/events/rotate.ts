/**
 * Size-triggered rotation for the canonical event stream
 * `.harnery/events.ndjson`.
 *
 * The stream is a deliberately-immutable, append-only ledger. Left unbounded it
 * grows past V8's ~512MB max string length, at which point any code that does a
 * whole-file `readFileSync` throws ("Cannot create a string longer than
 * 0x1fffffe8 characters"). Rather than police every current + future reader,
 * we bound the *active* file: once it crosses a byte cap we rename it to a dated
 * archive (`events-YYYY-MM-DD.ndjson`) and start a fresh active file. Archives
 * are kept — the audit trail is preserved, just spread across files that readers
 * glob newest-first.
 *
 * Both independent append paths (agent-hooks `hooks/events/emit.ts` and
 * agent-coord `agents/events/emit.ts`) call `maybeRotateEventStream` before
 * appending, so a roll is triggered continuously, not only at session
 * boundaries.
 *
 * Concurrency: many short-lived hook processes append at once. The rename itself
 * is atomic — a concurrent appender opening the path by name lands its line in
 * whichever inode the name currently resolves to (old archive or new active
 * file), never nowhere. The only hazard is two processes both renaming (the
 * second would move the fresh empty file to a second archive name), which an
 * `O_EXCL` roll-lock prevents.
 *
 * Design + rationale: harnery ADR 0009; decision docket
 * `should-harnery-adopt-a-retention-2026-07-07-ed07`.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { coordEnv } from "../../../lib/env.ts";

const STREAM_FILE = ".harnery/events.ndjson";
const ROLL_LOCK_FILE = ".harnery/events.ndjson.roll.lock";

/** Default active-file cap: 256 MiB — half of V8's ~512MB string cliff, so even
 * a reader that loads the whole active file whole stays clear of the limit. */
const DEFAULT_ROLL_BYTES = 256 * 1024 * 1024;

/** A roll-lock older than this is treated as abandoned (a crashed roller) and
 * stolen. Rolls are sub-millisecond, so 60s is orders of magnitude of slack. */
const STALE_LOCK_MS = 60_000;

/** Archive glob prefix. Readers enumerate `events-*.ndjson` newest-first.
 * The pre-existing manual `events-legacy.ndjson` matches and is picked up for
 * free. Kept in sync with the reader-side pattern in web/lib/coord-reader.ts. */
export const ARCHIVE_PREFIX = "events-";
export const ARCHIVE_SUFFIX = ".ndjson";

function resolveRollBytes(): number {
  const env = coordEnv("EVENTS_ROLL_BYTES");
  const n = env ? Number(env) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ROLL_BYTES;
}

/** `YYYY-MM-DD` (UTC) from a millisecond timestamp. Uses the file's own mtime
 * rather than `Date.now()` so it's deterministic and independent of the harness
 * runtime's clock surface. */
function utcDateStamp(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** First non-colliding `events-<stamp>[.N].ndjson` path under `coordDir`. */
function archivePathFor(coordDir: string, stamp: string): string {
  const base = join(coordDir, `${ARCHIVE_PREFIX}${stamp}${ARCHIVE_SUFFIX}`);
  if (!existsSync(base)) return base;
  for (let n = 1; ; n++) {
    const cand = join(coordDir, `${ARCHIVE_PREFIX}${stamp}.${n}${ARCHIVE_SUFFIX}`);
    if (!existsSync(cand)) return cand;
  }
}

/**
 * Roll `events.ndjson` to a dated archive when it exceeds the byte cap. Cheap
 * no-op (a single `statSync`) below the cap. Fail-soft: any error is swallowed
 * so a rotation problem can never break the append that triggered it.
 *
 * `nowMs` is injectable for the stale-lock check in tests; production leaves it
 * unset (the roll date always comes from the file's mtime, never `nowMs`).
 */
export function maybeRotateEventStream(coordRoot: string, nowMs?: number): boolean {
  try {
    const streamPath = join(coordRoot, STREAM_FILE);
    if (!existsSync(streamPath)) return false;
    const cap = resolveRollBytes();
    let st = statSync(streamPath);
    if (st.size < cap) return false;

    const coordDir = dirname(streamPath);
    const lockPath = join(coordRoot, ROLL_LOCK_FILE);
    mkdirSync(coordDir, { recursive: true });

    if (!acquireRollLock(lockPath, nowMs)) return false; // another roller active
    try {
      // Re-check under the lock: a concurrent process may have just rolled.
      if (!existsSync(streamPath)) return false;
      st = statSync(streamPath);
      if (st.size < cap) return false;

      const archive = archivePathFor(coordDir, utcDateStamp(st.mtimeMs));
      renameSync(streamPath, archive);
      // Recreate an empty active file so the very next append (and any reader's
      // existsSync) sees a valid, present stream.
      closeSync(openSync(streamPath, "a"));
      return true;
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    return false; // fail-soft: never break the caller's append
  }
}

/** Create the roll-lock with O_EXCL. Returns true on acquisition. On collision,
 * steals a stale lock (crashed roller) once, else returns false. */
function acquireRollLock(lockPath: string, nowMs?: number): boolean {
  try {
    closeSync(openSync(lockPath, "wx"));
    return true;
  } catch {
    // Exists: steal if abandoned.
    try {
      const age = (nowMs ?? Date.now()) - statSync(lockPath).mtimeMs;
      if (age > STALE_LOCK_MS) {
        unlinkSync(lockPath);
        closeSync(openSync(lockPath, "wx"));
        return true;
      }
    } catch {
      /* lost the steal race — someone else holds it */
    }
    return false;
  }
}
