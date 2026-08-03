import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser } from "../../src/lib/browser/client.ts";

const fixtureUrl = pathToFileURL(
  resolve(import.meta.dir, "../fixtures/content-checks/index.html"),
).href;
const profiles: string[] = [];

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-content-checks-"));
  profiles.push(path);
  return path;
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("browse content checks", () => {
  test("placeholder flags unrendered tells and is prose-safe", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 900 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const bad = await browser.checkContent({
        placeholder: { scope: ".ph-bad" },
        image: null,
        truncation: null,
        contrast: null,
      });
      expect(bad.placeholder?.outcome).toBe("fail");
      const kinds = new Set(bad.placeholder?.hits.map((h) => h.kind));
      expect(kinds.has("js-template")).toBe(true); // ${name}
      expect(kinds.has("mustache")).toBe(true); // {{count}}
      expect(kinds.has("object")).toBe(true); // [object Object]
      expect(kinds.has("nan")).toBe(true); // NaN%
      expect(kinds.has("empty-binding")).toBe(true); // <dd>undefined</dd>

      const good = await browser.checkContent({
        placeholder: { scope: ".ph-good" },
        image: null,
        truncation: null,
        contrast: null,
      });
      // "$5", "100%", and the word "undefined" inside prose must NOT flag.
      expect(good.placeholder?.outcome).toBe("pass");
    } finally {
      await browser.close();
    }
  });

  test("image flags broken + stretched, passes natural", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 900 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const bad = await browser.checkContent({
        placeholder: null,
        image: { scope: ".img-bad", tolerance: 0.1 },
        truncation: null,
        contrast: null,
      });
      expect(bad.image?.outcome).toBe("fail");
      const reasons = new Set(bad.image?.issues.map((i) => i.reason));
      expect(reasons.has("missing")).toBe(true);
      expect(reasons.has("stretched")).toBe(true);

      const good = await browser.checkContent({
        placeholder: null,
        image: { scope: ".img-good", tolerance: 0.1 },
        truncation: null,
        contrast: null,
      });
      expect(good.image?.outcome).toBe("pass");
    } finally {
      await browser.close();
    }
  });

  test("truncation flags active ellipsis + line-clamp, passes untruncated", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 900 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const bad = await browser.checkContent({
        placeholder: null,
        image: null,
        truncation: { scope: ".trunc-bad", tolerance: 2 },
        contrast: null,
      });
      expect(bad.truncation?.outcome).toBe("fail");
      const axes = new Set(bad.truncation?.hits.map((h) => h.axis));
      expect(axes.has("x")).toBe(true); // ellipsis
      expect(axes.has("y")).toBe(true); // line-clamp

      const good = await browser.checkContent({
        placeholder: null,
        image: null,
        truncation: { scope: ".trunc-good", tolerance: 2 },
        contrast: null,
      });
      expect(good.truncation?.outcome).toBe("pass");
    } finally {
      await browser.close();
    }
  });

  test("contrast fails low ratio, passes high, unknown on gradient", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 900 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const bad = await browser.checkContent({
        placeholder: null,
        image: null,
        truncation: null,
        contrast: { scope: ".ct-bad" },
      });
      expect(bad.contrast?.outcome).toBe("fail");

      const good = await browser.checkContent({
        placeholder: null,
        image: null,
        truncation: null,
        contrast: { scope: ".ct-good" },
      });
      expect(good.contrast?.outcome).toBe("pass");

      const grad = await browser.checkContent({
        placeholder: null,
        image: null,
        truncation: null,
        contrast: { scope: ".grad" },
      });
      expect(grad.contrast?.outcome).toBe("unknown");
    } finally {
      await browser.close();
    }
  });

  test("CLI emits content families and exits 2 after a gated failure", () => {
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        fixtureUrl,
        "--json",
        "--no-cookies",
        "--profile",
        profile(),
        "--check-placeholder",
        ".ph-bad",
        "--check-placeholder-fail",
        "--check-images",
        ".img-good",
        "--check-truncation",
        ".trunc-good",
        "--check-contrast",
        ".ct-good",
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(2);
    expect(stdout).toContain('"placeholder"');
    expect(stdout).toContain('"image"');
    expect(stdout).toContain('"truncation"');
    expect(stdout).toContain('"contrast"');
  });
});
