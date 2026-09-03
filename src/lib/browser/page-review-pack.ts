// Page review pack: the on-disk evidence for reviewing one rendered page
// without a browser. A pack holds, per rendering context (viewport × theme ×
// state), the full-page screenshot, its critique tiles as PNG files, the
// serialized DOM, and the QA signature; plus a `review.md` entry point, a
// bounded inspection plan, coverage, and a delegated-review `findings.json`.
//
// The split this enables: capture (needs a browser, seconds) and judging
// (vision calls, minutes) become separate stages. Every browser is closed
// before the first model call, and one bounded pool judges every tile of
// every context from disk. Tile PNGs are the evidence; every other file in
// the pack is navigation.
//
// Toolkit tier: this module must not import src/core (layering check).

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { PNG } from "pngjs";
import type { CritiqueCoverage, CritiqueFinding, CritiqueTile } from "./critique.js";
import type {
  PageReviewBudgetCoverage,
  PageReviewCapturePlan,
  PageReviewEvidenceContext,
  PageReviewNativeTile,
  PageReviewRect,
} from "./page-review-contracts.js";
import { machineEvidenceDigest, PAGE_REVIEW_CRITIQUE_SCHEMA } from "./page-review-evidence.js";
import type { QaContext, QaSignature } from "./qa-plan.js";

export type { PageReviewRect } from "./page-review-contracts.js";

export const PAGE_REVIEW_PACK_SCHEMA = "harnery-page-review/v2";
export const PAGE_REVIEW_FINDINGS_SCHEMA = "harnery-page-review-findings/v3";

/** Directory name a qa-run gives its pack inside the run directory. */
export const PAGE_REVIEW_PACK_DIRNAME = "pack";

export const PAGE_REVIEW_MANIFEST_FILENAME = "manifest.json";
export const PAGE_REVIEW_REVIEW_FILENAME = "review.md";
export const PAGE_REVIEW_FINDINGS_FILENAME = "findings.json";
export const PAGE_REVIEW_FINDINGS_SCHEMA_FILENAME = "findings.schema.json";

/** How long a pack lives after its judge (or its capture, when no judge
 * runs) before the whole directory is deleted. Ruled 2026-09-02. */
export const PAGE_REVIEW_DEFAULT_RETENTION_MINUTES = 90;
/** The only file left behind when an expired pack is deleted. */
export const PAGE_REVIEW_EXPIRED_STUB_FILENAME = "pack-expired.json";

/** Reviewer dispositions a machine finding can carry in `findings.json`. */
export const PAGE_REVIEW_DISPOSITIONS = [
  "confirmed",
  "artifact",
  "not-a-defect",
  "duplicate-of-gate",
] as const;
export type PageReviewDisposition = (typeof PAGE_REVIEW_DISPOSITIONS)[number];

/** Schema id and file name of the reviewed-outcome record `review-pack verdict` writes. */
export const PAGE_REVIEW_VERDICT_SCHEMA = "harnery-page-review-verdict/v2";
export const PAGE_REVIEW_VERDICT_FILENAME = "verdict.json";

export const PAGE_REVIEW_FINDING_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
export type PageReviewFindingSeverity = (typeof PAGE_REVIEW_FINDING_SEVERITIES)[number];
export const PAGE_REVIEW_FINDING_CATEGORIES = [
  "layout",
  "typography",
  "contrast",
  "content",
  "image",
  "interaction",
  "accessibility",
  "responsiveness",
  "render-artifact",
  "coverage",
  "other",
] as const;
export type PageReviewFindingCategory = (typeof PAGE_REVIEW_FINDING_CATEGORIES)[number];

export const PAGE_REVIEW_SUBAGENT_MODELS = ["GPT-5.6 Luna", "Composer 2.5", "Haiku 4.5"] as const;
export type PageReviewSubagentModel = (typeof PAGE_REVIEW_SUBAGENT_MODELS)[number];

/** One review-subagent finding in `findings.json`. */
export interface PageReviewReviewerFinding {
  id: string;
  severity: PageReviewFindingSeverity;
  category: PageReviewFindingCategory;
  context_id: string;
  /** Tile ids (`T012`) or pack-relative file paths; never empty. */
  evidence: string[];
  observation: string;
  recommendation?: string;
  confidence?: number;
}

/** A reviewer's verdict on one machine finding in `evidence/critique.json`. */
export interface PageReviewDispositionRecord {
  /** `<context-id>/<tile-id>#<n>`, n = 0-based position among the tile's findings. */
  target: string;
  disposition: PageReviewDisposition;
  note?: string;
  by?: string;
  at?: string;
}

/** One review subagent's assigned and completed primary-tile work. */
export interface PageReviewDelegatedReviewRecord {
  reviewer: string;
  model: PageReviewSubagentModel;
  /** `<context-id>/<tile-id>` entries assigned to this subagent. */
  assigned_tiles: string[];
  /** Assigned entries the subagent actually opened at native pixels. */
  completed_tiles: string[];
  status: "complete" | "incomplete";
}

/** The delegated-review `findings.json` document. */
export interface PageReviewFindingsDocument {
  schema: string;
  schema_path?: string;
  target: string;
  reviewer: string | null;
  reviewed_at: string | null;
  machine_evidence_digest?: string | null;
  delegated_reviews: PageReviewDelegatedReviewRecord[];
  findings: PageReviewReviewerFinding[];
  dispositions?: PageReviewDispositionRecord[];
}

/** What `resolvePackVerdict` derives from the machine critique plus the reviewer's file. */
export interface PageReviewVerdict {
  machine_outcome: "pass" | "fail" | "skipped" | "incomplete";
  reviewed_outcome: "pass" | "fail" | "skipped" | "incomplete";
  /** Machine `high` findings across every judged context. */
  high_total: number;
  high_confirmed: number;
  /** Highs dispositioned `artifact`, `not-a-defect`, or `duplicate-of-gate`. */
  high_dismissed: number;
  /** Highs with no disposition; they still count against the page. */
  high_open: number;
  /** Review-subagent findings at `critical` or `high`; each counts against the page. */
  reviewer_high: number;
  /** Dispositions whose target matched a machine finding. */
  dispositions_applied: number;
  /** Disposition targets that name no machine finding in the critique. */
  unmatched_dispositions: string[];
  /** Primary tiles the inspection plan requires. */
  primary_tiles_total: number;
  /** Required tiles covered by a completed review-subagent record. */
  primary_tiles_reviewed: number;
  /** Required `<context-id>/<tile-id>` entries with no completed subagent review. */
  uncovered_primary_tiles: string[];
}

export interface PageReviewVerdictDocument extends PageReviewVerdict {
  schema: string;
  reviewed_at: string;
}

/** How a context's tiles were cut: from one full-page screenshot (the
 * default) or from per-band scrolled viewport captures (the fallback when the
 * fidelity probe proved the full-page screenshot wrong). */
export interface PageReviewCaptureFidelity {
  source: "full-page" | "scrolled-bands";
  /** Bands re-shot by scroll-and-clip and compared with the full-page capture. */
  probed: Array<{ tile_id: string; scrollY: number; height: number; mismatch_ratio: number }>;
  /** Tile ids whose probe exceeded the mismatch threshold. */
  mismatched: string[];
  mismatch_threshold: number;
}

/** Pack expiry as written into the manifest. `managed` is false for a pack
 * written to an explicit `--out`; such a pack is never deleted automatically. */
export interface PageReviewRetention {
  expires_at: string;
  managed: boolean;
}

/** One tile as stored in the pack. `id` is stable within its context
 * (`T001`, `T002`, …) and is what a finding cites. `file` is pack-relative. */
export interface PageReviewTileRecord {
  id: string;
  /** Tiler index (position in the capture's tile list). */
  index: number;
  label: string;
  /** Selector the tile was cut for; absent for full-page bands. */
  scope?: string;
  /** `band` (full-page band), `scope` (selector tile), or `hit-band` (a band
   * captured past the tile cap because a gate hit lands in it). Absent on
   * packs written before this field existed; treat as `band`/`scope` by
   * whether `scope` is set. */
  kind?: "band" | "scope" | "hit-band";
  x: number;
  scrollY: number;
  width: number;
  height: number;
  file: string;
  sha256: string;
  bytes: number;
}

/** One tile region re-captured at a higher device scale factor after the
 * original capture (`review-pack expand`). The source tile is untouched; this
 * record sits beside it. `file` is pack-relative. Optional and additive on the
 * v1 context record. */
export interface PageReviewExpandedTileRecord {
  /** Source tile id (`T012`). */
  tile: string;
  /** Device scale factor the region was rendered at (2 = twice the pixels). */
  dpr: number;
  /** Pixel size of the expanded PNG (source tile size × dpr, clamped). */
  width: number;
  height: number;
  file: string;
  sha256: string;
  bytes: number;
  captured_at: string;
}

/** The per-context contact sheet: every tile downscaled into one grid PNG
 * for orientation. Reading order is row-major (left to right, then top to
 * bottom) in tile id order; each cell carries its tile id stamped in its
 * label band. Optional and additive on the v1 context record. */
export interface PageReviewContactSheetRecord {
  file: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  cell_width: number;
  cell_height: number;
  order: "row-major";
}

export interface PageReviewContextRecord {
  id: string;
  viewport: string;
  theme: "light" | "dark";
  state: string;
  /** Rendered URL after navigation. */
  url: string;
  title?: string;
  captured_at: string;
  page: { width: number; height: number };
  viewport_size: { width: number; height: number };
  dpr: number;
  recipe_version: string;
  full_page_scale: 0.5;
  capture_plan?: PageReviewCapturePlan;
  allocation_coverage?: PageReviewBudgetCoverage;
  evidence_context?: PageReviewEvidenceContext;
  capture_incomplete?: boolean;
  /** Full-page band coverage (what the tiler kept of the page). */
  coverage: CritiqueCoverage;
  scopes: Array<{ selector: string; tiles: number }>;
  /** Pack-relative file paths. `dom` ends in `.gz` (gzip) for packs written
   * after the footprint change and in `.html` (plain) for older packs. */
  files: { full_page: string; dom: string; signature: string; tiles: string; context: string };
  dom_sha256: string;
  tiles: PageReviewTileRecord[];
  /** Higher-DPR re-captures of single tiles, in the order they were made. */
  expanded?: PageReviewExpandedTileRecord[];
  /** Downscaled grid of every tile (`contacts.png`); absent for a context with no tiles. */
  contact_sheet?: PageReviewContactSheetRecord;
  /** Where the tiles came from and what the fidelity probe saw. Absent on
   * packs written before the probe existed (tiles came from the full page). */
  capture_fidelity?: PageReviewCaptureFidelity;
  /** Bands captured past the tile cap because a gate hit lands in them. */
  hit_bands?: number;
}

/** What a capture hands the pack for one context. `tiles` are the full-page
 * bands; `scopeTiles` are selector tiles, one entry per selector. */
export interface PageReviewContextCapture {
  context: QaContext & { id?: string };
  url: string;
  title?: string;
  fullPage: Buffer;
  pageWidth: number;
  pageHeight: number;
  viewportSize: { width: number; height: number };
  dpr: number;
  recipeVersion: string;
  capturePlan?: PageReviewCapturePlan;
  allocationCoverage?: PageReviewBudgetCoverage;
  captureIncomplete?: boolean;
  tiles: CritiqueTile[];
  coverage: CritiqueCoverage;
  scopeTiles?: Array<{ selector: string; tiles: CritiqueTile[] }>;
  signature: QaSignature;
  domHtml: string;
  capturedAt?: string;
  /** Result of the capture-fidelity probe (capture-fidelity.ts); absent when
   * the capture did not probe. Copied onto the record as `capture_fidelity`. */
  captureFidelity?: PageReviewCaptureFidelity;
  /** Bands cut past the tile cap because a gate hit lands in them (their
   * tiles sit in `tiles` after the kept bands, labelled `hit band N`). */
  hitBands?: number;
}

