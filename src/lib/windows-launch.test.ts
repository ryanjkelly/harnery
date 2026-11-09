import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec.ts";
import { npmShimScript, windowsLaunch } from "./windows-launch.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-windows-launch-"));
  roots.push(root);
  return root;
}

/** The launcher npm writes for a package bin on Windows (cmd-shim). */
function npmShim(dir: string, name: string, script: string): string {
  const launcher = join(dir, `${name}.cmd`);
  writeFileSync(
    launcher,
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
      "",
    ].join("\r\n"),
  );
  return launcher;
}

describe("windowsLaunch", () => {
  test("leaves commands unchanged off Windows", () => {
    expect(windowsLaunch("codex", ["exec"], {}, "linux")).toEqual({
      file: "codex",
      args: ["exec"],
    });
  });

  test("runs an npm .cmd launcher's script directly, keeping every argument", () => {
    const root = fixture();
    const bin = join(root, "bin");
    mkdirSync(join(bin, "node_modules", "pkg"), { recursive: true });
    const script = join(bin, "node_modules", "pkg", "cli.js");
    writeFileSync(script, "");
    npmShim(bin, "fakecli", "node_modules\\pkg\\cli.js");
    const env = { PATH: bin, PATHEXT: ".EXE;.CMD" };
    const launch = windowsLaunch("fakecli", ["-p", 'a "quoted" & prompt'], env, "win32");
    expect(launch).toMatchObject({ args: [script, "-p", 'a "quoted" & prompt'] });
  });

  test("reports a launcher it cannot read instead of spawning it", () => {
    const root = fixture();
    writeFileSync(join(root, "other.cmd"), "@echo off\r\nsomething.exe %*\r\n");
    const launch = windowsLaunch("other", [], { PATH: root, PATHEXT: ".CMD" }, "win32");
    expect(launch).toMatchObject({ error: expect.stringContaining("batch launcher") });
    expect(npmShimScript(join(root, "other.cmd"))).toBeNull();
  });

  test("an unknown or native command is spawned as given", () => {
    expect(windowsLaunch("no-such-cli", [], { PATH: fixture() }, "win32")).toEqual({
      file: "no-such-cli",
      args: [],
    });
    expect(windowsLaunch("C:\\tools\\rg.exe", ["-n"], {}, "win32")).toEqual({
      file: "C:\\tools\\rg.exe",
      args: ["-n"],
    });
  });

  // End to end through exec(): only Windows has the EINVAL this works around.
  test.skipIf(process.platform !== "win32")(
    "exec() starts an npm .cmd CLI on Windows",
    async () => {
      const root = fixture();
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, "echoargs.js"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      );
      npmShim(bin, "echoargs", "echoargs.js");
      const result = await exec(["echoargs", "-p", 'say "hi" & exit'], {
        env: { ...process.env, PATH: `${bin};${process.env.PATH ?? ""}` },
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["-p", 'say "hi" & exit']);
    },
  );
});
