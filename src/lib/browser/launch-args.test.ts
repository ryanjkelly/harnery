import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import {
  AUTOMATION_DEFAULT_ARGS_TO_DROP,
  assertSandboxArgs,
  automationDisguiseArgs,
  browserSandboxEnabled,
  chromeVersionFromExecutable,
  compareChromeVersions,
  explainSandboxLaunchError,
  installedChromeChannel,
  installedChromePath,
  peProductVersion,
  preferredChromeChannel,
} from "./launch-args.ts";
import { chromeMajorFromExecutable } from "./user-agent.ts";

/** Bytes shaped like a PE version resource: VS_VERSIONINFO header, key, padding, VS_FIXEDFILEINFO. */
function versionResource(
  product: [number, number, number, number],
  signature = 0xfeef04bd,
): Buffer {
  const [major, minor, build, patch] = product;
  const header = Buffer.alloc(6);
  const key = Buffer.from("VS_VERSION_INFO\0", "utf16le");
  const padding = Buffer.alloc(2);
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(signature, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  fixed.writeUInt32LE(0x00010002, 8); // file version 1.2.3.4, distinct from the product version
  fixed.writeUInt32LE(0x00030004, 12);
  fixed.writeUInt32LE(((major << 16) | minor) >>> 0, 16);
  fixed.writeUInt32LE(((build << 16) | patch) >>> 0, 20);
  return Buffer.concat([Buffer.alloc(1024, 0x90), header, key, padding, fixed, Buffer.alloc(64)]);
}

describe("Chrome version without running the binary", () => {
  test("reads the product version from a PE version resource", () => {
    expect(peProductVersion(versionResource([155, 0, 8059, 86]))).toBe("155.0.8059.86");
  });

  test("returns undefined when there is no valid version resource", () => {
    expect(peProductVersion(Buffer.alloc(4096))).toBeUndefined();
    expect(peProductVersion(versionResource([155, 0, 8059, 86], 0xdeadbeef))).toBeUndefined();
  });

  test("never executes a .exe or a win32 binary", () => {
    // The fake binaries cannot run, so a version proves it came from the bytes.
    const dir = mkdtempSync(join(tmpdir(), "harnery-chrome-version-"));
    try {
      const exe = join(dir, "chrome.exe");
      writeFileSync(exe, versionResource([156, 0, 8078, 80]));
      expect(chromeVersionFromExecutable(exe, "linux")).toBe("156.0.8078.80");
      expect(chromeMajorFromExecutable(exe, "linux")).toBe(156);
      const bare = join(dir, "chrome");
      writeFileSync(bare, versionResource([154, 0, 1, 2]));
      expect(chromeVersionFromExecutable(bare, "win32")).toBe("154.0.1.2");
      expect(chromeVersionFromExecutable(join(dir, "missing.exe"), "win32")).toBeUndefined();
    } finally {
      removeDir(dir);
    }
  });
});

describe("installedChromeChannel", () => {
  test("returns chrome when a known Chrome binary exists on linux", () => {
    const exists = (p: string) => p === "/usr/bin/google-chrome";
    expect(installedChromeChannel("linux", exists)).toBe("chrome");
  });

  test("returns undefined when no known binary exists", () => {
    expect(installedChromeChannel("linux", () => false)).toBeUndefined();
    expect(installedChromeChannel("darwin", () => false)).toBeUndefined();
  });

  test("checks the macOS app bundle path", () => {
    const exists = (p: string) => p.includes("Google Chrome.app");
    expect(installedChromeChannel("darwin", exists)).toBe("chrome");
  });

  test("unknown platforms never claim chrome", () => {
    expect(installedChromeChannel("freebsd", () => true)).toBeUndefined();
  });
});

describe("automation disguise", () => {
  test("drops --enable-automation and disables the AutomationControlled blink feature", () => {
    expect(AUTOMATION_DEFAULT_ARGS_TO_DROP).toEqual(["--enable-automation"]);
    expect(automationDisguiseArgs()).toEqual(["--disable-blink-features=AutomationControlled"]);
  });
});

describe("installedChromePath", () => {
  test("returns the first existing candidate", () => {
    const exists = (p: string) => p === "/usr/bin/google-chrome-stable";
    expect(installedChromePath("linux", exists)).toBe("/usr/bin/google-chrome-stable");
  });

  test("returns undefined when nothing exists", () => {
    expect(installedChromePath("linux", () => false)).toBeUndefined();
  });
});

describe("browser sandbox policy", () => {
  test("is on unless HARNERY_BROWSER_SANDBOX=0", () => {
    expect(browserSandboxEnabled({})).toBe(true);
    expect(browserSandboxEnabled({ HARNERY_BROWSER_SANDBOX: "1" })).toBe(true);
    expect(browserSandboxEnabled({ HARNERY_BROWSER_SANDBOX: "0" })).toBe(false);
  });

  test("refuses --no-sandbox while the sandbox is on", () => {
    expect(() => assertSandboxArgs(["--disable-gpu", "--no-sandbox"], true)).toThrow(
      /HARNERY_BROWSER_SANDBOX=0/,
    );
    expect(() => assertSandboxArgs(["--no-sandbox"], false)).not.toThrow();
    expect(() => assertSandboxArgs(["--disable-gpu"], true)).not.toThrow();
  });

  test("adds the remedy to sandbox launch failures and keeps the original message", () => {
    const original = new Error("No usable sandbox! Update your kernel");
    const wrapped = explainSandboxLaunchError(original, true) as Error;
    expect(wrapped.message).toContain("HARNERY_BROWSER_SANDBOX=0");
    expect(wrapped.message).toContain("No usable sandbox!");
    expect(wrapped.cause).toBe(original);
    const unrelated = new Error("Timeout 30000ms exceeded");
    expect(explainSandboxLaunchError(unrelated, true)).toBe(unrelated);
    expect(explainSandboxLaunchError(original, false)).toBe(original);
  });
});

describe("preferredChromeChannel", () => {
  test("compares all four version parts numerically", () => {
    expect(compareChromeVersions("156.0.8078.79", "156.0.8078.4")).toBeGreaterThan(0);
    expect(compareChromeVersions("154.0.8037.92", "156.0.8078.4")).toBeLessThan(0);
    expect(compareChromeVersions("156.0.8078.4", "156.0.8078.4")).toBe(0);
  });

  test("uses installed Chrome only when it is at least the bundled build", () => {
    expect(
      preferredChromeChannel({ installedVersion: "156.0.8078.79", bundledVersion: "156.0.8078.4" }),
    ).toBe("chrome");
    expect(
      preferredChromeChannel({ installedVersion: "156.0.8078.4", bundledVersion: "156.0.8078.4" }),
    ).toBe("chrome");
    expect(
      preferredChromeChannel({ installedVersion: "154.0.8037.92", bundledVersion: "156.0.8078.4" }),
    ).toBeUndefined();
    expect(
      preferredChromeChannel({ installedVersion: undefined, bundledVersion: "156.0.8078.4" }),
    ).toBeUndefined();
    expect(
      preferredChromeChannel({ installedVersion: "156.0.8078.79", bundledVersion: undefined }),
    ).toBe("chrome");
  });
});
