import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { harnChildEnv, harnCommand, harneryBinPath } from "./harn-command";

const root = path.join(path.sep, "work", "project");
const embedded = path.join(root, "harnery", "bin", "harn");
const own = path.join(root, "bin", "harn");

describe("harnCommand", () => {
  test("Windows runs the .mjs twin under the current runtime", () => {
    const command = harnCommand(root, ["--version"], {
      platform: "win32",
      execPath: "C:\\node\\node.exe",
      exists: (candidate) => candidate === embedded,
    });
    expect(command).toEqual({
      command: "C:\\node\\node.exe",
      args: [`${embedded}.mjs`, "--version"],
    });
  });

  test("other platforms run the shell wrapper directly", () => {
    const command = harnCommand(root, ["decision", "review"], {
      platform: "linux",
      exists: (candidate) => candidate === embedded,
    });
    expect(command).toEqual({ command: embedded, args: ["decision", "review"] });
  });

  test("falls back to Harnery's own bin/ when the project does not embed it", () => {
    const exists = (candidate: string) => candidate === own;
    expect(harneryBinPath(root, "harn", exists)).toBe(own);
    expect(harnCommand(root, [], { platform: "darwin", exists })).toEqual({
      command: own,
      args: [],
    });
  });

  test("locates agent-coord the same way", () => {
    const helper = path.join(root, "harnery", "bin", "agent-coord");
    const command = harnCommand(root, ["council-advance", "id"], {
      executable: "agent-coord",
      platform: "win32",
      execPath: "node",
      exists: (candidate) => candidate === helper,
    });
    expect(command).toEqual({ command: "node", args: [`${helper}.mjs`, "council-advance", "id"] });
  });

  test("with no candidate on disk it names the embedded path so the spawn reports ENOENT", () => {
    expect(harneryBinPath(root, "harn", () => false)).toBeNull();
    expect(harnCommand(root, [], { platform: "linux", exists: () => false }).command).toBe(
      embedded,
    );
  });

  test("starts the real CLI on this machine", () => {
    const harneryRoot = path.resolve(import.meta.dir, "..", "..");
    const command = harnCommand(harneryRoot, ["--version"]);
    const result = spawnSync(command.command, command.args, {
      cwd: harneryRoot,
      encoding: "utf8",
      env: harnChildEnv(harneryRoot),
      timeout: 60_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  }, 60_000);
});
