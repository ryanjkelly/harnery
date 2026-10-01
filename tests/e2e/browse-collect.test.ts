import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser } from "../../src/lib/browser/client.ts";
import {
  createPageDriver,
  createRng,
  DEFAULT_COLLECT_LIMITS,
  DEFAULT_SCROLL_PACING,
  resolveCollectSpec,
  runCollect,
} from "../../src/lib/browser/collect/index.ts";

const fixtureUrl = (total: number) =>
  `${pathToFileURL(resolve(import.meta.dir, "../fixtures/collect-feed/index.html")).href}?total=${total}`;
const dirs: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-collect-"));
  dirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const fastPacing = {
  ...DEFAULT_SCROLL_PACING,
  pauseMs: { min: 60, max: 120 },
  readChance: 0,
  tickGapMs: { min: 2, max: 6 },
};

describe("browse --collect against a virtualized feed", () => {
  test("collects every item once, in order, while the DOM holds about ten", async () => {
    const browser = new Browser({
      profileDir: join(tempDir(), "profile"),
      viewport: { width: 1000, height: 800 },
    });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl(60));
      const spec = resolveCollectSpec("generic", {
        fields: ["text=p.body", "url=a.perma@href"],
        expand: "button.more",
      });
      const rng = createRng(11);
      const { items, stats } = await runCollect(
        createPageDriver(browser.currentPage, spec, { rng, expandPauseMs: { min: 5, max: 10 } }),
        {
          limits: { ...DEFAULT_COLLECT_LIMITS, idleSteps: 3, expandPerStep: 3 },
          pacing: fastPacing,
          rng,
        },
      );
      expect(items.map((i) => i.key)).toEqual(
        Array.from({ length: 60 }, (_, i) => `https://feed.test/post/${i}`),
      );
      expect(items[5]?.time).toBe("2026-01-01T00:05:00Z");
      expect(stats.duplicates).toBeGreaterThan(0);
      expect(stats.stopReason).toBe("end-of-feed");
      // Long posts (every 7th from #3) were expanded before or after harvest.
      expect(stats.expanded).toBeGreaterThan(0);
      expect(String(items[3]?.text)).toContain("hidden remainder");
      const maxInDom = await browser.evaluate<number>("window.__maxInDom");
      expect(maxInDom).toBeLessThanOrEqual(10);
    } finally {
      await browser.close();
    }
  }, 60_000);

  test("CLI writes JSONL with max-items and a reproducible seed", () => {
    const dir = tempDir();
    const out = join(dir, "items.jsonl");
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        fixtureUrl(60),
        "--no-cookies",
        "--profile",
        join(dir, "profile"),
        "--wait-for",
        "article",
        "--batch",
        "eval (() => { window.__ready = 1; return 1 })(); wait 50",
        "--collect",
        "generic",
        "--collect-field",
        "url=a.perma@href",
        "--collect-pause",
        "60-120",
        "--collect-read-chance",
        "0",
        "--collect-seed",
        "7",
        "--collect-max-items",
        "40",
        "--collect-format",
        "jsonl",
        "--collect-out",
        out,
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stderr = result.stderr.toString();
    expect(result.exitCode, stderr).toBe(0);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines.length).toBe(40);
    const items = lines.map((l) => JSON.parse(l));
    expect(new Set(items.map((i) => i.key)).size).toBe(40);
    expect(items[39].url).toBe("https://feed.test/post/39");
    const summary = JSON.parse(result.stdout.toString().trim().split("\n").pop() ?? "{}");
    expect(summary.stopReason).toBe("max-items");
    expect(summary.items).toBe(40);
  }, 60_000);
});
