// Visual-result reuse for critique tiles (plan 3.3): avoid re-judging pixels
// that did not change.
//
// Two mechanisms share this module; which is primary was decided by the
// Stage 0 byte-stability experiment, not preference:
//
//   Path B (primary): band-level pixel diff. Compare each candidate tile's
//   document-space rect in the CURRENT full-page screenshot against the SAME
//   rect in the persisted baseline screenshot (qa-snapshot.ts), with
//   pixelmatch's anti-aliasing tolerance. At or below a strict mismatch
//   ratio (default 0.001), the tile region provably didn't change and the
//   provider call is skipped. No byte identity required, so font
//   rasterization and raster-path drift don't defeat it.
//
//   Path A (observe mode: key computation + logging only): the Stage 0
//   byte-stability experiment PASSED its gate (100% cross-restart identical
//   bands on real pages, same-day/same-machine, deterministic settle), so an
//   exact-digest cache is viable — but Path B subsumes its win (a
//   byte-identical band pixel-diffs at ratio 0) with zero extra storage, so
//   only the versioned cache key ships until telemetry shows a payoff Path B
//   misses (e.g. cross-target tile sharing).
//
// Hard rules, both paths: never convert a prior failure into a pass — any
// baseline finding overlapping a tile's region forces a fresh review; a
// missing/invalid baseline, changed rubric, or changed critique contract is
// a miss, never an error.

import { createHash } from "node:crypto";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CritiqueFinding, CritiqueTile } from "./critique.js";
import { fnv1a32 } from "./qa-plan.js";

/** Bump when the critique request/response contract changes in a way that
 * invalidates persisted findings (rubric semantics, finding schema, tiling
 * geometry meaning). Part of every cache key and persisted critique. */
export const QA_CRITIQUE_CONTRACT_VERSION = 1;

/** Default Path B mismatch-ratio threshold. Strict on purpose: reuse trades
 * essentially nothing for robustness against rasterization noise, and a
 * looser threshold could hide a sub-threshold real change. */
export const DEFAULT_REUSE_MISMATCH_RATIO = 0.001;

/** Critique results persisted beside a QA snapshot, enough to decide reuse
 * later: findings plus the geometry they were judged under. */
export interface PersistedCritique {
  contract_version: number;
  /** fnv1a32 of the exact rubric text the findings were judged under. */
  rubric_digest: string;
  outcome: "pass" | "fail";
  findings: CritiqueFinding[];
  tiles: Array<{
    index: number;
    label: string;
    x: number;
    scrollY: number;
    width: number;
    height: number;
  }>;
}

/** Versioned, canonicalized Path A cache key (observe mode). Field order is
 * part of the contract — never reorder without bumping the version. */
export function qaTileCacheKey(parts: {
  tilePngSha256: string;
  rubricDigest: string;
  provider: string;
  model: string;
  viewport: string;
  deviceScaleFactor: number;
  theme: string;
  state: string;
  tileLabel: string;
  browserVersion?: string;
}): string {
  const canonical = [
    `v${QA_CRITIQUE_CONTRACT_VERSION}`,
    `png:${parts.tilePngSha256}`,
    `rubric:${parts.rubricDigest}`,
    `provider:${parts.provider}`,
    `model:${parts.model}`,
    `viewport:${parts.viewport}`,
    `dpr:${parts.deviceScaleFactor}`,
    `theme:${parts.theme}`,
    `state:${parts.state}`,
    `tile:${parts.tileLabel}`,
    `browser:${parts.browserVersion ?? "unknown"}`,
  ].join("\x1f");
  return `qa1-${createHash("sha256").update(canonical).digest("hex")}`;
}

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function rubricDigest(rubric: string): string {
  // Whitespace-normalized so formatting-only edits don't invalidate reuse.
  return fnv1a32(rubric.replace(/\s+/g, " ").trim());
}

function cropRegion(
  png: PNG,
  rect: { x: number; y: number; width: number; height: number },
): PNG | null {
  const sx = Math.max(0, Math.min(Math.round(rect.x), png.width - 1));
  const sy = Math.max(0, Math.min(Math.round(rect.y), png.height - 1));
  const w = Math.min(Math.round(rect.width), png.width - sx);
  const h = Math.min(Math.round(rect.height), png.height - sy);
  if (w <= 0 || h <= 0) return null;
  const out = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const srcStart = ((sy + row) * png.width + sx) * 4;
    png.data.copy(out.data, row * w * 4, srcStart, srcStart + w * 4);
  }
  return out;
}

/**
 * Pixel-compare one document-space rect across two full-page screenshots.
 * `sizeMismatch` is true when the rect isn't fully comparable in both images
 * (page grew/shrank past it) — the caller treats that as changed.
 */
export function rectMismatch(
  baselineFullPage: PNG,
  currentFullPage: PNG,
  rect: { x: number; y: number; width: number; height: number },
  opts: { pixelThreshold?: number } = {},
): { ratio: number; comparablePixels: number; sizeMismatch: boolean } {
  const base = cropRegion(baselineFullPage, rect);
  const cur = cropRegion(currentFullPage, rect);
  if (!base || !cur || base.width !== cur.width || base.height !== cur.height) {
    return { ratio: 1, comparablePixels: 0, sizeMismatch: true };
  }
  const mismatched = pixelmatch(base.data, cur.data, undefined, base.width, base.height, {
    threshold: opts.pixelThreshold ?? 0.1,
    includeAA: false,
  });
  const total = base.width * base.height;
  return { ratio: mismatched / total, comparablePixels: total, sizeMismatch: false };
}

