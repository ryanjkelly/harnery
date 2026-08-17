import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import type { CritiqueTile } from "./critique.ts";
import {
  DEFAULT_REUSE_MISMATCH_RATIO,
  type PersistedCritique,
  planCritiqueReuse,
  QA_CRITIQUE_CONTRACT_VERSION,
  qaTileCacheKey,
  rectMismatch,
  rubricDigest,
} from "./qa-reuse.ts";

function png(width: number, height: number, paint?: (x: number, y: number) => number): Buffer {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = paint ? paint(x, y) : 255;
      const i = (y * width + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

function tile(index: number, scrollY: number, height: number): CritiqueTile {
  return { index, label: `band ${index + 1}`, scrollY, x: 0, width: 40, height, pngBase64: "" };
}

function persisted(overrides: Partial<PersistedCritique> = {}): PersistedCritique {
  return {
    contract_version: QA_CRITIQUE_CONTRACT_VERSION,
    rubric_digest: rubricDigest("rubric"),
    outcome: "pass",
    findings: [],
    tiles: [
      { index: 0, label: "band 1", x: 0, scrollY: 0, width: 40, height: 50 },
      { index: 1, label: "band 2", x: 0, scrollY: 50, width: 40, height: 50 },
    ],
    ...overrides,
  };
}

describe("rubricDigest", () => {
  test("normalizes whitespace so formatting edits do not invalidate", () => {
    expect(rubricDigest("a  b\n c")).toBe(rubricDigest("a b c"));
    expect(rubricDigest("a b c")).not.toBe(rubricDigest("a b d"));
  });
});

describe("qaTileCacheKey", () => {
  const parts = {
    tilePngSha256: "aa",
    rubricDigest: "r",
    provider: "p",
    model: "m",
    viewport: "desktop",
    deviceScaleFactor: 1,
    theme: "light",
    state: "default",
    tileLabel: "band 1",
  };
  test("is stable and versioned", () => {
    expect(qaTileCacheKey(parts)).toBe(qaTileCacheKey({ ...parts }));
    expect(qaTileCacheKey(parts)).toMatch(/^qa1-[0-9a-f]{64}$/);
  });
  test("any field change is a different key", () => {
    expect(qaTileCacheKey({ ...parts, model: "m2" })).not.toBe(qaTileCacheKey(parts));
    expect(qaTileCacheKey({ ...parts, theme: "dark" })).not.toBe(qaTileCacheKey(parts));
    expect(qaTileCacheKey({ ...parts, tilePngSha256: "bb" })).not.toBe(qaTileCacheKey(parts));
  });
});

describe("rectMismatch", () => {
  test("identical regions have ratio 0", () => {
    const a = PNG.sync.read(png(40, 100));
    const b = PNG.sync.read(png(40, 100));
    const r = rectMismatch(a, b, { x: 0, y: 0, width: 40, height: 50 });
    expect(r.ratio).toBe(0);
    expect(r.sizeMismatch).toBe(false);
  });

  test("a localized change registers only in its region", () => {
    const a = PNG.sync.read(png(40, 100));
    const b = PNG.sync.read(png(40, 100, (_x, y) => (y >= 60 && y < 70 ? 0 : 255)));
    expect(rectMismatch(a, b, { x: 0, y: 0, width: 40, height: 50 }).ratio).toBe(0);
    expect(rectMismatch(a, b, { x: 0, y: 50, width: 40, height: 50 }).ratio).toBeGreaterThan(0.1);
  });

  test("a region past the shorter image is a size mismatch", () => {
    const a = PNG.sync.read(png(40, 100));
    const b = PNG.sync.read(png(40, 60));
    const r = rectMismatch(a, b, { x: 0, y: 50, width: 40, height: 50 });
    expect(r.sizeMismatch).toBe(true);
    expect(r.ratio).toBe(1);
  });
});

describe("planCritiqueReuse", () => {
  const baseline = png(40, 100);
  const tiles = [tile(0, 0, 50), tile(1, 50, 50)];

  test("clean matching tiles are reused; changed tiles review fresh", () => {
    const current = png(40, 100, (_x, y) => (y >= 60 && y < 70 ? 0 : 255));
    const plan = planCritiqueReuse({
      baselineScreenshot: baseline,
      baselineCritique: persisted(),
      currentScreenshot: current,
      tiles,
      rubric: "rubric",
    });
    expect(plan.tiles_reused).toBe(1);
    expect(plan.review.map((t) => t.index)).toEqual([1]);
    expect(plan.decisions[0].reuse).toBe(true);
    expect(plan.provider_calls_avoided).toBe(1);
    expect(plan.mismatch_threshold).toBe(DEFAULT_REUSE_MISMATCH_RATIO);
  });

  test("identical screenshots reuse every clean tile", () => {
    const plan = planCritiqueReuse({
      baselineScreenshot: baseline,
      baselineCritique: persisted(),
      currentScreenshot: png(40, 100),
      tiles,
      rubric: "rubric",
    });
    expect(plan.tiles_reused).toBe(2);
    expect(plan.review).toEqual([]);
  });

  test("a baseline finding in a region forces fresh review even when pixels match", () => {
    const plan = planCritiqueReuse({
      baselineScreenshot: baseline,
      baselineCritique: persisted({
        outcome: "fail",
        findings: [{ tile: 0, severity: "high", category: "x", description: "d" }],
      }),
      currentScreenshot: png(40, 100),
      tiles,
      rubric: "rubric",
    });
    expect(plan.decisions[0].reuse).toBe(false);
    expect(plan.decisions[0].reason).toContain("findings");
    expect(plan.tiles_reused).toBe(1); // tile 1 still reuses
  });

  test("a changed rubric is a whole-run miss", () => {
    const plan = planCritiqueReuse({
      baselineScreenshot: baseline,
      baselineCritique: persisted(),
      currentScreenshot: png(40, 100),
      tiles,
      rubric: "different rubric",
    });
    expect(plan.tiles_reused).toBe(0);
    expect(plan.invalidation).toContain("rubric");
  });

  test("a contract version bump is a whole-run miss", () => {
    const plan = planCritiqueReuse({
      baselineScreenshot: baseline,
      baselineCritique: persisted({ contract_version: QA_CRITIQUE_CONTRACT_VERSION + 1 }),
      currentScreenshot: png(40, 100),
      tiles,
      rubric: "rubric",
    });
    expect(plan.tiles_reused).toBe(0);
    expect(plan.invalidation).toContain("contract");
  });

  test("an unreadable screenshot degrades to a whole-run miss, never throws", () => {
    const plan = planCritiqueReuse({
      baselineScreenshot: Buffer.from("not a png"),
      baselineCritique: persisted(),
      currentScreenshot: png(40, 100),
      tiles,
      rubric: "rubric",
    });
    expect(plan.tiles_reused).toBe(0);
    expect(plan.invalidation).toContain("unreadable");
  });

  test("a grown page invalidates the tile past the old height", () => {
    const plan = planCritiqueReuse({
      baselineScreenshot: png(40, 60),
      baselineCritique: persisted(),
      currentScreenshot: png(40, 100),
      tiles,
      rubric: "rubric",
    });
    expect(plan.decisions[1].reuse).toBe(false);
    expect(plan.decisions[1].reason).toContain("not comparable");
  });
});
