import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { plantFakeCli } from "../../../tests/helpers/fake-cli.ts";
import { claudeCodeSpawner } from "./spawn-claude.ts";
import { codexSpawner } from "./spawn-codex.ts";
import { cursorSpawner } from "./spawn-cursor.ts";
import { openCodeSpawner } from "./spawn-opencode.ts";
import type { SpawnRequest, Spawner } from "./types.ts";

// Each fake harness ignores SIGTERM and starts a grandchild that also ignores
// it and keeps the output pipes open. A timed-out spawn must stop both.

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let binDir: string;
let savedPath: string | undefined;

const fakeHarness = (name: string): string =>
  [
    `import { spawn } from "node:child_process";`,
    `process.on("SIGTERM", () => {});`,
    `spawn("sh", ["-c", "trap '' TERM; echo $$ > ${join("__DIR__", `${name}.pid`)}; exec sleep 60"], { stdio: "inherit" });`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");

const ADAPTERS: [string, Spawner][] = [
  ["claude", claudeCodeSpawner],
  ["codex", codexSpawner],
  ["cursor-agent", cursorSpawner],
  ["opencode", openCodeSpawner],
];

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "spawn-pgroup-test-"));
  for (const [name] of ADAPTERS) plantFakeCli(binDir, name, fakeHarness(name).replace("__DIR__", binDir));
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${savedPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = savedPath;
  for (const [name] of ADAPTERS) {
    try {
      const pid = Number(readFileSync(join(binDir, `${name}.pid`), "utf8").trim());
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      // No pid file: the fake never started its grandchild.
    }
  }
  rmSync(binDir, { recursive: true, force: true });
});

const request: SpawnRequest = { prompt: "hi", timeoutMs: 1_000, maxTurns: 1, cwd: tmpdir() };

describe.skipIf(process.platform === "win32")("spawn adapters stop the whole process group", () => {
  test("a timed-out harness leaves no grandchild behind", async () => {
    const results = await Promise.all(ADAPTERS.map(([, spawner]) => spawner(request)));
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timed out/);
    }
    for (const [name] of ADAPTERS) {
      const pid = Number(readFileSync(join(binDir, `${name}.pid`), "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      const until = Date.now() + 3_000;
      while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(alive(pid)).toBe(false);
    }
  }, 20_000);
});
