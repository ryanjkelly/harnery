import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { harnCliEntry } from "./cli-entry.ts";

describe("harnCliEntry", () => {
  test("is an absolute path to a file that exists on this platform", () => {
    const entry = harnCliEntry();
    expect(isAbsolute(entry)).toBe(true);
    // A URL pathname would read /C:/... on Windows, which does not exist.
    expect(entry.startsWith("/") && process.platform === "win32").toBe(false);
    expect(existsSync(entry)).toBe(true);
  });

  test("the runtime can run it directly, as detached daemons do", () => {
    const r = spawnSync(process.execPath, [harnCliEntry(), "--version"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });
});
