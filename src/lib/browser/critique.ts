// Vision-model page critic for `harn browse --check-critique`.
//
// Heuristic checks only catch what we can enumerate. The reason a human still
// eyeballs a page is the long tail — the odd thing that "looks off" without
// tripping a named rule. This hands a rendered page to a vision model and asks
// for that judgement, structured.
//
// Two things keep it honest:
//   1. Tiling. A tall page screenshotted whole and downscaled to a model's
//      input budget loses the detail the critique depends on. So the page is
//      cut into overlapping vertical bands (or one tile per selector match),
//      each captured at full resolution and judged on its own, with findings
//      tagged by tile + document scroll offset for locality.
//   2. Injection. harnery ships no model client and no API key. The host wires
//      a `critiqueProvider` into the program context (same pattern as
//      `extraHeaders`); without one, the check reports `skipped`, never a
//      false pass. That keeps this portable — the tiling, prompt, and
//      orchestration live here; the model call lives in the host.

import { PNG } from "pngjs";
import { bandOversizedRect, snappedBandRects, type VisualAtom } from "./tiling.js";

export interface CritiqueTile {
  index: number;
  /** Section label or "band N", for locating a finding. */
  label: string;
  /** Document-space Y offset of the tile's top, so findings map to a place. */
  scrollY: number;
  /** Document-space X offset (0 for full-width bands; element-relative for
   * selector tiles). Optional for backward compatibility — treat absent as 0. */
  x?: number;
  width: number;
  height: number;
  /** Base64 PNG of the tile (no data: prefix). */
  pngBase64: string;
}

export interface CritiqueFinding {
  tile: number;
  severity: "high" | "medium" | "low";
  category: string;
  description: string;
}

export interface CritiqueResult {
  rule: "critique";
  /** Number of tiles the page was cut into. */
  tiles: number;
  /** Whether a provider was available. False → outcome "skipped". */
  provider: boolean;
  findings: CritiqueFinding[];
  outcome: "pass" | "fail" | "skipped";
  /** Set when skipped or a provider call failed. */
  error?: string;
  /** Host-reported provider provenance (route, attempts, fallbacks, usage). */
  provider_meta?: Record<string, unknown>;
}

/**
 * The host-injected model call. Given one tile and the rubric, return the
 * findings for that tile. Throwing is caught and surfaced as an error finding
 * so one bad tile never sinks the run.
 *
 * Optional properties let the host shape execution without widening the call
 * contract: `concurrency` caps how many tiles run at once (default 4 — tiles
 * are independent, and the wall-clock win is roughly the cap factor), and
 * `meta()` is read once after the run so route/usage provenance lands on the
 * result envelope.
 */
export type CritiqueProvider = ((input: {
  url: string;
  rubric: string;
  tile: CritiqueTile;
}) => Promise<CritiqueFinding[]>) & {
  concurrency?: number;
  meta?: () => Record<string, unknown> | undefined;
  /** Long-edge pixel budget of the routed model's vision input. The tiler
   * clamps band height to it so tiles are never downscaled by the provider. */
  tileBudgetPx?: number;
};

export const DEFAULT_CRITIQUE_RUBRIC = [
  "You are reviewing one vertical slice of a rendered web page for visual defects.",
  "Report ONLY concrete, visible problems a careful designer would flag:",
  "- text cut off, overlapping, or colliding with other elements",
  "- text that is hard to read against its background (low contrast)",
  "- misaligned or unevenly spaced elements; two blocks touching with no gap",
  "- broken, distorted, or missing images",
  "- leaked template tokens, placeholder text, or obviously wrong values",
  "- anything that looks broken, unfinished, or accidental",
  "The slice's own top and bottom edges cut through the page at arbitrary points:",
  "content cropped by the slice boundary itself (a heading, row, or paragraph",
  "entering or leaving the frame) is a tiling artifact, NOT a defect - never report it.",
  "Only report clipping that happens at an element's own container edge inside the slice.",
  "Do NOT comment on content quality, wording, tone, or subjective taste.",
  "If the slice looks fine, return an empty list. Be precise and terse.",
  "Return JSON only: an array of objects",
  '{"severity":"high|medium|low","category":"<short-slug>","description":"<one sentence>"}.',
].join("\n");

/**
 * Cut a page of height `pageHeight` into overlapping vertical bands. Pure math
 * so the caller (which owns the page) can screenshot each `clip` rect. The
 * overlap keeps a finding that straddles a seam visible in at least one tile.
 */
export function bandRects(
  pageHeight: number,
  pageWidth: number,
  bandHeight: number,
  overlap: number,
): Array<{ index: number; x: number; y: number; width: number; height: number }> {
  const bands: Array<{ index: number; x: number; y: number; width: number; height: number }> = [];
  if (pageHeight <= 0 || pageWidth <= 0) return bands;
  const step = Math.max(1, bandHeight - overlap);
  let index = 0;
  for (let y = 0; y < pageHeight; y += step) {
    const height = Math.min(bandHeight, pageHeight - y);
    bands.push({ index, x: 0, y, width: pageWidth, height });
    index++;
    if (y + height >= pageHeight) break;
  }
  return bands;
}

/**
 * Cut tiles out of ONE full-page screenshot with pngjs. Playwright's own
 * `clip` is viewport-relative, so a band below the fold errors with "clipped
 * area outside the resulting image" — capturing the whole page once and
 * cropping in pixel space sidesteps that and keeps every tile at full
 * resolution. Pass `elementRects` for semantic (per-element) tiling; otherwise
 * the page is banded from the actual image height. Rects are clamped to the
 * image so an off-by-one never throws.
 *
 * When `atoms` are supplied (see tiling.ts), band seams snap into content
 * gaps instead of cutting at fixed offsets, and element rects taller than the
 * band budget are banded internally rather than shipped as one over-tall tile
 * the provider would downscale. Atom coordinates must be in the same pixel
 * space as the screenshot (identical at deviceScaleFactor 1; scale them if
 * the capture DPR differs).
 */
