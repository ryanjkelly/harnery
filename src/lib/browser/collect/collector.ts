import {
  planScrollStep,
  type Rng,
  type ScrollPacing,
  type ScrollStepPlan,
  uniform,
  type WheelTick,
} from "./scroll-plan.ts";

/** One item as read from the page in a single harvest. */
export interface HarvestedItem {
  key: string;
  fields: Record<string, unknown>;
}

export interface CollectedItem {
  key: string;
  /** Step index the item was first seen at (0 is the initial harvest). */
  firstSeenStep: number;
  [field: string]: unknown;
}

export interface PageMetrics {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  atBottom: boolean;
}

/** What the collector needs from a page. The Playwright driver implements it. */
export interface CollectDriver {
  harvest(): Promise<HarvestedItem[]>;
  metrics(): Promise<PageMetrics>;
  /** Scroll by these wheel notches. Returns true when a non-wheel fallback was used. */
  wheel(ticks: WheelTick[]): Promise<boolean>;
  /** Click up to `limit` unexpanded "show more" buttons; returns how many were clicked. */
  expand(limit: number): Promise<number>;
  /** A short reason when the page shows a login wall or rate limit, else null. */
  blocked(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface CollectLimits {
  /** Stop once this many unique items are collected (null: no item cap). */
  maxItems: number | null;
  /** Stop after this many scroll steps. */
  maxScrolls: number;
  /** Stop once this much wall time has passed, in ms. */
  maxMs: number;
  /** Stop after this many consecutive steps with no new items and no page growth. */
  idleSteps: number;
  /** Expand clicks per step (0 disables expansion). */
  expandPerStep: number;
  /** Expand clicks per run. */
  expandTotal: number;
}

export const DEFAULT_COLLECT_LIMITS: CollectLimits = {
  maxItems: null,
  maxScrolls: 60,
  maxMs: 300_000,
  idleSteps: 5,
  expandPerStep: 0,
  expandTotal: 50,
};

export type StopReason =
  | "max-items"
  | "max-scrolls"
  | "time-budget"
  | "idle"
  | "end-of-feed"
  | "blocked"
  | "interrupted";

export interface CollectStats {
  /** Scroll steps taken (the initial harvest is step 0 and not counted). */
  steps: number;
  harvests: number;
  items: number;
  /** Sightings of an already-collected key across all harvests. */
  duplicates: number;
  expanded: number;
  readingPauses: number;
  scrollBacks: number;
  /** Steps where wheel scrolling did not move the page and a fallback ran. */
  scrollFallbacks: number;
  elapsedMs: number;
  stopReason: StopReason;
  stopDetail: string | null;
}

export interface CollectResult {
  items: CollectedItem[];
  stats: CollectStats;
}

export interface CollectRunOptions {
  limits: CollectLimits;
  pacing: ScrollPacing;
  rng: Rng;
  /** Polled between and during pauses; true stops the run with "interrupted". */
  shouldStop?: () => boolean;
  onStep?: (info: { step: number; items: number; added: number; plan: ScrollStepPlan }) => void;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Ordered, de-duplicated item store. The first sighting fixes an item's
 * position and step; later sightings only fill in what was missing: empty
 * fields, longer text (an expanded "show more"), and new array members.
 */
export class ItemStore {
  private byKey = new Map<string, CollectedItem>();
  duplicates = 0;

  get size(): number {
    return this.byKey.size;
  }

  add(items: HarvestedItem[], step: number, maxItems: number | null = null): number {
    let added = 0;
    for (const item of items) {
      if (!item.key) continue;
      const existing = this.byKey.get(item.key);
      if (existing) {
        this.duplicates++;
        mergeFields(existing, item.fields);
        continue;
      }
      if (maxItems !== null && this.byKey.size >= maxItems) continue;
      this.byKey.set(item.key, { key: item.key, firstSeenStep: step, ...item.fields });
      added++;
    }
    return added;
  }

  items(): CollectedItem[] {
    return [...this.byKey.values()];
  }
}

function mergeFields(target: CollectedItem, fields: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(fields)) {
    const current = target[name];
    if (isEmpty(value)) continue;
    if (isEmpty(current)) {
      target[name] = value;
    } else if (typeof current === "string" && typeof value === "string") {
      if (value.length > current.length) target[name] = value;
    } else if (Array.isArray(current) && Array.isArray(value)) {
      const merged = [...current];
      for (const v of value) if (!merged.includes(v)) merged.push(v);
      target[name] = merged;
    }
  }
}

/**
 * Scroll a feed like a reader and collect every item that passes through the
 * DOM. Each step harvests right after scrolling and again after the pause, so
 * a virtualized list cannot drop an item between two harvests.
 */
export async function runCollect(
  driver: CollectDriver,
  options: CollectRunOptions,
): Promise<CollectResult> {
  const { limits, pacing, rng } = options;
  const store = new ItemStore();
  const started = driver.now();
  const stats: CollectStats = {
    steps: 0,
    harvests: 0,
    items: 0,
    duplicates: 0,
    expanded: 0,
    readingPauses: 0,
    scrollBacks: 0,
    scrollFallbacks: 0,
    elapsedMs: 0,
    stopReason: "idle",
    stopDetail: null,
  };
  const elapsed = () => driver.now() - started;
  const interrupted = () => options.shouldStop?.() === true;
  const full = () => limits.maxItems !== null && store.size >= limits.maxItems;

  const harvest = async (step: number): Promise<number> => {
    stats.harvests++;
    return store.add(await driver.harvest(), step, limits.maxItems);
  };

  /** Sleep in slices so an interrupt or the time budget cuts a pause short. */
  const pause = async (ms: number) => {
    let remaining = Math.min(ms, Math.max(0, limits.maxMs - elapsed()));
    while (remaining > 0 && !interrupted()) {
      const slice = Math.min(remaining, 250);
      await driver.sleep(slice);
      remaining -= slice;
    }
  };

  const expand = async (step: number): Promise<number> => {
    if (limits.expandPerStep <= 0) return 0;
    const budget = Math.min(limits.expandPerStep, limits.expandTotal - stats.expanded);
    if (budget <= 0) return 0;
    const clicked = await driver.expand(budget);
    stats.expanded += clicked;
    return clicked > 0 ? harvest(step) : 0;
  };

  const stop = (reason: StopReason, detail: string | null = null) => {
    stats.stopReason = reason;
    stats.stopDetail = detail;
  };

  await harvest(0);
  await expand(0);
  let idle = 0;
  let before = await driver.metrics();

  for (;;) {
    if (interrupted()) {
      stop("interrupted");
      break;
    }
    if (full()) {
      stop("max-items", `collected ${store.size} items`);
      break;
    }
    if (stats.steps >= limits.maxScrolls) {
      stop("max-scrolls", `took ${stats.steps} scroll steps`);
      break;
    }
    if (elapsed() >= limits.maxMs) {
      stop("time-budget", `ran ${Math.round(elapsed() / 1000)} s`);
      break;
    }

    const step = ++stats.steps;
    const plan = planScrollStep(rng, pacing, before.viewportHeight);
    let added = 0;
    if (plan.back.length > 0) {
      stats.scrollBacks++;
      await driver.wheel(plan.back);
      added += await harvest(step);
      await pause(plan.backPauseMs);
    }
    if (await driver.wheel(plan.ticks)) stats.scrollFallbacks++;
    added += await harvest(step);
    if (plan.reading) stats.readingPauses++;
    // Split the pause so items rendered mid-pause are harvested too.
    const firstHalf = Math.round(plan.pauseMs * uniform(rng, { min: 0.35, max: 0.65 }));
    await pause(firstHalf);
    added += await harvest(step);
    added += await expand(step);
    await pause(plan.pauseMs - firstHalf);
    added += await harvest(step);

    const after = await driver.metrics();
    options.onStep?.({ step, items: store.size, added, plan });
    const grew = after.scrollHeight > before.scrollHeight;
    const moved = after.scrollTop > before.scrollTop;
    before = after;

    if (added > 0 || grew) {
      idle = 0;
      continue;
    }
    if (full()) continue;
    const blocked = await driver.blocked();
    if (blocked) {
      stop("blocked", blocked);
      break;
    }
    idle++;
    if (idle >= limits.idleSteps) {
      if (after.atBottom) {
        stop("end-of-feed", `no new items or page growth for ${idle} steps at the bottom`);
      } else if (!moved) {
        stop("idle", `the page stopped scrolling; no new items for ${idle} steps`);
      } else {
        stop("idle", `no new items or page growth for ${idle} steps`);
      }
      break;
    }
  }

  const items = store.items();
  stats.items = items.length;
  stats.duplicates = store.duplicates;
  stats.elapsedMs = Math.round(elapsed());
  if (items.length === 0 && stats.stopDetail && stats.stopReason !== "blocked") {
    stats.stopDetail += " (the item selector matched nothing)";
  }
  return { items, stats };
}
