import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAssertSpec } from "../../src/lib/browser/asserts.ts";
import { Browser } from "../../src/lib/browser/client.ts";

const fixtureUrl = pathToFileURL(
  resolve(import.meta.dir, "../fixtures/content-checks/index.html"),
).href;
const profiles: string[] = [];

function profile(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-asserts-"));
  profiles.push(path);
  return path;
}

afterEach(() => {
  for (const path of profiles.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("browse asserts", () => {
  test("parseAssertSpec parses each op and rejects malformed input", () => {
    expect(parseAssertSpec("text h1 => Welcome")).toEqual({
      raw: "text h1 => Welcome",
      op: "text",
      selector: "h1",
      expected: "Welcome",
    });
    expect(parseAssertSpec("count .card => >=3").expected).toBe(">=3");
    expect(parseAssertSpec("exists .cta")).toEqual({
      raw: "exists .cta",
      op: "exists",
      selector: ".cta",
      expected: "",
    });
    expect(() => parseAssertSpec("bogus .x => y")).toThrow(/op must be one of/);
    expect(() => parseAssertSpec("text")).toThrow(/needs/);
    expect(() => parseAssertSpec("contains .x")).toThrow(/needs 'selector => expected'/);
  });

  test("checkAsserts evaluates each op against the page", async () => {
    const browser = new Browser({ profileDir: profile(), viewport: { width: 800, height: 900 } });
    try {
      await browser.open();
      await browser.navigate(fixtureUrl);
      const results = await browser.checkAsserts([
        parseAssertSpec("exists section.ph-bad"),
        parseAssertSpec("absent .no-such-thing"),
        parseAssertSpec("count section => >=5"),
        parseAssertSpec("count section => 1"), // wrong count → fail
        parseAssertSpec("contains .ph-good => $5"),
        parseAssertSpec("contains .ph-good => NOT PRESENT"), // → fail
        parseAssertSpec("matches .ph-good => 100% effective"),
      ]);
      const byRaw = Object.fromEntries(results.map((r) => [r.raw, r.outcome]));
      expect(byRaw["exists section.ph-bad"]).toBe("pass");
      expect(byRaw["absent .no-such-thing"]).toBe("pass");
      expect(byRaw["count section => >=5"]).toBe("pass");
      expect(byRaw["count section => 1"]).toBe("fail");
      expect(byRaw["contains .ph-good => $5"]).toBe("pass");
      expect(byRaw["contains .ph-good => NOT PRESENT"]).toBe("fail");
      expect(byRaw["matches .ph-good => 100% effective"]).toBe("pass");
    } finally {
      await browser.close();
    }
  });

  test("CLI --assert emits results and --assert-fail exits 2 on failure", () => {
    const result = Bun.spawnSync({
      cmd: [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        fixtureUrl,
        "--json",
        "--no-cookies",
        "--profile",
        profile(),
        "--assert",
        "exists section.ph-bad",
        "--assert",
        "count section => 999",
        "--assert-fail",
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout = result.stdout.toString();
    expect(stdout).toContain('"asserts"');
    expect(result.exitCode).toBe(2); // the count assert fails
  });
});
