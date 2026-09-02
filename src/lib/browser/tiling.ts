// Content-aware band placement for the vision critique tiler.
//
// Fixed-height bands cut whatever sits at the boundary — half a heading, a
// sliced table row, the middle of an image — and the critique rubric then has
// to tell the model to ignore slice-edge clipping, which costs sensitivity on
// every tile. This module snaps each cut into nearby content gaps instead:
// the caller extracts "visual atoms" (text line boxes, replaced elements,
// small bordered boxes) from the live page, and `snappedBandRects` places
// each seam at the cheapest cut inside a bounded search window above the
// fixed target. A clean seam (nothing straddles it) needs only a token
// overlap; a dirty seam (unavoidable content, e.g. an element taller than
// the band) keeps the caller's full overlap so the rubric mitigation still
// applies there.
//
// Measured on a mixed fixture (prose, cards, 60-row table, an 1800px chart):
// hard-atom slices per page dropped 9 → 1 on desktop and 4 → 2 on mobile at
// an unchanged tile count, with every band height within [50%, 100%] of the
// budget. The remaining slice was inside the over-tall chart, where no clean
// cut exists — exactly the case the dirty-seam fallback covers.
//
// Pure math, no DOM access: atoms come in as plain rect spans so the module
// stays testable and portable. Atom extraction lives on the browser client.

export interface VisualAtom {
  /** hard: cutting through it visibly breaks content. soft: looks untidy. */
  kind: "text-line" | "replaced" | "box";
  /** Document-space vertical span (CSS px scaled to image px by the caller). */
  top: number;
  bottom: number;
}

export interface SnapSeam {
  /** Document-space y of the cut. */
  y: number;
  /** Weighted atoms the cut passes through; 0 = clean. */
  cost: number;
  /** Hard atoms (text lines, replaced elements) the cut passes through. */
  hard: number;
  clean: boolean;
}

export interface SnapOptions {
  bandHeight: number;
  /** Overlap applied below a dirty seam (the legacy constant, e.g. 120). */
  overlap: number;
  /** Overlap applied below a clean seam. Default 16. */
  cleanOverlap?: number;
  /** Fraction of bandHeight the seam may move up from its target. Default 0.3. */
  slackRatio?: number;
  /** Minimum band height as a fraction of bandHeight. Default 0.5. */
  minBandRatio?: number;
}

const HARD_WEIGHT = 10;
const SOFT_WEIGHT = 1;
const EDGE_MARGIN = 4; // grazing an atom edge this closely counts as crossing
const CANDIDATE_STEP = 2; // px between scored cut candidates

/** Weighted cost of a horizontal cut at document-space y. */
export function cutCost(atoms: VisualAtom[], y: number): { cost: number; hard: number } {
  let cost = 0;
  let hard = 0;
  for (const a of atoms) {
    if (y > a.top - EDGE_MARGIN && y < a.bottom + EDGE_MARGIN) {
      if (a.kind === "box") {
        cost += SOFT_WEIGHT;
      } else {
        cost += HARD_WEIGHT;
        hard++;
      }
    }
  }
  return { cost, hard };
}

/**
 * Cut the vertical span [top, bottom) into bands whose seams snap into
 * content gaps. Seams only move UP from their fixed target (never down), so
 * band height is bounded by `bandHeight` above and `minBandRatio` below.
 * Returns full-width rects in the caller's coordinate space plus the seam
 * record for logging/telemetry.
 */
