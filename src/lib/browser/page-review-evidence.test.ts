import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { CritiqueFinding } from "./critique.ts";
import {
  PAGE_REVIEW_DECISIONS_SCHEMA,
  type PageReviewDecisionSlot,
} from "./page-review-contracts.ts";
import {
  applyPackReviewDecisions,
  buildPackNativeEvidence,
  machineFindingKey,
  nativePixelDigest,
  persistPackReviewDecisions,
  planNativeTileReuse,
} from "./page-review-evidence.ts";
import { judgePageReviewPack, toCritiqueRecords } from "./page-review-judge.ts";
import {
  buildInspectionPlan,
  deleteExpiredPacks,
  finalizePageReviewPack,
  type PageReviewContextCapture,
  packPaths,
  readPackContext,
  readPackFindings,
  readPackTiles,
  writePackContext,
  writePackExpandedTile,
  writePackFindings,
} from "./page-review-pack.ts";
import {
  loadQaSnapshot,
  loadReviewDecisions,
  saveQaSnapshot,
  saveReviewDecisions,
} from "./qa-snapshot.ts";

const roots: string[] = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), "native-evidence-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const context = { viewport: "desktop", theme: "light" as const, state: "default" };
const target = "https://example.test/page";
const rubric = "test rubric";
function png(color = 255) {
  const image = new PNG({ width: 8, height: 8 });
  image.data.fill(color);
  return PNG.sync.write(image);
}
function capture(): PageReviewContextCapture {
  return {
    context,
    url: target,
    fullPage: png(),
    pageWidth: 8,
    pageHeight: 8,
    viewportSize: { width: 8, height: 8 },
    dpr: 1,
    recipeVersion: "native-test/v2",
    tiles: [
      {
        index: 0,
        label: "band 1",
        scrollY: 0,
        x: 0,
        width: 8,
        height: 8,
        pngBase64: png().toString("base64"),
      },
    ],
    coverage: {
      page_height_px: 8,
      reviewed_height_px: 8,
      bands_total: 1,
      bands_reviewed: 1,
      capped: false,
    },
    signature: { url: target, capturedAt: "2026-09-03T00:00:00Z", nodes: [], stylesheets: [] },
    domHtml: "<p>test</p>",
  };
}
const finding: CritiqueFinding & { tile_id: string } = {
  tile: 0,
  tile_id: "T001",
  severity: "high",
  category: "layout",
  description: "Cut text",
};
function setup() {
  const dir = temp();
  const cap = capture();
  const record = writePackContext(dir, cap);
  const tiles = readPackTiles(dir, record);
  const evidence = buildPackNativeEvidence(record, tiles, rubric);
  const tile = evidence.tiles[0]!;
  const slot: PageReviewDecisionSlot = {
    schema: PAGE_REVIEW_DECISIONS_SCHEMA,
    target,
    context: evidence.context,
    source_run: "run-1",
    source_revision: "rev-1",
    reviewer: "reviewer-1",
    reviewed_at: "2026-09-03T00:01:00Z",
    complete: true,
    decisions: [
      {
        finding_key: machineFindingKey(evidence.context, tile, finding),
        tile_pixel_digest: tile.pixel_digest,
        rect: tile.rect,
        finding: {
          severity: finding.severity,
          category: finding.category,
          description: finding.description,
        },
        disposition: "artifact",
        reviewer: "reviewer-1",
        at: "2026-09-03T00:01:00Z",
      },
    ],
  };
  return { dir, cap, record, tiles, evidence, slot };
}