/** One context's machine critique, as the judge records it into the pack. */
export interface PageReviewCritiqueRecord {
  context_id: string;
  provider: string;
  tiles_total: number;
  tiles_reviewed: number;
  tiles_reused: number;
  outcome: "pass" | "fail" | "skipped" | "incomplete";
  findings: Array<CritiqueFinding & { tile_id: string }>;
  coverage: CritiqueCoverage;
  error?: string;
  evidence?: {
    schema: string;
    context: PageReviewEvidenceContext;
    tiles: Array<Omit<PageReviewNativeTile, "png">>;
  };
}

/** One gate finding that carries a document-space rectangle (CSS px at the
 * capture's device scale factor 1, the same space as tile `x`/`scrollY`). */
export interface PageReviewGateHit {
  /** Check family the hit came from: runts, contrast, truncation, clip, … */
  rule: string;
  /** Short locator: the element label plus the check's own detail. */
  label: string;
  rect: PageReviewRect;
}

export interface PageReviewGateRecord {
  context_id: string;
  check_id: string;
  outcome: "passed" | "failed" | "unknown";
  failures: string[];
  /** Rectangles the gate's envelope recorded; optional and additive. */
  hits?: PageReviewGateHit[];
}

export interface PageReviewInspectionGateHit extends PageReviewGateHit {
  check_id: string;
  /** Tile ids whose rect intersects the hit; empty when no tile covers it. */
  tiles: string[];
}

export interface PageReviewInspectionPlan {
  schema: string;
  purpose: string;
  contexts: Array<{
    context_id: string;
    full_page: string;
    /** Tiles review subagents must open for a complete review; everything else is drill-down. */
    primary_tiles: Array<{ id: string; file: string; reason: string }>;
    drilldown_tiles: number;
    /** Every gate hit with a rectangle, mapped to the tiles that show it. */
    gate_hits: PageReviewInspectionGateHit[];
  }>;
}

export interface PageReviewPackManifest {
  schema: string;
  created_at: string;
  target: string;
  tested_revision?: string;
  tool: { name: string; version?: string };
  contexts: PageReviewContextRecord[];
  gates: PageReviewGateRecord[];
  critique: PageReviewCritiqueRecord[] | null;
  pool?: { concurrency: number; wall_time_ms: number; provider: string };
  not_checked: Array<{ check: string; reason: string }>;
  warnings: string[];
  /** Pack expiry; absent until the writer knows when the judge finished. */
  retention?: PageReviewRetention;
  /** Bytes on disk across every file in the pack at finalize time. */
  size_bytes?: number;
  files: {
    review: string;
    findings: string;
    findings_schema: string;
    inspection_plan: string;
    coverage: string;
    index: string;
    inventory: string;
    critique: string;
  };
}

export function packPaths(packDir: string) {
  const evidenceDir = join(packDir, "evidence");
  const contextsDir = join(packDir, "contexts");
  return {
    dir: packDir,
    manifest: join(packDir, PAGE_REVIEW_MANIFEST_FILENAME),
    review: join(packDir, PAGE_REVIEW_REVIEW_FILENAME),
    findings: join(packDir, PAGE_REVIEW_FINDINGS_FILENAME),
    findingsSchema: join(packDir, PAGE_REVIEW_FINDINGS_SCHEMA_FILENAME),
    evidenceDir,
    inspectionPlan: join(evidenceDir, "inspection-plan.json"),
    coverage: join(evidenceDir, "coverage.json"),
    index: join(evidenceDir, "index.json"),
    inventory: join(evidenceDir, "files.json"),
    critique: join(evidenceDir, "critique.json"),
    verdict: join(evidenceDir, PAGE_REVIEW_VERDICT_FILENAME),
    contextsDir,
    contextDir: (contextId: string) => join(contextsDir, safeSegment(contextId)),
  };
}

function safeSegment(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^\.+/, "");
  return clean.length > 0 ? clean : "context";
}

export function sha256Hex(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function tileId(position: number): string {
  return `T${String(position + 1).padStart(3, "0")}`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Deterministic file name for an expanded tile: `T012@2x.png`. */
export function expandedTileFilename(tileId: string, dpr: number): string {
  return `${tileId}@${dpr}x.png`;
}

/**
 * Crop one region out of a PNG buffer in pixel space. The rect is clamped to
 * the image so an off-by-one never throws; the result is at least 1×1.
 */
export function cropPngRegion(
  buffer: Buffer,
  rect: { x: number; y: number; width: number; height: number },
): { png: Buffer; width: number; height: number } {
  const src = PNG.sync.read(buffer);
  const sx = Math.max(0, Math.min(Math.round(rect.x), src.width - 1));
  const sy = Math.max(0, Math.min(Math.round(rect.y), src.height - 1));
  const w = Math.max(1, Math.min(Math.round(rect.width), src.width - sx));
  const h = Math.max(1, Math.min(Math.round(rect.height), src.height - sy));
  const dst = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const srcStart = ((sy + row) * src.width + sx) * 4;
    src.data.copy(dst.data, row * w * 4, srcStart, srcStart + w * 4);
  }
  return { png: PNG.sync.write(dst), width: w, height: h };
}

/**
 * Locate one tile across a pack's contexts. With `contextId` the lookup is
 * exact; without it the tile id must be unique across the given contexts,
 * otherwise the caller has to name the context.
 */
export function findPackTile(
  contexts: PageReviewContextRecord[],
  tileId: string,
  contextId?: string,
): { context: PageReviewContextRecord; tile: PageReviewTileRecord } {
  if (contextId !== undefined) {
    const context = contexts.find((ctx) => ctx.id === contextId);
    if (!context) {
      throw new Error(
        `context ${contextId} is not in the pack (have: ${contexts.map((c) => c.id).join(", ") || "none"})`,
      );
    }
    const tile = context.tiles.find((t) => t.id === tileId);
    if (!tile) {
      throw new Error(
        `tile ${tileId} is not in context ${contextId} (${context.tiles.length} tile(s): ${
          context.tiles[0]?.id ?? "none"
        }…${context.tiles[context.tiles.length - 1]?.id ?? ""})`,
      );
    }
    return { context, tile };
  }
  const matches = contexts.flatMap((context) =>
    context.tiles.filter((t) => t.id === tileId).map((tile) => ({ context, tile })),
  );
  if (matches.length === 0) throw new Error(`tile ${tileId} is not in any context of the pack`);
  if (matches.length > 1) {
    throw new Error(
      `tile ${tileId} exists in ${matches.length} contexts (${matches
        .map((m) => m.context.id)
        .join(", ")}); pass --context <id>`,
    );
  }
  return matches[0] as { context: PageReviewContextRecord; tile: PageReviewTileRecord };
}

/**
 * Write one tile region re-rendered at `dpr` into an existing context:
 * `tiles/<tile>@<dpr>x.png` cropped from `fullPage` (a screenshot of the same
 * page at that device scale factor, so the source tile's CSS-pixel rect is
 * multiplied by `dpr`). Existing tiles are never touched; the context record
 * gains or replaces one `expanded` entry for that tile + dpr and is rewritten.
 */
export function writePackExpandedTile(
  packDir: string,
  contextId: string,
  input: { tileId: string; dpr: number; capturedAt?: string } & (
    | { fullPage: Buffer; region?: undefined }
    | {
        fullPage?: undefined;
        /** The tile's region already rendered at `dpr` (a scrolled viewport
         * capture, `Browser.captureRegionByScroll`); written as is. */
        region: Buffer;
      }
  ),
): { record: PageReviewContextRecord; expanded: PageReviewExpandedTileRecord } {
  if (!Number.isFinite(input.dpr) || input.dpr <= 0) {
    throw new Error(`dpr must be a positive number (got ${input.dpr})`);
  }
  const record = readPackContext(packDir, contextId);
  const { tile } = findPackTile([record], input.tileId, contextId);
  const paths = packPaths(packDir);
  const dir = paths.contextDir(contextId);
  const file = join(dir, "tiles", expandedTileFilename(tile.id, input.dpr));
  const scale = input.dpr / record.dpr;
  const { png, width, height } = input.region
    ? {
        png: input.region,
        width: input.region.readUInt32BE(16),
        height: input.region.readUInt32BE(20),
      }
    : cropPngRegion(input.fullPage, {
        x: tile.x * scale,
        y: tile.scrollY * scale,
        width: tile.width * scale,
        height: tile.height * scale,
      });
  mkdirSync(join(dir, "tiles"), { recursive: true });
  writeFileSync(file, png);
  const expanded: PageReviewExpandedTileRecord = {
    tile: tile.id,
    dpr: input.dpr,
    width,
    height,
    file: relative(packDir, file).split("\\").join("/"),
    sha256: sha256Hex(png),
    bytes: png.byteLength,
    captured_at: input.capturedAt ?? new Date().toISOString(),
  };
  const kept = (record.expanded ?? []).filter(
    (entry) => !(entry.tile === expanded.tile && entry.dpr === expanded.dpr),
  );
  const next: PageReviewContextRecord = { ...record, expanded: [...kept, expanded] };
  writeJson(join(dir, "context.json"), { schema: PAGE_REVIEW_PACK_SCHEMA, ...next });
  return { record: next, expanded };
}

/**
 * Write one context's capture into the pack: `full-page.png`, `dom.html.gz`,
 * `signature.json`, `tiles/T001.png…`, `tiles.json`, and `context.json`.
 * Full-page bands come first, then each scope's tiles in selector order, so
 * tile ids are stable for a given capture. Returns the record written.
 */
export function writePackContext(
  packDir: string,
  capture: PageReviewContextCapture,
): PageReviewContextRecord {
  if (
    !capture.viewportSize ||
    ![capture.viewportSize.width, capture.viewportSize.height, capture.dpr].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    !capture.recipeVersion?.trim()
  ) {
    throw new Error(
      "Native pack capture requires viewportSize, positive DPR, and a capture recipe version",
    );
  }
  const contextId =
    capture.context.id ??
    `${capture.context.viewport}-${capture.context.theme}-${capture.context.state}`;
  const paths = packPaths(packDir);
  const dir = paths.contextDir(contextId);
  const tilesDir = join(dir, "tiles");
  mkdirSync(tilesDir, { recursive: true });

  const rel = (abs: string): string => relative(packDir, abs).split("\\").join("/");
  const fullPagePath = join(dir, "full-page.png");
  const domPath = join(dir, "dom.html.gz");
  const signaturePath = join(dir, "signature.json");
  const tilesPath = join(dir, "tiles.json");
  const contextPath = join(dir, "context.json");
  // Full-page pixels are transient. The saved image is orientation only.
  const native = PNG.sync.read(capture.fullPage);
  const overview = boxDownscale(
    native,
    Math.max(1, Math.round(native.width / 2)),
    Math.max(1, Math.round(native.height / 2)),
  );
  writeFileSync(fullPagePath, PNG.sync.write(overview));
  // The serialized DOM compresses roughly 10:1; `dom_sha256` stays the digest
  // of the uncompressed bytes so a reader can verify what `readPackDom` returns.
  writeFileSync(domPath, gzipSync(Buffer.from(capture.domHtml, "utf8")));
  writeJson(signaturePath, capture.signature);

  const records: PageReviewTileRecord[] = [];
  const tilePngs = new Map<string, Buffer>();
  const ordered: Array<{ tile: CritiqueTile; scope?: string }> = [
    ...capture.tiles.map((tile) => ({ tile })),
    ...(capture.scopeTiles ?? []).flatMap((entry) =>
      entry.tiles.map((tile) => ({ tile, scope: entry.selector })),
    ),
  ];
  ordered.forEach(({ tile, scope }, position) => {
    const id = tileId(position);
    const png = Buffer.from(tile.pngBase64, "base64");
    const file = join(tilesDir, `${id}.png`);
    writeFileSync(file, png);
    tilePngs.set(id, png);
    records.push({
      id,
      index: tile.index,
      label: tile.label,
      ...(scope !== undefined ? { scope } : {}),
      kind: tile.label.startsWith("hit band") ? "hit-band" : scope !== undefined ? "scope" : "band",
      x: tile.x ?? 0,
      scrollY: tile.scrollY,
      width: tile.width,
      height: tile.height,
      file: rel(file),
      sha256: sha256Hex(png),
      bytes: png.byteLength,
    });
  });

  const record: PageReviewContextRecord = {
    id: contextId,
    viewport: capture.context.viewport,
    theme: capture.context.theme,
    state: capture.context.state,
    url: capture.url,
    ...(capture.title !== undefined ? { title: capture.title } : {}),
    captured_at: capture.capturedAt ?? new Date().toISOString(),
    page: {
      width: Math.round(capture.pageWidth * capture.dpr),
      height: Math.round(capture.pageHeight * capture.dpr),
    },
    viewport_size: capture.viewportSize,
    dpr: capture.dpr,
    recipe_version: capture.recipeVersion,
    full_page_scale: 0.5,
    ...(capture.capturePlan ? { capture_plan: capture.capturePlan } : {}),
    ...(capture.allocationCoverage ? { allocation_coverage: capture.allocationCoverage } : {}),
    ...(capture.captureIncomplete ? { capture_incomplete: true } : {}),
    coverage: capture.coverage,
    scopes: (capture.scopeTiles ?? []).map((entry) => ({
      selector: entry.selector,
      tiles: entry.tiles.length,
    })),
    files: {
      full_page: rel(fullPagePath),
      dom: rel(domPath),
      signature: rel(signaturePath),
      tiles: rel(tilesPath),
      context: rel(contextPath),
    },
    dom_sha256: sha256Hex(capture.domHtml),
    tiles: records,
    ...(capture.captureFidelity ? { capture_fidelity: capture.captureFidelity } : {}),
    ...(capture.hitBands !== undefined && capture.hitBands > 0
      ? { hit_bands: capture.hitBands }
      : {}),
  };
  writeJson(tilesPath, { schema: PAGE_REVIEW_PACK_SCHEMA, context_id: contextId, tiles: records });
  writeJson(contextPath, { schema: PAGE_REVIEW_PACK_SCHEMA, ...record });
  // The contact sheet is navigation, so it rides on the record but never
  // gates the capture: the tiles are already on disk when it is built.
  return writePackContactSheet(packDir, record, tilePngs);
}

// ---------------------------------------------------------------------------
// Contact sheet
// ---------------------------------------------------------------------------

export const CONTACT_SHEET_FILENAME = "contacts.png";
/** Tiles per row. Four 320 px cells plus gutters stay under a 1600 px sheet. */
export const CONTACT_SHEET_COLUMNS = 4;
const CONTACT_CELL = 320;
const CONTACT_LABEL_H = 20;
const CONTACT_GUTTER = 8;
const CONTACT_BG: [number, number, number] = [212, 212, 216];
const CONTACT_LABEL_BG: [number, number, number] = [24, 24, 27];
const CONTACT_LABEL_FG: [number, number, number] = [250, 250, 250];

/** 3×5 bitmap glyphs for the characters a tile id uses. Rows top-down, bits
 * left-to-right. Anything else renders as a blank column. */
const CONTACT_FONT: Record<string, number[]> = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b001, 0b001, 0b001],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
  T: [0b111, 0b010, 0b010, 0b010, 0b010],
};

