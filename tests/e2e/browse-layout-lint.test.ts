import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser } from "../../src/lib/browser/client.ts";

const fixtureUrl = pathToFileURL(
  resolve(import.meta.dir, "../fixtures/layout-lint/index.html"),
).href;
const nonConvergentFixtureUrl = pathToFileURL(
  resolve(import.meta.dir, "../fixtures/capture-viewport/non-convergent.html"),
).href;
const pageChecksFixtureUrl = pathToFileURL(
  resolve(import.meta.dir, "../fixtures/page-checks/index.html"),
).href;
const profiles: string[] = [];

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-layout-lint-"));
  profiles.push(path);
  return path;
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("browse layout lint", () => {
  test("classifies alignment, gap, clipping, and overlap from one page state", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 900 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const result = await browser.checkLayoutLint({
        align: [
          { selector: ".align-good", axis: "auto", tolerancePx: 2 },
          { selector: ".bad-align", axis: "auto", tolerancePx: 2 },
        ],
        gap: [
          { selector: ".good-gap", axis: "auto", tolerancePx: 2, expectedGapPx: null },
          { selector: ".bad-gap", axis: "auto", tolerancePx: 2, expectedGapPx: null },
          { selector: ".two-gap", axis: "auto", tolerancePx: 2, expectedGapPx: null },
        ],
        clip: [
          { selector: ".clip-good", tolerancePx: 0 },
          { selector: ".clip-bad", tolerancePx: 0 },
          { selector: ".clip-text-case", tolerancePx: 0 },
          { selector: ".clip-text-scroll", tolerancePx: 0 },
          { selector: ".clip-scroll-y", tolerancePx: 0 },
          { selector: ".clip-closed-details", tolerancePx: 0 },
          { selector: ".clip-hidden-in-scroll", tolerancePx: 0 },
          { selector: ".clip-hanging-indent", tolerancePx: 0 },
          { selector: ".clip-rounded-visible", tolerancePx: 0 },
          { selector: ".clip-rounded-hidden", tolerancePx: 0 },
          { selector: ".clip-path-unknown", tolerancePx: 0 },
        ],
        overlap: [
          { selector: ".overlap-good", tolerancePx: 0 },
          { selector: ".overlap-bad", tolerancePx: 0 },
        ],
        crowd: [
          { selector: ".crowd-good", minGapPx: 6 },
          { selector: ".crowd-bad", minGapPx: 6 },
          { selector: ".crowd-plain", minGapPx: 6 },
          { selector: ".crowd-composite-bad", minGapPx: 6 },
          { selector: ".crowd-composite-good", minGapPx: 6 },
          { selector: ".crowd-composite-deep", minGapPx: 6 },
        ],
      });

      expect(result.align.map((entry) => entry.outcome)).toEqual(["pass", "fail"]);
      expect(result.align[1]?.clusters[0]?.children[0]?.source).toBe("svg");
      expect(result.gap.map((entry) => entry.outcome)).toEqual(["pass", "fail", "unknown"]);
      expect(result.clip.map((entry) => entry.outcome)).toEqual([
        "pass",
        "fail",
        "fail",
        "pass",
        "pass",
        "pass",
        "fail",
        "pass",
        "pass",
        "pass",
        "unknown",
      ]);
      expect(result.clip[8]?.unsupported).toEqual([]);
      expect(result.clip[9]?.unsupported).toEqual([]);
      expect(result.clip[10]?.unsupported).toContain("section.clip-path-unknown:clip-path");
      // Content below the fold of a scroller is reachable, and a collapsed
      // disclosure is deliberately unrendered; neither is a clip defect. An
      // overflow:hidden box inside that scroller still is.
      expect(result.clip[4]?.issues).toEqual([]);
      expect(result.clip[5]?.issues).toEqual([]);
      expect(result.clip[6]?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ clippedBy: "div.inner" }),
        ]),
      );
      expect(result.clip[2]?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            clippedBy: "section.clip-text-case.clip-text-bad",
            element: expect.objectContaining({ source: "text", snippet: "Persistence" }),
          }),
        ]),
      );
      expect(result.overlap.map((entry) => entry.outcome)).toEqual(["pass", "fail"]);
      // crowd-good: panels 16px apart pass. crowd-bad: flush panels fail.
      // crowd-plain: flush but non-panel paragraphs must NOT flag (panel gate).
      // crowd-composite-bad: wrapper-of-panels flush to a panel fails (nearest faces).
      // crowd-composite-good: same structure with 16px gap passes.
      // crowd-composite-deep: tall wrapper flush to next panel but inner face far — pass.
      expect(result.crowd.map((entry) => entry.outcome)).toEqual([
        "pass",
        "fail",
        "pass",
        "fail",
        "pass",
        "pass",
      ]);
      expect(result.crowd[1]?.issues[0]?.axis).toBe("y");
      expect(result.crowd[1]?.issues[0]?.separationPx ?? 99).toBeLessThan(6);
      expect(result.crowd[3]?.issues[0]?.beforeKind).toBe("composite");
      expect(result.crowd[3]?.issues[0]?.afterKind).toBe("panel");
      expect(result.crowd[3]?.issues[0]?.separationPx ?? 99).toBeLessThan(6);
    } finally {
      await browser.close();
    }
  });

  test("runt checks distinguish pass, fail, and a missing scope", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 900 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const good = await browser.checkRunts({ scope: ".runt-good", minChars: 1 });
      const bad = await browser.checkRunts({ scope: ".runt-bad", minChars: 1 });
      const missing = await browser.checkRunts({ scope: ".does-not-exist", minChars: 1 });

      expect(good).toMatchObject({ found: true, outcome: "pass", truncated: false });
      expect(bad).toMatchObject({ found: true, outcome: "fail", truncated: false });
      expect(bad.runts).toHaveLength(1);
      expect(missing).toMatchObject({ found: false, outcome: "fail", scannedBlocks: 0 });
    } finally {
      await browser.close();
    }
  });

  test(
    "CLI fail flags cannot silently skip their checks",
    () => {
      const run = (...args: string[]) =>
        Bun.spawnSync({
          cmd: [
            resolve(import.meta.dir, "../../bin/harn"),
            "browse",
            pageChecksFixtureUrl,
            "--json",
            "--no-cookies",
            "--profile",
            profile(),
            ...args,
          ],
          cwd: resolve(import.meta.dir, "../.."),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NO_COLOR: "1" },
        });

      const overflow = run("--check-overflow-fail");
      expect(overflow.exitCode).toBe(2);
      expect(overflow.stdout.toString()).toContain('"overflow"');

      const runts = run("--check-runts-fail", "--check-runts-min-chars", "1");
      expect(runts.exitCode).toBe(2);
      expect(runts.stdout.toString()).toContain('"runts"');

      const clip = run("--check-clip-fail");
      expect(clip.exitCode).toBe(1);
      expect(clip.stderr.toString()).toContain("--check-clip-fail requires --check-clip");

      const hit = run("--check-hit-fail");
      expect(hit.exitCode).toBe(2);
      expect(hit.stdout.toString()).toContain('"hit"');

      const assertion = run("--assert-fail");
      expect(assertion.exitCode).toBe(1);
      expect(assertion.stderr.toString()).toContain("--assert-fail requires --assert");

      const diff = run("--diff-fail");
      expect(diff.exitCode).toBe(1);
      expect(diff.stderr.toString()).toContain("--diff-fail requires --diff");
    },
    { timeout: 30_000 },
  );

  test("CLI runt gate fails when its requested scope is missing", () => {
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        fixtureUrl,
        "--no-cookies",
        "--profile",
        profile(),
        "--no-screenshot",
        "--check-runts",
        ".does-not-exist",
        "--check-runts-fail",
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("check-runts FAIL .does-not-exist: scope not found");
  });

  test("preserves target-size pass and fail truth", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 900 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const result = await browser.checkTargetSize([".hit-good", ".hit-bad"], "wcag-aa");
      expect(result[0]?.outcome).toBe("pass");
      expect(result[1]?.outcome).toBe("fail");
      expect(result[1]?.nodes.some((node) => node.outcome === "fail")).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test("CLI emits every result family and exits 2 after a gated failure", () => {
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        fixtureUrl,
        "--json",
        "--no-cookies",
        "--profile",
        profile(),
        "--check-align",
        ".bad-align",
        "--check-align-fail",
        "--check-gap",
        ".good-gap",
        "--check-clip",
        ".clip-good",
        "--check-overlap",
        ".overlap-good",
        "--check-crowd",
        ".crowd-bad",
        "--check-hit",
        ".hit-good",
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(2);
    expect(stdout).toContain('"align"');
    expect(stdout).toContain('"gap"');
    expect(stdout).toContain('"clip"');
    expect(stdout).toContain('"overlap"');
    expect(stdout).toContain('"crowd"');
    expect(stdout).toContain('"hit"');
  });

  test("CLI clip gate catches text overflow in a later selector match", () => {
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        fixtureUrl,
        "--json",
        "--no-cookies",
        "--profile",
        profile(),
        "--check-clip",
        ".clip-text-case",
        "--check-clip-threshold",
        "2",
        "--check-clip-fail",
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(2);
    expect(stdout).toContain('"snippet":"Persistence"');
    expect(stdout).toContain('"source":"text"');
  });

  test("CLI layout fail gates exit 2 when any geometry result is unknown", () => {
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        fixtureUrl,
        "--no-cookies",
        "--profile",
        profile(),
        "--no-screenshot",
        "--check-gap",
        ".two-gap",
        "--check-gap-fail",
        "--check-clip",
        ".clip-path-unknown",
        "--check-clip-fail",
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain("check-gap FAIL .two-gap: result unknown");
    expect(stderr).toContain("check-clip FAIL .clip-path-unknown: result unknown");
  });

  test("CLI binds captureEval to the explicit full-page screenshot viewport", () => {
    const outputDir = profile();
    const output = join(outputDir, "capture-state");
    const browserProfile = profile();
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        fixtureUrl,
        "--no-cookies",
        "--profile",
        browserProfile,
        "--viewport",
        "800x900",
        "--out",
        output,
        "--evaluate",
        '({ phase: "initial", height: innerHeight })',
        "--capture-evaluate",
        '({ phase: "capture", height: innerHeight, scrollHeight: document.documentElement.scrollHeight })',
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(readFileSync(`${output}.json`, "utf8"));
    expect(envelope.eval).toEqual({ phase: "initial", height: 900 });
    expect(envelope.captureEval).toMatchObject({
      phase: "capture",
      height: envelope.captureViewport.height,
      scrollHeight: envelope.captureViewport.height,
    });
    expect(envelope.captureViewport.width).toBe(800);
    expect(envelope.captureViewport.height).toBeGreaterThanOrEqual(900);
    expect(envelope.captureEvidence).toMatchObject({
      converged: true,
      reason: "capture_viewport_converged",
      evaluated_viewport: envelope.captureViewport,
      document_extent_before_evaluation: envelope.captureViewport,
      document_extent_after_evaluation: envelope.captureViewport,
      document_extent_after_screenshot: envelope.captureViewport,
      screenshot: {
        width: envelope.captureViewport.width,
        height: envelope.captureViewport.height,
        bytes: envelope.screenshotBytes,
      },
    });
  });

  test("CLI records viewport-relative full-page non-convergence instead of mismatched green evidence", () => {
    const outputDir = profile();
    const output = join(outputDir, "capture-non-convergent");
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        nonConvergentFixtureUrl,
        "--no-cookies",
        "--profile",
        profile(),
        "--viewport",
        "800x900",
        "--out",
        output,
        "--capture-evaluate",
        "({ width: innerWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight })",
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(readFileSync(`${output}.json`, "utf8"));
    expect(envelope.captureEvidence).toMatchObject({
      converged: false,
      reason: "capture_viewport_non_convergent",
      passes: 4,
      max_passes: 4,
      evaluated_viewport: envelope.captureViewport,
      screenshot: {
        width: 800,
        bytes: envelope.screenshotBytes,
      },
    });
    expect(envelope.captureEval.height).toBe(envelope.captureViewport.height);
    expect(envelope.captureEval.scrollHeight).toBeGreaterThan(envelope.captureEval.height);
    expect(envelope.captureEvidence.screenshot.height).toBeGreaterThan(
      envelope.captureViewport.height,
    );
    expect(envelope.captureEvidence.converged).toBe(false);
  });

  test("restores the original viewport when capture-state evaluation throws", async () => {
    const browser = new Browser({
      profileDir: profile(),
      viewport: { width: 800, height: 900 },
    });
    try {
      await browser.open();
      await browser.navigate(nonConvergentFixtureUrl);
      await expect(
        browser.screenshotWithEvaluation(
          join(profile(), "capture-evaluation-error.png"),
          '(() => { throw new Error("capture-finalizer-failed"); })()',
        ),
      ).rejects.toThrow("capture-finalizer-failed");
      expect(browser.currentPage.viewportSize()).toEqual({ width: 800, height: 900 });
    } finally {
      await browser.close();
    }
  });
});
