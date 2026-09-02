import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { CritiqueTile } from "./critique.ts";
import {
  buildContactSheet,
  buildInspectionPlan,
  CONTACT_SHEET_COLUMNS,
  cropPngRegion,
  expandedTileFilename,
  finalizePageReviewPack,
  findPackTile,
  GATE_HITS_PER_ENVELOPE,
  gateHitsFromEnvelope,
  listPackContexts,
  PAGE_REVIEW_FINDINGS_SCHEMA,
  PAGE_REVIEW_PACK_SCHEMA,
  type PageReviewContextCapture,
  readPackContext,
  readPackManifest,
  readPackTiles,
  tilesCoveringRect,
  writePackContactSheet,
  writePackContext,
  writePackExpandedTile,
} from "./page-review-pack.ts";

function png(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

function tiles(count: number, label = "band"): CritiqueTile[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: `${label} ${index + 1}`,
    scrollY: index * 1280,
    x: 0,
    width: 16,
    height: 16,
    pngBase64: png(16, 16).toString("base64"),
  }));
}

function capture(overrides: Partial<PageReviewContextCapture> = {}): PageReviewContextCapture {
  return {
    context: { viewport: "desktop", theme: "light", state: "default" },
    url: "http://localhost:4276/page",
    title: "Fixture",
    fullPage: png(64, 128),
    pageWidth: 64,
    pageHeight: 128,
    tiles: tiles(3),
    coverage: {
      page_height_px: 128,
      reviewed_height_px: 128,
      bands_total: 3,
      bands_reviewed: 3,
      capped: false,
    },
    signature: {
      url: "http://localhost:4276/page",
      capturedAt: "2026-09-02T00:00:00.000Z",
      nodes: [],
      stylesheets: [],
    },
    domHtml: "<html><body>fixture</body></html>",
    ...overrides,
  };
}

function packDir(): string {
  return mkdtempSync(join(tmpdir(), "page-review-pack-"));
}

describe("writePackContext / readPackContext / readPackTiles", () => {
  test("writes stable tile ids in band-then-scope order and reads them back byte-exact", () => {
    const dir = packDir();
    const record = writePackContext(
      dir,
      capture({ scopeTiles: [{ selector: "#hero", tiles: tiles(2, "hero") }] }),
    );
    expect(record.id).toBe("desktop-light-default");
    expect(record.tiles.map((t) => t.id)).toEqual(["T001", "T002", "T003", "T004", "T005"]);
    expect(record.tiles[3]?.scope).toBe("#hero");
    expect(record.tiles[0]?.scope).toBeUndefined();
    expect(record.scopes).toEqual([{ selector: "#hero", tiles: 2 }]);
    expect(existsSync(join(dir, record.files.full_page))).toBe(true);
    expect(existsSync(join(dir, record.files.dom))).toBe(true);
    expect(existsSync(join(dir, record.files.signature))).toBe(true);
    expect(readFileSync(join(dir, record.files.dom), "utf8")).toContain("fixture");

    const again = readPackContext(dir, record.id);
    expect(again).toEqual(record);
    const loaded = readPackTiles(dir, again);
    expect(loaded).toHaveLength(5);
    expect(loaded[0]?.id).toBe("T001");
    expect(loaded[0]?.pngBase64).toBe(tiles(1)[0]?.pngBase64);
    expect(loaded[4]?.scope).toBe("#hero");
    expect(listPackContexts(dir)).toEqual(["desktop-light-default"]);
  });

  test("an explicit context id and an altered tile are both honored: id kept, tamper refused", () => {
    const dir = packDir();
    const record = writePackContext(
      dir,
      capture({ context: { id: "hd-dark-menu", viewport: "hd", theme: "dark", state: "menu" } }),
    );
    expect(record.id).toBe("hd-dark-menu");
    const tilePath = join(dir, record.tiles[1]?.file ?? "");
    writeFileSync(tilePath, png(16, 16).subarray(0, 40));
    expect(() => readPackTiles(dir, record)).toThrow(/digest/);
  });
});

