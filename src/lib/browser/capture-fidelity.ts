// Capture-fidelity probe for page review packs (pure: no browser, no src/core).
//
// A full-page screenshot of a very tall page can carry raster artifacts (a
// blank block, a callout clipped mid-sentence) that a viewport render of the
// same region does not show. While the capture browser is still open, the
// capture branch re-shoots a couple of bands by scroll-and-clip and pixel
// compares them with the crop the tiler took from the full-page image. When
// they disagree, every band is re-cut from scrolled captures and the context
// records `capture_fidelity.source = "scrolled-bands"`.
//
// This module owns the parts that need no browser: which bands to probe, the
// comparison, the decision, and the row stitch that joins viewport-height
// pieces into one band capture. `client.ts` owns the scroll-and-clip itself.

import { PNG } from "pngjs";
import type { PageReviewCaptureFidelity } from "./page-review-pack.js";
import { DEFAULT_REUSE_MISMATCH_RATIO, rectMismatch } from "./qa-reuse.js";

/** The band-diff reuse threshold doubles as the fidelity threshold: a probe
 * that would count as "unchanged" for reuse counts as "agrees" here. */
export const CAPTURE_FIDELITY_MISMATCH_THRESHOLD = DEFAULT_REUSE_MISMATCH_RATIO;

export type FidelityProbe = PageReviewCaptureFidelity["probed"][number];

/**
 * The bands worth re-shooting: the top band and the middle band (by document
 * position). Two probes catch the two failure shapes seen so far, a page that
 * renders wrong from the start and one whose full-page raster degrades some
 * way down, without paying for every band up front. Returns one band when the
 * page has fewer than two.
 */
export function chooseProbeBands<T extends { scrollY: number }>(tiles: readonly T[]): T[] {
  if (tiles.length === 0) return [];
  const ordered = [...tiles].sort((a, b) => a.scrollY - b.scrollY);
  const top = ordered[0] as T;
  const middle = ordered[Math.floor(ordered.length / 2)] as T;
  return middle === top ? [top] : [top, middle];
}

/**
 * Pixel-compare a band cropped from the full-page screenshot with the same
 * band captured by scrolling. `mismatch_ratio` is measured over the area the
 * two images share (pixelmatch, anti-aliasing tolerant, the same math as
 * band-diff reuse). `size_mismatch` is set when the two differ by more than a
 * rounding pixel in either dimension; the caller treats that probe as
 * inconclusive rather than as proof the full page is wrong, because a page
 * wider than the viewport cannot be rendered whole by scrolling.
 */
export function compareBand(
  fullPageCrop: PNG,
  scrolledCapture: PNG,
  threshold: number = CAPTURE_FIDELITY_MISMATCH_THRESHOLD,
): { mismatch_ratio: number; exceeds: boolean; size_mismatch: boolean } {
  const width = Math.min(fullPageCrop.width, scrolledCapture.width);
  const height = Math.min(fullPageCrop.height, scrolledCapture.height);
  const size_mismatch =
    Math.abs(fullPageCrop.width - scrolledCapture.width) > 1 ||
    Math.abs(fullPageCrop.height - scrolledCapture.height) > 1;
  if (width <= 0 || height <= 0) return { mismatch_ratio: 1, exceeds: true, size_mismatch: true };
  const cmp = rectMismatch(fullPageCrop, scrolledCapture, { x: 0, y: 0, width, height });
  return { mismatch_ratio: cmp.ratio, exceeds: cmp.ratio > threshold, size_mismatch };
}

/**
 * Turn the probe results into the record the context carries. Any probe over
 * the threshold means the full-page screenshot is not trustworthy for this
 * context and the tiles must come from scrolled captures.
 */
export function decideFidelity(
  probes: readonly FidelityProbe[],
  threshold: number = CAPTURE_FIDELITY_MISMATCH_THRESHOLD,
): PageReviewCaptureFidelity {
  const mismatched = probes
    .filter((probe) => probe.mismatch_ratio > threshold)
    .map((probe) => probe.tile_id);
  return {
    source: mismatched.length > 0 ? "scrolled-bands" : "full-page",
    probed: probes.map((probe) => ({ ...probe })),
    mismatched,
    mismatch_threshold: threshold,
  };
}

/**
 * Join PNG pieces top to bottom into one image. The output takes the first
 * piece's width; a narrower piece leaves transparent pixels on its right, a
 * wider one is cropped. Used to assemble a band taller than the viewport from
 * viewport-height captures (see `Browser.captureRegionByScroll`).
 */
export function stitchPngRows(pieces: readonly Buffer[]): Buffer {
  const first = pieces[0];
  if (!first) throw new Error("stitchPngRows: at least one piece is required");
  if (pieces.length === 1) return first;
  const decoded = pieces.map((piece) => PNG.sync.read(piece));
  const width = (decoded[0] as PNG).width;
  const height = decoded.reduce((sum, piece) => sum + piece.height, 0);
  const out = new PNG({ width, height });
  let row = 0;
  for (const piece of decoded) {
    const copyWidth = Math.min(width, piece.width);
    for (let y = 0; y < piece.height; y++) {
      const srcStart = y * piece.width * 4;
      piece.data.copy(out.data, (row + y) * width * 4, srcStart, srcStart + copyWidth * 4);
    }
    row += piece.height;
  }
  return PNG.sync.write(out);
}

/** Width and height from a PNG header, without decoding the image. */
export function pngDimensions(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
