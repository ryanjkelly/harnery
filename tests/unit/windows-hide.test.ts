import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanWindowsHide, scanWindowsHideSource } from "../../scripts/check-windows-hide.ts";

// On Windows, a background process with no console that starts a console
// program without `windowsHide: true` opens a new terminal window per child.
// This test is the CI backstop that keeps every child process in src/ hidden;
// the same scan runs standalone via `bun run check:windows-hide`.
describe("windowsHide guard", () => {
  test("every child process call in src/ passes windowsHide or carries a waiver", () => {
    const violations = scanWindowsHide(join(import.meta.dir, "..", ".."));
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line} (${v.call})`).join("\n");
      throw new Error(
        `${violations.length} child process call(s) without windowsHide:\n${report}\n` +
          "Add `windowsHide: true` to the options, or `// windows-hide-allow: <reason>` " +
          "on the line above when the window is meant to be seen.",
      );
    }
    expect(violations).toEqual([]);
  });

  const scan = (source: string) =>
    scanWindowsHideSource("fixture.ts", source).map((v) => `${v.line}:${v.call}`);

  test("flags calls whose options omit windowsHide, including calls with no options", () => {
    const source = [
      'import { spawn, spawnSync, execFileSync } from "node:child_process";',
      'spawnSync("git", ["status"], { encoding: "utf8" });',
      'spawn("git", ["fetch"]);',
      "execFileSync(",
      '  "git",',
      '  ["log"],',
      '  { encoding: "utf8" },',
      ");",
    ].join("\n");
    expect(scan(source)).toEqual(["2:spawnSync", "3:spawn", "4:execFileSync"]);
  });

  test("accepts windowsHide anywhere in a multi-line options object", () => {
    const source = [
      'import { spawnSync } from "node:child_process";',
      "spawnSync(",
      '  "git",',
      '  ["status", ")"],',
      "  {",
      '    encoding: "utf8",',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text
      "    env: { ...process.env, A: `${fn(1)}` },",
      "    windowsHide: true,",
      "  },",
      ");",
    ].join("\n");
    expect(scan(source)).toEqual([]);
  });

  test("an options object passed by name counts as missing", () => {
    const source = [
      'import { spawnSync } from "node:child_process";',
      "const opts = { windowsHide: true };",
      'spawnSync("git", [], opts);',
      'spawnSync("git", [], { ...opts, windowsHide: true });',
    ].join("\n");
    expect(scan(source)).toEqual(["3:spawnSync"]);
  });

  test("a waiver with a reason on the call line or the line above suppresses the finding", () => {
    const source = [
      'import { spawn } from "node:child_process";',
      "// windows-hide-allow: the person signs in to this window",
      'spawn("chrome", [url]);',
      'spawn("code", [file]); // windows-hide-allow: opens the editor the user asked for',
      "// windows-hide-allow:",
      'spawn("notepad", [file]);',
    ].join("\n");
    expect(scan(source)).toEqual(["6:spawn"]);
  });

  test("resolves aliased, namespace, require, promisify and injected bindings", () => {
    const source = [
      'import * as cp from "node:child_process";',
      'import run, { execFile, spawn as start } from "child_process";',
      'const { spawnSync: sync } = require("node:child_process");',
      "const execFileAsync = promisify(execFile);",
      "function probe(runner: typeof sync = sync) {",
      '  return runner("bun", ["--version"], { stdio: "ignore" });',
      "}",
      'cp.spawnSync("git", []);',
      'run.exec("ls");',
      'start("git", []);',
      'sync("git", []);',
      'execFileAsync("git", []);',
    ].join("\n");
    expect(scan(source)).toEqual([
      "6:runner",
      "8:cp.spawnSync",
      "9:run.exec",
      "10:start",
      "11:sync",
      "12:execFileAsync",
    ]);
  });

  test("checks Bun.spawn and Bun.spawnSync without any import", () => {
    const source = [
      'Bun.spawn(["git", "status"], { stdout: "pipe" });',
      'Bun.spawnSync(["git", "status"], { windowsHide: true });',
    ].join("\n");
    expect(scan(source)).toEqual(["1:Bun.spawn"]);
  });

  test("ignores comments, strings, regexes, other objects' methods and type-only imports", () => {
    const source = [
      'import type { SpawnOptions } from "node:child_process";',
      'import { spawnSync } from "node:child_process";',
      '// spawnSync("git", []);',
      '/* spawnSync("git", []); */',
      'const help = "run spawnSync(git) by hand";',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text
      "const tpl = `spawnSync(${name})`;",
      "const pattern = /spawnSync\\(['\"]/;",
      'adapter.spawnSync("git", []);',
      'const match = /(\\w+)/.exec("text");',
      "function spawnSyncLike() {}",
    ].join("\n");
    expect(scan(source)).toEqual([]);
  });

  test("a file that does not import child_process may define its own exec", () => {
    const source = [
      'import { exec } from "../lib/exec.ts";',
      'await exec(["git", "status"]);',
    ].join("\n");
    expect(scan(source)).toEqual([]);
  });
});