describe("finalizePageReviewPack", () => {
  test("writes manifest, evidence, findings skeleton, and a review.md that names the judge gap", () => {
    const dir = packDir();
    const desktop = writePackContext(dir, capture());
    const mobile = writePackContext(
      dir,
      capture({
        context: { viewport: "mobile", theme: "dark", state: "default" },
        coverage: {
          page_height_px: 40_000,
          reviewed_height_px: 30_000,
          bands_total: 30,
          bands_reviewed: 24,
          capped: true,
        },
      }),
    );
    const out = finalizePageReviewPack({
      packDir: dir,
      target: "http://localhost:4276/page",
      tested_revision: "abc123",
      contexts: [desktop, mobile],
      gates: [
        {
          context_id: "desktop-light-default",
          check_id: "manifest:overflow",
          outcome: "failed",
          failures: ["overflow: +42px horizontal overflow"],
        },
      ],
      critique: null,
      judgeCommand: "harn review-pack judge <dir>",
      createdAt: "2026-09-02T05:00:00.000Z",
    });
    const manifest = readPackManifest(dir);
    expect(manifest.schema).toBe(PAGE_REVIEW_PACK_SCHEMA);
    expect(manifest.contexts).toHaveLength(2);
    expect(manifest.critique).toBeNull();
    expect(manifest.warnings[0]).toContain("mobile-dark-default: tile cap reached");
    expect(manifest.not_checked.some((n) => n.check === "machine vision critique")).toBe(true);
    const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    expect(findings.schema).toBe(PAGE_REVIEW_FINDINGS_SCHEMA);
    expect(findings.findings).toEqual([]);
    expect(existsSync(join(dir, "findings.schema.json"))).toBe(true);
    expect(existsSync(join(dir, "evidence", "inspection-plan.json"))).toBe(true);
    expect(existsSync(join(dir, "evidence", "coverage.json"))).toBe(true);
    expect(existsSync(join(dir, "evidence", "index.json"))).toBe(true);
    expect(existsSync(join(dir, "evidence", "files.json"))).toBe(true);
    expect(existsSync(join(dir, "evidence", "critique.json"))).toBe(false);
    const review = readFileSync(out.review, "utf8");
    expect(review).toContain("# Page review: http://localhost:4276/page");
    expect(review).toContain("harn review-pack judge <dir>");
    expect(review).toContain("| mobile-dark-default | mobile | dark |");
    expect(review).toContain("manifest:overflow · **failed**: overflow: +42px");
    expect(review).toContain("[T001](contexts/desktop-light-default/tiles/T001.png)");
  });

  test("a second finalize after the judge keeps a reviewer's findings and adds machine findings to the plan", () => {
    const dir = packDir();
    const desktop = writePackContext(dir, capture({ tiles: tiles(5) }));
    const base = {
      packDir: dir,
      target: "http://localhost:4276/page",
      contexts: [desktop],
    };
    finalizePageReviewPack({ ...base, critique: null });
    const reviewed = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    reviewed.reviewer = "agent-test";
    reviewed.findings.push({
      id: "R01",
      severity: "medium",
      category: "layout",
      context_id: "desktop-light-default",
      evidence: ["T002"],
      observation: "cards misaligned",
    });
    writeFileSync(join(dir, "findings.json"), JSON.stringify(reviewed));
    finalizePageReviewPack({
      ...base,
      critique: [
        {
          context_id: "desktop-light-default",
          provider: "claude-code",
          tiles_total: 5,
          tiles_reviewed: 5,
          tiles_reused: 0,
          outcome: "fail",
          findings: [
            {
              tile: 2,
              tile_id: "T003",
              severity: "high",
              category: "text-clipping",
              description: "heading cut off",
            },
          ],
          coverage: desktop.coverage,
        },
      ],
      pool: { concurrency: 8, wall_time_ms: 1234, provider: "claude-code" },
    });
    const kept = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    expect(kept.reviewer).toBe("agent-test");
    expect(kept.findings).toHaveLength(1);
    const manifest = readPackManifest(dir);
    expect(manifest.pool?.concurrency).toBe(8);
    expect(existsSync(join(dir, "evidence", "critique.json"))).toBe(true);
    const plan = buildInspectionPlan(manifest.contexts, manifest.critique);
    const primary = plan.contexts[0]?.primary_tiles.map((t) => t.id);
    // Top, bottom, and the tile with the machine finding.
    expect(primary).toEqual(["T001", "T003", "T005"]);
    expect(plan.contexts[0]?.drilldown_tiles).toBe(2);
    const review = readFileSync(join(dir, "review.md"), "utf8");
    expect(review).toContain("desktop-light-default · FAIL · 5 of 5 tiles judged");
    expect(review).toContain(
      "[T003](contexts/desktop-light-default/tiles/T003.png) · **high** · text-clipping",
    );
  });
});

