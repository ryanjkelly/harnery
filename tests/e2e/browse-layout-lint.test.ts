import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser } from "../../src/lib/browser/client.ts";

const fixtureUrl = pathToFileURL(
  resolve(import.meta.dir, "../fixtures/layout-lint/index.html"),
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
        ],
        overlap: [
          { selector: ".overlap-good", tolerancePx: 0 },
          { selector: ".overlap-bad", tolerancePx: 0 },
        ],
      });

      expect(result.align.map((entry) => entry.outcome)).toEqual(["pass", "fail"]);
      expect(result.align[1]?.clusters[0]?.children[0]?.source).toBe("svg");
      expect(result.gap.map((entry) => entry.outcome)).toEqual(["pass", "fail", "unknown"]);
      expect(result.clip.map((entry) => entry.outcome)).toEqual(["pass", "fail"]);
      expect(result.overlap.map((entry) => entry.outcome)).toEqual(["pass", "fail"]);
    } finally {
      await browser.close();
    }
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
    expect(stdout).toContain('"hit"');
  });
});