describe("native evidence and strict decision identity", () => {
  test("expansion scales native rectangles relative to the original DPR", () => {
    const dir = temp();
    const record = writePackContext(dir, { ...capture(), dpr: 2, pageWidth: 4, pageHeight: 4 });
    const { expanded } = writePackExpandedTile(dir, record.id, {
      tileId: "T001",
      dpr: 3,
      fullPage: PNG.sync.write(new PNG({ width: 12, height: 12 })),
    });
    expect([expanded.width, expanded.height]).toEqual([12, 12]);
    expect(record.page).toEqual({ width: 8, height: 8 });
  });
  test("v2 capture requires explicit valid viewport, DPR and recipe metadata", () => {
    const dir = temp();
    const cap = capture();
    for (const invalid of [
      { viewportSize: undefined },
      { dpr: 0 },
      { dpr: Number.NaN },
      { recipeVersion: "" },
    ]) {
      expect(() =>
        writePackContext(dir, { ...cap, ...invalid } as PageReviewContextCapture),
      ).toThrow("requires viewportSize");
    }
  });
  test("active v1 pack contexts require recapture", () => {
    const { dir, record } = setup();
    writeFileSync(
      join(dir, record.files.context),
      JSON.stringify({ ...record, schema: "harnery-page-review/v1" }),
    );
    expect(() => readPackContext(dir, record.id)).toThrow("recapture");
  });
  test("decoded pixels have identical identity across PNG encodings", () => {
    const image = PNG.sync.read(png());
    const a = PNG.sync.write(image, { deflateLevel: 0 });
    const b = PNG.sync.write(image, { deflateLevel: 9 });
    expect(a.equals(b)).toBe(false);
    expect(nativePixelDigest(a)).toBe(nativePixelDigest(b));
  });
  test("orientation is half scale and native pixels remain in tiles only", () => {
    const { dir, record } = setup();
    const image = PNG.sync.read(readFileSync(join(dir, record.files.full_page)));
    expect(image.width).toBe(4);
    expect(image.height).toBe(4);
    expect(record.full_page_scale).toBe(0.5);
    expect(PNG.sync.read(readFileSync(join(dir, record.tiles[0]!.file))).width).toBe(8);
  });
  test("reorder and whitespace preserve identity; new and reworded highs remain open", () => {
    const { evidence, slot } = setup();
    const newFinding = { ...finding, description: "New defect" };
    const reworded = { ...finding, description: "Text is cut" };
    const old = { ...finding, description: "  Cut\n text  " };
    const input = [newFinding, old, reworded];
    const result = applyPackReviewDecisions({
      target,
      evidence,
      slot,
      findings: input,
      enabled: true,
    });
    expect(result.findings).toEqual([newFinding, reworded]);
    expect(result.applied).toHaveLength(1);
    expect(input).toHaveLength(3);
    expect(result.applied[0]?.target).toBe("T001#1");
  });
  test("off, target, context, rubric, recipe, pixels and provider errors never dismiss", () => {
    const { evidence, slot } = setup();
    const run = (overrides: Partial<Parameters<typeof applyPackReviewDecisions>[0]>) =>
      applyPackReviewDecisions({
        target,
        evidence,
        slot,
        findings: [finding],
        enabled: true,
        ...overrides,
      });
    expect(run({ enabled: false }).applied).toHaveLength(0);
    expect(run({ target: "other" }).applied).toHaveLength(0);
    for (const changed of [
      { dpr: 2 },
      { state: "open" },
      { rubric_digest: "other" },
      { viewport_width: 9 },
      { recipe_version: "other" },
    ]) {
      expect(
        run({ evidence: { ...evidence, context: { ...evidence.context, ...changed } } }).applied,
      ).toHaveLength(0);
    }
    const tile = { ...evidence.tiles[0]!, png: png(0), pixel_digest: nativePixelDigest(png(0)) };
    expect(run({ evidence: { ...evidence, tiles: [tile] } }).applied).toHaveLength(0);
    expect(run({ findings: [{ ...finding, category: "provider-error" }] }).applied).toHaveLength(0);
  });
  test("native reuse handles missing/corrupt/legacy evidence and prior findings", () => {
    const { evidence, tiles } = setup();
    const critique = {
      contract_version: 2,
      rubric_digest: evidence.context.rubric_digest,
      outcome: "pass" as const,
      findings: [],
      tiles: tiles.map(({ pngBase64: _png, id: _id, ...t }) => ({ ...t, x: t.x ?? 0 })),
    };
    const run = (args: Partial<Parameters<typeof planNativeTileReuse>[0]>) =>
      planNativeTileReuse({ current: evidence, baseline: evidence, critique, tiles, ...args });
    expect(run({}).tiles_reused).toBe(1);
    expect(run({ baseline: undefined }).tiles_reused).toBe(0);
    expect(run({ critique: { ...critique, contract_version: 1 } }).tiles_reused).toBe(0);
    expect(
      run({
        baseline: { ...evidence, tiles: [{ ...evidence.tiles[0]!, png: Buffer.from("bad") }] },
      }).tiles_reused,
    ).toBe(0);
    expect(run({ critique: { ...critique, findings: [finding] } }).tiles_reused).toBe(0);
    expect(
      run({ baseline: { ...evidence, context: { ...evidence.context, recipe_version: "other" } } })
        .tiles_reused,
    ).toBe(0);
    expect(run({ baseline: { ...evidence, tiles: [] } }).tiles_reused).toBe(0);
  });
});