/** Solid-colour PNG, so a crop can be checked by pixel value. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    image.data[i * 4] = rgb[0];
    image.data[i * 4 + 1] = rgb[1];
    image.data[i * 4 + 2] = rgb[2];
    image.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(image);
}

describe("writePackExpandedTile", () => {
  test("crops the tile rect at the DPR into <tile>@<dpr>x.png, records it, and leaves every existing tile alone", () => {
    const dir = packDir();
    // Three 16×16 bands at y = 0, 1280, 2560 on a 64×128 page (fixture units).
    const record = writePackContext(dir, capture());
    const before = record.tiles.map((t) => ({ file: t.file, sha: t.sha256 }));
    // A 2× render of the same page: twice the pixels in both directions.
    const fullPage = solidPng(128, 256, [200, 30, 30]);
    const { record: next, expanded } = writePackExpandedTile(dir, record.id, {
      tileId: "T001",
      dpr: 2,
      fullPage,
      capturedAt: "2026-09-02T06:00:00.000Z",
    });
    expect(expanded.tile).toBe("T001");
    expect(expanded.dpr).toBe(2);
    expect(expanded.width).toBe(32);
    expect(expanded.height).toBe(32);
    expect(expanded.file).toBe(
      `contexts/desktop-light-default/tiles/${expandedTileFilename("T001", 2)}`,
    );
    expect(expandedTileFilename("T001", 2)).toBe("T001@2x.png");
    const written = PNG.sync.read(readFileSync(join(dir, expanded.file)));
    expect([written.width, written.height]).toEqual([32, 32]);
    expect([written.data[0], written.data[1], written.data[2]]).toEqual([200, 30, 30]);
    // Source tiles are byte-identical and their records unchanged.
    expect(next.tiles.map((t) => ({ file: t.file, sha: t.sha256 }))).toEqual(before);
    expect(() => readPackTiles(dir, next)).not.toThrow();
    // The record on disk carries the expanded entry.
    const reread = readPackContext(dir, record.id);
    expect(reread.expanded).toEqual([expanded]);
    // A second expand of the same tile + dpr replaces the entry instead of stacking it.
    writePackExpandedTile(dir, record.id, { tileId: "T001", dpr: 2, fullPage });
    expect(readPackContext(dir, record.id).expanded).toHaveLength(1);
    // A different dpr is a second entry.
    writePackExpandedTile(dir, record.id, {
      tileId: "T001",
      dpr: 3,
      fullPage: solidPng(192, 384, [0, 0, 0]),
    });
    expect(readPackContext(dir, record.id).expanded?.map((e) => e.dpr)).toEqual([2, 3]);
    // review.md lists the expanded files after the tile index.
    finalizePageReviewPack({
      packDir: dir,
      target: "http://localhost:4276/page",
      contexts: [readPackContext(dir, record.id)],
      critique: null,
    });
    const review = readFileSync(join(dir, "review.md"), "utf8");
    expect(review).toContain("Expanded tiles");
    expect(review).toContain("[T001@2x.png](contexts/desktop-light-default/tiles/T001@2x.png)");
  });

  test("an unknown tile, an unknown context, and an ambiguous tile all fail with a named reason", () => {
    const dir = packDir();
    const desktop = writePackContext(dir, capture());
    const mobile = writePackContext(
      dir,
      capture({ context: { viewport: "mobile", theme: "light", state: "default" } }),
    );
    expect(() =>
      writePackExpandedTile(dir, desktop.id, { tileId: "T099", dpr: 2, fullPage: png(128, 256) }),
    ).toThrow(/T099 is not in context desktop-light-default/);
    expect(() => findPackTile([desktop, mobile], "T001", "hd-dark-default")).toThrow(
      /hd-dark-default is not in the pack/,
    );
    expect(() => findPackTile([desktop, mobile], "T001")).toThrow(/pass --context/);
    expect(findPackTile([desktop, mobile], "T001", mobile.id).context.id).toBe(mobile.id);
    expect(findPackTile([desktop], "T002").tile.id).toBe("T002");
    expect(() =>
      writePackExpandedTile(dir, desktop.id, { tileId: "T001", dpr: 0, fullPage: png(1, 1) }),
    ).toThrow(/dpr/);
  });

  test("cropPngRegion clamps to the image instead of throwing", () => {
    const {
      png: out,
      width,
      height,
    } = cropPngRegion(png(10, 10), {
      x: 8,
      y: 8,
      width: 10,
      height: 10,
    });
    expect([width, height]).toEqual([2, 2]);
    expect(PNG.sync.read(out).width).toBe(2);
  });
});

describe("contact sheets", () => {
  test("writePackContext writes contacts.png as a row-major grid and records its layout", () => {
    const dir = packDir();
    const record = writePackContext(dir, capture({ tiles: tiles(6) }));
    expect(record.contact_sheet).toBeDefined();
    const sheet = record.contact_sheet;
    if (!sheet) throw new Error("no contact sheet");
    expect(sheet.file).toBe("contexts/desktop-light-default/contacts.png");
    expect(sheet.order).toBe("row-major");
    expect(sheet.columns).toBe(CONTACT_SHEET_COLUMNS);
    expect(sheet.rows).toBe(2);
    const image = PNG.sync.read(readFileSync(join(dir, sheet.file)));
    expect([image.width, image.height]).toEqual([sheet.width, sheet.height]);
    expect(sheet.width).toBeLessThanOrEqual(1600);
    // The record on disk matches, and finalize does not rebuild an existing sheet.
    expect(readPackContext(dir, record.id).contact_sheet).toEqual(sheet);
    finalizePageReviewPack({
      packDir: dir,
      target: "http://localhost:4276/page",
      contexts: [record],
      critique: null,
    });
    expect(readPackManifest(dir).contexts[0]?.contact_sheet?.sha256).toBe(sheet.sha256);
    const review = readFileSync(join(dir, "review.md"), "utf8");
    expect(review).toContain("| [contacts.png](contexts/desktop-light-default/contacts.png) |");
    expect(review).toContain(
      "Contact sheet: [contacts.png](contexts/desktop-light-default/contacts.png)",
    );
    expect(review).toContain("4 per row");
  });

  test("buildContactSheet box-filters large tiles, keeps small ones at native size, and stamps ids", () => {
    // A 640×640 tile, left half red, right half blue, lands at 320×320.
    const wide = new PNG({ width: 640, height: 640 });
    for (let y = 0; y < 640; y++) {
      for (let x = 0; x < 640; x++) {
        const i = (y * 640 + x) * 4;
        wide.data[i] = x < 320 ? 255 : 0;
        wide.data[i + 1] = 0;
        wide.data[i + 2] = x < 320 ? 0 : 255;
        wide.data[i + 3] = 255;
      }
    }
    const sheet = buildContactSheet([
      { id: "T001", png: PNG.sync.write(wide) },
      { id: "T002", png: solidPng(16, 16, [0, 200, 0]) },
    ]);
    expect(sheet.columns).toBe(2);
    expect(sheet.rows).toBe(1);
    const image = PNG.sync.read(sheet.png);
    const px = (x: number, y: number): number[] => {
      const i = (y * image.width + x) * 4;
      return [image.data[i] ?? -1, image.data[i + 1] ?? -1, image.data[i + 2] ?? -1];
    };
    const gutter = 8;
    const labelH = sheet.cell_height - sheet.cell_width;
    // First cell: red on the left edge of the image area, blue on the right.
    expect(px(gutter, gutter + labelH)).toEqual([255, 0, 0]);
    expect(px(gutter + 319, gutter + labelH + 319)).toEqual([0, 0, 255]);
    // Second cell: a 16×16 tile is drawn at native size, so pixel 15 is green and 16 is background.
    const x2 = gutter * 2 + sheet.cell_width;
    expect(px(x2 + 15, gutter + labelH + 15)).toEqual([0, 200, 0]);
    expect(px(x2 + 16, gutter + labelH + 16)).toEqual([212, 212, 216]);
    // The label band carries stamped glyph pixels (white on the dark band).
    let lit = 0;
    for (let y = gutter; y < gutter + labelH; y++) {
      for (let x = gutter; x < gutter + 80; x++) {
        if (px(x, y)[0] === 250) lit++;
      }
    }
    expect(lit).toBeGreaterThan(20);
  });

  test("finalize builds a missing sheet from disk and skips a context without tiles", () => {
    const dir = packDir();
    const withTiles = writePackContext(dir, capture());
    const { contact_sheet: _drop, ...bare } = withTiles;
    const empty = writePackContext(
      dir,
      capture({
        context: { viewport: "mobile", theme: "light", state: "default" },
        tiles: [],
        coverage: {
          page_height_px: 128,
          reviewed_height_px: 0,
          bands_total: 0,
          bands_reviewed: 0,
          capped: false,
        },
      }),
    );
    expect(empty.contact_sheet).toBeUndefined();
    finalizePageReviewPack({
      packDir: dir,
      target: "http://localhost:4276/page",
      contexts: [bare, empty],
      critique: null,
    });
    const manifest = readPackManifest(dir);
    expect(manifest.contexts[0]?.contact_sheet?.file).toBe(
      "contexts/desktop-light-default/contacts.png",
    );
    expect(manifest.contexts[1]?.contact_sheet).toBeUndefined();
    expect(readPackContext(dir, "desktop-light-default").contact_sheet).toBeDefined();
    const rebuilt = writePackContactSheet(dir, bare);
    expect(rebuilt.contact_sheet?.sha256).toBe(manifest.contexts[0]?.contact_sheet?.sha256);
    const review = readFileSync(join(dir, "review.md"), "utf8");
    expect(review).toContain(
      "| mobile-light-default | mobile | light | default | 64×128 | 0 | complete | none |",
    );
  });
});

describe("gate hits", () => {
  test("gateHitsFromEnvelope lifts every rectangle-bearing finding and skips the rest", () => {
    const rect = (y: number) => ({ x: 10, y, width: 100, height: 20 });
    const hits = gateHitsFromEnvelope({
      overflow: {
        hasHorizontalOverflow: true,
        overflowPx: 42,
        widerThanViewport: [
          { tagName: "TABLE", className: "wide grid", id: "", rect: rect(50), widthOverflowPx: 42 },
        ],
        rightOverflow: [],
      },
      runts: { runts: [{ block: "p.lede", word: "alone.", rect: rect(1290), lines: 3 }] },
      truncation: {
        hits: [{ label: "h2.title", axis: "x", how: "ellipsis", overflowPx: 18, rect: rect(2570) }],
      },
      contrast: { hits: [{ label: "span.muted", ratio: 3.1, required: 4.5, rect: rect(60) }] },
      clip: [
        {
          issues: [
            {
              element: { label: "img.hero", rect: rect(70) },
              clippedBy: "div.card",
              maxOverrunPx: 6,
            },
          ],
        },
      ],
      overlap: [
        {
          issues: [
            {
              first: { label: "a.cta" },
              second: { label: "p.note" },
              intersection: rect(80),
              areaPx: 400,
            },
          ],
        },
      ],
      crowd: [
        {
          issues: [
            {
              before: { label: "section.a", rect: { x: 0, y: 100, width: 50, height: 50 } },
              after: { label: "section.b", rect: { x: 60, y: 120, width: 50, height: 50 } },
              separationPx: 4,
            },
          ],
        },
      ],
      align: [{ clusters: [{ children: [{ label: "li", rect: rect(90), fail: false }] }] }],
      gap: [
        {
          clusters: [
            {
              pairs: [
                {
                  before: { label: "li.a", rect: rect(200) },
                  after: { label: "li.b", rect: rect(240) },
                  observedGapPx: 30,
                  fail: true,
                },
              ],
            },
          ],
        },
      ],
      hit: [
        {
          nodes: [
            { outcome: "fail", target: ["a.tiny"], message: "too small", rect: rect(300) },
            { outcome: "pass", target: ["a.ok"], message: "", rect: rect(310) },
            { outcome: "fail", target: ["a.none"], message: "no rect", rect: null },
          ],
        },
      ],
      asserts: [{ op: "exists", selector: "#x", outcome: "fail" }],
      critique: { outcome: "fail", findings: [{ severity: "high", description: "x" }] },
    });
    expect(hits.map((h) => h.rule)).toEqual([
      "runts",
      "truncation",
      "contrast",
      "clip",
      "overlap",
      "crowd",
      "gap",
      "overflow",
      "hit",
    ]);
    expect(hits[0]?.label).toBe('p.lede: "alone."');
    expect(hits.find((h) => h.rule === "crowd")?.rect).toEqual({
      x: 0,
      y: 100,
      width: 110,
      height: 70,
    });
    expect(hits.find((h) => h.rule === "gap")?.rect).toEqual({
      x: 10,
      y: 200,
      width: 100,
      height: 60,
    });
    expect(hits.find((h) => h.rule === "overflow")?.label).toBe(
      "table.wide: +42px past the viewport",
    );
    expect(gateHitsFromEnvelope(undefined)).toEqual([]);
    expect(gateHitsFromEnvelope({ overflow: { hasHorizontalOverflow: true } })).toEqual([]);
    const many = gateHitsFromEnvelope({
      runts: {
        runts: Array.from({ length: GATE_HITS_PER_ENVELOPE + 10 }, (_, i) => ({
          block: "p",
          word: "w",
          rect: rect(i),
        })),
      },
    });
    expect(many).toHaveLength(GATE_HITS_PER_ENVELOPE);
  });

  test("tilesCoveringRect intersects by y range and by x for scoped tiles", () => {
    const dir = packDir();
    const record = writePackContext(
      dir,
      capture({
        tiles: tiles(3).map((t) => ({ ...t, width: 64, height: 1400 })),
        scopeTiles: [
          {
            selector: "#side",
            tiles: [{ ...tiles(1, "side")[0]!, x: 40, scrollY: 0, width: 20, height: 100 }],
          },
        ],
      }),
    );
    // Bands: T001 y 0..1400, T002 1280..2680, T003 2560..3960 (all full width); T004 x 40..60, y 0..100.
    expect(tilesCoveringRect(record.tiles, { x: 5, y: 1300, width: 10, height: 10 })).toEqual([
      "T001",
      "T002",
    ]);
    expect(tilesCoveringRect(record.tiles, { x: 45, y: 10, width: 5, height: 5 })).toEqual([
      "T001",
      "T004",
    ]);
    expect(tilesCoveringRect(record.tiles, { x: 5, y: 10, width: 5, height: 5 })).toEqual(["T001"]);
    expect(tilesCoveringRect(record.tiles, { x: 5, y: 5000, width: 5, height: 5 })).toEqual([]);
  });

  test("gate hits become primary tiles, land in the plan, and render with tile links in review.md", () => {
    const dir = packDir();
    const record = writePackContext(
      dir,
      capture({ tiles: tiles(5).map((t) => ({ ...t, width: 64, height: 1400 })) }),
    );
    const gates = [
      {
        context_id: record.id,
        check_id: "manifest:runts",
        outcome: "failed" as const,
        failures: ["runts: 1 hit"],
        hits: [
          {
            rule: "runts",
            label: 'p.lede: "alone."',
            rect: { x: 4, y: 2700, width: 50, height: 16 },
          },
          { rule: "runts", label: "p.deep", rect: { x: 4, y: 9000, width: 50, height: 16 } },
        ],
      },
      {
        context_id: record.id,
        check_id: "manifest:overflow",
        outcome: "passed" as const,
        failures: [],
      },
    ];
    const plan = buildInspectionPlan([record], null, gates);
    const ctx = plan.contexts[0];
    expect(ctx?.gate_hits).toHaveLength(2);
    expect(ctx?.gate_hits[0]).toMatchObject({ check_id: "manifest:runts", tiles: ["T003"] });
    expect(ctx?.gate_hits[1]?.tiles).toEqual([]);
    // Top, bottom, and the tile the runt lands on.
    expect(ctx?.primary_tiles.map((t) => t.id)).toEqual(["T001", "T003", "T005"]);
    expect(ctx?.primary_tiles[1]?.reason).toBe('gate hit (runts): p.lede: "alone."');
    finalizePageReviewPack({
      packDir: dir,
      target: "http://localhost:4276/page",
      contexts: [record],
      gates,
      critique: null,
    });
    const written = JSON.parse(readFileSync(join(dir, "evidence", "inspection-plan.json"), "utf8"));
    expect(written.contexts[0].gate_hits[0].tiles).toEqual(["T003"]);
    expect(readPackManifest(dir).gates[0]?.hits).toHaveLength(2);
    const review = readFileSync(join(dir, "review.md"), "utf8");
    expect(review).toContain(
      '  - runts · p.lede: "alone." · at (4, 2700) 50×16 px → [T003](contexts/desktop-light-default/tiles/T003.png)',
    );
    expect(review).toContain("p.deep · at (4, 9000) 50×16 px → no tile covers this rect");
    // A gate without hits keeps the single-line form.
    expect(review).toContain("manifest:overflow · **passed**\n");
  });
});
