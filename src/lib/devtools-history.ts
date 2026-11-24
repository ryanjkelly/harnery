import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * `devtools` usage history (ADR 0273, amendment 2026-11-23): a small local log
 * of quota readings, so the report can show how fast each limit is being used
 * *recently* rather than only the average since the window opened.
 *
 * One JSON sample per line at `<home>/.cache/harnery/devtools/history.jsonl`.
 * Only live reads are recorded, and a key (account + window) gets a new line
 * only when its value changed or ten minutes passed. Samples older than 35
 * days are pruned when the file is rewritten (about once a day, or when it
 * grows past 2 MB).
 *
 * Pure toolkit tier: depends only on `node:*`, never on `src/core/`.
 */

/** One recorded reading of one limit. */
export interface UsageSample {
  /** ms epoch the reading was taken. */
  t: number;
  /** Account id (the report's `AccountUsage.id`). */
  account: string;
  /** Quota window label, or `cursor:total` / `cursor:api` / `cursor:auto`. */
  window: string;
  /** Percent used, 0-100. */
  used: number;
  /** ISO reset time of the window the reading belongs to, else null. */
  resetsAt: string | null;
}

/** Recent burn rate of one limit, from the history log. */
export interface RecentRate {
  /** Percentage points used per hour over the recent span, or null when too little history. */
  ratePerHour: number | null;
  /** How far back the rate looks (ms). */
  lookbackMs: number;
  /** ms epoch of the first point used. */
  sinceMs: number;
  /** Up to 24 `[t, used]` points in the current window, oldest first. */
  points: Array<[number, number]>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A key gets a fresh sample at least this often even when its value is unchanged. */
const RESAMPLE_MS = 10 * MINUTE;
const KEEP_MS = 35 * DAY;
/** Rewrite (prune) once the oldest sample is this old, which is about once a day. */
const PRUNE_AFTER_MS = KEEP_MS + DAY;
const MAX_BYTES = 2 * 1024 * 1024;
const TRIM_TO_BYTES = 1.5 * 1024 * 1024;
/** Two readings of the same window can report a reset time a little apart. */
const RESET_TOLERANCE_MS = 2 * MINUTE;
const MAX_POINTS = 24;

/** Path of the history log for a home directory. */
export function historyPath(home: string): string {
  return join(home, ".cache", "harnery", "devtools", "history.jsonl");
}

/** Read every well-formed sample, oldest first. Missing or unreadable file → []. */
export function readHistory(home: string): UsageSample[] {
  let text: string;
  try {
    text = readFileSync(historyPath(home), "utf8");
  } catch {
    return [];
  }
  const out: UsageSample[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as Partial<UsageSample>;
      if (
        typeof s.t === "number" &&
        typeof s.account === "string" &&
        typeof s.window === "string" &&
        typeof s.used === "number"
      ) {
        out.push({
          t: s.t,
          account: s.account,
          window: s.window,
          used: s.used,
          resetsAt: typeof s.resetsAt === "string" ? s.resetsAt : null,
        });
      }
    } catch {
      // torn or corrupt line: skip
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

const keyOf = (s: { account: string; window: string }) => `${s.account}\u0000${s.window}`;

/**
 * Append the candidates that add information (value changed, or ten minutes
 * since that key's last sample) and prune when due. Returns the full history
 * after the write, oldest first, for computing recent rates without a re-read.
 * Best-effort: a write failure still returns the in-memory history.
 */
export function recordSamples(home: string, candidates: UsageSample[], now: number): UsageSample[] {
  const file = historyPath(home);
  const all = readHistory(home);
  const last = new Map<string, UsageSample>();
  for (const s of all) last.set(keyOf(s), s);

  const added: UsageSample[] = [];
  for (const c of candidates) {
    if (!Number.isFinite(c.used)) continue;
    const prev = last.get(keyOf(c));
    if (prev && prev.used === c.used && c.t - prev.t < RESAMPLE_MS) continue;
    added.push(c);
    last.set(keyOf(c), c);
  }
  const merged = added.length ? [...all, ...added].sort((a, b) => a.t - b.t) : all;

  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    // no file yet
  }
  const oldest = merged[0]?.t;
  const dueToAge = oldest != null && now - oldest > PRUNE_AFTER_MS;
  const dueToSize = size > MAX_BYTES;
  try {
    if (dueToAge || dueToSize) {
      let kept = merged.filter((s) => now - s.t <= KEEP_MS);
      let lines = kept.map((s) => JSON.stringify(s));
      let bytes = lines.reduce((n, l) => n + l.length + 1, 0);
      let drop = 0;
      while (bytes > TRIM_TO_BYTES && drop < lines.length) {
        bytes -= (lines[drop] as string).length + 1;
        drop++;
      }
      if (drop) {
        kept = kept.slice(drop);
        lines = lines.slice(drop);
      }
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, lines.length ? `${lines.join("\n")}\n` : "");
      renameSync(tmp, file);
      return kept;
    }
    if (added.length) {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${added.map((s) => JSON.stringify(s)).join("\n")}\n`);
    }
  } catch {
    // history is best-effort
  }
  return merged;
}

/** Window length from a quota label: "5h", "45m", "3d", "weekly…" (7 days), "monthly…" (30 days). */
export function windowDurationMs(label: string): number | null {
  const m = /^(\d+)\s*(m|h|d)$/.exec(label.trim());
  if (m) return Number(m[1]) * (m[2] === "m" ? MINUTE : m[2] === "h" ? HOUR : DAY);
  if (/^weekly/i.test(label)) return 7 * DAY;
  if (/^monthly/i.test(label)) return 30 * DAY;
  return null;
}

/**
 * How far back a window's recent rate looks: 90 minutes for a 5-hour window,
 * a day for a weekly one, three days for a monthly or billing-cycle one, and
 * otherwise a quarter of the window (a day when its length is unknown).
 */
export function lookbackFor(window: string, durationMs: number | null): number {
  if (durationMs === 5 * HOUR) return 90 * MINUTE;
  if (durationMs === 7 * DAY) return DAY;
  if (window.startsWith("cursor:") || (durationMs != null && durationMs >= 28 * DAY))
    return 3 * DAY;
  if (durationMs != null && durationMs > 0) return Math.round(durationMs / 4);
  return DAY;
}

/**
 * The recent burn rate of one limit: its samples in the current window over
 * the lookback, restarting after any drop (a reset grant clears usage without
 * moving the reset time). The rate needs at least two points spanning a fifth
 * of the lookback; otherwise it is null and the points still draw a trend.
 * Returns null when there are no points at all.
 */
export function recentFor(
  samples: readonly UsageSample[],
  key: { account: string; window: string },
  current: { resetsAt: string | null; durationMs: number | null; now: number },
): RecentRate | null {
  const lookbackMs = lookbackFor(key.window, current.durationMs);
  const from = current.now - lookbackMs;
  const curReset = current.resetsAt ? Date.parse(current.resetsAt) : Number.NaN;
  const hasReset = Number.isFinite(curReset);
  const prevReset = hasReset && current.durationMs ? curReset - current.durationMs : null;
  const inWindow = (s: UsageSample): boolean => {
    if (!hasReset) return true;
    const sr = s.resetsAt ? Date.parse(s.resetsAt) : Number.NaN;
    if (Number.isFinite(sr) && Math.abs(sr - curReset) <= RESET_TOLERANCE_MS) return true;
    return prevReset != null && s.t > prevReset;
  };
  let pts = samples
    .filter(
      (s) =>
        s.account === key.account &&
        s.window === key.window &&
        s.t >= from &&
        s.t <= current.now + MINUTE &&
        inWindow(s),
    )
    .sort((a, b) => a.t - b.t);
  // Usage only falls inside one window when a reset was applied: start after it.
  for (let i = pts.length - 1; i > 0; i--) {
    if ((pts[i] as UsageSample).used < (pts[i - 1] as UsageSample).used - 0.5) {
      pts = pts.slice(i);
      break;
    }
  }
  if (!pts.length) return null;
  const first = pts[0] as UsageSample;
  const lastPt = pts[pts.length - 1] as UsageSample;
  const span = lastPt.t - first.t;
  const ratePerHour =
    pts.length >= 2 && span > 0 && span >= 0.2 * lookbackMs
      ? Math.round(((lastPt.used - first.used) / (span / HOUR)) * 100) / 100
      : null;
  return { ratePerHour, lookbackMs, sinceMs: first.t, points: downsample(pts) };
}

/** Evenly thin points to at most 24, always keeping the first and last. */
function downsample(pts: UsageSample[]): Array<[number, number]> {
  const n = pts.length;
  if (n <= MAX_POINTS) return pts.map((s) => [s.t, s.used]);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < MAX_POINTS; i++) {
    const s = pts[Math.round((i * (n - 1)) / (MAX_POINTS - 1))] as UsageSample;
    out.push([s.t, s.used]);
  }
  return out;
}