function fillRect(
  png: PNG,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = rgb[0];
      png.data[i + 1] = rgb[1];
      png.data[i + 2] = rgb[2];
      png.data[i + 3] = 255;
    }
  }
}

/** Stamp `text` at (x, y) with the bitmap font at `scale` pixels per dot. */
function stampText(
  png: PNG,
  text: string,
  x: number,
  y: number,
  scale: number,
  rgb: [number, number, number],
): void {
  let cursor = x;
  for (const ch of text) {
    const glyph = CONTACT_FONT[ch];
    if (glyph) {
      glyph.forEach((rowBits, row) => {
        for (let col = 0; col < 3; col++) {
          if ((rowBits >> (2 - col)) & 1) {
            fillRect(png, cursor + col * scale, y + row * scale, scale, scale, rgb);
          }
        }
      });
    }
    cursor += 4 * scale;
  }
}

/**
 * Box-filter downscale (area average) of `src` to `dstW`×`dstH`. Never used
 * to upscale; callers pass a destination no larger than the source.
 */
function boxDownscale(src: PNG, dstW: number, dstH: number): PNG {
  const dst = new PNG({ width: dstW, height: dstH });
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.floor((dy * src.height) / dstH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * src.height) / dstH));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.floor((dx * src.width) / dstW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * src.width) / dstW));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i] ?? 0;
          g += src.data[i + 1] ?? 0;
          b += src.data[i + 2] ?? 0;
          a += src.data[i + 3] ?? 0;
          n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      dst.data[o] = Math.round(r / n);
      dst.data[o + 1] = Math.round(g / n);
      dst.data[o + 2] = Math.round(b / n);
      dst.data[o + 3] = Math.round(a / n);
    }
  }
  return dst;
}

/**
 * Build one contact sheet from tile PNGs, in the order given: a fixed grid of
 * `CONTACT_SHEET_COLUMNS` cells per row, each cell a label band stamped with
 * the tile id above the tile downscaled (box filter, aspect kept, never
 * upscaled) to fit the cell. Row-major reading order.
 */
export function buildContactSheet(tiles: Array<{ id: string; png: Buffer }>): {
  png: Buffer;
  width: number;
  height: number;
  columns: number;
  rows: number;
  cell_width: number;
  cell_height: number;
} {
  const columns = Math.max(1, Math.min(CONTACT_SHEET_COLUMNS, tiles.length));
  const rows = Math.max(1, Math.ceil(tiles.length / columns));
  const cellH = CONTACT_LABEL_H + CONTACT_CELL;
  const width = columns * CONTACT_CELL + (columns + 1) * CONTACT_GUTTER;
  const height = rows * cellH + (rows + 1) * CONTACT_GUTTER;
  const sheet = new PNG({ width, height });
  fillRect(sheet, 0, 0, width, height, CONTACT_BG);
  tiles.forEach((tile, position) => {
    const col = position % columns;
    const row = Math.floor(position / columns);
    const x0 = CONTACT_GUTTER + col * (CONTACT_CELL + CONTACT_GUTTER);
    const y0 = CONTACT_GUTTER + row * (cellH + CONTACT_GUTTER);
    fillRect(sheet, x0, y0, CONTACT_CELL, CONTACT_LABEL_H, CONTACT_LABEL_BG);
    stampText(sheet, tile.id, x0 + 4, y0 + 3, 3, CONTACT_LABEL_FG);
    const src = PNG.sync.read(tile.png);
    const scale = Math.min(1, CONTACT_CELL / src.width, CONTACT_CELL / src.height);
    const dstW = Math.max(1, Math.round(src.width * scale));
    const dstH = Math.max(1, Math.round(src.height * scale));
    const scaled = scale < 1 ? boxDownscale(src, dstW, dstH) : src;
    const ty = y0 + CONTACT_LABEL_H;
    for (let y = 0; y < scaled.height; y++) {
      const srcStart = y * scaled.width * 4;
      scaled.data.copy(
        sheet.data,
        ((ty + y) * width + x0) * 4,
        srcStart,
        srcStart + scaled.width * 4,
      );
    }
  });
  return {
    png: PNG.sync.write(sheet),
    width,
    height,
    columns,
    rows,
    cell_width: CONTACT_CELL,
    cell_height: cellH,
  };
}

/**
 * Write (or rewrite) a context's `contacts.png` from its tiles and record it
 * on the context. Tile bytes are read from the pack unless supplied. A
 * context with no tiles gets no sheet and its record is returned unchanged.
 */
export function writePackContactSheet(
  packDir: string,
  record: PageReviewContextRecord,
  tilePngs?: Map<string, Buffer>,
): PageReviewContextRecord {
  if (record.tiles.length === 0) return record;
  const tiles = record.tiles.map((tile) => ({
    id: tile.id,
    png: tilePngs?.get(tile.id) ?? readFileSync(join(packDir, tile.file)),
  }));
  const sheet = buildContactSheet(tiles);
  const dir = packPaths(packDir).contextDir(record.id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, CONTACT_SHEET_FILENAME);
  writeFileSync(file, sheet.png);
  const next: PageReviewContextRecord = {
    ...record,
    contact_sheet: {
      file: relative(packDir, file).split("\\").join("/"),
      sha256: sha256Hex(sheet.png),
      bytes: sheet.png.byteLength,
      width: sheet.width,
      height: sheet.height,
      columns: sheet.columns,
      rows: sheet.rows,
      cell_width: sheet.cell_width,
      cell_height: sheet.cell_height,
      order: "row-major",
    },
  };
  writeJson(join(dir, "context.json"), { schema: PAGE_REVIEW_PACK_SCHEMA, ...next });
  return next;
}

/** Context ids present in the pack, in directory order. */
export function listPackContexts(packDir: string): string[] {
  const dir = packPaths(packDir).contextsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "context.json")))
    .map((entry) => entry.name)
    .sort();
}

export function readPackContext(packDir: string, contextId: string): PageReviewContextRecord {
  const path = join(packPaths(packDir).contextDir(contextId), "context.json");
  const { schema, ...record } = readJson<PageReviewContextRecord & { schema?: string }>(path);
  if (schema !== PAGE_REVIEW_PACK_SCHEMA) {
    throw new Error(
      `${path}: expected schema ${PAGE_REVIEW_PACK_SCHEMA}, found ${schema}; recapture the target to create a v2 pack`,
    );
  }
  return record;
}

/**
 * Load a context's tiles back as `CritiqueTile`s (PNG bytes read from disk
 * and base64-encoded), verifying each file against its recorded digest so a
 * judge never reviews a tile that was altered after capture.
 */
export function readPackTiles(
  packDir: string,
  record: PageReviewContextRecord,
): Array<CritiqueTile & { id: string; scope?: string }> {
  return record.tiles.map((tile) => {
    const abs = join(packDir, tile.file);
    const png = readFileSync(abs);
    const digest = sha256Hex(png);
    if (digest !== tile.sha256) {
      throw new Error(`${abs}: tile digest ${digest} does not match recorded ${tile.sha256}`);
    }
    return {
      id: tile.id,
      ...(tile.scope !== undefined ? { scope: tile.scope } : {}),
      index: tile.index,
      label: tile.label,
      scrollY: tile.scrollY,
      x: tile.x,
      width: tile.width,
      height: tile.height,
      pngBase64: png.toString("base64"),
    };
  });
}

/** Half-scale navigation image; never native evidence. */
export function readPackOverview(packDir: string, record: PageReviewContextRecord): Buffer {
  return readFileSync(join(packDir, record.files.full_page));
}

export function readPackSignature(packDir: string, record: PageReviewContextRecord): QaSignature {
  return readJson<QaSignature>(join(packDir, record.files.signature));
}

/** Read a context's serialized DOM, inflating a gzip-compressed `dom.html.gz`
 * and reading an older plain `dom.html` as-is. */
export function readPackDom(packDir: string, record: PageReviewContextRecord): string {
  const path = join(packDir, record.files.dom);
  const bytes = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
}

export function readPackManifest(packDir: string): PageReviewPackManifest {
  const manifest = readJson<PageReviewPackManifest>(packPaths(packDir).manifest);
  if (manifest.schema !== PAGE_REVIEW_PACK_SCHEMA) {
    throw new Error(
      `${packPaths(packDir).manifest}: expected schema ${PAGE_REVIEW_PACK_SCHEMA}, found ${manifest.schema}; recapture the target to create a v2 pack`,
    );
  }
  return manifest;
}

