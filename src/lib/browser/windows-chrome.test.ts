import { describe, expect, test } from "bun:test";
import {
  cookieInDomain,
  cookiesForDomain,
  harvestDomain,
  harvestScript,
  keepSessionScript,
  parseHarvestOutput,
  parseStopOutput,
  profileCommandLinePattern,
  sitePages,
  stopScript,
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

  test("the PowerShell harvest restores the last session, reads cookies and pages, and closes", () => {
    const script = harvestScript();
    expect(script).toContain("--headless=new");
    expect(script).toContain("--restore-last-session");
    expect(script).toContain("--remote-debugging-port=0");
    expect(script).toContain("DevToolsActivePort");
    expect(script).toContain("Storage.getCookies");
    expect(script).toContain("Target.getTargets");
    expect(script).toContain("Browser.close");
    expect(script).toContain("throw 'Windows Chrome did not open its DevTools port in time.'");
    expect(script).toContain("Chrome is still running on the sign-in profile");
  });

  test("the keep-session script sets the startup preference through the settings page", () => {
    const script = keepSessionScript();
    expect(script).toContain("chrome://settings/onStartup");
    expect(script).toContain("setPref('session.restore_on_startup', 1");
    expect(script).toContain("'Secure Preferences', 'Preferences'");
    expect(script).not.toContain("--restore-last-session");
    expect(script.indexOf("Chrome is still running on the sign-in profile")).toBeLessThan(
      script.indexOf("Secure Preferences"),
    );
  });

  test("the stop script closes windows first and reports survivors", () => {
    const script = stopScript();
    expect(script.indexOf("CloseMainWindow")).toBeLessThan(script.indexOf("Stop-Process"));
    expect(script).toContain("remaining");
  });

  test("the profile pattern matches the exact profile, quoted or not", () => {
    const profile = "C:\\Users\\a\\AppData\\Local\\harnery\\plain-login-profile";
    const pattern = new RegExp(profileCommandLinePattern(profile), "i");
    const chrome = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
    expect(pattern.test(`${chrome} --user-data-dir=${profile} --no-first-run`)).toBe(true);
    expect(pattern.test(`${chrome} --user-data-dir="${profile}" --headless=new`)).toBe(true);
    expect(pattern.test(`${chrome} --type=renderer --user-data-dir=${profile}`)).toBe(true);
    expect(pattern.test(`${chrome} --user-data-dir=${profile.toUpperCase()} x`)).toBe(true);
    expect(pattern.test(`${chrome} --user-data-dir=${profile}-2 x`)).toBe(false);
    expect(pattern.test(`${chrome} --user-data-dir=C:\\other`)).toBe(false);
    expect(profileCommandLinePattern(profile)).not.toContain('"');
  });

  test("lists open pages on the sign-in site only, in order and without duplicates", () => {
    expect(
      sitePages(
        [
          { type: "page", url: "about:blank" },
          { type: "page", url: "https://app.example.org/home?tid=1" },
          { type: "service_worker", url: "https://example.org/sw.js" },
          { type: "page", url: "https://other.test/" },
          { type: "page", url: "https://app.example.org/home?tid=1" },
          { type: "page", url: "https://example.org/inbox" },
        ],
        "example.org",
      ),
    ).toEqual(["https://app.example.org/home?tid=1", "https://example.org/inbox"]);
  });

  test("parses the harvest output, keeping browser-session cookies", () => {
    const out = JSON.stringify({
      cookies: {
        id: 1,
        result: {
          cookies: [
            {
              name: "sid",
              value: "s",
              domain: "example.org",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: false,
              session: true,
            },
            {
              name: "other",
              value: "o",
              domain: "other.test",
              path: "/",
              expires: -1,
              httpOnly: false,
              secure: false,
            },
          ],
        },
      },
      targets: {
        id: 2,
        result: { targetInfos: [{ type: "page", url: "https://example.org/a?tid=9" }] },
      },
    });
    const harvest = parseHarvestOutput(out, "example.org");
    expect(harvest.cookies.map((c) => [c.name, c.expires])).toEqual([["sid", -1]]);
    expect(harvest.pages).toEqual(["https://example.org/a?tid=9"]);
    expect(() =>
      parseHarvestOutput(JSON.stringify({ cookies: { error: { message: "no" } } }), "x.test"),
    ).toThrow("no cookie list: no");
  });

  test("the stop result fails loudly when a profile process survives", () => {
    expect(parseStopOutput('{"found":3,"forced":0,"remaining":[]}', "P")).toEqual({
      found: 3,
      forced: 0,
    });
    expect(parseStopOutput('{"found":0,"forced":0,"remaining":null}', "P")).toEqual({
      found: 0,
      forced: 0,
    });
    expect(() => parseStopOutput('{"found":2,"forced":2,"remaining":4242}', "P")).toThrow(
      "process 4242",
    );
  });
});
