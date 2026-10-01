import { describe, expect, test } from "bun:test";
import {
  cookieInDomain,
  cookiesForDomain,
  harvestDomain,
  harvestScript,
  windowsChromePath,
  windowsPlainProfile,
  wslPathToWindows,
} from "./windows-chrome.ts";

describe("windows chrome sign-in helpers", () => {
  test("finds the Windows Chrome through the /mnt/c mount", () => {
    const present = "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe";
    expect(windowsChromePath((path) => path === present)).toBe(present);
    expect(windowsChromePath(() => false)).toBeUndefined();
  });

  test("converts /mnt paths to drive-letter paths", () => {
    expect(wslPathToWindows("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe")).toBe(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    );
    expect(() => wslPathToWindows("/usr/bin/google-chrome")).toThrow();
  });

  test("keeps the sign-in profile under LOCALAPPDATA", () => {
    expect(windowsPlainProfile("C:\\Users\\a\\AppData\\Local")).toBe(
      "C:\\Users\\a\\AppData\\Local\\harnery\\plain-login-profile",
    );
  });

  test("harvests the sign-in site's registrable domain only", () => {
    expect(harvestDomain("https://x.com/i/flow/login")).toBe("x.com");
    expect(harvestDomain("https://accounts.example.org/login")).toBe("example.org");
    expect(cookieInDomain(".x.com", "x.com")).toBe(true);
    expect(cookieInDomain("api.x.com", "x.com")).toBe(true);
    expect(cookieInDomain(".notx.com", "x.com")).toBe(false);
    expect(cookieInDomain("accounts.google.com", "x.com")).toBe(false);
  });

  test("normalizes CDP cookies to the store shape and drops other domains", () => {
    const cookies = cookiesForDomain(
      [
        {
          name: "auth_token",
          value: "a",
          domain: ".x.com",
          path: "/",
          expires: 2_000_000_000,
          httpOnly: true,
          secure: true,
          sameSite: "None",
          size: 11,
        },
        {
          name: "SID",
          value: "g",
          domain: ".google.com",
          path: "/",
          expires: 2_000_000_000,
          httpOnly: true,
          secure: true,
        },
      ],
      "x.com",
    );
    expect(cookies).toEqual([
      {
        name: "auth_token",
        value: "a",
        domain: ".x.com",
        path: "/",
        expires: 2_000_000_000,
        size: 11,
        httpOnly: true,
        secure: true,
        sameSite: "None",
      },
    ]);
  });

  test("the PowerShell harvest launches headless, reads cookies, and closes the browser", () => {
    const script = harvestScript();
    expect(script).toContain("--headless=new");
    expect(script).toContain("--remote-debugging-port=0");
    expect(script).toContain("DevToolsActivePort");
    expect(script).toContain("Storage.getCookies");
    expect(script).toContain("Browser.close");
    expect(script).toContain("throw 'Windows Chrome did not open its DevTools port in time.'");
  });
});