/** Read the bounded primary-tile plan used to prove delegated review coverage. */
export function readPackInspectionPlan(packDir: string): PageReviewInspectionPlan {
  return readJson<PageReviewInspectionPlan>(packPaths(packDir).inspectionPlan);
}

// ---------------------------------------------------------------------------
// Findings, dispositions, verdict: the reviewer's half of the pack
// ---------------------------------------------------------------------------

export function readPackFindings(packDir: string): PageReviewFindingsDocument {
  const path = packPaths(packDir).findings;
  const doc = readJson<PageReviewFindingsDocument>(path);
  if (doc.schema !== PAGE_REVIEW_FINDINGS_SCHEMA) {
    throw new Error(
      `${path}: expected schema ${PAGE_REVIEW_FINDINGS_SCHEMA}, found ${String(doc.schema)}`,
    );
  }
  return doc;
}

/** Write `findings.json` atomically: a temp file beside it, then a rename. */
export function writePackFindings(packDir: string, doc: PageReviewFindingsDocument): void {
  const path = packPaths(packDir).findings;
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(temp, path);
}

const FINDING_ID_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const DISPOSITION_TARGET_PATTERN = /^[^/#]+\/T[0-9]{3}#[0-9]+$/;
const REVIEW_TILE_PATTERN = /^[^/]+\/T[0-9]{3}$/;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check a findings document against the rules `findingsSchemaDocument()`
 * states, by hand so the toolkit tier carries no validator dependency.
 * Returns every violation found; an empty array means the document is valid.
 */
export function validateFindingsDocument(doc: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(doc)) return ["findings document must be a JSON object"];
  const topAllowed = new Set([
    "schema",
    "schema_path",
    "target",
    "reviewer",
    "reviewed_at",
    "machine_evidence_digest",
    "delegated_reviews",
    "findings",
    "dispositions",
  ]);
  for (const key of Object.keys(doc)) {
    if (!topAllowed.has(key)) errors.push(`unknown top-level key "${key}"`);
  }
  for (const key of [
    "schema",
    "target",
    "reviewer",
    "reviewed_at",
    "delegated_reviews",
    "findings",
  ]) {
    if (!(key in doc)) errors.push(`missing required key "${key}"`);
  }
  if (doc.schema !== undefined && doc.schema !== PAGE_REVIEW_FINDINGS_SCHEMA) {
    errors.push(`schema must be ${PAGE_REVIEW_FINDINGS_SCHEMA}`);
  }
  if (doc.schema_path !== undefined && typeof doc.schema_path !== "string") {
    errors.push("schema_path must be a string");
  }
  if (doc.target !== undefined && typeof doc.target !== "string") {
    errors.push("target must be a string");
  }
  if (doc.reviewer !== undefined && doc.reviewer !== null && typeof doc.reviewer !== "string") {
    errors.push("reviewer must be a string or null");
  }
  if (doc.reviewed_at !== undefined && doc.reviewed_at !== null) {
    if (typeof doc.reviewed_at !== "string" || !DATE_TIME_PATTERN.test(doc.reviewed_at)) {
      errors.push("reviewed_at must be an RFC 3339 date-time string or null");
    }
  }

  if (doc.delegated_reviews !== undefined) {
    if (!Array.isArray(doc.delegated_reviews)) {
      errors.push("delegated_reviews must be an array");
    } else {
      const allowed = new Set(["reviewer", "model", "assigned_tiles", "completed_tiles", "status"]);
      doc.delegated_reviews.forEach((entry: unknown, index: number) => {
        const at = `delegated_reviews[${index}]`;
        if (!isRecord(entry)) {
          errors.push(`${at}: must be an object`);
          return;
        }
        for (const key of Object.keys(entry)) {
          if (!allowed.has(key)) errors.push(`${at}: unknown key "${key}"`);
        }
        for (const key of ["reviewer", "model", "assigned_tiles", "completed_tiles", "status"]) {
          if (!(key in entry)) errors.push(`${at}: missing required key "${key}"`);
        }
        if (
          entry.reviewer !== undefined &&
          (typeof entry.reviewer !== "string" || entry.reviewer.trim().length === 0)
        ) {
          errors.push(`${at}: reviewer must be a non-empty string`);
        }
        if (
          entry.model !== undefined &&
          !(PAGE_REVIEW_SUBAGENT_MODELS as readonly string[]).includes(String(entry.model))
        ) {
          errors.push(`${at}: model must be one of ${PAGE_REVIEW_SUBAGENT_MODELS.join(", ")}`);
        }
        for (const key of ["assigned_tiles", "completed_tiles"] as const) {
          const value = entry[key];
          if (!Array.isArray(value) || value.some((tile) => typeof tile !== "string")) {
            errors.push(`${at}: ${key} must be an array of <context-id>/T012 strings`);
            continue;
          }
          const invalid = value.filter((tile) => !REVIEW_TILE_PATTERN.test(tile));
          if (invalid.length > 0) {
            errors.push(`${at}: ${key} contains invalid tile(s): ${invalid.join(", ")}`);
          }
          if (new Set(value).size !== value.length) {
            errors.push(`${at}: ${key} must not contain duplicates`);
          }
        }
        if (
          entry.status !== undefined &&
          entry.status !== "complete" &&
          entry.status !== "incomplete"
        ) {
          errors.push(`${at}: status must be complete or incomplete`);
        }
        if (Array.isArray(entry.assigned_tiles) && Array.isArray(entry.completed_tiles)) {
          const assigned = new Set(entry.assigned_tiles);
          const outside = entry.completed_tiles.filter((tile) => !assigned.has(tile));
          if (outside.length > 0) {
            errors.push(`${at}: completed_tiles not assigned: ${outside.join(", ")}`);
          }
        }
      });
    }
  }

  if (doc.findings !== undefined) {
    if (!Array.isArray(doc.findings)) {
      errors.push("findings must be an array");
    } else {
      const allowed = new Set([
        "id",
        "severity",
        "category",
        "context_id",
        "evidence",
        "observation",
        "recommendation",
        "confidence",
      ]);
      const seenIds = new Set<string>();
      doc.findings.forEach((entry: unknown, index: number) => {
        const at = `findings[${index}]`;
        if (!isRecord(entry)) {
          errors.push(`${at}: must be an object`);
          return;
        }
        for (const key of Object.keys(entry)) {
          if (!allowed.has(key)) errors.push(`${at}: unknown key "${key}"`);
        }
        for (const key of ["id", "severity", "category", "context_id", "evidence", "observation"]) {
          if (!(key in entry)) errors.push(`${at}: missing required key "${key}"`);
        }
        if (entry.id !== undefined) {
          if (typeof entry.id !== "string" || !FINDING_ID_PATTERN.test(entry.id)) {
            errors.push(`${at}: id must match ${FINDING_ID_PATTERN.source}`);
          } else if (seenIds.has(entry.id)) {
            errors.push(`${at}: duplicate id "${entry.id}"`);
          } else {
            seenIds.add(entry.id);
          }
        }
        if (
          entry.severity !== undefined &&
          !(PAGE_REVIEW_FINDING_SEVERITIES as readonly string[]).includes(String(entry.severity))
        ) {
          errors.push(
            `${at}: severity must be one of ${PAGE_REVIEW_FINDING_SEVERITIES.join(", ")}`,
          );
        }
        if (
          entry.category !== undefined &&
          !(PAGE_REVIEW_FINDING_CATEGORIES as readonly string[]).includes(String(entry.category))
        ) {
          errors.push(
            `${at}: category must be one of ${PAGE_REVIEW_FINDING_CATEGORIES.join(", ")}`,
          );
        }
        if (entry.context_id !== undefined && typeof entry.context_id !== "string") {
          errors.push(`${at}: context_id must be a string`);
        }
        if (entry.evidence !== undefined) {
          if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
            errors.push(`${at}: evidence must be a non-empty array of strings`);
          } else if (entry.evidence.some((e: unknown) => typeof e !== "string")) {
            errors.push(`${at}: evidence entries must be strings`);
          }
        }
        if (
          entry.observation !== undefined &&
          (typeof entry.observation !== "string" || entry.observation.length === 0)
        ) {
          errors.push(`${at}: observation must be a non-empty string`);
        }
        if (entry.recommendation !== undefined && typeof entry.recommendation !== "string") {
          errors.push(`${at}: recommendation must be a string`);
        }
        if (entry.confidence !== undefined) {
          const c = entry.confidence;
          if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
            errors.push(`${at}: confidence must be a number between 0 and 1`);
          }
        }
      });
    }
  }

  if (doc.dispositions !== undefined) {
    if (!Array.isArray(doc.dispositions)) {
      errors.push("dispositions must be an array");
    } else {
      const allowed = new Set(["target", "disposition", "note", "by", "at"]);
      const seen = new Set<string>();
      doc.dispositions.forEach((entry: unknown, index: number) => {
        const at = `dispositions[${index}]`;
        if (!isRecord(entry)) {
          errors.push(`${at}: must be an object`);
          return;
        }
        for (const key of Object.keys(entry)) {
          if (!allowed.has(key)) errors.push(`${at}: unknown key "${key}"`);
        }
        for (const key of ["target", "disposition"]) {
          if (!(key in entry)) errors.push(`${at}: missing required key "${key}"`);
        }
        if (entry.target !== undefined) {
          if (typeof entry.target !== "string" || !DISPOSITION_TARGET_PATTERN.test(entry.target)) {
            errors.push(`${at}: target must look like <context-id>/T012#0`);
          } else if (seen.has(entry.target)) {
            errors.push(`${at}: duplicate target "${entry.target}"`);
          } else {
            seen.add(entry.target);
          }
        }
        if (
          entry.disposition !== undefined &&
          !(PAGE_REVIEW_DISPOSITIONS as readonly string[]).includes(String(entry.disposition))
        ) {
          errors.push(`${at}: disposition must be one of ${PAGE_REVIEW_DISPOSITIONS.join(", ")}`);
        }
        for (const key of ["note", "by"]) {
          if (entry[key] !== undefined && typeof entry[key] !== "string") {
            errors.push(`${at}: ${key} must be a string`);
          }
        }
        if (entry.at !== undefined) {
          if (typeof entry.at !== "string" || !DATE_TIME_PATTERN.test(entry.at)) {
            errors.push(`${at}: at must be an RFC 3339 date-time string`);
          }
        }
      });
    }
  }
  return errors;
}

/** `<context-id>/<tile-id>#<n>` for the n-th finding of a tile in one context. */
export function dispositionTarget(contextId: string, tileId: string, n: number): string {
  return `${contextId}/${tileId}#${n}`;
}

/**
 * Every machine finding in the critique, keyed by its disposition target.
 * `n` counts a tile's findings in critique order, all severities included, so
 * a reviewer can point at the second finding on T006 as `ctx/T006#1`.
 */
export function machineFindingTargets(
  critique: PageReviewCritiqueRecord[] | null,
): Map<string, CritiqueFinding & { tile_id: string; context_id: string }> {
  const out = new Map<string, CritiqueFinding & { tile_id: string; context_id: string }>();
  if (!critique) return out;
  for (const row of critique) {
    const perTile = new Map<string, number>();
    for (const finding of row.findings) {
      const n = perTile.get(finding.tile_id) ?? 0;
      perTile.set(finding.tile_id, n + 1);
      out.set(dispositionTarget(row.context_id, finding.tile_id, n), {
        ...finding,
        context_id: row.context_id,
      });
    }
  }
  return out;
}

/**
 * Combine the immutable machine critique with the reviewer's dispositions and
 * findings into one reviewed outcome. A machine `high` counts against the page
 * unless a reviewer dispositioned it `artifact`, `not-a-defect`, or
 * `duplicate-of-gate`; `confirmed` and undispositioned highs count; so does a
 * review-subagent finding at `critical` or `high`. Nothing here rewrites the
 * critique: `evidence/critique.json` stays the machine record.
 */
