import { describe, expect, test } from "bun:test";
import {
  COLLECT_PRESETS,
  type CollectDriver,
  type CollectLimits,
  createRng,
  DEFAULT_COLLECT_LIMITS,
  DEFAULT_SCROLL_PACING,
  type HarvestedItem,
  ItemStore,
  type PageMetrics,
  parseExtractor,
  parseFieldSpec,
  parseRange,
  planScrollStep,
  resolveCollectSpec,
  runCollect,
  type ScrollPacing,
  scrollPacingFromEnv,
  wheelTicks,
} from "./index.ts";

describe("seeded rng and scroll plan", () => {
  test("the same seed yields the same sequence; a different seed does not", () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(seqA);
    for (const v of seqA) expect(v >= 0 && v < 1).toBe(true);
  });

  test("plans stay inside every pacing bound over many steps", () => {
    const rng = createRng(7);
    const p = DEFAULT_SCROLL_PACING;
    let reads = 0;
    let backs = 0;
    for (let i = 0; i < 2_000; i++) {
      const plan = planScrollStep(rng, p, 800);
      expect(plan.deltaY).toBeGreaterThanOrEqual(Math.floor(p.step.min * 800));
      expect(plan.deltaY).toBeLessThanOrEqual(Math.ceil(p.step.max * 800));
      expect(plan.ticks.reduce((s, t) => s + t.deltaY, 0)).toBe(plan.deltaY);
      for (const t of plan.ticks) {
        expect(t.deltaY).toBeGreaterThan(0);
        expect(t.deltaY).toBeLessThanOrEqual(p.tickPx.max);
        expect(t.gapMs).toBeGreaterThanOrEqual(p.tickGapMs.min);
        expect(t.gapMs).toBeLessThanOrEqual(p.tickGapMs.max);
      }
      const bounds = plan.reading ? p.readPauseMs : p.pauseMs;
      expect(plan.pauseMs).toBeGreaterThanOrEqual(bounds.min);
      expect(plan.pauseMs).toBeLessThanOrEqual(bounds.max);
      if (plan.reading) reads++;
      if (plan.back.length > 0) {
        backs++;
        const up = plan.back.reduce((s, t) => s + t.deltaY, 0);
        expect(up).toBeLessThan(0);
        expect(-up).toBeLessThanOrEqual(Math.ceil(p.back.max * 800));
      }
    }
    // Roughly the configured chances (0.12 and 0.08) over 2000 draws.
    expect(reads).toBeGreaterThan(160);
    expect(reads).toBeLessThan(330);
    expect(backs).toBeGreaterThan(90);
    expect(backs).toBeLessThan(240);
  });

  test("plans are reproducible from a seed", () => {
    const run = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 10 }, () => planScrollStep(rng, DEFAULT_SCROLL_PACING, 900));
    };
    expect(run(99)).toEqual(run(99));
  });

  test("wheel ticks split negative distances too", () => {
    const ticks = wheelTicks(createRng(1), DEFAULT_SCROLL_PACING, -250);
    expect(ticks.reduce((s, t) => s + t.deltaY, 0)).toBe(-250);
    for (const t of ticks) expect(t.deltaY).toBeLessThan(0);
  });

  test("parseRange accepts min-max and single values and rejects bad input", () => {
    expect(parseRange("100-200", "--x", { min: 0, max: 1000 })).toEqual({ min: 100, max: 200 });
    expect(parseRange("0.5", "--x", { min: 0, max: 3 })).toEqual({ min: 0.5, max: 0.5 });
    expect(() => parseRange("200-100", "--x", { min: 0, max: 1000 })).toThrow(/must not exceed/);
    expect(() => parseRange("abc", "--x", { min: 0, max: 1000 })).toThrow(/--x/);
    expect(() => parseRange("0-5000", "--x", { min: 0, max: 1000 })).toThrow(/within/);
  });

  test("env pacing follows the HARNERY_ prefix style and validates", () => {
    const p = scrollPacingFromEnv({
      HARNERY_COLLECT_PAUSE_MS: "10-20",
      HARNERY_COLLECT_STEP: "0.5-0.7",
    });
    expect(p.pauseMs).toEqual({ min: 10, max: 20 });
    expect(p.step).toEqual({ min: 0.5, max: 0.7 });
    expect(scrollPacingFromEnv({})).toEqual(DEFAULT_SCROLL_PACING);
    expect(() => scrollPacingFromEnv({ HARNERY_COLLECT_PAUSE_MS: "fast" })).toThrow(
      /HARNERY_COLLECT_PAUSE_MS/,
    );
  });
});