describe("durable review and baseline lifecycle", () => {
  test("incomplete review, unknown targets, changed machine binding, and corrupt tiles never publish", async () => {
    const { dir, record, slot } = setup();
    const root = temp();
    const judged = await judgePageReviewPack({
      packDir: dir,
      provider: async () => [finding],
      rubric,
    });
    const critique = toCritiqueRecords(judged);
    const finalize = () =>
      finalizePageReviewPack({ packDir: dir, target, contexts: [record], critique });
    finalize();
    saveReviewDecisions(target, context, slot, { root });
    const doc = readPackFindings(dir);
    doc.reviewer = "reviewer-1";
    doc.reviewed_at = "2026-09-03T00:01:00Z";
    doc.dispositions = [{ target: `${record.id}/T001#0`, disposition: "artifact" }];
    writePackFindings(dir, doc);
    expect(() => persistPackReviewDecisions(dir, { root })).toThrow("complete delegated");
    expect(loadReviewDecisions(target, context, { root })).toEqual(slot);
    const primary = [`${record.id}/T001`];
    doc.delegated_reviews = [
      {
        reviewer: "reviewer-1",
        model: "GPT-5.6 Luna",
        assigned_tiles: primary,
        completed_tiles: primary,
        status: "complete",
      },
    ];
    doc.dispositions = [{ target: `${record.id}/T001#8`, disposition: "artifact" }];
    writePackFindings(dir, doc);
    expect(() => persistPackReviewDecisions(dir, { root })).toThrow("absent machine finding");
    doc.dispositions = [{ target: `${record.id}/T001#0`, disposition: "artifact" }];
    writePackFindings(dir, doc);
    critique[0]!.findings = [{ ...finding, description: "A new high on the same tile" }];
    finalize();
    writePackFindings(dir, doc);
    expect(() => persistPackReviewDecisions(dir, { root })).toThrow("different machine evidence");
    critique[0]!.findings = [finding];
    finalize();
    writePackFindings(dir, doc);
    writeFileSync(join(dir, record.tiles[0]!.file), png(0));
    expect(() => persistPackReviewDecisions(dir, { root })).toThrow("digest");
    expect(loadReviewDecisions(target, context, { root })).toEqual(slot);
  });
  test("changed rejudge archives the old review and requires a fresh complete review", async () => {
    const { dir, record } = setup();
    const root = temp();
    const judged = await judgePageReviewPack({
      packDir: dir,
      provider: async () => [finding],
      rubric,
    });
    const critique = toCritiqueRecords(judged);
    const finalize = () =>
      finalizePageReviewPack({ packDir: dir, target, contexts: [record], critique });
    finalize();
    const old = readPackFindings(dir);
    old.reviewer = "reviewer-1";
    old.reviewed_at = "2026-09-03T00:01:00Z";
    const primary = [`${record.id}/T001`];
    old.delegated_reviews = [
      {
        reviewer: "reviewer-1",
        model: "GPT-5.6 Luna",
        assigned_tiles: primary,
        completed_tiles: primary,
        status: "complete",
      },
    ];
    old.dispositions = [{ target: `${record.id}/T001#0`, disposition: "artifact" }];
    writePackFindings(dir, old);
    finalize();
    expect(readPackFindings(dir)).toEqual(old);
    expect(existsSync(join(dir, "review-history"))).toBe(false);
    critique[0]!.findings = [{ ...finding, description: "Changed finding text" }];
    writeFileSync(join(dir, "review-history"), "blocked archive destination");
    expect(finalize).toThrow();
    expect(readPackFindings(dir)).toEqual(old);
    expect(
      JSON.parse(readFileSync(packPaths(dir).critique, "utf8")).contexts[0].findings[0].description,
    ).toBe(finding.description);
    rmSync(join(dir, "review-history"));
    finalize();
    const fresh = readPackFindings(dir);
    expect(fresh.machine_evidence_digest).not.toBe(old.machine_evidence_digest);
    expect(fresh.dispositions).toEqual([]);
    expect(fresh.delegated_reviews).toEqual([]);
    expect(fresh.reviewer).toBeNull();
    expect(() => persistPackReviewDecisions(dir, { root })).toThrow("reviewer identity");
    const archives = readdirSync(join(dir, "review-history"));
    expect(archives).toHaveLength(1);
    const archive = join(dir, "review-history", archives[0]!);
    expect(JSON.parse(readFileSync(join(archive, "findings.json"), "utf8"))).toEqual(old);
    expect(
      JSON.parse(readFileSync(join(archive, "critique.json"), "utf8")).contexts[0].findings[0]
        .description,
    ).toBe(finding.description);
    writePackFindings(dir, { ...old, machine_evidence_digest: fresh.machine_evidence_digest });
    expect(persistPackReviewDecisions(dir, { root })).toBe(1);
    expect(loadReviewDecisions(target, context, { root })?.decisions[0]?.finding.description).toBe(
      "Changed finding text",
    );
  });
  test("decisions survive repeated baseline replacement and corrupt PNG becomes miss", () => {
    const { cap, evidence, slot } = setup();
    const root = temp();
    saveReviewDecisions(target, context, slot, { root });
    const saved = saveQaSnapshot(
      target,
      context,
      { signature: cap.signature, tileEvidence: evidence },
      { root },
    );
    saveQaSnapshot(target, context, { signature: cap.signature, tileEvidence: evidence }, { root });
    expect(loadReviewDecisions(target, context, { root })).toEqual(slot);
    expect(loadQaSnapshot(target, context, { root })?.tileEvidence?.tiles).toHaveLength(1);
    writeFileSync(join(saved.path, "tile-0.png"), "bad");
    expect(loadQaSnapshot(target, context, { root })?.tileEvidence).toBeUndefined();
    expect(loadReviewDecisions(target, context, { root })).toEqual(slot);
    expect(() =>
      saveQaSnapshot(
        target,
        context,
        { signature: cap.signature, tileEvidence: evidence, screenshotPng: png() },
        { root },
      ),
    ).toThrow("full-page");
  });
  test("concurrent baseline and decision processes preserve both owned slots", async () => {
    const { cap, slot } = setup();
    const root = temp();
    const moduleUrl = new URL("./qa-snapshot.ts", import.meta.url).href;
    const input = JSON.stringify({ target, context, slot, root, signature: cap.signature });
    const child = (mode: string) =>
      new Promise<void>((resolve, reject) => {
        const source = `import { saveQaSnapshot, saveReviewDecisions } from ${JSON.stringify(moduleUrl)}; const x=${input}; for(let i=0;i<15;i++){ if(${JSON.stringify(mode)}==='baseline') saveQaSnapshot(x.target,x.context,{signature:{...x.signature,capturedAt:'generation-'+i}}, {root:x.root}); else saveReviewDecisions(x.target,x.context,x.slot,{root:x.root}); }`;
        const process = spawn(globalThis.process.execPath, ["--eval", source], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let error = "";
        process.stderr.on("data", (chunk) => {
          error += chunk;
        });
        process.on("error", reject);
        process.on("close", (code) => (code === 0 ? resolve() : reject(new Error(error))));
      });
    await Promise.all([child("baseline"), child("decisions")]);
    expect(loadQaSnapshot(target, context, { root })?.signature.capturedAt).toBe("generation-14");
    expect(loadReviewDecisions(target, context, { root })).toEqual(slot);
  });
  test("failed decision persistence throws while existing baseline remains", () => {
    const { cap, slot } = setup();
    const root = temp();
    const snapshot = saveQaSnapshot(target, context, { signature: cap.signature }, { root });
    const slotPath = join(snapshot.path, "..", "review-decisions.json");
    // A directory cannot be atomically replaced by a file on supported hosts.
    mkdirSync(slotPath);
    expect(() => saveReviewDecisions(target, context, slot, { root })).toThrow();
    expect(loadQaSnapshot(target, context, { root })?.signature).toEqual(cap.signature);
  });
  test("failed baseline staging preserves both prior baseline and decisions", () => {
    const { cap, slot } = setup();
    const root = temp();
    saveQaSnapshot(target, context, { signature: cap.signature }, { root });
    saveReviewDecisions(target, context, slot, { root });
    const circular = { ...cap.signature };
    Object.assign(circular, { broken: circular });
    expect(() => saveQaSnapshot(target, context, { signature: circular }, { root })).toThrow();
    expect(loadQaSnapshot(target, context, { root })?.signature).toEqual(cap.signature);
    expect(loadReviewDecisions(target, context, { root })).toEqual(slot);
  });
  test("first, second and third unchanged scrolled runs reuse native evidence", async () => {
    const { dir, cap } = setup();
    const root = temp();
    const record = writePackContext(dir, {
      ...cap,
      captureFidelity: {
        source: "scrolled-bands",
        probed: [],
        mismatched: [],
        mismatch_threshold: 0.01,
      },
    });
    let calls = 0;
    for (let pass = 0; pass < 3; pass++) {
      const result = await judgePageReviewPack({
        packDir: dir,
        provider: async () => {
          calls++;
          return [];
        },
        rubric,
        reuse: { target, store: { root } },
      });
      expect(result.tiles_reused).toBe(pass === 0 ? 0 : 1);
      const row = result.contexts[0]!;
      const tileEvidence = buildPackNativeEvidence(record, readPackTiles(dir, record), rubric);
      saveQaSnapshot(
        target,
        context,
        {
          signature: cap.signature,
          tileEvidence,
          critique: {
            contract_version: 2,
            rubric_digest: tileEvidence.context.rubric_digest,
            outcome: "pass",
            findings: row.findings,
            tiles: record.tiles.map((t) => ({
              index: t.index,
              label: t.label,
              x: t.x,
              scrollY: t.scrollY,
              width: t.width,
              height: t.height,
            })),
          },
        },
        { root },
      );
    }
    expect(calls).toBe(1);
    expect(loadQaSnapshot(target, context, { root })?.screenshotPath).toBeUndefined();
  });
  test("review, verdict, expiry, next run retains exact decisions and text summary", async () => {
    const { dir, record, evidence } = setup();
    const root = temp();
    const judged = await judgePageReviewPack({
      packDir: dir,
      provider: async () => [finding],
      rubric,
    });
    const critique = toCritiqueRecords(judged);
    finalizePageReviewPack({
      packDir: dir,
      target,
      contexts: [record],
      critique,
      tested_revision: "rev-1",
      retention: { managed: true, expires_at: "2026-09-03T00:00:00Z" },
    });
    const doc = readPackFindings(dir);
    doc.reviewer = "reviewer-1";
    doc.reviewed_at = "2026-09-03T00:01:00Z";
    const plan = buildInspectionPlan([record], critique, []);
    const primary = plan.contexts.flatMap((c) =>
      c.primary_tiles.map((t) => `${c.context_id}/${t.id}`),
    );
    doc.delegated_reviews = [
      {
        reviewer: "reviewer-1",
        model: "GPT-5.6 Luna",
        assigned_tiles: primary,
        completed_tiles: primary,
        status: "complete",
      },
    ];
    doc.dispositions = [
      {
        target: `${record.id}/T001#0`,
        disposition: "artifact",
        by: "reviewer-1",
        at: doc.reviewed_at,
      },
    ];
    writePackFindings(dir, doc);
    expect(persistPackReviewDecisions(dir, { root })).toBe(1);
    deleteExpiredPacks({ roots: [dir], dryRun: false, now: new Date("2026-09-04T00:00:00Z") });
    expect(existsSync(packPaths(dir).manifest)).toBe(false);
    const stub = JSON.parse(readFileSync(join(dir, "pack-expired.json"), "utf8"));
    expect(stub).toHaveProperty("result");
    expect(stub.findings_summary).not.toBeNull();
    const slot = loadReviewDecisions(target, context, { root });
    expect(
      applyPackReviewDecisions({ target, evidence, slot, enabled: true, findings: [finding] })
        .applied,
    ).toHaveLength(1);
    expect(JSON.stringify(slot)).not.toContain(dir);
    expect(JSON.stringify(slot)).not.toContain("png");
  });
});