export function resolvePackVerdict(
  manifest: Pick<PageReviewPackManifest, "critique"> &
    Partial<Pick<PageReviewPackManifest, "gates" | "contexts">>,
  inspectionPlan: PageReviewInspectionPlan,
  findings: PageReviewFindingsDocument,
): PageReviewVerdict {
  const critique = manifest.critique;
  const machine_outcome: PageReviewVerdict["machine_outcome"] =
    critique === null || critique.length === 0
      ? "skipped"
      : critique.some((row) => row.outcome === "fail")
        ? "fail"
        : critique.some((row) => row.outcome === "incomplete")
          ? "incomplete"
          : critique.every((row) => row.outcome === "skipped")
            ? "skipped"
            : "pass";

  const targets = machineFindingTargets(critique);
  const byTarget = new Map<string, PageReviewDispositionRecord>();
  const unmatched: string[] = [];
  for (const entry of findings.dispositions ?? []) {
    if (targets.has(entry.target)) byTarget.set(entry.target, entry);
    else unmatched.push(entry.target);
  }

  let high_total = 0;
  let high_confirmed = 0;
  let high_dismissed = 0;
  let high_open = 0;
  for (const [target, finding] of targets) {
    if (finding.severity !== "high") continue;
    high_total += 1;
    const disposition = byTarget.get(target)?.disposition;
    if (disposition === undefined) high_open += 1;
    else if (disposition === "confirmed" || finding.category === "provider-error")
      high_confirmed += 1;
    else high_dismissed += 1;
  }
  const reviewer_high = findings.findings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  ).length;

  const requiredTiles = new Set(
    inspectionPlan.contexts.flatMap((context) =>
      context.primary_tiles.map((tile) => `${context.context_id}/${tile.id}`),
    ),
  );
  const completedTiles = new Set(
    findings.delegated_reviews
      .filter((review) => review.status === "complete")
      .flatMap((review) => review.completed_tiles),
  );
  const uncovered_primary_tiles = [...requiredTiles]
    .filter((tile) => !completedTiles.has(tile))
    .sort();

  const blocking =
    high_confirmed +
    high_open +
    reviewer_high +
    (manifest.gates?.filter((g) => g.outcome === "failed").length ?? 0);
  const anyIncomplete =
    (critique?.some(
      (row) =>
        row.outcome === "incomplete" ||
        (row.outcome === "skipped" && machine_outcome !== "skipped"),
    ) ??
      false) ||
    manifest.contexts?.some((c) => c.capture_incomplete || c.coverage.capped) ||
    false;
  const reviewed_outcome: PageReviewVerdict["reviewed_outcome"] =
    blocking > 0
      ? "fail"
      : anyIncomplete || uncovered_primary_tiles.length > 0
        ? "incomplete"
        : machine_outcome === "skipped"
          ? "skipped"
          : "pass";

  return {
    machine_outcome,
    reviewed_outcome,
    high_total,
    high_confirmed,
    high_dismissed,
    high_open,
    reviewer_high,
    dispositions_applied: byTarget.size,
    unmatched_dispositions: unmatched,
    primary_tiles_total: requiredTiles.size,
    primary_tiles_reviewed: requiredTiles.size - uncovered_primary_tiles.length,
    uncovered_primary_tiles,
  };
}

/** The verdict a previous `review-pack verdict` wrote, or undefined when none exists. */
export function readPackVerdict(packDir: string): PageReviewVerdictDocument | undefined {
  const path = packPaths(packDir).verdict;
  if (!existsSync(path)) return undefined;
  const doc = readJson<PageReviewVerdictDocument>(path);
  return doc.schema === PAGE_REVIEW_VERDICT_SCHEMA ? doc : undefined;
}

// ---------------------------------------------------------------------------
// Finalize: manifest, evidence, findings skeleton, review.md
// ---------------------------------------------------------------------------

export interface FinalizePageReviewPackInput {
  packDir: string;
  target: string;
  tested_revision?: string;
  contexts: PageReviewContextRecord[];
  gates?: PageReviewGateRecord[];
  /** Null or absent until the judge has run. */
  critique?: PageReviewCritiqueRecord[] | null;
  pool?: { concurrency: number; wall_time_ms: number; provider: string };
  not_checked?: Array<{ check: string; reason: string }>;
  warnings?: string[];
  tool?: { name: string; version?: string };
  /** Command the reader can run to judge the pack, shown in review.md. */
  judgeCommand?: string;
  createdAt?: string;
  /** Pack expiry to record; omit to keep whatever the manifest already says. */
  retention?: PageReviewRetention;
}

export function findingsSchemaDocument(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: PAGE_REVIEW_FINDINGS_SCHEMA,
    title: "Page review findings",
    type: "object",
    additionalProperties: false,
    required: ["schema", "target", "reviewer", "reviewed_at", "delegated_reviews", "findings"],
    properties: {
      machine_evidence_digest: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
      schema: { const: PAGE_REVIEW_FINDINGS_SCHEMA },
      schema_path: { type: "string" },
      target: { type: "string" },
      reviewer: { type: ["string", "null"] },
      reviewed_at: { type: ["string", "null"], format: "date-time" },
      delegated_reviews: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["reviewer", "model", "assigned_tiles", "completed_tiles", "status"],
          properties: {
            reviewer: { type: "string", minLength: 1 },
            model: { enum: [...PAGE_REVIEW_SUBAGENT_MODELS] },
            assigned_tiles: {
              type: "array",
              uniqueItems: true,
              items: { type: "string", pattern: "^[^/]+/T[0-9]{3}$" },
            },
            completed_tiles: {
              type: "array",
              uniqueItems: true,
              items: { type: "string", pattern: "^[^/]+/T[0-9]{3}$" },
            },
            status: { enum: ["complete", "incomplete"] },
          },
        },
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "severity", "category", "context_id", "evidence", "observation"],
          properties: {
            id: { type: "string", pattern: "^[A-Z][A-Z0-9_-]*$" },
            severity: { enum: ["critical", "high", "medium", "low", "info"] },
            category: {
              enum: [
                "layout",
                "typography",
                "contrast",
                "content",
                "image",
                "interaction",
                "accessibility",
                "responsiveness",
                "render-artifact",
                "coverage",
                "other",
              ],
            },
            context_id: { type: "string" },
            /** Tile ids (`T012`) or pack-relative file paths. */
            evidence: { type: "array", minItems: 1, items: { type: "string" } },
            observation: { type: "string", minLength: 1 },
            recommendation: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
      /** Reviewer verdicts on machine findings in `evidence/critique.json`.
       * `target` is `<context-id>/<tile-id>#<n>`, n = position of the finding
       * among that tile's findings in the critique record (0-based). */
      dispositions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["target", "disposition"],
          properties: {
            target: { type: "string", pattern: "^[^/#]+/T[0-9]{3}#[0-9]+$" },
            disposition: { enum: [...PAGE_REVIEW_DISPOSITIONS] },
            note: { type: "string" },
            by: { type: "string" },
            at: { type: "string", format: "date-time" },
          },
        },
      },
    },
  };
}

/** Most hits one envelope contributes; a runaway sweep must not bloat the pack. */
export const GATE_HITS_PER_ENVELOPE = 50;

function asRect(value: unknown): PageReviewRect | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const x = r.x;
  const y = r.y;
  const width = r.width;
  const height = r.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite)
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

function unionRect(a: PageReviewRect, b: PageReviewRect): PageReviewRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
    : [];
}

