import { describe, expect, test } from "bun:test";
import { bandOversizedRect, cutCost, snappedBandRects, type VisualAtom } from "./tiling.ts";

/** A paragraph: line boxes every `lineHeight` px from top, `lines` of them. */
function paragraph(top: number, lines: number, lineHeight = 24, glyph = 18): VisualAtom[] {
  const atoms: VisualAtom[] = [];
  for (let i = 0; i < lines; i++) {
    const t = top + i * lineHeight;
    atoms.push({ kind: "text-line", top: t, bottom: t + glyph });
  }
  return atoms;
}

const OPTS = { bandHeight: 1400, overlap: 120 };

describe("cutCost", () => {
  test("clean gap costs zero", () => {
    const atoms = paragraph(100, 5);
    expect(cutCost(atoms, 50).cost).toBe(0);
    expect(cutCost(atoms, 5000).cost).toBe(0);
  });

  test("cut through a text line is a hard crossing", () => {
    const atoms = paragraph(100, 1);
    const c = cutCost(atoms, 110);
    expect(c.hard).toBe(1);
    expect(c.cost).toBe(10);
  });

  test("grazing within the edge margin counts as crossing", () => {
    const atoms: VisualAtom[] = [{ kind: "replaced", top: 100, bottom: 200 }];
    expect(cutCost(atoms, 98).cost).toBeGreaterThan(0); // 2px above the top edge
    expect(cutCost(atoms, 90).cost).toBe(0);
  });

  test("soft boxes cost less than hard atoms", () => {
    const atoms: VisualAtom[] = [
      { kind: "box", top: 100, bottom: 200 },
      { kind: "text-line", top: 100, bottom: 200 },
    ];
    const c = cutCost(atoms, 150);
    expect(c.cost).toBe(11);
    expect(c.hard).toBe(1);
  });
});

describe("snappedBandRects", () => {
  test("empty span yields nothing", () => {
    const { rects, seams } = snappedBandRects(0, 0, 0, 800, [], OPTS);
    expect(rects.length).toBe(0);
    expect(seams.length).toBe(0);
  });

  test("short page is one tile, no seams", () => {
    const { rects, seams } = snappedBandRects(0, 900, 0, 800, [], OPTS);
    expect(rects.length).toBe(1);
    expect(rects[0]).toEqual({ index: 0, x: 0, y: 0, width: 800, height: 900 });
    expect(seams.length).toBe(0);
  });

  test("seam snaps into a content gap and gets the small clean overlap", () => {
    // Text fills [0, 1250] and [1330, 2600]; the only clean zone near the
    // 1400 target is the [1268, 1326] gap.
    const atoms = [...paragraph(0, 52), ...paragraph(1330, 53)];
    const { rects, seams } = snappedBandRects(0, 2800, 0, 800, atoms, OPTS);
    expect(seams[0].clean).toBe(true);
    expect(seams[0].y).toBeGreaterThan(1250);
    expect(seams[0].y).toBeLessThan(1330);
    // clean seam → next band starts 16px above the cut, not 120px
    expect(rects[1].y).toBe(seams[0].y - 16);
  });

  test("solid content falls back to a dirty cut at the target with full overlap", () => {
    // One replaced element spanning the whole search window: no clean cut.
    const atoms: VisualAtom[] = [{ kind: "replaced", top: 0, bottom: 2000 }];
    const { rects, seams } = snappedBandRects(0, 2800, 0, 800, atoms, OPTS);
    expect(seams[0].clean).toBe(false);
    expect(seams[0].hard).toBe(1);
    // widest equal-cost run spans the whole window; its center sits at
    // target − slack/2, and the dirty overlap applies below it
    expect(rects[1].y).toBe(seams[0].y - 120);
  });

  test("seams never move below the target nor above the minimum band height", () => {
    const atoms = paragraph(0, 200); // dense text everywhere
    const { rects, seams } = snappedBandRects(0, 6000, 0, 800, atoms, OPTS);
    for (const [i, s] of seams.entries()) {
      const bandTop = rects[i].y;
      expect(s.y - bandTop).toBeLessThanOrEqual(1400);
      expect(s.y - bandTop).toBeGreaterThanOrEqual(700);
    }
  });

  test("no-atom input matches fixed-band coverage: contiguous, full span", () => {
    const { rects } = snappedBandRects(0, 5000, 0, 800, [], OPTS);
    expect(rects[0].y).toBe(0);
    const last = rects[rects.length - 1];
    expect(last.y + last.height).toBe(5000);
    for (let i = 1; i < rects.length; i++) {
      // each band starts at or above the previous band's bottom (overlap ≥ 0)
      expect(rects[i].y).toBeLessThanOrEqual(rects[i - 1].y + rects[i - 1].height);
    }
  });
});

describe("bandOversizedRect", () => {
  const rect = { label: "figure#tall-chart", x: 40, y: 3000, width: 900, height: 1800 };

  test("splits an over-tall element into labeled parts covering the full rect", () => {
    const parts = bandOversizedRect(rect, [], OPTS);
    expect(parts.length).toBe(2);
    expect(parts[0].label).toBe("figure#tall-chart (1/2)");
    expect(parts[1].label).toBe("figure#tall-chart (2/2)");
    expect(parts[0].y).toBe(3000);
    const last = parts[parts.length - 1];
    expect(last.y + last.height).toBe(4800);
    for (const p of parts) expect(p.x).toBe(40);
  });

  test("leaves elements within 1.25x of the budget whole", () => {
    const small = { ...rect, height: 1700 };
    expect(bandOversizedRect(small, [], OPTS)).toEqual([small]);
  });
});