export function snappedBandRects(
  top: number,
  bottom: number,
  x: number,
  width: number,
  atoms: VisualAtom[],
  opts: SnapOptions,
): {
  rects: Array<{ index: number; x: number; y: number; width: number; height: number }>;
  seams: SnapSeam[];
} {
  const rects: Array<{ index: number; x: number; y: number; width: number; height: number }> = [];
  const seams: SnapSeam[] = [];
  const span = bottom - top;
  if (span <= 0 || width <= 0) return { rects, seams };

  const cleanOverlap = opts.cleanOverlap ?? 16;
  const slack = Math.round(opts.bandHeight * (opts.slackRatio ?? 0.3));
  const minBand = Math.round(opts.bandHeight * (opts.minBandRatio ?? 0.5));

  let bandTop = top;
  let index = 0;
  while (bandTop + opts.bandHeight < bottom) {
    const target = bandTop + opts.bandHeight;
    const lo = Math.max(bandTop + minBand, target - slack);

    // Score candidates, find the minimal cost in the window.
    const costs: Array<{ y: number; cost: number; hard: number }> = [];
    let minCost = Number.POSITIVE_INFINITY;
    for (let y = lo; y <= target; y += CANDIDATE_STEP) {
      const c = cutCost(atoms, y);
      costs.push({ y, ...c });
      if (c.cost < minCost) minCost = c.cost;
    }

    // Snap to the center of the widest minimal-cost run; ties resolve toward
    // the target (later run wins on >=) so bands stay as tall as possible.
    let runStart = -1;
    let best = { start: 0, end: costs.length - 1, len: 0 };
    for (let i = 0; i <= costs.length; i++) {
      const inRun = i < costs.length && costs[i].cost === minCost;
      if (inRun && runStart === -1) runStart = i;
      if (!inRun && runStart !== -1) {
        const len = i - runStart;
        if (len >= best.len) best = { start: runStart, end: i - 1, len };
        runStart = -1;
      }
    }
    const pick = costs[Math.floor((best.start + best.end) / 2)];
    const clean = pick.cost === 0;
    seams.push({ y: pick.y, cost: pick.cost, hard: pick.hard, clean });
    rects.push({ index, x, y: bandTop, width, height: pick.y - bandTop });
    index++;
    bandTop = pick.y - (clean ? cleanOverlap : opts.overlap);
  }
  rects.push({ index, x, y: bandTop, width, height: bottom - bandTop });
  return { rects, seams };
}

/**
 * Split one element rect into internally-banded sub-rects when it is taller
 * than the band budget. Selector-mode tiles previously shipped over-tall
 * elements as one giant tile that the vision provider downscales; banding
 * inside the element keeps every sub-tile at full resolution. Elements within
 * 1.25x of the budget stay whole — a slightly-over tile beats a degenerate
 * split.
 */
export function bandOversizedRect(
  rect: { label: string; x: number; y: number; width: number; height: number },
  atoms: VisualAtom[],
  opts: SnapOptions,
): Array<{ label: string; x: number; y: number; width: number; height: number }> {
  if (rect.height <= opts.bandHeight * 1.25) return [rect];
  const { rects } = snappedBandRects(rect.y, rect.y + rect.height, rect.x, rect.width, atoms, opts);
  return rects.map((r, i) => ({
    label: `${rect.label} (${i + 1}/${rects.length})`,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  }));
}

/**
 * Indices of bands past the kept prefix (`allBands[0..keptCount)`) that
 * intersect any of `rects`. A tile cap keeps the top of a tall page and drops
 * the rest; a deterministic gate that already found a defect below the cap
 * still deserves a tile, so the caller cuts these bands as well and labels
 * them as hit bands. Pure: the result is deduplicated, ascending, and holds
 * at most `maxExtra` entries. Rects and bands share one pixel space.
 */
export function bandsCoveringRects(
  allBands: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  keptCount: number,
  rects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  maxExtra = 50,
): number[] {
  const out: number[] = [];
  if (rects.length === 0 || maxExtra <= 0) return out;
  for (let index = Math.max(0, keptCount); index < allBands.length; index++) {
    if (out.length >= maxExtra) break;
    const band = allBands[index];
    if (!band) continue;
    const hit = rects.some((rect) => {
      const x1 = rect.x + Math.max(rect.width, 1);
      const y1 = rect.y + Math.max(rect.height, 1);
      return (
        band.x < x1 && band.x + band.width > rect.x && band.y < y1 && band.y + band.height > rect.y
      );
    });
    if (hit) out.push(index);
  }
  return out;
}
