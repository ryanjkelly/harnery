import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detachedLoginPlan, loginRelaySentence, resolveLoginMode } from "./browse.ts";

describe("detached sign-in", () => {
  const base = {
    url: "https://app.example.com/login",
    store: "/s/cookies.json",
    profile: "/s/profile",
    cookies: true,
    pace: true,
    closeFile: null,
    dir: "/s/browse",
    stamp: "2026-11-02T19-00-00-000Z",
  };

  test("runs an ordinary --login that waits on a close file, with the store and profile pinned", () => {
    const plan = detachedLoginPlan(base);
    expect(plan.closeFile).toBe(join("/s/browse", "login-2026-11-02T19-00-00-000Z.close"));
    expect(plan.logFile).toBe(join("/s/browse", "login-2026-11-02T19-00-00-000Z.log"));
    expect(plan.args).toEqual([
      "browse",
      "https://app.example.com/login",
      "--login",
      "--login-close-file",
      plan.closeFile,
      "--store",
      "/s/cookies.json",
      "--profile",
      "/s/profile",
    ]);
    expect(plan.args).not.toContain("--detach");
  });

  test("keeps a given close file and passes the user agent, --no-cookies and --no-pace through", () => {
    const plan = detachedLoginPlan({
      ...base,
      closeFile: "/x/done",
      userAgent: "native",
      cookies: false,
      pace: false,
    });
    expect(plan.closeFile).toBe("/x/done");
    expect(plan.args.slice(-4)).toEqual(["--user-agent", "native", "--no-cookies", "--no-pace"]);
  });

  test("the sentence for the person names the site and what to do", () => {
    expect(loginRelaySentence("https://app.example.com/login")).toBe(
      "A separate Chrome window is open at example.com. Sign in there, then close that window and tell me when you're done.",
    );
  });
});

describe("resolveLoginMode", () => {
  test("--login opens plain Chrome with nothing attached by default", () => {
    expect(resolveLoginMode({ login: true })).toBe("plain");
    expect(resolveLoginMode({ login: true, loginCloseFile: "/tmp/close" })).toBe("plain");
  });

  test("the automation-controlled window needs an explicit --attached", () => {
    expect(resolveLoginMode({ login: true, attached: true })).toBe("attached");
    expect(resolveLoginMode({ login: true, attached: true, controlFile: "/tmp/c.ctl" })).toBe(
      "attached",
    );
  });

  test("no --login means no sign-in window", () => {
    expect(resolveLoginMode({})).toBe("none");
  });

  test("--control-file refuses a plain sign-in instead of attaching to it", () => {
    expect(() => resolveLoginMode({ login: true, controlFile: "/tmp/c.ctl" })).toThrow(
      "--control-file requires --login --attached",
    );
    expect(() => resolveLoginMode({ controlFile: "/tmp/c.ctl" })).toThrow(
      "--control-file requires --login --attached",
    );
  });

  test("--attached and --login-close-file require --login", () => {
    expect(() => resolveLoginMode({ attached: true })).toThrow("--attached requires --login");
    expect(() => resolveLoginMode({ loginCloseFile: "/tmp/close" })).toThrow(
      "--login-close-file requires --login",
    );
  });
});
