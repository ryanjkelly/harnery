// Page review pack: the on-disk evidence for reviewing one rendered page
// without a browser. A pack holds, per rendering context (viewport × theme ×
// state), the full-page screenshot, its critique tiles as PNG files, the
// serialized DOM, and the QA signature; plus a `review.md` entry point, a
// bounded inspection plan, coverage, and a reviewer-owned `findings.json`.
//
// The split this enables: capture (needs a browser, seconds) and judging
// (vision calls, minutes) become separate stages. Every browser is closed
// before the first model call, and one bounded pool judges every tile of
// every context from disk. Tile PNGs are the evidence; every other file in
// the pack is navigation.
//
// Toolkit tier: this module must not import src/core (layering check).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { CritiqueCoverage, CritiqueFinding, CritiqueTile } from "./critique.js";
import type { QaContext, QaSignature } from "./qa-plan.js";

export const PAGE_REVIEW_PACK_SCHEMA = "harnery-page-review/v1";
export const PAGE_REVIEW_FINDINGS_SCHEMA = "harnery-page-review-findings/v1";

/** Directory name a qa-run gives its pack inside the run directory. */
export const PAGE_REVIEW_PACK_DIRNAME = "pack";

export const PAGE_REVIEW_MANIFEST_FILENAME = "manifest.json";
export const PAGE_REVIEW_REVIEW_FILENAME = "review.md";
export const PAGE_REVIEW_FINDINGS_FILENAME = "findings.json";
export const PAGE_REVIEW_FINDINGS_SCHEMA_FILENAME = "findings.schema.json";

/** One tile as stored in the pack. `id` is stable within its context
 * (`T001`, `T002`, …) and is what a finding cites. `file` is pack-relative. */
export interface PageReviewTileRecord {
  id: string;
  /** Tiler index (position in the capture's tile list). */
  index: number;
  label: string;
  /** Selector the tile was cut for; absent for full-page bands. */
  scope?: string;
  x: number;
  scrollY: number;
  width: number;
  height: number;
  file: string;
  sha256: string;
  bytes: number;
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
  /** Full-page band coverage (what the tiler kept of the page). */
  coverage: CritiqueCoverage;
  scopes: Array<{ selector: string; tiles: number }>;
  /** Pack-relative file paths. */
  files: { full_page: string; dom: string; signature: string; tiles: string; context: string };
  dom_sha256: string;
  tiles: PageReviewTileRecord[];
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
  tiles: CritiqueTile[];
  coverage: CritiqueCoverage;
  scopeTiles?: Array<{ selector: string; tiles: CritiqueTile[] }>;
  signature: QaSignature;
  domHtml: string;
  capturedAt?: string;
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
}

export interface PageReviewGateRecord {
  context_id: string;
  check_id: string;
  outcome: "passed" | "failed" | "unknown";
  failures: string[];
}

