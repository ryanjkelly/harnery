// `review-pack findings add` / `disposition` / `verdict`: the reviewer loop
// over a pack on disk. Every test builds a real pack with the library and
// drives the registered commander program; no browser and no vision call.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { PNG } from "pngjs";
import type { EmitContext } from "../commander.ts";
import type { CritiqueTile } from "../lib/browser/critique.ts";
import {
  finalizePageReviewPack,
  PAGE_REVIEW_VERDICT_SCHEMA,
  type PageReviewCritiqueRecord,
  writePackContext,
} from "../lib/browser/page-review-pack.ts";
import { registerReviewPackCommand } from "./review-pack.ts";

interface CapturedEmit {
  emit: EmitContext;
  data: unknown[];
  logs: string[];
  errors: Array<{ code?: string; message?: string }>;
}

function captureEmit(): CapturedEmit {
  const data: unknown[] = [];
  const logs: string[] = [];
  const errors: Array<{ code?: string; message?: string }> = [];
  const emit: EmitContext = {
    config() {},
    data(payload) {
      data.push(payload);
    },
    rows() {},
    text(s) {
      logs.push(s);
    },
    file() {},
    error(err) {
      errors.push(err as { code?: string; message?: string });
    },
    log(msg) {
      logs.push(msg);
    },
    setExitCode(n) {
      process.exitCode = n;
    },
  };
  return { emit, data, logs, errors };
}

async function run(args: string[]): Promise<CapturedEmit> {
  const captured = captureEmit();
  const program = new Command();
  program.exitOverride();
  registerReviewPackCommand(program, captured.emit);
  await program.parseAsync(["review-pack", ...args], { from: "user" });
  return captured;
}

const CTX = "desktop-light-default";
const roots: string[] = [];
let savedExitCode: typeof process.exitCode;

/** The exit code a command left behind; 0 when it set none. Assigning
 * `undefined` does not clear a prior code on every runtime, so the reset
 * writes 0 explicitly. */
function exitCode(): number {
  return Number(process.exitCode ?? 0);
}

function resetExitCode(): void {
  process.exitCode = 0;
}

beforeEach(() => {
  savedExitCode = process.exitCode;
  resetExitCode();
});

afterEach(() => {
  process.exitCode = savedExitCode;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function png(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

function tiles(count: number): CritiqueTile[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: `band ${index + 1}`,
    scrollY: index * 1280,
    x: 0,
    width: 16,
    height: 16,
    pngBase64: png(16, 16).toString("base64"),
  }));
}

function critiqueRow(): PageReviewCritiqueRecord {
  return {
    context_id: CTX,
    provider: "fixture",
    tiles_total: 4,
    tiles_reviewed: 4,
    tiles_reused: 0,
    outcome: "fail",
    findings: [
      { tile: 1, tile_id: "T002", severity: "high", category: "text-clipping", description: "a" },
      { tile: 2, tile_id: "T003", severity: "medium", category: "spacing", description: "b" },
      { tile: 2, tile_id: "T003", severity: "high", category: "contrast", description: "c" },
    ],
    coverage: {
      page_height_px: 128,
      reviewed_height_px: 128,
      bands_total: 4,
      bands_reviewed: 4,
      capped: false,
    },
  };
}

