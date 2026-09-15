import { describe, expect, test } from "bun:test";

import {
  AUTOMATION_DEFAULT_ARGS_TO_DROP,
  automationDisguiseArgs,
  installedChromeChannel,
  installedChromePath,
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
