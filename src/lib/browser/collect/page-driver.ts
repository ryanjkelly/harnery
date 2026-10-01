import type { Page } from "playwright";
import type { CollectDriver, HarvestedItem, PageMetrics } from "./collector.ts";
import type { ResolvedCollectSpec } from "./presets.ts";
import { type Range, type Rng, uniform, type WheelTick } from "./scroll-plan.ts";

/** Attribute the driver puts on expand buttons it has handled. */
const EXPAND_MARK = "data-harn-collect-expand";

/** Generic signs of a rate limit or login wall, checked for every preset. */
const GENERIC_BLOCKED_TEXT = [
  "rate limit exceeded",
  "too many requests",
  "(log in|sign in|sign up) to (continue|see more|keep (reading|scrolling))",
];

/** Words that mark a button as an action rather than a "show more" toggle. */
const UNSAFE_EXPAND_WORDS =
  "like|unlike|follow|reply|repost|retweet|share|subscribe|join|delete|block|report|mute|send|post|vote|bookmark|save";

interface HarvestArgs {
  item: string;
  key: { selector: string; attr: string | null } | null;
  keyPattern: string | null;
  fields: Array<{ name: string; selector: string; attr: string | null; all: boolean }>;
}

/** Runs in the page. Must stay self-contained: no closures over module scope. */
function harvestInPage(args: HarvestArgs): Array<{ key: string; fields: Record<string, unknown> }> {
  const urlish = /href|src|permalink|url/i;
  const read = (el: Element, attr: string | null): string | null => {
    if (attr === null) {
      const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
      return text.trim() || null;
    }
    let value = el.getAttribute(attr);
    if (value === null) return null;
    value = value.trim();
    if (value && urlish.test(attr) && !/^(data|blob|javascript):/i.test(value)) {
      try {
        value = new URL(value, location.href).href;
      } catch {
        // Keep the raw attribute when it is not a URL.
      }
    }
    return value || null;
  };
  const pick = (root: Element, selector: string): Element[] => {
    if (!selector) return [root];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  };
  const first = (root: Element, selector: string, attr: string | null): string | null => {
    for (const el of pick(root, selector)) {
      const v = read(el, attr);
      if (v) return v;
    }
    return null;
  };
  const permalinkRe = args.keyPattern
    ? new RegExp(args.keyPattern)
    : /\/(status|statuses|post|posts|p|reel|reels|video|videos|comments|watch|item|items|story|stories|article|articles|entry|thread|threads)\/[^/?#]+|\/@[^/]+\/\d+|[?&](v|id|lc|p|story_fbid)=[\w-]+/i;
  const here = location.href.split("#")[0];
  const permalink = (item: Element): string | null => {
    const anchors: Element[] = item.matches("a[href]") ? [item] : [];
    anchors.push(...Array.from(item.querySelectorAll("a[href]")));
    for (const a of anchors) {
      const href = (a as HTMLAnchorElement).href;
      if (!href || href.split("#")[0] === here) continue;
      try {
        const u = new URL(href);
        if (permalinkRe.test(u.pathname + u.search)) return u.href.split("#")[0] ?? null;
      } catch {
        // Ignore malformed hrefs.
      }
    }
    return null;
  };
  const textHash = (text: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `text:${h.toString(16).padStart(8, "0")}`;
  };

  let items: Element[] = [];
  try {
    items = Array.from(document.querySelectorAll(args.item));
  } catch {
    return [];
  }
  const out: Array<{ key: string; fields: Record<string, unknown> }> = [];
  for (const item of items) {
    let key = args.key ? first(item, args.key.selector, args.key.attr) : null;
    if (key && args.key?.attr && urlish.test(args.key.attr)) key = key.split("#")[0] ?? key;
    if (!key) key = permalink(item);
    if (!key) {
      const text = ((item as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue; // A skeleton or placeholder row: nothing to key on yet.
      key = textHash(text);
    }
    const fields: Record<string, unknown> = {};
    for (const f of args.fields) {
      if (f.all) {
        const values: string[] = [];
        for (const el of pick(item, f.selector)) {
          const v = read(el, f.attr);
          if (v && !values.includes(v)) values.push(v);
        }
        fields[f.name] = values;
      } else {
        fields[f.name] = first(item, f.selector, f.attr);
      }
    }
    out.push({ key, fields });
  }
  return out;
}

/** Runs in the page: scroll state of the element that actually scrolls the feed. */
function metricsInPage(itemSelector: string): PageMetrics & { pointerX: number; pointerY: number } {
  const doc = document.scrollingElement ?? document.documentElement;
  let container: Element = doc;
  let firstItem: Element | null = null;
  try {
    firstItem = document.querySelector(itemSelector);
  } catch {
    firstItem = null;
  }
  for (
    let el = firstItem?.parentElement ?? null;
    el && el !== document.body;
    el = el.parentElement
  ) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
      container = el;
      break;
    }
  }
  const isDoc = container === doc;
  const scrollTop = isDoc ? window.scrollY : container.scrollTop;
  const viewportHeight = isDoc ? window.innerHeight : container.clientHeight;
  const scrollHeight = container.scrollHeight;
  let pointerX = window.innerWidth / 2;
  let pointerY = window.innerHeight / 2;
  const target = firstItem ?? (isDoc ? null : container);
  if (target) {
    const r = (isDoc ? target : container).getBoundingClientRect();
    pointerX = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
    if (!isDoc) pointerY = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
  }
  return {
    scrollTop,
    scrollHeight,
    viewportHeight,
    atBottom: scrollTop + viewportHeight >= scrollHeight - 4,
    pointerX,
    pointerY,
  };
}

export interface PageDriverDeps {
  rng: Rng;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  /** Pause before each expand click, in ms (default 250-700). */
  expandPauseMs?: Range;
}

export function createPageDriver(
  page: Page,
  spec: ResolvedCollectSpec,
  deps: PageDriverDeps,
): CollectDriver {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => performance.now());
  const harvestArgs: HarvestArgs = {
    item: spec.item,
    key: spec.key,
    keyPattern: spec.keyPattern,
    fields: spec.fields.map(({ name, selector, attr, all }) => ({ name, selector, attr, all })),
  };
  let expandEnabled = spec.expand !== null;
  let expandSeq = 0;
  let pointer: { x: number; y: number } | null = null;

  const metrics = async () => await page.evaluate(metricsInPage, spec.item);

  return {
    async harvest(): Promise<HarvestedItem[]> {
      return await page.evaluate(harvestInPage, harvestArgs);
    },
    async metrics(): Promise<PageMetrics> {
      const { scrollTop, scrollHeight, viewportHeight, atBottom } = await metrics();
      return { scrollTop, scrollHeight, viewportHeight, atBottom };
    },
    async wheel(ticks: WheelTick[]): Promise<boolean> {
      if (ticks.length === 0) return false;
      const start = await metrics();
      // Rest the pointer over the feed, drifting a little between steps the
      // way a hand does, so wheel events reach an inner scroller too.
      const jitter = () => uniform(deps.rng, { min: -40, max: 40 });
      const target = {
        x: Math.max(1, start.pointerX + jitter()),
        y: Math.max(1, start.pointerY + jitter()),
      };
      if (!pointer || Math.hypot(pointer.x - target.x, pointer.y - target.y) > 30) {
        await page.mouse.move(target.x, target.y, { steps: 4 });
        pointer = target;
      }
      for (const tick of ticks) {
        await page.mouse.wheel(0, tick.deltaY);
        await sleep(tick.gapMs);
      }
      const total = ticks.reduce((sum, t) => sum + t.deltaY, 0);
      if (total <= 0) return false;
      // Wheel scrolling settles asynchronously; give it a beat before judging.
      await sleep(120);
      let after = await metrics();
      if (after.scrollTop > start.scrollTop || after.atBottom) return false;
      await page.keyboard.press("PageDown").catch(() => {});
      await sleep(150);
      after = await metrics();
      if (after.scrollTop > start.scrollTop || after.atBottom) return true;
      await page.evaluate(
        ({ selector, dy }) => {
          const first = document.querySelector(selector);
          let el = first?.parentElement ?? null;
          while (el && el !== document.body) {
            const oy = getComputedStyle(el).overflowY;
            if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
              el.scrollBy(0, dy);
              return;
            }
            el = el.parentElement;
          }
          window.scrollBy(0, dy);
        },
        { selector: spec.item, dy: total },
      );
      return true;
    },
    async expand(limit: number): Promise<number> {
      if (!expandEnabled || spec.expand === null || limit <= 0) return 0;
      const base = expandSeq;
      const marked: string[] = await page.evaluate(
        ({ item, expand, mark, unsafe, limit, base }) => {
          const unsafeRe = new RegExp(`\\b(${unsafe})\\b`, "i");
          const ids: string[] = [];
          let seq = base;
          for (const it of Array.from(document.querySelectorAll(item))) {
            for (const el of Array.from(it.querySelectorAll(expand))) {
              if (ids.length >= limit) return ids;
              if (el.hasAttribute(mark)) continue;
              if (el.closest("a[href]")) continue; // Links navigate away.
              const label = `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("data-testid") ?? ""} ${(el as HTMLElement).innerText ?? ""}`;
              if (unsafeRe.test(label)) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) {
                continue;
              }
              const id = String(++seq);
              el.setAttribute(mark, id);
              ids.push(id);
            }
          }
          return ids;
        },
        {
          item: spec.item,
          expand: spec.expand,
          mark: EXPAND_MARK,
          unsafe: UNSAFE_EXPAND_WORDS,
          limit,
          base,
        },
      );
      expandSeq = base + marked.length;
      let clicked = 0;
      for (const id of marked) {
        await sleep(Math.round(uniform(deps.rng, deps.expandPauseMs ?? { min: 250, max: 700 })));
        const before = page.url();
        try {
          await page.locator(`[${EXPAND_MARK}="${id}"]`).click({ timeout: 2_000 });
          clicked++;
        } catch {
          continue;
        }
        if (page.url() !== before) {
          // The button navigated: go back to the feed and stop expanding.
          deps.log?.(`collect: an expand click navigated to ${page.url()}; expansion disabled.`);
          expandEnabled = false;
          await page.goBack().catch(() => {});
          break;
        }
      }
      return clicked;
    },
    async blocked(): Promise<string | null> {
      return await page.evaluate(
        ({ patterns }) => {
          const dialogs = Array.from(
            document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]'),
          )
            .map((d) => (d as HTMLElement).innerText ?? "")
            .join("\n");
          const body = (document.body?.innerText ?? "").slice(0, 200_000);
          for (const source of patterns) {
            const re = new RegExp(source, "i");
            const m = re.exec(dialogs) ?? re.exec(body);
            if (m) return `page shows "${m[0].slice(0, 80)}"`;
          }
          return null;
        },
        { patterns: [...spec.blockedText, ...GENERIC_BLOCKED_TEXT] },
      );
    },
    sleep,
    now,
  };
}
