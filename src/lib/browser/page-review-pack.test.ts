import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { CritiqueTile } from "./critique.ts";
import {
  buildInspectionPlan,
  finalizePageReviewPack,
  listPackContexts,
  PAGE_REVIEW_FINDINGS_SCHEMA,
  PAGE_REVIEW_PACK_SCHEMA,
  type PageReviewContextCapture,
  readPackContext,
  readPackManifest,
  readPackTiles,
  writePackContext,
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
