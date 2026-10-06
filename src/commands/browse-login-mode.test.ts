import { describe, expect, test } from "bun:test";
import { resolveLoginMode } from "./browse.ts";

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