/** A finalized pack with one context and a judged critique (or none). */
function seedPack(judged = true): string {
  const dir = mkdtempSync(join(tmpdir(), "review-pack-cli-"));
  roots.push(dir);
  const record = writePackContext(dir, {
    context: { viewport: "desktop", theme: "light", state: "default" },
    url: "http://localhost:4276/page",
    title: "Fixture",
    fullPage: png(64, 128),
    pageWidth: 64,
    pageHeight: 128,
    tiles: tiles(4),
    coverage: {
      page_height_px: 128,
      reviewed_height_px: 128,
      bands_total: 4,
      bands_reviewed: 4,
      capped: false,
    },
    signature: {
      url: "http://localhost:4276/page",
      capturedAt: "2026-09-02T00:00:00.000Z",
      nodes: [],
      stylesheets: [],
    },
    domHtml: "<html><body>fixture</body></html>",
  });
  finalizePageReviewPack({
    packDir: dir,
    target: "http://localhost:4276/page",
    contexts: [record],
    critique: judged ? [critiqueRow()] : null,
    createdAt: "2026-09-02T05:00:00.000Z",
  });
  return dir;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("review-pack findings add", () => {
  test("appends an auto-numbered finding with the tiles as evidence and stamps the reviewer", async () => {
    const dir = seedPack();
    const first = await run([
      "findings",
      "add",
      dir,
      "--context",
      CTX,
      "--tile",
      "T001",
      "--tile",
      "T004",
      "--severity",
      "medium",
      "--category",
      "layout",
      "--observation",
      "cards misaligned",
      "--recommendation",
      "align the grid",
      "--reviewer",
      "agent-test",
      "--json",
    ]);
    expect(first.errors).toEqual([]);
    expect(exitCode()).toBe(0);
    expect(first.data[0]).toMatchObject({
      id: "F001",
      severity: "medium",
      category: "layout",
      context_id: CTX,
      evidence: ["T001", "T004"],
      recommendation: "align the grid",
    });
    await run([
      "findings",
      "add",
      dir,
      "--context",
      CTX,
      "--tile",
      "T002",
      "--severity",
      "low",
      "--category",
      "typography",
      "--observation",
      "runt",
    ]);
    const doc = readJson(join(dir, "findings.json"));
    expect(doc.reviewer).toBe("agent-test");
    expect(typeof doc.reviewed_at).toBe("string");
    expect((doc.findings as Array<{ id: string }>).map((f) => f.id)).toEqual(["F001", "F002"]);
  });

  test("refuses a bad severity, an unknown tile, and an unknown context without writing", async () => {
    const dir = seedPack();
    const before = readFileSync(join(dir, "findings.json"), "utf8");
    const bad = await run([
      "findings",
      "add",
      dir,
      "--context",
      CTX,
      "--tile",
      "T001",
      "--severity",
      "urgent",
      "--category",
      "layout",
      "--observation",
      "x",
    ]);
    expect(bad.errors[0]?.code).toBe("review_pack_findings_invalid");
    expect(bad.logs.some((l) => l.includes("severity must be one of"))).toBe(true);
    expect(exitCode()).toBe(1);
    resetExitCode();

    const tile = await run([
      "findings",
      "add",
      dir,
      "--context",
      CTX,
      "--tile",
      "T099",
      "--severity",
      "low",
      "--category",
      "layout",
      "--observation",
      "x",
    ]);
    expect(tile.errors[0]?.code).toBe("review_pack_unknown_tile");
    expect(exitCode()).toBe(1);
    resetExitCode();

    const ctx = await run([
      "findings",
      "add",
      dir,
      "--context",
      "tablet-light-default",
      "--tile",
      "T001",
      "--severity",
      "low",
      "--category",
      "layout",
      "--observation",
      "x",
    ]);
    expect(ctx.errors[0]?.code).toBe("review_pack_unknown_context");
    expect(exitCode()).toBe(1);
    expect(readFileSync(join(dir, "findings.json"), "utf8")).toBe(before);
  });
});

describe("review-pack reviews add", () => {
  test("records completed subagent coverage and rejects non-primary assignments", async () => {
    const dir = seedPack();
    const written = await run([
      "reviews",
      "add",
      dir,
      "--reviewer",
      "agent-review-1",
      "--model",
      "GPT-5.6 Luna",
      "--assigned",
      `${CTX}/T001`,
      "--completed",
      `${CTX}/T001`,
      "--json",
    ]);
    expect(written.errors).toEqual([]);
    expect(written.data[0]).toMatchObject({
      reviewer: "agent-review-1",
      model: "GPT-5.6 Luna",
      assigned_tiles: [`${CTX}/T001`],
      completed_tiles: [`${CTX}/T001`],
      status: "complete",
    });
    expect(readJson(join(dir, "findings.json")).delegated_reviews).toEqual([written.data[0]]);
    resetExitCode();

    const refused = await run([
      "reviews",
      "add",
      dir,
      "--reviewer",
      "agent-review-2",
      "--model",
      "GPT-5.6 Luna",
      "--assigned",
      `${CTX}/T999`,
    ]);
    expect(refused.errors[0]?.code).toBe("review_pack_unknown_primary_tile");
    expect(exitCode()).toBe(1);
  });
});

describe("review-pack disposition", () => {
  test("writes a disposition for an existing machine finding and replaces a repeat", async () => {
    const dir = seedPack();
    const first = await run([
      "disposition",
      dir,
      `${CTX}/T003#1`,
      "confirmed",
      "--note",
      "text really is grey on grey",
      "--by",
      "agent-test",
      "--json",
    ]);
    expect(first.errors).toEqual([]);
    expect(first.data[0]).toMatchObject({
      target: `${CTX}/T003#1`,
      disposition: "confirmed",
      note: "text really is grey on grey",
      by: "agent-test",
    });
    const second = await run(["disposition", dir, `${CTX}/T003#1`, "artifact"]);
    expect(second.logs.some((l) => l.includes("(replaced)"))).toBe(true);
    const doc = readJson(join(dir, "findings.json"));
    expect(doc.dispositions).toHaveLength(1);
    expect((doc.dispositions as Array<{ disposition: string }>)[0]?.disposition).toBe("artifact");
    // The machine record is untouched.
    const critique = readJson(join(dir, "evidence", "critique.json"));
    expect(JSON.stringify(critique)).not.toContain('artifact"');
  });

  test("refuses a target that is not in the critique, an unknown disposition, and an unjudged pack", async () => {
    const dir = seedPack();
    const missing = await run(["disposition", dir, `${CTX}/T003#7`, "artifact"]);
    expect(missing.errors[0]?.code).toBe("review_pack_unknown_finding");
    expect(missing.errors[0]?.message).toContain(`${CTX}/T002#0`);
    expect(exitCode()).toBe(1);
    resetExitCode();

    const enumErr = await run(["disposition", dir, `${CTX}/T002#0`, "meh"]);
    expect(enumErr.errors[0]?.code).toBe("review_pack_invalid_disposition");
    expect(exitCode()).toBe(1);
    resetExitCode();

    const unjudged = seedPack(false);
    const notJudged = await run(["disposition", unjudged, `${CTX}/T002#0`, "artifact"]);
    expect(notJudged.errors[0]?.code).toBe("review_pack_not_judged");
    expect(exitCode()).toBe(1);
    expect(readJson(join(dir, "findings.json")).dispositions).toEqual([]);
  });
});

describe("review-pack verdict", () => {
  test("fails while a high is open, passes once every high is dismissed, and refreshes review.md", async () => {
    const dir = seedPack();
    const open = await run(["verdict", dir, "--json"]);
    expect(open.errors).toEqual([]);
    expect(exitCode()).toBe(2);
    expect(open.data[0]).toMatchObject({
      schema: PAGE_REVIEW_VERDICT_SCHEMA,
      machine_outcome: "fail",
      reviewed_outcome: "fail",
      high_total: 2,
      high_open: 2,
    });
    const verdictPath = join(dir, "evidence", "verdict.json");
    expect(existsSync(verdictPath)).toBe(true);
    expect(readFileSync(join(dir, "review.md"), "utf8")).toContain("## Reviewed outcome");
    resetExitCode();

    const d1 = await run(["disposition", dir, `${CTX}/T002#0`, "artifact", "--note", "seam"]);
    const d2 = await run(["disposition", dir, `${CTX}/T003#1`, "not-a-defect"]);
    expect(d1.errors).toEqual([]);
    expect(d2.errors).toEqual([]);
    const coverage = await run([
      "reviews",
      "add",
      dir,
      "--reviewer",
      "agent-review-1",
      "--model",
      "GPT-5.6 Luna",
      "--assigned",
      `${CTX}/T001`,
      "--assigned",
      `${CTX}/T002`,
      "--assigned",
      `${CTX}/T003`,
      "--assigned",
      `${CTX}/T004`,
      "--completed",
      `${CTX}/T001`,
      "--completed",
      `${CTX}/T002`,
      "--completed",
      `${CTX}/T003`,
      "--completed",
      `${CTX}/T004`,
    ]);
    expect(coverage.errors).toEqual([]);
    const passed = await run(["verdict", dir, "--json"]);
    expect(passed.errors).toEqual([]);
    expect(exitCode()).toBe(0);
    expect(passed.data[0]).toMatchObject({
      reviewed_outcome: "pass",
      high_dismissed: 2,
      high_open: 0,
      dispositions_applied: 2,
      primary_tiles_reviewed: 4,
      primary_tiles_total: 4,
    });
    expect(readJson(verdictPath).reviewed_outcome).toBe("pass");
    const review = readFileSync(join(dir, "review.md"), "utf8");
    expect(review).toContain("**PASS** (machine outcome fail)");
    expect(review.split("## Reviewed outcome")).toHaveLength(2);
  });

  test("exits 4 for an unjudged pack and 1 with every error listed for an invalid findings.json", async () => {
    const unjudged = seedPack(false);
    const skipped = await run(["verdict", unjudged, "--json"]);
    expect(skipped.data[0]).toMatchObject({
      machine_outcome: "skipped",
      reviewed_outcome: "incomplete",
    });
    expect(exitCode()).toBe(4);
    resetExitCode();

    const dir = seedPack();
    const findingsPath = join(dir, "findings.json");
    const doc = readJson(findingsPath);
    doc.findings = [
      {
        id: "bad id",
        severity: "huge",
        category: "layout",
        context_id: CTX,
        evidence: [],
        observation: "x",
      },
    ];
    const { writeFileSync } = await import("node:fs");
    writeFileSync(findingsPath, JSON.stringify(doc));
    const invalid = await run(["verdict", dir]);
    expect(invalid.errors[0]?.code).toBe("review_pack_findings_invalid");
    expect(invalid.logs.filter((l) => l.startsWith("findings.json:"))).toHaveLength(3);
    expect(exitCode()).toBe(1);
    expect(existsSync(join(dir, "evidence", "verdict.json"))).toBe(false);
  });
});

describe("review-pack list / show", () => {
  test("list finds the pack under --root and reports outcome, tiles, and expiry", async () => {
    const dir = seedPack(true);
    const out = await run(["list", "--root", dir, "--json"]);
    expect(out.errors).toEqual([]);
    const payload = out.data[0] as { root: string; packs: Array<Record<string, unknown>> };
    expect(payload.packs).toHaveLength(1);
    const row = payload.packs[0] as Record<string, unknown>;
    expect(row.dir).toBe(dir);
    expect(row.contexts).toBe(1);
    expect(row.tiles).toBe(4);
    expect(row.machine_outcome).toBe("fail");
    expect(row.reviewed_outcome).toBeNull();
    expect(row.expired).toBe(false);
  });

  test("show summarizes one pack and refuses a directory that is not a pack", async () => {
    const dir = seedPack(true);
    const out = await run(["show", dir, "--json"]);
    expect(out.errors).toEqual([]);
    const summary = out.data[0] as {
      target: string;
      machine_outcome: string | null;
      contexts: Array<{ id: string; tiles: number; high: number; capture_source: string }>;
    };
    expect(summary.target).toBe("http://localhost:4276/page");
    expect(summary.machine_outcome).toBe("fail");
    expect(summary.contexts).toHaveLength(1);
    expect(summary.contexts[0]?.id).toBe(CTX);
    expect(summary.contexts[0]?.tiles).toBe(4);
    expect(summary.contexts[0]?.high).toBe(2);
    expect(summary.contexts[0]?.capture_source).toBe("full-page");

    const empty = mkdtempSync(join(tmpdir(), "review-pack-cli-empty-"));
    roots.push(empty);
    const bad = await run(["show", empty, "--json"]);
    expect(bad.errors[0]?.code).toBe("review_pack_not_found");
    expect(exitCode()).toBe(1);
  });
});