export function tilesFromFullPage(
  fullPageBuffer: Buffer,
  opts: {
    elementRects?: Array<{ label: string; x: number; y: number; width: number; height: number }>;
    bandHeight?: number;
    overlap?: number;
    maxTiles: number;
    atoms?: VisualAtom[];
  },
): CritiqueTile[] {
  const png = PNG.sync.read(fullPageBuffer);
  const snapOpts = {
    bandHeight: opts.bandHeight ?? 1400,
    overlap: opts.overlap ?? 120,
  };
  let rects: Array<{
    index: number;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  if (opts.elementRects && opts.elementRects.length > 0) {
    const expanded = opts.atoms
      ? opts.elementRects.flatMap((r) => bandOversizedRect(r, opts.atoms ?? [], snapOpts))
      : opts.elementRects;
    rects = expanded.map((r, index) => ({ index, ...r }));
  } else if (opts.atoms && opts.atoms.length > 0) {
    rects = snappedBandRects(0, png.height, 0, png.width, opts.atoms, snapOpts).rects.map((b) => ({
      index: b.index,
      label: `band ${b.index + 1}`,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    }));
  } else {
    rects = bandRects(png.height, png.width, snapOpts.bandHeight, snapOpts.overlap).map((b) => ({
      index: b.index,
      label: `band ${b.index + 1}`,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    }));
  }
  const tiles: CritiqueTile[] = [];
  for (const rect of rects.slice(0, opts.maxTiles)) {
    const sx = Math.max(0, Math.min(Math.round(rect.x), png.width - 1));
    const sy = Math.max(0, Math.min(Math.round(rect.y), png.height - 1));
    const w = Math.max(1, Math.min(Math.round(rect.width), png.width - sx));
    const h = Math.max(1, Math.min(Math.round(rect.height), png.height - sy));
    const dst = new PNG({ width: w, height: h });
    // Manual RGBA row copy — pngjs's bitblt isn't available under every runtime
    // (missing under Bun's build), so copy the crop window row by row instead.
    for (let row = 0; row < h; row++) {
      const srcStart = ((sy + row) * png.width + sx) * 4;
      const dstStart = row * w * 4;
      png.data.copy(dst.data, dstStart, srcStart, srcStart + w * 4);
    }
    tiles.push({
      index: rect.index,
      label: rect.label,
      scrollY: sy,
      x: sx,
      width: w,
      height: h,
      pngBase64: PNG.sync.write(dst).toString("base64"),
    });
  }
  return tiles;
}

/**
 * Validate + normalize a provider's raw output into CritiqueFindings. Tolerant
 * of a model returning a bare array or wrapping it in `{ findings: [...] }`,
 * and drops entries that are not shaped like a finding.
 */
export function normalizeFindings(raw: unknown, tile: number): CritiqueFinding[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { findings?: unknown }).findings)
      ? (raw as { findings: unknown[] }).findings
      : [];
  const severities = new Set(["high", "medium", "low"]);
  const out: CritiqueFinding[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const severity = String(record.severity ?? "low").toLowerCase();
    const description = typeof record.description === "string" ? record.description.trim() : "";
    if (!description) continue;
    out.push({
      tile,
      severity: severities.has(severity) ? (severity as CritiqueFinding["severity"]) : "low",
      category:
        typeof record.category === "string" && record.category.trim()
          ? record.category.trim()
          : "visual",
      description,
    });
  }
  return out;
}

/**
 * Run the critique over pre-captured tiles with an injected provider. Findings
 * are collected across tiles; a provider throw becomes a `high` error finding
 * for that tile rather than aborting. Outcome is `fail` when any `high` finding
 * survives (the gate escalation lives in the caller).
 */
export async function runCritique(args: {
  url: string;
  rubric: string;
  tiles: CritiqueTile[];
  provider: CritiqueProvider | undefined;
}): Promise<CritiqueResult> {
  const { url, rubric, tiles, provider } = args;
  if (!provider) {
    return {
      rule: "critique",
      tiles: tiles.length,
      provider: false,
      findings: [],
      outcome: "skipped",
      error:
        "no critiqueProvider injected by the host (see HarneryProgramContext.critiqueProvider)",
    };
  }
  // Tiles are judged independently, so run them concurrently (bounded) and
  // reassemble findings in tile order so artifacts stay deterministic.
  const concurrency = Math.max(1, Math.min(provider.concurrency ?? 4, tiles.length || 1));
  const perTile: CritiqueFinding[][] = tiles.map(() => []);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= tiles.length) return;
      const tile = tiles[i];
      try {
        const tileFindings = await provider({ url, rubric, tile });
        perTile[i] = tileFindings.map((f) => ({ ...f, tile: tile.index }));
      } catch (err: unknown) {
        perTile[i] = [
          {
            tile: tile.index,
            severity: "high",
            category: "provider-error",
            description: `critique provider failed on ${tile.label}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ];
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const findings = perTile.flat();
  const outcome = findings.some((f) => f.severity === "high") ? "fail" : "pass";
  const meta = provider.meta?.();
  return {
    rule: "critique",
    tiles: tiles.length,
    provider: true,
    findings,
    outcome,
    ...(meta ? { provider_meta: meta } : {}),
  };
}
