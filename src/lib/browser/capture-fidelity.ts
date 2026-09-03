// Capture-fidelity probe for page review packs (pure: no browser, no src/core).
//
// A full-page screenshot of a very tall page can carry raster artifacts (a
// blank block, a callout clipped mid-sentence) that a viewport render of the
// same region does not show. While the capture browser is still open, the
// capture branch re-shoots every band by scroll-and-clip and pixel compares
// each with the crop the tiler took from the full-page image. When any band
// disagrees, the tiles are re-cut from those scrolled captures and the
// context records `capture_fidelity.source = "scrolled-bands"`.
//
// This module owns the parts that need no browser: the comparison, the
// decision, and the row stitch that joins viewport-height pieces into one
// band capture. `client.ts` owns the scroll-and-clip itself.

import { PNG } from "pngjs";
import type { PageReviewCaptureFidelity } from "./page-review-pack.js";
import { DEFAULT_REUSE_MISMATCH_RATIO, rectMismatch } from "./qa-reuse.js";

/** The band-diff reuse threshold doubles as the fidelity threshold: a probe
 * that would count as "unchanged" for reuse counts as "agrees" here. */
export const CAPTURE_FIDELITY_MISMATCH_THRESHOLD = DEFAULT_REUSE_MISMATCH_RATIO;

export type FidelityProbe = PageReviewCaptureFidelity["probed"][number];

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

/** Crop already decoded native pixels; callers reuse one decode across all selected rectangles. */
export function cropNativePng(
  png: PNG,
  rect: { x: number; y: number; width: number; height: number },
): Buffer {
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > png.width ||
    rect.y + rect.height > png.height
  )
    throw new Error("Native capture rectangle lies outside the image.");
  const out = new PNG({ width: rect.width, height: rect.height });
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.y + y) * png.width + rect.x) * 4;
    png.data.copy(out.data, y * rect.width * 4, start, start + rect.width * 4);
  }
  return PNG.sync.write(out);
}
