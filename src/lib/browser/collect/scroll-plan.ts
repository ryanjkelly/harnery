/**
 * Seeded randomness and the human-like scroll schedule for `browse --collect`.
 *
 * Everything here is pure: given a seed and a pacing policy, the plan for each
 * step (wheel notches, pauses, reading pauses, small scroll-backs) is fully
 * reproducible, which is what the unit tests rely on.
 */

/** A random source returning floats in [0, 1). */
export type Rng = () => number;

/** mulberry32: a small, fast, well-distributed 32-bit seeded generator. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh 32-bit seed for runs that did not pass one. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

export interface Range {
  min: number;
  max: number;
}

export function uniform(rng: Rng, range: Range): number {
  return range.min + (range.max - range.min) * rng();
}

export interface ScrollPacing {
  /** Scroll distance per step, as a fraction of the viewport height. */
  step: Range;
  /** Pause after each step, in ms. */
  pauseMs: Range;
  /** Probability that a step is followed by a longer reading pause instead. */
  readChance: number;
  /** Reading pause, in ms. */
  readPauseMs: Range;
  /** Probability that a step starts with a small scroll back up. */
  backChance: number;
  /** Scroll-back distance, as a fraction of the viewport height. */
  back: Range;
  /** Size of one wheel notch, in px. */
  tickPx: Range;
  /** Gap between wheel notches, in ms. */
  tickGapMs: Range;
}

export const DEFAULT_SCROLL_PACING: ScrollPacing = {
  step: { min: 0.6, max: 1.1 },
  pauseMs: { min: 1_200, max: 3_500 },
  readChance: 0.12,
  readPauseMs: { min: 4_000, max: 9_000 },
  backChance: 0.08,
  back: { min: 0.1, max: 0.3 },
  tickPx: { min: 80, max: 140 },
  tickGapMs: { min: 12, max: 45 },
};

/** Upper bounds that keep every pause and step bounded. */
export const PACING_LIMITS = {
  maxStepFraction: 3,
  maxPauseMs: 120_000,
} as const;

export interface WheelTick {
  /** Positive scrolls down, negative scrolls up. */
  deltaY: number;
  /** Wait after this notch, in ms. */
  gapMs: number;
}

export interface ScrollStepPlan {
  /** Optional scroll-back notches run before the main step (negative deltas). */
  back: WheelTick[];
  /** Pause after the scroll-back, in ms (0 when there is no scroll-back). */
  backPauseMs: number;
  /** Main downward notches. */
  ticks: WheelTick[];
  /** Total downward distance, in px. */
  deltaY: number;
  /** Pause after the main step, in ms. */
  pauseMs: number;
  /** True when the pause is a longer reading pause. */
  reading: boolean;
}

/** Split a distance into wheel notches the way a mouse wheel reports them. */
export function wheelTicks(rng: Rng, pacing: ScrollPacing, distance: number): WheelTick[] {
  const sign = distance < 0 ? -1 : 1;
  let remaining = Math.round(Math.abs(distance));
  const ticks: WheelTick[] = [];
  while (remaining > 0) {
    const size = Math.min(remaining, Math.max(1, Math.round(uniform(rng, pacing.tickPx))));
    remaining -= size;
    ticks.push({ deltaY: sign * size, gapMs: Math.round(uniform(rng, pacing.tickGapMs)) });
  }
  return ticks;
}

export function planScrollStep(
  rng: Rng,
  pacing: ScrollPacing,
  viewportHeight: number,
): ScrollStepPlan {
  const height = Math.max(1, viewportHeight);
  let back: WheelTick[] = [];
  let backPauseMs = 0;
  if (rng() < pacing.backChance) {
    back = wheelTicks(rng, pacing, -uniform(rng, pacing.back) * height);
    backPauseMs = Math.round(uniform(rng, { min: 400, max: 1_100 }));
  }
  const deltaY = Math.max(1, Math.round(uniform(rng, pacing.step) * height));
  const ticks = wheelTicks(rng, pacing, deltaY);
  const reading = rng() < pacing.readChance;
  const pauseMs = Math.round(uniform(rng, reading ? pacing.readPauseMs : pacing.pauseMs));
  return { back, backPauseMs, ticks, deltaY, pauseMs, reading };
}

/**
 * Parse `min-max` (or a single value meaning min = max). Throws a message that
 * names the flag when the value is malformed or out of bounds.
 */
export function parseRange(raw: string, flag: string, bounds: { min: number; max: number }): Range {
  const text = raw.trim();
  const m = /^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/.exec(text);
  if (!m) throw new Error(`${flag} must be <min>-<max> or a single number (got "${raw}").`);
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : Number(m[2]);
  if (min > max) throw new Error(`${flag}: min (${min}) must not exceed max (${max}).`);
  if (min < bounds.min || max > bounds.max) {
    throw new Error(`${flag} must stay within ${bounds.min}-${bounds.max} (got "${raw}").`);
  }
  return { min, max };
}

export function parseProbability(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${flag} must be a number from 0 to 1 (got "${raw}").`);
  }
  return n;
}

/**
 * Machine-wide pacing defaults from the environment, in the same style as the
 * page-load pace gate (`HARNERY_PACE_*`):
 *
 * - `HARNERY_COLLECT_PAUSE_MS`: pause after each step, `min-max` in ms.
 * - `HARNERY_COLLECT_STEP`: step size as a viewport fraction, `min-max`.
 *
 * Command flags override these.
 */
export function scrollPacingFromEnv(env: NodeJS.ProcessEnv = process.env): ScrollPacing {
  const pacing: ScrollPacing = { ...DEFAULT_SCROLL_PACING };
  const pause = env.HARNERY_COLLECT_PAUSE_MS?.trim();
  if (pause) {
    pacing.pauseMs = parseRange(pause, "HARNERY_COLLECT_PAUSE_MS", {
      min: 0,
      max: PACING_LIMITS.maxPauseMs,
    });
  }
  const step = env.HARNERY_COLLECT_STEP?.trim();
  if (step) {
    pacing.step = parseRange(step, "HARNERY_COLLECT_STEP", {
      min: 0.05,
      max: PACING_LIMITS.maxStepFraction,
    });
  }
  return pacing;
}