describe("field grammar", () => {
  test("extractors split on the last top-level @", () => {
    expect(parseExtractor("time@datetime")).toEqual({ selector: "time", attr: "datetime" });
    expect(parseExtractor('a[href*="@"]@href')).toEqual({ selector: 'a[href*="@"]', attr: "href" });
    expect(parseExtractor("[data-testid=tweetText]")).toEqual({
      selector: "[data-testid=tweetText]",
      attr: null,
    });
    expect(parseExtractor("@permalink")).toEqual({ selector: "", attr: "permalink" });
    expect(parseExtractor(":scope")).toEqual({ selector: "", attr: null });
    expect(() => parseExtractor("img@ bad attr")).toThrow(/attribute/);
  });

  test("field specs parse names, arrays and reject reserved names", () => {
    expect(parseFieldSpec("media[]=img@src")).toEqual({
      name: "media",
      all: true,
      selector: "img",
      attr: "src",
    });
    expect(parseFieldSpec("text=")).toEqual({ name: "text", all: false, selector: "", attr: null });
    expect(() => parseFieldSpec("key=a@href")).toThrow(/reserved/);
    expect(() => parseFieldSpec("nope")).toThrow(/name>=/);
    expect(() => parseFieldSpec("1bad=a")).toThrow(/Field name/);
  });
});

describe("preset table", () => {
  test("every preset is well-formed data that resolves", () => {
    const required = [
      "generic",
      "x",
      "threads",
      "bluesky",
      "reddit",
      "linkedin",
      "instagram",
      "tiktok",
      "mastodon",
      "youtube-comments",
    ];
    for (const name of required) expect(COLLECT_PRESETS[name]).toBeDefined();
    for (const [name, preset] of Object.entries(COLLECT_PRESETS)) {
      expect(typeof preset.item).toBe("string");
      expect(preset.item.length).toBeGreaterThan(0);
      expect(typeof preset.description).toBe("string");
      expect(typeof preset.tested).toBe("boolean");
      const spec = resolveCollectSpec(name, { expand: Boolean(preset.expand) });
      expect(spec.fields.length).toBeGreaterThan(0);
      for (const re of preset.blockedText ?? []) expect(() => new RegExp(re)).not.toThrow();
    }
    expect(COLLECT_PRESETS.x?.tested).toBe(true);
  });

  test("overrides replace item, key and fields; expand needs a selector", () => {
    const spec = resolveCollectSpec("x", {
      item: "li.post",
      key: "a.perma@href",
      fields: ["text=.body", "tags[]=.tag"],
      expand: true,
    });
    expect(spec.item).toBe("li.post");
    expect(spec.key).toEqual({ selector: "a.perma", attr: "href" });
    expect(spec.fields.find((f) => f.name === "text")?.selector).toBe(".body");
    expect(spec.fields.find((f) => f.name === "tags")?.all).toBe(true);
    expect(spec.expand).toBe(COLLECT_PRESETS.x?.expand ?? null);
    expect(() => resolveCollectSpec("generic", { expand: true })).toThrow(/no expand selector/);
    expect(resolveCollectSpec("generic", { expand: ".more" }).expand).toBe(".more");
    expect(() => resolveCollectSpec("nope")).toThrow(/Unknown collect preset/);
    expect(() => resolveCollectSpec("generic", { keyPattern: "(" })).toThrow(/regex/);
  });
});

describe("item store", () => {
  test("dedupes by key, keeps first-seen order and step, fills in richer values", () => {
    const store = new ItemStore();
    store.add(
      [
        { key: "a", fields: { text: "short", media: ["1"], time: null } },
        { key: "b", fields: { text: "bee", media: [], time: "t" } },
      ],
      0,
    );
    const added = store.add(
      [
        { key: "b", fields: { text: "be", media: ["x"], time: "u" } },
        { key: "a", fields: { text: "short plus more", media: ["1", "2"], time: "now" } },
        { key: "c", fields: { text: "sea" } },
        { key: "", fields: { text: "no key" } },
      ],
      3,
    );
    expect(added).toBe(1);
    expect(store.duplicates).toBe(2);
    expect(store.items()).toEqual([
      { key: "a", firstSeenStep: 0, text: "short plus more", media: ["1", "2"], time: "now" },
      { key: "b", firstSeenStep: 0, text: "bee", media: ["x"], time: "t" },
      { key: "c", firstSeenStep: 3, text: "sea" },
    ]);
  });

  test("a max-items cap stops new keys but still counts duplicates", () => {
    const store = new ItemStore();
    store.add(
      [
        { key: "a", fields: {} },
        { key: "b", fields: {} },
        { key: "c", fields: {} },
      ],
      0,
      2,
    );
    expect(store.size).toBe(2);
    store.add([{ key: "a", fields: {} }], 1, 2);
    expect(store.duplicates).toBe(1);
  });
});

