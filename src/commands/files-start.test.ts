import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import { coordRootId } from "../lib/coord-root-id.ts";
import { DashboardRootError, verifyOrStartDashboard } from "./files.ts";
import {
  DEFAULT_VIEWER_START_TIMEOUT_SECONDS,
  ensureViewerStarted,
  type ProbeOutcome,
  readViewerStartConfig,
  ViewerStartConfigError,
  ViewerStartError,
  viewerStartPaths,
} from "./files-start.ts";

const roots: string[] = [];
const pids: number[] = [];
const savedXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (const root of roots.splice(0)) removeDir(root);
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-files-start-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = join(root, "user-config");
  mkdirSync(join(root, ".harnery"), { recursive: true });
  return root;
}

function writeConfig(root: string, files: unknown, name = "config.jsonc"): void {
  writeFileSync(join(root, ".harnery", name), `// comment\n${JSON.stringify({ files })}\n`);
}

function fakeChild(): ChildProcess & EventEmitter {
  return new EventEmitter() as ChildProcess & EventEmitter;
}

describe("readViewerStartConfig", () => {
  test("returns null when no layer names a start command", () => {
    const root = tempRoot();
    expect(readViewerStartConfig(root)).toBeNull();
    writeConfig(root, { deny_globs: [] });
    expect(readViewerStartConfig(root)).toBeNull();
  });

  test("reads the project command with the default timeout", () => {
    const root = tempRoot();
    writeConfig(root, { start_command: ["tool", "web", "up"] });
    expect(readViewerStartConfig(root)).toEqual({
      command: ["tool", "web", "up"],
      timeoutMs: DEFAULT_VIEWER_START_TIMEOUT_SECONDS * 1000,
    });
  });

  test("ignores a machine-local command but honours its timeout", () => {
    const root = tempRoot();
    writeConfig(root, { start_command: ["tool", "web", "up"], start_timeout_seconds: 30 });
    writeConfig(
      root,
      { start_command: ["other"], start_timeout_seconds: 45 },
      "config.local.jsonc",
    );
    expect(readViewerStartConfig(root)).toEqual({
      command: ["tool", "web", "up"],
      timeoutMs: 45_000,
    });
  });

  test("rejects malformed values instead of silently ignoring them", () => {
    const root = tempRoot();
    writeConfig(root, { start_command: "tool web up" });
    expect(() => readViewerStartConfig(root)).toThrow(ViewerStartConfigError);
    writeConfig(root, { start_command: ["tool"], start_timeout_seconds: 0 });
    expect(() => readViewerStartConfig(root)).toThrow(ViewerStartConfigError);
  });
});