function str(value: unknown, fallback = "?"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Pull every rectangle-bearing finding out of a `browse` JSON envelope so the
 * inspection plan can point at the tiles that show it. Covers the checks
 * whose results carry a document-space rect: runts, truncation, contrast,
 * placeholder, image, clip, overlap, crowd, align, gap, overflow, and
 * target-size (`hit`). Anything without a rect is skipped; the gate's
 * `failures` lines still describe it. Capped at `GATE_HITS_PER_ENVELOPE`.
 */
export function gateHitsFromEnvelope(
  envelope: Record<string, unknown> | undefined,
  maxHits = GATE_HITS_PER_ENVELOPE,
): PageReviewGateHit[] {
  if (!envelope) return [];
  const hits: PageReviewGateHit[] = [];
  const push = (rule: string, label: string, rect: PageReviewRect | undefined): void => {
    if (rect && hits.length < maxHits) hits.push({ rule, label, rect });
  };
  const runts = envelope.runts as Record<string, unknown> | undefined;
  for (const hit of asArray(runts?.runts)) {
    push("runts", `${str(hit.block)}: "${str(hit.word, "")}"`, asRect(hit.rect));
  }
  const truncation = envelope.truncation as Record<string, unknown> | undefined;
  for (const hit of asArray(truncation?.hits)) {
    push(
      "truncation",
      `${str(hit.label)}: ${str(hit.how)} on ${str(hit.axis)}, +${String(hit.overflowPx ?? "?")}px`,
      asRect(hit.rect),
    );
  }
  const contrast = envelope.contrast as Record<string, unknown> | undefined;
  for (const hit of asArray(contrast?.hits)) {
    push(
      "contrast",
      `${str(hit.label)}: ${String(hit.ratio ?? "?")}:1 < ${String(hit.required ?? "?")}`,
      asRect(hit.rect),
    );
  }
  const placeholder = envelope.placeholder as Record<string, unknown> | undefined;
  for (const hit of asArray(placeholder?.hits)) {
    push(
      "placeholder",
      `${str(hit.label)}: ${str(hit.kind)} ${str(hit.token, "")}`,
      asRect(hit.rect),
    );
  }
  const image = envelope.image as Record<string, unknown> | undefined;
  for (const hit of asArray(image?.issues)) {
    push("image", `${str(hit.label)}: ${str(hit.reason)}`, asRect(hit.rect));
  }
  for (const result of asArray(envelope.clip)) {
    for (const issue of asArray(result.issues)) {
      const element = issue.element as Record<string, unknown> | undefined;
      push(
        "clip",
        `${str(element?.label)} clipped by ${str(issue.clippedBy)}, ${String(issue.maxOverrunPx ?? "?")}px`,
        asRect(element?.rect),
      );
    }
  }
  for (const result of asArray(envelope.overlap)) {
    for (const issue of asArray(result.issues)) {
      const first = issue.first as Record<string, unknown> | undefined;
      const second = issue.second as Record<string, unknown> | undefined;
      push(
        "overlap",
        `${str(first?.label)} × ${str(second?.label)}, ${String(issue.areaPx ?? "?")}px²`,
        asRect(issue.intersection),
      );
    }
  }
  for (const result of asArray(envelope.crowd)) {
    for (const issue of asArray(result.issues)) {
      const before = asRect((issue.before as Record<string, unknown> | undefined)?.rect);
      const after = asRect((issue.after as Record<string, unknown> | undefined)?.rect);
      const rect = before && after ? unionRect(before, after) : (before ?? after);
      push(
        "crowd",
        `${str((issue.before as Record<string, unknown> | undefined)?.label)} / ${str(
          (issue.after as Record<string, unknown> | undefined)?.label,
        )}: ${String(issue.separationPx ?? "?")}px apart`,
        rect,
      );
    }
  }
  for (const result of asArray(envelope.align)) {
    for (const cluster of asArray(result.clusters)) {
      for (const child of asArray(cluster.children)) {
        if (child.fail !== true) continue;
        push(
          "align",
          `${str(child.label)}: off by ${String(child.deltaPx ?? "?")}px`,
          asRect(child.rect),
        );
      }
    }
  }
  for (const result of asArray(envelope.gap)) {
    for (const cluster of asArray(result.clusters)) {
      for (const pair of asArray(cluster.pairs)) {
        if (pair.fail !== true) continue;
        const before = pair.before as Record<string, unknown> | undefined;
        const after = pair.after as Record<string, unknown> | undefined;
        const a = asRect(before?.rect);
        const b = asRect(after?.rect);
        push(
          "gap",
          `${str(before?.label)} / ${str(after?.label)}: ${String(pair.observedGapPx ?? "?")}px`,
          a && b ? unionRect(a, b) : (a ?? b),
        );
      }
    }
  }
  const overflow = envelope.overflow as Record<string, unknown> | undefined;
  for (const key of ["widerThanViewport", "rightOverflow"] as const) {
    for (const element of asArray(overflow?.[key])) {
      const tag = str(element.tagName, "element").toLowerCase();
      const id = str(element.id, "");
      const cls = str(element.className, "").trim().split(/\s+/)[0] ?? "";
      const label = id ? `${tag}#${id}` : cls ? `${tag}.${cls}` : tag;
      const px = key === "widerThanViewport" ? element.widthOverflowPx : element.rightOverflowPx;
      push("overflow", `${label}: +${String(px ?? "?")}px past the viewport`, asRect(element.rect));
    }
  }
  for (const result of asArray(envelope.hit)) {
    for (const node of asArray(result.nodes)) {
      if (node.outcome !== "fail") continue;
      const target = Array.isArray(node.target) ? node.target.map(String).join(" ") : "target";
      push(
        "hit",
        `${target}: ${str(node.message, "below the minimum target size")}`,
        asRect(node.rect),
      );
    }
  }
  return hits;
}

/** Tile ids whose rect intersects `rect` (both in document-space px). */
export function tilesCoveringRect(tiles: PageReviewTileRecord[], rect: PageReviewRect): string[] {
  const x1 = rect.x + Math.max(rect.width, 1);
  const y1 = rect.y + Math.max(rect.height, 1);
  return tiles
    .filter(
      (tile) =>
        tile.x < x1 &&
        tile.x + tile.width > rect.x &&
        tile.scrollY < y1 &&
        tile.scrollY + tile.height > rect.y,
    )
    .map((tile) => tile.id);
}

export function buildInspectionPlan(
  contexts: PageReviewContextRecord[],
  critique: PageReviewCritiqueRecord[] | null | undefined,
  gates?: PageReviewGateRecord[],
): PageReviewInspectionPlan {
  return {
    schema: PAGE_REVIEW_PACK_SCHEMA,
    purpose:
      "Bound a complete review to representative tiles instead of every PNG. Open primary tiles; treat the rest as drill-down for a named question.",
    contexts: contexts.map((ctx) => {
      const reasons = new Map<string, string[]>();
      const add = (id: string, reason: string): void => {
        const list = reasons.get(id) ?? [];
        list.push(reason);
        reasons.set(id, list);
      };
      // Hit bands sit past the cap, so they never stand in for the page bottom.
      const bands = ctx.tiles.filter(
        (tile) => tile.scope === undefined && tile.kind !== "hit-band",
      );
      const first = bands[0] ?? ctx.tiles[0];
      const last = bands[bands.length - 1] ?? ctx.tiles[ctx.tiles.length - 1];
      if (first) add(first.id, "page top: header, navigation, first fold");
      if (last && last.id !== first?.id)
        add(last.id, "page bottom: footer and final call to action");
      for (const tile of ctx.tiles) {
        if (tile.scope !== undefined) add(tile.id, `scoped tile for ${tile.scope}`);
        if (tile.kind === "hit-band") add(tile.id, "hit band: selected for a gate hit");
      }
      const row = critique?.find((entry) => entry.context_id === ctx.id);
      for (const finding of row?.findings ?? []) {
        add(finding.tile_id, `machine finding (${finding.severity}): ${finding.category}`);
      }
      const gateHits: PageReviewInspectionGateHit[] = [];
      for (const gate of gates ?? []) {
        if (gate.context_id !== ctx.id) continue;
        for (const hit of gate.hits ?? []) {
          const tiles = tilesCoveringRect(ctx.tiles, hit.rect);
          gateHits.push({ ...hit, check_id: gate.check_id, tiles });
          for (const id of tiles) add(id, `gate hit (${hit.rule}): ${hit.label}`);
        }
      }
      const byId = new Map(ctx.tiles.map((tile) => [tile.id, tile]));
      const primary = [...reasons.entries()]
        .map(([id, list]) => ({ id, file: byId.get(id)?.file ?? "", reason: list.join("; ") }))
        .filter((entry) => entry.file.length > 0)
        .sort((a, b) => a.id.localeCompare(b.id));
      return {
        context_id: ctx.id,
        full_page: ctx.files.full_page,
        primary_tiles: primary,
        drilldown_tiles: Math.max(0, ctx.tiles.length - primary.length),
        gate_hits: gateHits,
      };
    }),
  };
}

function walkFiles(root: string, dir: string, out: Array<{ path: string; bytes: number }>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, abs, out);
    else if (entry.isFile()) {
      out.push({
        path: relative(root, abs).split("\\").join("/"),
        bytes: readFileSync(abs).byteLength,
      });
    }
  }
}

/**
 * Write the pack's navigation layer: manifest, evidence files, the findings
 * skeleton and schema, and `review.md`. An unchanged judge result preserves
 * the review; changed machine evidence archives it before starting a fresh
 * review, so a previous finding position cannot acquire a new meaning.
 */
export function finalizePageReviewPack(input: FinalizePageReviewPackInput): {
  manifest: string;
  review: string;
} {
  const paths = packPaths(input.packDir);
  mkdirSync(paths.evidenceDir, { recursive: true });
  const rel = (abs: string): string => relative(input.packDir, abs).split("\\").join("/");
  const createdAt = input.createdAt ?? new Date().toISOString();
  const critique = input.critique ?? null;
  const gates = input.gates ?? [];
  const notChecked = [...(input.not_checked ?? [])];
  const warnings = [...(input.warnings ?? [])];
  const reviewDigest = critique === null ? null : machineEvidenceDigest(input.target, critique);
  const freshFindings = (): PageReviewFindingsDocument => ({
    schema: PAGE_REVIEW_FINDINGS_SCHEMA,
    schema_path: PAGE_REVIEW_FINDINGS_SCHEMA_FILENAME,
    target: input.target,
    machine_evidence_digest: reviewDigest,
    reviewer: null,
    reviewed_at: null,
    delegated_reviews: [],
    findings: [],
    dispositions: [],
  });

  // Preserve the old machine evidence before any navigation files are replaced.
  // Archive failure aborts finalization without clearing the current review.
  if (critique !== null && existsSync(paths.findings)) {
    const previous = readPackFindings(input.packDir);
    if (previous.machine_evidence_digest !== reviewDigest) {
      if (
        previous.machine_evidence_digest ||
        previous.reviewer ||
        previous.reviewed_at ||
        previous.delegated_reviews.length ||
        previous.findings.length ||
        previous.dispositions?.length
      ) {
        const historyRoot = join(input.packDir, "review-history");
        mkdirSync(historyRoot, { recursive: true });
        const historyDir = mkdtempSync(join(historyRoot, "review-"));
        for (const source of [
          paths.findings,
          paths.critique,
          paths.inspectionPlan,
          paths.verdict,
          paths.manifest,
        ]) {
          if (existsSync(source)) copyFileSync(source, join(historyDir, basename(source)));
        }
        warnings.push(
          `Changed machine evidence requires a new review. Previous review archived at ${rel(historyDir)}.`,
        );
      }
      rmSync(paths.verdict, { force: true });
      writePackFindings(input.packDir, freshFindings());
    }
  }

  if (critique === null) {
    notChecked.push({
      check: "machine vision critique",
      reason: input.judgeCommand
        ? `The judge stage has not run for this pack. Run: ${input.judgeCommand}`
        : "The judge stage has not run for this pack.",
    });
  } else if (critique.some((row) => row.outcome === "skipped")) {
    notChecked.push({
      check: "machine vision critique",
      reason:
        "The judge ran without a vision provider (or the provider never answered) for at least one context; review those tiles directly.",
    });
  }
  for (const ctx of input.contexts) {
    if (ctx.coverage.capped) {
      warnings.push(
        `${ctx.id}: tile cap reached, ${ctx.coverage.bands_reviewed} of ${ctx.coverage.bands_total} bands ` +
          `(${ctx.coverage.reviewed_height_px} of ${ctx.coverage.page_height_px} px) are in the pack; the rest of the page is unreviewed.`,
      );
    }
    if (ctx.hit_bands !== undefined && ctx.hit_bands > 0) {
      warnings.push(
        `${ctx.id}: ${ctx.hit_bands} band(s) were selected because gate hits land in them.`,
      );
    }
  }
  notChecked.push({
    check: "interactive behavior",
    reason:
      "The pack holds frozen states only. Hover, focus, open menus, and scroll-triggered motion are not in it unless captured as named states.",
  });
  notChecked.push({
    check: "external copy facts",
    reason:
      "The pack shows rendered text. It does not verify prices, dates, names, or claims against an outside source.",
  });

  // A context captured by an older writer, or one whose sheet was removed,
  // gets its contact sheet here so every finalized pack carries one per
  // context with tiles. Failure is a warning, never a lost pack.
  const contexts = input.contexts.map((ctx) => {
    if (ctx.tiles.length === 0) return ctx;
    if (ctx.contact_sheet && existsSync(join(input.packDir, ctx.contact_sheet.file))) return ctx;
    try {
      return writePackContactSheet(input.packDir, ctx);
    } catch (err: unknown) {
      warnings.push(
        `${ctx.id}: contact sheet not written (${err instanceof Error ? err.message : String(err)})`,
      );
      return ctx;
    }
  });

  const plan = buildInspectionPlan(contexts, critique, gates);
  writeJson(paths.inspectionPlan, plan);
  writeJson(paths.coverage, {
    schema: PAGE_REVIEW_PACK_SCHEMA,
    contexts: contexts.map((ctx) => ({
      context_id: ctx.id,
      page_height_px: ctx.coverage.page_height_px,
      reviewed_height_px: ctx.coverage.reviewed_height_px,
      bands_total: ctx.coverage.bands_total,
      bands_reviewed: ctx.coverage.bands_reviewed,
      capped: ctx.coverage.capped,
      tiles: ctx.tiles.length,
      scopes: ctx.scopes,
    })),
    warnings,
    not_checked: notChecked,
  });
  if (critique !== null) {
    writeJson(paths.critique, {
      schema: PAGE_REVIEW_CRITIQUE_SCHEMA,
      ...(input.pool ? { pool: input.pool } : {}),
      contexts: critique,
    });
  }

  writeJson(paths.findingsSchema, findingsSchemaDocument());
  if (!existsSync(paths.findings)) {
    writeJson(paths.findings, freshFindings());
  }

  // Retention: what the caller says, else what the manifest already carries.
  let retention = input.retention;
  if (!retention && existsSync(paths.manifest)) {
    try {
      const prior = JSON.parse(
        readFileSync(paths.manifest, "utf8"),
      ) as Partial<PageReviewPackManifest>;
      if (prior.retention) retention = prior.retention;
    } catch {
      // A malformed prior manifest is rewritten below; retention starts absent.
    }
  }

  const manifest: PageReviewPackManifest = {
    schema: PAGE_REVIEW_PACK_SCHEMA,
    created_at: createdAt,
    target: input.target,
    ...(input.tested_revision !== undefined ? { tested_revision: input.tested_revision } : {}),
    tool: input.tool ?? { name: "harnery" },
    contexts,
    gates,
    critique,
    ...(input.pool ? { pool: input.pool } : {}),
    not_checked: notChecked,
    warnings,
    ...(retention ? { retention } : {}),
    files: {
      review: rel(paths.review),
      findings: rel(paths.findings),
      findings_schema: rel(paths.findingsSchema),
      inspection_plan: rel(paths.inspectionPlan),
      coverage: rel(paths.coverage),
      index: rel(paths.index),
      inventory: rel(paths.inventory),
      critique: rel(paths.critique),
    },
  };
  writeJson(paths.manifest, manifest);
  writeJson(paths.index, {
    schema: PAGE_REVIEW_PACK_SCHEMA,
    purpose:
      "Small map for agents that should not have to probe the manifest before finding evidence.",
    target: input.target,
    counts: {
      contexts: contexts.length,
      tiles: contexts.reduce((sum, ctx) => sum + ctx.tiles.length, 0),
      machine_findings: critique?.reduce((sum, row) => sum + row.findings.length, 0) ?? null,
    },
    start_here: {
      review: manifest.files.review,
      inspection_plan: manifest.files.inspection_plan,
      coverage: manifest.files.coverage,
      critique: critique !== null ? manifest.files.critique : null,
      findings: manifest.files.findings,
      contexts: Object.fromEntries(contexts.map((ctx) => [ctx.id, ctx.files.context])),
      contact_sheets: Object.fromEntries(
        contexts.flatMap((ctx) => (ctx.contact_sheet ? [[ctx.id, ctx.contact_sheet.file]] : [])),
      ),
    },
  });
  // A verdict survives an unchanged refinalize. Changed machine evidence
  // archives and removes it above, before starting the next review.
  let verdict: PageReviewVerdictDocument | undefined;
  try {
    verdict = readPackVerdict(input.packDir);
  } catch {
    verdict = undefined;
  }
  writeFileSync(paths.review, renderReviewMarkdown(manifest, plan, input.judgeCommand, verdict));
  const inventory: Array<{ path: string; bytes: number }> = [];
  walkFiles(input.packDir, input.packDir, inventory);
  writeJson(paths.inventory, {
    schema: PAGE_REVIEW_PACK_SCHEMA,
    files: inventory.sort((a, b) => a.path.localeCompare(b.path)),
  });
  // The manifest is rewritten once with the pack's size so `list` and the
  // run result can report it without walking the tree again.
  manifest.size_bytes = inventory.reduce((sum, file) => sum + file.bytes, 0);
  writeJson(paths.manifest, manifest);
  return { manifest: paths.manifest, review: paths.review };
}