export interface TileReuseDecision {
  index: number;
  label: string;
  reuse: boolean;
  reason: string;
  /** Rect mismatch ratio, present when a pixel comparison ran. */
  mismatch_ratio?: number;
}

export interface CritiqueReusePlan {
  mode: "band-diff";
  /** Tiles that must be reviewed fresh, in original order. */
  review: CritiqueTile[];
  decisions: TileReuseDecision[];
  tiles_total: number;
  tiles_reused: number;
  tiles_reviewed: number;
  provider_calls_avoided: number;
  mismatch_threshold: number;
  /** Set when the whole baseline was unusable (everything reviews fresh). */
  invalidation?: string;
}

function wholeRunMiss(
  tiles: CritiqueTile[],
  threshold: number,
  invalidation: string,
): CritiqueReusePlan {
  return {
    mode: "band-diff",
    review: tiles,
    decisions: tiles.map((t) => ({
      index: t.index,
      label: t.label,
      reuse: false,
      reason: invalidation,
    })),
    tiles_total: tiles.length,
    tiles_reused: 0,
    tiles_reviewed: tiles.length,
    provider_calls_avoided: 0,
    mismatch_threshold: threshold,
    invalidation,
  };
}

/**
 * Path B reuse plan: decide per tile whether the baseline run's verdict still
 * covers it. A tile is reused ONLY when (a) the baseline is valid for this
 * rubric and contract, (b) no baseline finding overlaps the tile's document
 * region (a prior failure is never converted into a pass), and (c) its rect
 * pixel-matches the baseline screenshot at or below the strict threshold.
 * Everything else reviews fresh — reuse can produce false REVIEWS, never
 * false passes.
 */
export function planCritiqueReuse(args: {
  baselineScreenshot: Buffer;
  baselineCritique: PersistedCritique;
  currentScreenshot: Buffer;
  tiles: CritiqueTile[];
  rubric: string;
  mismatchThreshold?: number;
}): CritiqueReusePlan {
  const threshold = args.mismatchThreshold ?? DEFAULT_REUSE_MISMATCH_RATIO;
  const { baselineCritique, tiles } = args;
  if (baselineCritique.contract_version !== QA_CRITIQUE_CONTRACT_VERSION) {
    return wholeRunMiss(
      tiles,
      threshold,
      `baseline critique contract v${baselineCritique.contract_version} != v${QA_CRITIQUE_CONTRACT_VERSION}`,
    );
  }
  if (baselineCritique.rubric_digest !== rubricDigest(args.rubric)) {
    return wholeRunMiss(tiles, threshold, "rubric changed since the baseline run");
  }
  let baselinePng: PNG;
  let currentPng: PNG;
  try {
    baselinePng = PNG.sync.read(args.baselineScreenshot);
    currentPng = PNG.sync.read(args.currentScreenshot);
  } catch {
    return wholeRunMiss(tiles, threshold, "unreadable baseline or current screenshot");
  }

  // Document regions of baseline tiles that produced findings.
  const findingTiles = new Set(baselineCritique.findings.map((f) => f.tile));
  const dirtyRegions = baselineCritique.tiles
    .filter((t) => findingTiles.has(t.index))
    .map((t) => ({ top: t.scrollY, bottom: t.scrollY + t.height }));

  const decisions: TileReuseDecision[] = [];
  const review: CritiqueTile[] = [];
  for (const tile of tiles) {
    const top = tile.scrollY;
    const bottom = tile.scrollY + tile.height;
    const overlapsFinding = dirtyRegions.some((r) => r.top < bottom && r.bottom > top);
    if (overlapsFinding) {
      decisions.push({
        index: tile.index,
        label: tile.label,
        reuse: false,
        reason: "baseline run had findings in this region — always re-reviewed",
      });
      review.push(tile);
      continue;
    }
    const rect = { x: tile.x ?? 0, y: tile.scrollY, width: tile.width, height: tile.height };
    const cmp = rectMismatch(baselinePng, currentPng, rect);
    if (cmp.sizeMismatch || cmp.ratio > threshold) {
      decisions.push({
        index: tile.index,
        label: tile.label,
        reuse: false,
        reason: cmp.sizeMismatch
          ? "region not comparable across screenshots (layout size changed)"
          : `mismatch ratio ${cmp.ratio.toFixed(6)} > ${threshold}`,
        mismatch_ratio: cmp.sizeMismatch ? undefined : cmp.ratio,
      });
      review.push(tile);
      continue;
    }
    decisions.push({
      index: tile.index,
      label: tile.label,
      reuse: true,
      reason: `clean region pixel-matched baseline (ratio ${cmp.ratio.toFixed(6)})`,
      mismatch_ratio: cmp.ratio,
    });
  }
  return {
    mode: "band-diff",
    review,
    decisions,
    tiles_total: tiles.length,
    tiles_reused: tiles.length - review.length,
    tiles_reviewed: review.length,
    provider_calls_avoided: tiles.length - review.length,
    mismatch_threshold: threshold,
  };
}
