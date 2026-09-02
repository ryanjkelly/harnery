import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { CritiqueProvider, CritiqueTile } from "./critique.ts";
import { judgePageReviewPack, toCritiqueRecords } from "./page-review-judge.ts";
import { type PageReviewContextCapture, writePackContext } from "./page-review-pack.ts";
import { QA_CRITIQUE_CONTRACT_VERSION, rubricDigest } from "./qa-reuse.ts";
import { saveQaSnapshot } from "./qa-snapshot.ts";

const RUBRIC = "fixture rubric";

function png(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

function tiles(count: number): CritiqueTile[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: `band ${index + 1}`,
    scrollY: index * 32,
    x: 0,
    width: 64,
    height: 32,
    pngBase64: png(64, 32).toString("base64"),
  }));
}

function capture(
  context: PageReviewContextCapture["context"],
  count: number,
  scopeTiles?: PageReviewContextCapture["scopeTiles"],
): PageReviewContextCapture {
  return {
    context,
    url: `http://localhost:4276/${context.viewport}`,
    fullPage: png(64, count * 32),
    pageWidth: 64,
    pageHeight: count * 32,
    tiles: tiles(count),
    coverage: {
      page_height_px: count * 32,
      reviewed_height_px: count * 32,
      bands_total: count,
      bands_reviewed: count,
      capped: false,
    },
    ...(scopeTiles ? { scopeTiles } : {}),
    signature: { url: "x", capturedAt: "2026-09-02T00:00:00.000Z", nodes: [], stylesheets: [] },
    domHtml: "<html></html>",
  };
}

function pack(): string {
  return mkdtempSync(join(tmpdir(), "page-review-judge-"));
}