function severityCounts(findings: ReadonlyArray<{ severity: string }>): string {
  const high = findings.filter((f) => f.severity === "high").length;
  const medium = findings.filter((f) => f.severity === "medium").length;
  const low = findings.filter((f) => f.severity === "low").length;
  return `${high} high / ${medium} medium / ${low} low`;
}

export function renderReviewMarkdown(
  manifest: PageReviewPackManifest,
  plan: PageReviewInspectionPlan,
  judgeCommand?: string,
  verdict?: PageReviewVerdictDocument,
): string {
  const lines: string[] = [];
  const contexts = manifest.contexts;
  lines.push(`# Page review: ${manifest.target}`);
  lines.push("");
  lines.push(`Captured ${manifest.created_at}. ${contexts.length} rendering context(s).`);
  if (manifest.tested_revision) lines.push(`Tested revision: \`${manifest.tested_revision}\`.`);
  lines.push("");
  lines.push(
    "This pack is evidence, not a verdict. Tile PNGs are the evidence; every other file here is navigation. Cite a tile as `<context-id>/<tile-id>` in every finding.",
  );
  lines.push("");
  lines.push("## Delegated review protocol");
  lines.push("");
  lines.push(
    "1. The coordinating agent reads the context table and coverage below. A budgeted context can have unreviewed gaps between selected tiles; use its recorded coverage intervals.",
  );
  lines.push(
    "2. Read `evidence/inspection-plan.json`, then dispatch review subagents with disjoint assignments covering every `primary_tiles` entry. Choose the first model available in this exact order: GPT-5.6 Luna (`gpt-5.6-luna` where an id is required), Composer 2.5, Haiku 4.5. Use that model for every tile-review subagent; do not substitute another model. If none exists, the review is incomplete. Each tile must be opened at native pixels by at least one completed subagent. The coordinating agent must not open tile images itself.",
  );
  lines.push(
    "3. Review subagents may use the contact sheet (`contacts.png`, every tile downscaled into one grid, ids stamped, row-major order) and the full-page screenshot for orientation only; both hide small defects a tile shows at native pixels.",
  );
  lines.push(
    "4. Review subagents read the machine findings for their assigned tiles. A finding is a claim to confirm against the tile, never a fact. Slice-edge cropping is a tiling artifact, not a defect.",
  );
  lines.push(
    "5. Review subagents read the deterministic gate results for their assignments. A failed gate is already a defect; do not re-litigate it, cite it.",
  );
  lines.push(
    "6. Review subagents read `not checked`. Do not invent evidence for anything listed there; record the gap in their report instead.",
  );
  lines.push(
    "7. The coordinating agent serializes the subagent reports into `findings.json`, recording the reviewer names or ids, then runs the verdict. If subagents are unavailable, any primary tile is uncovered, or reports conflict, dispatch another subagent; never substitute a coordinator image read. Without complete delegated coverage, the review is incomplete.",
  );
  lines.push("");
  lines.push("## Contexts");
  lines.push("");
  lines.push(
    "| Context | Viewport | Theme | State | Page (w×h px) | Tiles | Coverage | Contacts | Full page |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const ctx of contexts) {
    const cov = ctx.coverage.capped
      ? `${ctx.coverage.bands_reviewed}/${ctx.coverage.bands_total} bands, capped`
      : "complete";
    const contacts = ctx.contact_sheet
      ? `[${CONTACT_SHEET_FILENAME}](${ctx.contact_sheet.file})`
      : "none";
    lines.push(
      `| ${ctx.id} | ${ctx.viewport} | ${ctx.theme} | ${ctx.state} | ${ctx.page.width}×${ctx.page.height} | ${ctx.tiles.length} | ${cov} | ${contacts} | [full-page.png](${ctx.files.full_page}) |`,
    );
  }
  lines.push("");
  lines.push("## Coverage and warnings");
  lines.push("");
  if (manifest.warnings.length === 0) lines.push("- No warnings from the capture.");
  for (const warning of manifest.warnings) lines.push(`- ${warning}`);
  lines.push("");
  lines.push("## Not checked");
  lines.push("");
  for (const entry of manifest.not_checked) lines.push(`- **${entry.check}:** ${entry.reason}`);
  lines.push("");
  lines.push("## Deterministic gates");
  lines.push("");
  if (manifest.gates.length === 0) {
    lines.push("- No gate results were recorded in this pack.");
  } else {
    const shown = 20;
    for (const gate of manifest.gates) {
      const detail = gate.failures.length > 0 ? `: ${gate.failures.join("; ")}` : "";
      lines.push(`- ${gate.context_id} · ${gate.check_id} · **${gate.outcome}**${detail}`);
      const ctx = contexts.find((c) => c.id === gate.context_id);
      const planned = plan.contexts.find((c) => c.context_id === gate.context_id);
      const hits = planned?.gate_hits.filter((hit) => hit.check_id === gate.check_id) ?? [];
      for (const hit of hits.slice(0, shown)) {
        const r = hit.rect;
        const where = `(${Math.round(r.x)}, ${Math.round(r.y)}) ${Math.round(r.width)}×${Math.round(r.height)} px`;
        const tiles =
          hit.tiles.length > 0
            ? hit.tiles
                .map((id) => {
                  const tile = ctx?.tiles.find((t) => t.id === id);
                  return tile ? `[${id}](${tile.file})` : id;
                })
                .join(", ")
            : "no tile covers this rect (outside the reviewed page area)";
        lines.push(`  - ${hit.rule} · ${hit.label} · at ${where} → ${tiles}`);
      }
      if (hits.length > shown) {
        lines.push(
          `  - ${hits.length - shown} more hit(s) with rectangles in \`evidence/inspection-plan.json\``,
        );
      }
    }
  }
  lines.push("");
  lines.push("## Machine findings");
  lines.push("");
  if (manifest.critique === null) {
    lines.push(
      judgeCommand
        ? `The judge stage has not run. Run \`${judgeCommand}\` to add machine findings, then dispatch review subagents over the primary tiles.`
        : "The judge stage has not run. Dispatch review subagents over the primary tiles.",
    );
  } else {
    for (const row of manifest.critique) {
      const reused = row.tiles_reused > 0 ? `, ${row.tiles_reused} reused from the baseline` : "";
      lines.push(
        `### ${row.context_id} · ${row.outcome.toUpperCase()} · ${row.tiles_reviewed} of ${row.tiles_total} tiles judged${reused} · ${severityCounts(row.findings)}`,
      );
      lines.push("");
      if (row.error) lines.push(`- Error: ${row.error}`);
      if (row.findings.length === 0) lines.push("- No machine findings.");
      for (const finding of row.findings) {
        const ctx = contexts.find((c) => c.id === row.context_id);
        const tile = ctx?.tiles.find((t) => t.id === finding.tile_id);
        const link = tile ? `[${finding.tile_id}](${tile.file})` : finding.tile_id;
        lines.push(
          `- ${link} · **${finding.severity}** · ${finding.category}: ${finding.description}`,
        );
      }
      lines.push("");
    }
  }
  if (verdict) {
    lines.push("## Reviewed outcome");
    lines.push("");
    lines.push(
      `**${verdict.reviewed_outcome.toUpperCase()}** (machine outcome ${verdict.machine_outcome}), recorded ${verdict.reviewed_at} in \`evidence/${PAGE_REVIEW_VERDICT_FILENAME}\`.`,
    );
    lines.push("");
    lines.push(
      `- Machine high findings: ${verdict.high_total} total · ${verdict.high_confirmed} confirmed · ${verdict.high_dismissed} dismissed (artifact, not a defect, or duplicate of a gate) · ${verdict.high_open} without a disposition.`,
    );
    lines.push(
      `- Review-subagent findings at critical or high: ${verdict.reviewer_high}. Dispositions applied: ${verdict.dispositions_applied}.`,
    );
    lines.push(
      `- Delegated primary-tile coverage: ${verdict.primary_tiles_reviewed}/${verdict.primary_tiles_total}.`,
    );
    if (verdict.uncovered_primary_tiles.length > 0) {
      lines.push(`- Uncovered primary tiles: ${verdict.uncovered_primary_tiles.join(", ")}.`);
    }
    if (verdict.unmatched_dispositions.length > 0) {
      lines.push(
        `- Dispositions naming no machine finding (ignored): ${verdict.unmatched_dispositions.join(", ")}.`,
      );
    }
    lines.push(
      "- A confirmed or undispositioned high, or a review-subagent finding at high or critical, fails the reviewed outcome. Missing delegated coverage keeps it incomplete. The machine critique above is unchanged by any disposition.",
    );
    lines.push("");
  }
  lines.push("## Inspection plan");
  lines.push("");
  for (const ctx of plan.contexts) {
    lines.push(
      `### ${ctx.context_id} · ${ctx.primary_tiles.length} primary tile(s), ${ctx.drilldown_tiles} drill-down`,
    );
    lines.push("");
    for (const tile of ctx.primary_tiles) {
      lines.push(`- [${tile.id}](${tile.file}) · ${tile.reason}`);
    }
    lines.push("");
  }
  lines.push("## Tile index");
  lines.push("");
  for (const ctx of contexts) {
    lines.push(`### ${ctx.id}`);
    lines.push("");
    if (ctx.contact_sheet) {
      lines.push(
        `Contact sheet: [${CONTACT_SHEET_FILENAME}](${ctx.contact_sheet.file}) shows every tile below in id order, row-major (left to right, then top to bottom), ${ctx.contact_sheet.columns} per row, each cell stamped with its tile id. Orientation only; a review subagent opens the tile file for native pixels.`,
      );
      lines.push("");
    }
    lines.push("| Tile | Label | Kind | Scope | y (px) | Size (px) | File |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const tile of ctx.tiles) {
      const kind = tile.kind ?? (tile.scope !== undefined ? "scope" : "band");
      lines.push(
        `| ${tile.id} | ${tile.label} | ${kind} | ${tile.scope ?? "full page"} | ${tile.scrollY} | ${tile.width}×${tile.height} | [${tile.id}.png](${tile.file}) |`,
      );
    }
    lines.push("");
    if (ctx.expanded && ctx.expanded.length > 0) {
      lines.push(
        "Expanded tiles (the same region re-rendered at a higher device scale factor; the source tile above is unchanged):",
      );
      lines.push("");
      for (const entry of ctx.expanded) {
        lines.push(
          `- ${entry.tile} at ${entry.dpr}× · ${entry.width}×${entry.height} px · [${expandedTileFilename(entry.tile, entry.dpr)}](${entry.file})`,
        );
      }
      lines.push("");
    }
  }
  lines.push("## Write findings");
  lines.push("");
  lines.push(
    "`findings.json` is the delegated review output file. The coordinating agent writes it serially from completed subagent reports. Record each assignment and its chosen model with `review-pack reviews add`; `delegated_reviews` must prove completed coverage for every primary tile before the verdict can pass. Set top-level `reviewer` to the review subagent names or ids and set an RFC 3339 `reviewed_at`. Each finding requires `id`, `severity` (critical, high, medium, low, info), `category`, `context_id`, `evidence` (tile ids or pack-relative paths), and `observation`; `recommendation` and `confidence` are optional. Use `findings.schema.json` only when a validator rejects the write.",
  );
  lines.push("");
  lines.push("## Files");
  lines.push("");
  lines.push(
    `- [Manifest](${PAGE_REVIEW_MANIFEST_FILENAME}) · [Inspection plan](${manifest.files.inspection_plan}) · [Coverage](${manifest.files.coverage}) · [Index](${manifest.files.index}) · [Inventory](${manifest.files.inventory})`,
  );
  if (manifest.critique !== null) lines.push(`- [Machine critique](${manifest.files.critique})`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Expiry: find packs, delete the expired ones, leave a stub behind
// ---------------------------------------------------------------------------

/** Schema of the stub left behind when an expired pack is deleted. */
export const PAGE_REVIEW_EXPIRED_SCHEMA = "harnery-page-review-expired/v1";

/** The artifact store's per-workspace manifest. A standalone review-pack
 * workspace IS the pack, so deletion keeps this one file beside the stub.
 * Named here rather than imported: this toolkit module must not reach into
 * `src/core`. */
const ARTIFACT_WORKSPACE_MANIFEST_FILENAME = ".harnery-artifact.json";

/** What remains of a deleted pack: enough for a result document's
 * `review_pack.dir` to explain itself without the evidence. */
export interface PageReviewExpiredStub {
  schema: typeof PAGE_REVIEW_EXPIRED_SCHEMA;
  target: string;
  created_at: string;
  expires_at: string;
  deleted_at: string;
  /** Contexts the pack held before deletion. */
  contexts: number;
  /** Aggregate of the manifest's critique outcomes; null when no judge ran. */
  machine_outcome: PageReviewCritiqueRecord["outcome"] | null;
  result: PageReviewVerdictDocument | null;
  findings_summary: {
    machine_high: number;
    machine_medium: number;
    machine_low: number;
    reviewer_findings: number;
    dispositions: number;
  } | null;
}

/** One pack as seen by the expiry sweep. `expires_at`, `size_bytes`, and
 * `managed` are null when the manifest does not carry them; such a pack is
 * never deleted. */
export interface PageReviewPackRow {
  dir: string;
  target: string;
  created_at: string;
  expires_at: string | null;
  size_bytes: number | null;
  managed: boolean | null;
  /** `retention.expires_at` is in the past (at the sweep's `now`). */
  expired: boolean;
}

export interface DeleteExpiredPacksInput {
  /** Directories to search; see `findPageReviewPacks` for the shape searched. */
  roots: string[];
  /** Sweep clock (default: the wall clock). */
  now?: Date;
  /** Also delete packs whose manifest says `managed: false` (an explicit
   * `--out`). Default false: only the store's own packs are touched. */
  includeUnmanaged?: boolean;
  /** Report without touching the filesystem. */
  dryRun: boolean;
}

export interface DeleteExpiredPacksResult {
  /** Every pack found under the roots, deletable or not. */
  candidates: PageReviewPackRow[];
  /** Packs removed by this call; under `dryRun`, the packs that would be. */
  deleted: PageReviewPackRow[];
}

/** The manifest at `dir`, or null when `dir` is not a page review pack. A
 * malformed or foreign `manifest.json` is not a pack. */
function readPackManifestIfPack(dir: string): PageReviewPackManifest | null {
  const manifestPath = join(dir, PAGE_REVIEW_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as Partial<PageReviewPackManifest>;
    if (manifest.schema !== PAGE_REVIEW_PACK_SCHEMA) return null;
    if (typeof manifest.target !== "string" || typeof manifest.created_at !== "string") return null;
    return manifest as PageReviewPackManifest;
  } catch {
    return null;
  }
}

function listChildDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** A workspace and the qa-run packs beneath it (`run-<id>/pack`). */
function packCandidatesUnder(workspace: string): string[] {
  const out = [workspace];
  for (const runDir of listChildDirs(workspace)) {
    if (!runDir.split(/[\\/]/).pop()?.startsWith("run-")) continue;
    out.push(join(runDir, PAGE_REVIEW_PACK_DIRNAME));
  }
  return out;
}

/**
 * Every page review pack under the given roots. A pack is a directory whose
 * `manifest.json` carries the pack schema. Each root is searched as: the root
 * itself, each immediate child workspace, and `run-<id>/pack` under the root and
 * under each workspace (the layout of the managed artifact store, where a
 * `review-pack` workspace is itself the pack and a `qa-run` workspace holds
 * one pack per run). Nothing deeper is walked.
 */
export function findPageReviewPacks(roots: string[]): string[] {
  const found = new Set<string>();
  for (const rawRoot of roots) {
    const root = resolve(rawRoot);
    if (!existsSync(root)) continue;
    const candidates = [
      ...packCandidatesUnder(root),
      ...listChildDirs(root).flatMap((workspace) => packCandidatesUnder(workspace)),
    ];
    for (const candidate of candidates) {
      if (readPackManifestIfPack(candidate)) found.add(candidate);
    }
  }
  return [...found].sort();
}

function packRow(dir: string, manifest: PageReviewPackManifest, nowMs: number): PageReviewPackRow {
  const expiresAt = manifest.retention?.expires_at ?? null;
  const expiresMs = expiresAt === null ? Number.NaN : Date.parse(expiresAt);
  return {
    dir,
    target: manifest.target,
    created_at: manifest.created_at,
    expires_at: expiresAt,
    size_bytes: typeof manifest.size_bytes === "number" ? manifest.size_bytes : null,
    managed: typeof manifest.retention?.managed === "boolean" ? manifest.retention.managed : null,
    expired: Number.isFinite(expiresMs) && expiresMs <= nowMs,
  };
}

/** Whether the sweep may delete this pack: expired, and either managed by the
 * store or explicitly included. A pack without retention never qualifies. */
export function isPackDeletable(row: PageReviewPackRow, includeUnmanaged = false): boolean {
  if (!row.expired || row.expires_at === null) return false;
  if (row.managed === true) return true;
  return includeUnmanaged && row.managed === false;
}

/** One verdict for the whole pack from its per-context critique rows: any
 * fail is a fail, otherwise the weakest non-pass outcome, otherwise pass. */
export function aggregateMachineOutcome(
  critique: PageReviewCritiqueRecord[] | null | undefined,
): PageReviewCritiqueRecord["outcome"] | null {
  if (!critique || critique.length === 0) return null;
  if (critique.some((row) => row.outcome === "fail")) return "fail";
  if (critique.some((row) => row.outcome === "incomplete")) return "incomplete";
  if (critique.some((row) => row.outcome === "skipped")) return "skipped";
  return "pass";
}

/**
 * Delete every expired pack under the roots and leave `pack-expired.json` in
 * its place. Deletion removes every entry inside the pack directory except
 * the artifact store's own `.harnery-artifact.json` (a standalone review-pack
 * workspace is the pack, and the store still owns the workspace). Nothing
 * outside the pack directory is touched. Only a pack whose manifest carries
 * `retention.expires_at` in the past is eligible, and an unmanaged pack
 * (explicit `--out`) only when `includeUnmanaged` is set.
 */
function expiredFindingsSummary(
  dir: string,
  manifest: PageReviewPackManifest,
): PageReviewExpiredStub["findings_summary"] {
  try {
    const findings = readPackFindings(dir);
    const machine = manifest.critique?.flatMap((row) => row.findings) ?? [];
    return {
      machine_high: machine.filter((f) => f.severity === "high").length,
      machine_medium: machine.filter((f) => f.severity === "medium").length,
      machine_low: machine.filter((f) => f.severity === "low").length,
      reviewer_findings: findings.findings.length,
      dispositions: findings.dispositions?.length ?? 0,
    };
  } catch {
    return null;
  }
}

export function deleteExpiredPacks(input: DeleteExpiredPacksInput): DeleteExpiredPacksResult {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const candidates: PageReviewPackRow[] = [];
  const deleted: PageReviewPackRow[] = [];
  for (const dir of findPageReviewPacks(input.roots)) {
    const manifest = readPackManifestIfPack(dir);
    if (!manifest) continue;
    const row = packRow(dir, manifest, nowMs);
    candidates.push(row);
    if (!isPackDeletable(row, input.includeUnmanaged === true)) continue;
    const protection = packArtifactProtection(dir);
    if (protection.protected) continue;
    let locked = false;
    if (!input.dryRun && protection.lock) {
      try {
        mkdirSync(protection.lock);
        locked = true;
      } catch {
        continue;
      }
    }
    try {
      if (packArtifactProtection(dir).protected) continue;
      if (!input.dryRun) {
        const stub: PageReviewExpiredStub = {
          schema: PAGE_REVIEW_EXPIRED_SCHEMA,
          target: manifest.target,
          created_at: manifest.created_at,
          // Guarded by isPackDeletable: a deletable row always has expires_at.
          expires_at: row.expires_at ?? "",
          deleted_at: now.toISOString(),
          contexts: Array.isArray(manifest.contexts) ? manifest.contexts.length : 0,
          machine_outcome: aggregateMachineOutcome(manifest.critique),
          result: readPackVerdict(dir) ?? null,
          findings_summary: expiredFindingsSummary(dir, manifest),
        };
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === ARTIFACT_WORKSPACE_MANIFEST_FILENAME) continue;
          rmSync(join(dir, entry.name), { recursive: true, force: true });
        }
        writeJson(join(dir, PAGE_REVIEW_EXPIRED_STUB_FILENAME), stub);
      }
      deleted.push(row);
    } finally {
      if (locked) rmdirSync(protection.lock!);
    }
  }
  return { candidates, deleted };
}