/** A virtual feed: `total` items, `window` visible at a time, scrolled by wheel deltas. */
function fakeFeed(opts: {
  total: number;
  window?: number;
  itemPx?: number;
  viewport?: number;
  blockedAfter?: number;
  stuck?: boolean;
}): CollectDriver & { clock: number; wheels: number } {
  const itemPx = opts.itemPx ?? 100;
  const viewport = opts.viewport ?? 800;
  const windowSize = opts.window ?? 10;
  let top = 0;
  const feed = {
    clock: 0,
    wheels: 0,
    height: () => opts.total * itemPx,
    async harvest(): Promise<HarvestedItem[]> {
      const first = Math.floor(top / itemPx);
      const out: HarvestedItem[] = [];
      for (let i = first; i < Math.min(opts.total, first + windowSize); i++) {
        if (opts.blockedAfter !== undefined && i >= opts.blockedAfter) break;
        out.push({ key: `item-${i}`, fields: { text: `post ${i}` } });
      }
      return out;
    },
    async metrics(): Promise<PageMetrics> {
      const scrollHeight = feed.height();
      return {
        scrollTop: top,
        scrollHeight,
        viewportHeight: viewport,
        atBottom: top + viewport >= scrollHeight - 4,
      };
    },
    async wheel(ticks: Array<{ deltaY: number }>) {
      feed.wheels++;
      if (opts.stuck) return true;
      const total = ticks.reduce((s, t) => s + t.deltaY, 0);
      top = Math.max(0, Math.min(feed.height() - viewport, top + total));
      return false;
    },
    async expand() {
      return 0;
    },
    async blocked() {
      return opts.blockedAfter !== undefined && top / itemPx + windowSize >= opts.blockedAfter
        ? 'page shows "Rate limit exceeded"'
        : null;
    },
    async sleep(ms: number) {
      feed.clock += ms;
    },
    now() {
      return feed.clock;
    },
  };
  return feed;
}

const fastPacing: ScrollPacing = {
  ...DEFAULT_SCROLL_PACING,
  pauseMs: { min: 10, max: 20 },
  readPauseMs: { min: 30, max: 40 },
};

function limits(over: Partial<CollectLimits>): CollectLimits {
  return { ...DEFAULT_COLLECT_LIMITS, ...over };
}

describe("runCollect", () => {
  test("collects a whole virtualized feed in order and stops at the end of feed", async () => {
    const feed = fakeFeed({ total: 60 });
    const { items, stats } = await runCollect(feed, {
      limits: limits({ maxScrolls: 500, idleSteps: 3 }),
      pacing: fastPacing,
      rng: createRng(5),
    });
    expect(items.map((i) => i.key)).toEqual(Array.from({ length: 60 }, (_, i) => `item-${i}`));
    expect(items[0]?.firstSeenStep).toBe(0);
    expect(stats.items).toBe(60);
    expect(stats.duplicates).toBeGreaterThan(0);
    expect(stats.stopReason).toBe("end-of-feed");
    expect(stats.harvests).toBeGreaterThan(stats.steps);
  });

  test("stops exactly at max-items", async () => {
    const { items, stats } = await runCollect(fakeFeed({ total: 500 }), {
      limits: limits({ maxItems: 25 }),
      pacing: fastPacing,
      rng: createRng(5),
    });
    expect(items.length).toBe(25);
    expect(stats.stopReason).toBe("max-items");
  });

  test("stops at max-scrolls", async () => {
    const { stats } = await runCollect(fakeFeed({ total: 500 }), {
      limits: limits({ maxScrolls: 3 }),
      pacing: fastPacing,
      rng: createRng(5),
    });
    expect(stats.steps).toBe(3);
    expect(stats.stopReason).toBe("max-scrolls");
  });

  test("stops on the time budget and never sleeps past it", async () => {
    const feed = fakeFeed({ total: 5_000 });
    const { stats } = await runCollect(feed, {
      limits: limits({ maxMs: 500, maxScrolls: 10_000 }),
      pacing: fastPacing,
      rng: createRng(5),
    });
    expect(stats.stopReason).toBe("time-budget");
    expect(feed.clock).toBeLessThanOrEqual(500);
  });

  test("reports a stuck page as idle, not end of feed", async () => {
    const { stats } = await runCollect(fakeFeed({ total: 500, stuck: true }), {
      limits: limits({ idleSteps: 2 }),
      pacing: fastPacing,
      rng: createRng(5),
    });
    expect(stats.stopReason).toBe("idle");
    expect(stats.stopDetail).toMatch(/stopped scrolling/);
    expect(stats.scrollFallbacks).toBeGreaterThan(0);
  });

  test("stops with blocked when the page shows a rate limit and growth stops", async () => {
    const { items, stats } = await runCollect(fakeFeed({ total: 500, blockedAfter: 30 }), {
      limits: limits({ idleSteps: 5 }),
      pacing: fastPacing,
      rng: createRng(5),
    });
    expect(items.length).toBe(30);
    expect(stats.stopReason).toBe("blocked");
    expect(stats.stopDetail).toMatch(/Rate limit/);
  });

  test("an interrupt stops the run and keeps what was collected", async () => {
    let calls = 0;
    const { items, stats } = await runCollect(fakeFeed({ total: 500 }), {
      limits: limits({}),
      pacing: fastPacing,
      rng: createRng(5),
      shouldStop: () => ++calls > 20,
    });
    expect(stats.stopReason).toBe("interrupted");
    expect(items.length).toBeGreaterThan(0);
  });

  test("identical seeds give identical runs", async () => {
    const go = async () =>
      await runCollect(fakeFeed({ total: 80 }), {
        limits: limits({ idleSteps: 3, maxScrolls: 500 }),
        pacing: fastPacing,
        rng: createRng(1234),
      });
    const [a, b] = [await go(), await go()];
    expect(a.items).toEqual(b.items);
    expect(a.stats).toEqual(b.stats);
  });
});
