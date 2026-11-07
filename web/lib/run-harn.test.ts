import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetCoordRootCache } from "./coord-reader";
import { harnChildEnv, runHarn } from "./run-harn";

describe("harnChildEnv", () => {
  test("pins the project and drops the dashboard's NODE_OPTIONS preload", () => {
    const env = harnChildEnv("/work/project", {
      NODE_OPTIONS: "--import=./server-preload.mjs",
      PATH: "/usr/bin",
    } as unknown as NodeJS.ProcessEnv);
    expect(env.HARNERY_COORD_ROOT_OVERRIDE).toBe("/work/project");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe.skipIf(process.platform === "win32")("runHarn", () => {
  let root = "";
  let previousRoot: string | undefined;
  const script = (name: string, body: string) => {
    const file = path.join(root, "bin", name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };

  beforeEach(() => {
    previousRoot = process.env.HARNERY_COORD_ROOT;
    root = mkdtempSync(path.join(tmpdir(), "run-harn-"));
    mkdirSync(path.join(root, ".harnery"));
    mkdirSync(path.join(root, "bin"));
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
    else process.env.HARNERY_COORD_ROOT = previousRoot;
    __resetCoordRootCache();
    rmSync(root, { recursive: true, force: true });
  });

  test("passes argv and stdin through and picks the executable", async () => {
    script("harn", 'echo "harn:$*"; cat');
    script("agent-coord", 'echo "coord:$*" >&2; exit 3');
    const harn = await runHarn(["a", "--b"], { stdin: "secret" });
    expect(harn).toEqual({
      ok: true,
      stdout: "harn:a --b\nsecret",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    const coord = await runHarn(["x"], { executable: "agent-coord" });
    expect(coord.ok).toBe(false);
    expect(coord.exitCode).toBe(3);
    expect(coord.stderr).toBe("coord:x\n");
  });

  test("kills a child that outlives its timeout", async () => {
    script("harn", "exec sleep 5");
    const result = await runHarn(["slow"], { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("harn slow did not finish");
  });

  test("a child that exits without reading stdin does not crash the caller", async () => {
    script("harn", "exit 0");
    const result = await runHarn(["x"], { stdin: "x".repeat(4 * 1024 * 1024) });
    expect(result.exitCode).toBe(0);
  });

  test("a missing executable resolves as a failure", async () => {
    const result = await runHarn(["x"]);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
  });
});