describe("ensureViewerStarted", () => {
  test("concurrent callers spawn the start command once", async () => {
    const root = tempRoot();
    let ready = false;
    let spawns = 0;
    const probe = async (): Promise<ProbeOutcome> =>
      ready ? { kind: "ready" } : { kind: "waiting", message: "not yet" };
    const spawnImpl = () => {
      spawns += 1;
      setTimeout(() => {
        ready = true;
      }, 30);
      return fakeChild();
    };
    const config = { command: ["start-it"], timeoutMs: 5_000 };
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        ensureViewerStarted({ coordRoot: root, config, probe, spawnImpl, pollMs: 5 }),
      ),
    );
    expect(spawns).toBe(1);
    expect(results.filter((result) => result.started)).toHaveLength(1);
  });

  test("does not spawn when a peer finished starting before the lease was taken", async () => {
    const root = tempRoot();
    let spawns = 0;
    const result = await ensureViewerStarted({
      coordRoot: root,
      config: { command: ["start-it"], timeoutMs: 1_000 },
      probe: async () => ({ kind: "ready" }),
      spawnImpl: () => {
        spawns += 1;
        return fakeChild();
      },
    });
    expect(spawns).toBe(0);
    expect(result.started).toBe(false);
  });

  test("fails fast with the command and log when the start command exits nonzero", async () => {
    const root = tempRoot();
    const child = fakeChild();
    const run = ensureViewerStarted({
      coordRoot: root,
      config: { command: ["start-it", "now"], timeoutMs: 60_000 },
      probe: async () => ({ kind: "waiting", message: "not yet" }),
      spawnImpl: () => {
        setTimeout(() => child.emit("exit", 3, null), 10);
        return child;
      },
      pollMs: 5,
    });
    const error = await run.catch((caught) => caught);
    expect(error).toBeInstanceOf(ViewerStartError);
    expect(error.message).toContain("start-it now");
    expect(error.message).toContain("(3)");
    expect(error.hint).toContain(viewerStartPaths(root).log);
  });

  test("stops at the configured bound and releases the lease", async () => {
    const root = tempRoot();
    let clock = 0;
    const run = ensureViewerStarted({
      coordRoot: root,
      config: { command: ["start-it"], timeoutMs: 1_000 },
      probe: async () => ({ kind: "waiting", message: "connection refused" }),
      spawnImpl: () => fakeChild(),
      now: () => clock,
      sleep: async () => {
        clock += 400;
      },
    });
    const error = await run.catch((caught) => caught);
    expect(error).toBeInstanceOf(ViewerStartError);
    expect(error.message).toContain("within 1s");
    expect(error.message).toContain("connection refused");
    expect(existsSync(join(viewerStartPaths(root).lease, "current"))).toBe(false);
  });

  test("a fatal probe outcome is thrown as is", async () => {
    const root = tempRoot();
    const fatal = new Error("other repository");
    const error = await ensureViewerStarted({
      coordRoot: root,
      config: { command: ["start-it"], timeoutMs: 1_000 },
      probe: async () => ({ kind: "fatal", error: fatal }),
      spawnImpl: () => fakeChild(),
    }).catch((caught) => caught);
    expect(error).toBe(fatal);
  });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

describe("verifyOrStartDashboard", () => {
  test("runs the configured command and returns once the dashboard answers", async () => {
    const root = tempRoot();
    const port = await freePort();
    const script = join(root, "fake-dashboard.ts");
    const pidFile = join(root, "fake-dashboard.pid");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
const [port, rootId, pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
setTimeout(() => process.exit(0), 20_000);
await new Promise((r) => setTimeout(r, 200));
Bun.serve({ hostname: "127.0.0.1", port: Number(port), fetch: () => Response.json({ root_id: rootId }) });
`,
    );
    writeConfig(root, {
      start_command: [process.execPath, script, String(port), coordRootId(root), pidFile],
      start_timeout_seconds: 20,
    });
    const progress: string[] = [];
    await verifyOrStartDashboard(root, port, {
      start: true,
      onProgress: (message) => progress.push(message),
    });
    pids.push(Number(readFileSync(pidFile, "utf8")));
    expect(progress[0]).toContain("starting it with");
  }, 30_000);

  test("keeps today's error when no start command is configured or --no-start is given", async () => {
    const root = tempRoot();
    const port = await freePort();
    const plain = await verifyOrStartDashboard(root, port, { start: true }).catch((e) => e);
    expect(plain).toBeInstanceOf(DashboardRootError);
    expect(plain.code).toBe("dashboard_unreachable");

    writeConfig(root, { start_command: ["should-not-run"] });
    const skipped = await verifyOrStartDashboard(root, port, { start: false }).catch((e) => e);
    expect(skipped.code).toBe("dashboard_unreachable");
    expect(existsSync(viewerStartPaths(root).log)).toBe(false);
  });

  test("names the command it tried when the start fails", async () => {
    const root = tempRoot();
    const port = await freePort();
    writeConfig(root, { start_command: [process.execPath, "-e", "process.exit(4)"] });
    const error = await verifyOrStartDashboard(root, port, { start: true }).catch((e) => e);
    expect(error).toBeInstanceOf(DashboardRootError);
    expect(error.code).toBe("dashboard_unreachable");
    expect(error.message).toContain("start command failed (4)");
    expect(error.message).toContain("process.exit(4)");
  }, 30_000);
});