/** Read the artifact wire contract without importing the product tier. The same
 * lock protocol covers core hold writes and pack payload deletion. Unknown or
 * malformed manifests are retained, including legacy manifests awaiting migration. */
function packArtifactProtection(dir: string): { protected: boolean; lock?: string } {
  let current = resolve(dir);
  let lock: string | undefined;
  let protectedByManifest = false;
  while (dirname(current) !== current) {
    try {
      if (lstatSync(current).isSymbolicLink()) return { protected: true };
      if (
        basename(dirname(current)) === "artifacts" &&
        basename(dirname(dirname(current))) === ".harnery"
      ) {
        lock = join(dirname(dirname(current)), "artifacts-mutation.lock");
        if (!existsSync(join(current, ARTIFACT_WORKSPACE_MANIFEST_FILENAME)))
          protectedByManifest = true;
      }
      const path = join(current, ARTIFACT_WORKSPACE_MANIFEST_FILENAME);
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
          return { protected: true };
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        if (
          manifest?.schema_version !== 2 ||
          !Array.isArray(manifest.holds) ||
          manifest.holds.length !== 0
        )
          protectedByManifest = true;
      }
    } catch {
      return { protected: true };
    }
    current = dirname(current);
  }
  return { protected: protectedByManifest, lock };
}