describe("judgePageReviewPack", () => {
  test("one pool spans every context; findings carry stable tile ids; order is deterministic", async () => {
    const dir = pack();
    writePackContext(dir, capture({ viewport: "desktop", theme: "light", state: "default" }, 3));
    writePackContext(dir, capture({ viewport: "mobile", theme: "light", state: "default" }, 2));
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    const provider: CritiqueProvider = async ({ url, tile }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      seen.push(`${url}#${tile.label}`);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return tile.index === 1
        ? [{ tile: tile.index, severity: "medium", category: "gap", description: "uneven" }]
        : [];
    };
    provider.concurrency = 1;
    provider.meta = () => ({ active_harness: "fixture", providers: {} });
    const result = await judgePageReviewPack({
      packDir: dir,
      provider,
      rubric: RUBRIC,
      concurrency: 5,
    });
    expect(seen).toHaveLength(5);
    expect(peak).toBe(5);
    expect(result.pool.concurrency).toBe(5);
    expect(result.pool.provider).toBe("fixture");
    expect(result.outcome).toBe("pass");
    expect(result.contexts.map((c) => c.context_id)).toEqual([
      "desktop-light-default",
      "mobile-light-default",
    ]);
    expect(result.contexts[0]?.findings).toEqual([
      { tile: 1, tile_id: "T002", severity: "medium", category: "gap", description: "uneven" },
    ]);
    expect(result.contexts[0]?.tiles_reviewed).toBe(3);
    expect(result.contexts[1]?.tiles_reviewed).toBe(2);
    const records = toCritiqueRecords(result);
    expect("record" in (records[0] ?? {})).toBe(false);
    expect("tiles_unjudged" in (records[0] ?? {})).toBe(false);
  });

  test("no provider: every context is skipped with the injection error, nothing is called", async () => {
    const dir = pack();
    writePackContext(dir, capture({ viewport: "desktop", theme: "light", state: "default" }, 2));
    const result = await judgePageReviewPack({ packDir: dir, provider: undefined, rubric: RUBRIC });
    expect(result.outcome).toBe("skipped");
    expect(result.contexts[0]?.outcome).toBe("skipped");
    expect(result.contexts[0]?.error).toContain("critiqueProvider");
    expect(result.contexts[0]?.provider).toBe("none");
    expect(result.pool.concurrency).toBe(0);
  });

  test("a provider throw on one tile becomes a high provider-error finding for that tile only", async () => {
    const dir = pack();
    writePackContext(dir, capture({ viewport: "desktop", theme: "light", state: "default" }, 3));
    const provider: CritiqueProvider = async ({ tile }) => {
      if (tile.index === 2) throw new Error("harness exited 1");
      return [];
    };
    const result = await judgePageReviewPack({ packDir: dir, provider, rubric: RUBRIC });
    expect(result.outcome).toBe("fail");
    expect(result.contexts[0]?.findings).toEqual([
      {
        tile: 2,
        tile_id: "T003",
        severity: "high",
        category: "provider-error",
        description: "critique provider failed on band 3: harness exited 1",
      },
    ]);
  });

  test("a passed deadline leaves tiles unjudged and the context incomplete, never pass", async () => {
    const dir = pack();
    writePackContext(dir, capture({ viewport: "desktop", theme: "light", state: "default" }, 4));
    const provider: CritiqueProvider = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return [];
    };
    const result = await judgePageReviewPack({
      packDir: dir,
      provider,
      rubric: RUBRIC,
      concurrency: 1,
      deadlineAt: Date.now() + 25,
    });
    expect(result.outcome).toBe("incomplete");
    expect(result.contexts[0]?.outcome).toBe("incomplete");
    expect(result.contexts[0]?.tiles_unjudged).toBeGreaterThan(0);
    expect(
      (result.contexts[0]?.tiles_reviewed ?? 0) + (result.contexts[0]?.tiles_unjudged ?? 0),
    ).toBe(4);
  });

  test("band-diff reuse skips unchanged clean tiles from the persisted snapshot", async () => {
    const dir = pack();
    const root = mkdtempSync(join(tmpdir(), "page-review-judge-store-"));
    const cap = capture({ viewport: "desktop", theme: "light", state: "default" }, 3);
    const record = writePackContext(dir, cap);
    // Baseline: same pixels, a prior pass, a finding on tile 2 only.
    saveQaSnapshot(
      "http://localhost:4276/desktop",
      { viewport: "desktop", theme: "light", state: "default" },
      {
        signature: cap.signature,
        domHtml: cap.domHtml,
        screenshotPng: cap.fullPage,
        critique: {
          contract_version: QA_CRITIQUE_CONTRACT_VERSION,
          rubric_digest: rubricDigest(RUBRIC),
          outcome: "pass",
          findings: [{ tile: 2, severity: "low", category: "gap", description: "prior" }],
          tiles: record.tiles.map((t) => ({
            index: t.index,
            label: t.label,
            x: t.x,
            scrollY: t.scrollY,
            width: t.width,
            height: t.height,
          })),
        },
      },
      { root },
    );
    const judged: number[] = [];
    const provider: CritiqueProvider = async ({ tile }) => {
      judged.push(tile.index);
      return [];
    };
    const result = await judgePageReviewPack({
      packDir: dir,
      provider,
      rubric: RUBRIC,
      reuse: { target: "http://localhost:4276/desktop", store: { root } },
    });
    // Tiles 0 and 1 pixel-match and were clean → reused; tile 2 had a finding → re-reviewed.
    expect(judged).toEqual([2]);
    expect(result.contexts[0]?.tiles_reused).toBe(2);
    expect(result.contexts[0]?.tiles_reviewed).toBe(1);
    expect(result.contexts[0]?.reuse?.tiles_reused).toBe(2);
    expect(result.tiles_reused).toBe(2);
  });

  test("reuse is skipped for a scoped capture so scope tiles never inherit band verdicts", async () => {
    const dir = pack();
    const root = mkdtempSync(join(tmpdir(), "page-review-judge-store-"));
    const cap = capture({ viewport: "desktop", theme: "light", state: "default" }, 0, [
      { selector: "#hero", tiles: tiles(2) },
    ]);
    const record = writePackContext(dir, cap);
    saveQaSnapshot(
      "http://localhost:4276/desktop",
      { viewport: "desktop", theme: "light", state: "default" },
      {
        signature: cap.signature,
        domHtml: cap.domHtml,
        screenshotPng: cap.fullPage,
        critique: {
          contract_version: QA_CRITIQUE_CONTRACT_VERSION,
          rubric_digest: rubricDigest(RUBRIC),
          outcome: "pass",
          findings: [],
          tiles: record.tiles.map((t) => ({
            index: t.index,
            label: t.label,
            x: t.x,
            scrollY: t.scrollY,
            width: t.width,
            height: t.height,
          })),
        },
      },
      { root },
    );
    let calls = 0;
    const provider: CritiqueProvider = async () => {
      calls += 1;
      return [];
    };
    const result = await judgePageReviewPack({
      packDir: dir,
      provider,
      rubric: RUBRIC,
      reuse: { target: "http://localhost:4276/desktop", store: { root } },
    });
    expect(calls).toBe(2);
    expect(result.contexts[0]?.tiles_reused).toBe(0);
    expect(result.contexts[0]?.reuse).toBeUndefined();
  });
});
