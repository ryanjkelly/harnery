import { describe, expect, test } from "bun:test";

import {
  AUTOMATION_DEFAULT_ARGS_TO_DROP,
  assertSandboxArgs,
  automationDisguiseArgs,
  browserSandboxEnabled,
  compareChromeVersions,
  explainSandboxLaunchError,
  installedChromeChannel,
  installedChromePath,
  preferredChromeChannel,
} from "./launch-args.ts";

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