export interface PageReviewInspectionPlan {
  schema: string;
  purpose: string;
  contexts: Array<{
    context_id: string;
    full_page: string;
    /** Tiles to open for a complete review; everything else is drill-down. */
    primary_tiles: Array<{ id: string; file: string; reason: string }>;
    drilldown_tiles: number;
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

/**
 * Write one context's capture into the pack: `full-page.png`, `dom.html`,
 * `signature.json`, `tiles/T001.png…`, `tiles.json`, and `context.json`.
 * Full-page bands come first, then each scope's tiles in selector order, so
 * tile ids are stable for a given capture. Returns the record written.
 */
export function writePackContext(
  packDir: string,
  capture: PageReviewContextCapture,
): PageReviewContextRecord {
  const contextId =
    capture.context.id ??
    `${capture.context.viewport}-${capture.context.theme}-${capture.context.state}`;
  const paths = packPaths(packDir);
  const dir = paths.contextDir(contextId);
  const tilesDir = join(dir, "tiles");
  mkdirSync(tilesDir, { recursive: true });

  const rel = (abs: string): string => relative(packDir, abs).split("\\").join("/");
  const fullPagePath = join(dir, "full-page.png");
  const domPath = join(dir, "dom.html");
  const signaturePath = join(dir, "signature.json");
  const tilesPath = join(dir, "tiles.json");
  const contextPath = join(dir, "context.json");
  writeFileSync(fullPagePath, capture.fullPage);
  writeFileSync(domPath, capture.domHtml);
  writeJson(signaturePath, capture.signature);

  const records: PageReviewTileRecord[] = [];
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
    records.push({
      id,
      index: tile.index,
      label: tile.label,
      ...(scope !== undefined ? { scope } : {}),
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
    page: { width: capture.pageWidth, height: capture.pageHeight },
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
  };
  writeJson(tilesPath, { schema: PAGE_REVIEW_PACK_SCHEMA, context_id: contextId, tiles: records });
  writeJson(contextPath, { schema: PAGE_REVIEW_PACK_SCHEMA, ...record });
  return record;
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
    throw new Error(`${path}: expected schema ${PAGE_REVIEW_PACK_SCHEMA}, found ${schema}`);
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

export function readPackFullPage(packDir: string, record: PageReviewContextRecord): Buffer {
  return readFileSync(join(packDir, record.files.full_page));
}

export function readPackSignature(packDir: string, record: PageReviewContextRecord): QaSignature {
  return readJson<QaSignature>(join(packDir, record.files.signature));
}

export function readPackDom(packDir: string, record: PageReviewContextRecord): string {
  return readFileSync(join(packDir, record.files.dom), "utf8");
}

export function readPackManifest(packDir: string): PageReviewPackManifest {
  const manifest = readJson<PageReviewPackManifest>(packPaths(packDir).manifest);
  if (manifest.schema !== PAGE_REVIEW_PACK_SCHEMA) {
    throw new Error(
      `${packPaths(packDir).manifest}: expected schema ${PAGE_REVIEW_PACK_SCHEMA}, found ${manifest.schema}`,
    );
  }
  return manifest;
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
}

export function findingsSchemaDocument(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: PAGE_REVIEW_FINDINGS_SCHEMA,
    title: "Page review findings",
    type: "object",
    additionalProperties: false,
    required: ["schema", "target", "reviewer", "reviewed_at", "findings"],
    properties: {
      schema: { const: PAGE_REVIEW_FINDINGS_SCHEMA },
      schema_path: { type: "string" },
      target: { type: "string" },
      reviewer: { type: ["string", "null"] },
      reviewed_at: { type: ["string", "null"], format: "date-time" },
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
    },
  };
}

export function buildInspectionPlan(
  contexts: PageReviewContextRecord[],
  critique: PageReviewCritiqueRecord[] | null | undefined,
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
      const bands = ctx.tiles.filter((tile) => tile.scope === undefined);
      const first = bands[0] ?? ctx.tiles[0];
      const last = bands[bands.length - 1] ?? ctx.tiles[ctx.tiles.length - 1];
      if (first) add(first.id, "page top: header, navigation, first fold");
      if (last && last.id !== first?.id)
        add(last.id, "page bottom: footer and final call to action");
      for (const tile of ctx.tiles) {
        if (tile.scope !== undefined) add(tile.id, `scoped tile for ${tile.scope}`);
      }
      const row = critique?.find((entry) => entry.context_id === ctx.id);
      for (const finding of row?.findings ?? []) {
        add(finding.tile_id, `machine finding (${finding.severity}): ${finding.category}`);
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
 * skeleton and schema (never overwriting a findings file a reviewer already
 * filled), and `review.md`. Safe to call twice: once after capture, again
 * after the judge so machine findings land in the plan and the review.
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

  const plan = buildInspectionPlan(input.contexts, critique);
  writeJson(paths.inspectionPlan, plan);
  writeJson(paths.coverage, {
    schema: PAGE_REVIEW_PACK_SCHEMA,
    contexts: input.contexts.map((ctx) => ({
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
      schema: PAGE_REVIEW_PACK_SCHEMA,
      ...(input.pool ? { pool: input.pool } : {}),
      contexts: critique,
    });
  }

  writeJson(paths.findingsSchema, findingsSchemaDocument());
  if (!existsSync(paths.findings)) {
    writeJson(paths.findings, {
      schema: PAGE_REVIEW_FINDINGS_SCHEMA,
      schema_path: PAGE_REVIEW_FINDINGS_SCHEMA_FILENAME,
      target: input.target,
      reviewer: null,
      reviewed_at: null,
      findings: [],
    });
  }

  const manifest: PageReviewPackManifest = {
    schema: PAGE_REVIEW_PACK_SCHEMA,
    created_at: createdAt,
    target: input.target,
    ...(input.tested_revision !== undefined ? { tested_revision: input.tested_revision } : {}),
    tool: input.tool ?? { name: "harnery" },
    contexts: input.contexts,
    gates,
    critique,
    ...(input.pool ? { pool: input.pool } : {}),
    not_checked: notChecked,
    warnings,
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
      contexts: input.contexts.length,
      tiles: input.contexts.reduce((sum, ctx) => sum + ctx.tiles.length, 0),
      machine_findings: critique?.reduce((sum, row) => sum + row.findings.length, 0) ?? null,
    },
    start_here: {
      review: manifest.files.review,
      inspection_plan: manifest.files.inspection_plan,
      coverage: manifest.files.coverage,
      critique: critique !== null ? manifest.files.critique : null,
      findings: manifest.files.findings,
      contexts: Object.fromEntries(input.contexts.map((ctx) => [ctx.id, ctx.files.context])),
    },
  });
  writeFileSync(paths.review, renderReviewMarkdown(manifest, plan, input.judgeCommand));
  const inventory: Array<{ path: string; bytes: number }> = [];
  walkFiles(input.packDir, input.packDir, inventory);
  writeJson(paths.inventory, {
    schema: PAGE_REVIEW_PACK_SCHEMA,
    files: inventory.sort((a, b) => a.path.localeCompare(b.path)),
  });
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
  lines.push("## Agent review protocol");
  lines.push("");
  lines.push(
    "1. Read the context table and the coverage section below. A capped context has unreviewed page below its last tile.",
  );
  lines.push(
    "2. Read `evidence/inspection-plan.json`. Its `primary_tiles` are the complete-review budget for each context: the top of the page, the bottom, every scoped tile, and every tile with a machine finding. Open those tile files. Open another tile only for a named layout, text, or image question.",
  );
  lines.push(
    "3. Use the full-page screenshot for orientation only; it is downscaled by any viewer and hides small defects a tile shows at native pixels.",
  );
  lines.push(
    "4. Read the machine findings section. They come from a vision model judging each tile alone; a finding is a claim to confirm against the tile, never a fact. Slice-edge cropping is a tiling artifact, not a defect.",
  );
  lines.push(
    "5. Read the deterministic gate results. A failed gate is already a defect; do not re-litigate it, cite it.",
  );
  lines.push(
    "6. Read `not checked`. Do not invent evidence for anything listed there; record the gap in `findings.json` instead.",
  );
  lines.push(
    "7. Write findings into `findings.json` (contract below). Check peer claims before writing when the pack sits in a shared workspace.",
  );
  lines.push("");
  lines.push("## Contexts");
  lines.push("");
  lines.push(
    "| Context | Viewport | Theme | State | Page (w×h px) | Tiles | Coverage | Full page |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const ctx of contexts) {
    const cov = ctx.coverage.capped
      ? `${ctx.coverage.bands_reviewed}/${ctx.coverage.bands_total} bands, capped`
      : "complete";
    lines.push(
      `| ${ctx.id} | ${ctx.viewport} | ${ctx.theme} | ${ctx.state} | ${ctx.page.width}×${ctx.page.height} | ${ctx.tiles.length} | ${cov} | [full-page.png](${ctx.files.full_page}) |`,
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
    for (const gate of manifest.gates) {
      const detail = gate.failures.length > 0 ? `: ${gate.failures.join("; ")}` : "";
      lines.push(`- ${gate.context_id} · ${gate.check_id} · **${gate.outcome}**${detail}`);
    }
  }
  lines.push("");
  lines.push("## Machine findings");
  lines.push("");
  if (manifest.critique === null) {
    lines.push(
      judgeCommand
        ? `The judge stage has not run. Run \`${judgeCommand}\` to add machine findings, or review the primary tiles directly.`
        : "The judge stage has not run. Review the primary tiles directly.",
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
    lines.push("| Tile | Label | Scope | y (px) | Size (px) | File |");
    lines.push("|---|---|---|---|---|---|");
    for (const tile of ctx.tiles) {
      lines.push(
        `| ${tile.id} | ${tile.label} | ${tile.scope ?? "full page"} | ${tile.scrollY} | ${tile.width}×${tile.height} | [${tile.id}.png](${tile.file}) |`,
      );
    }
    lines.push("");
  }
  lines.push("## Write findings");
  lines.push("");
  lines.push(
    "`findings.json` is the reviewer-owned output file. Set top-level `reviewer` and an RFC 3339 `reviewed_at`. Each finding requires `id`, `severity` (critical, high, medium, low, info), `category`, `context_id`, `evidence` (tile ids or pack-relative paths), and `observation`; `recommendation` and `confidence` are optional. Use `findings.schema.json` only when a validator rejects the write.",
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
