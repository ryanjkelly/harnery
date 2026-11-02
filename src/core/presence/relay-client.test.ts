import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelayServer } from "../../commands/relay.ts";
import { closeProcessLoggers } from "../storage/logger.ts";
import { readRemoteMachines } from "./index.ts";
import {
  appendPresenceRelayDiagnostic,
  awaitPreviousRelayExit,
  ensureRelayDaemon,
  RELAY_LAUNCH_RESERVATION_MS,
  relayDaemonStatus,
  relayTickDecision,
  releaseRelayLaunchReservation,
  reserveRelayLaunch,
} from "./relay-client.ts";
import { computeSenderId, deriveRoomCredentials, encryptPayload } from "./relay-protocol.ts";

/**
 * Relay client-side coverage without spawning the real daemon process:
 *   - the Bun relay host round-trips frames (warm join + live fan-out)
 *   - relay-cache files merge into readRemoteMachines, freshest source wins
 *   - relayDaemonStatus reflects the pid file's liveness
 */

let base: string;
let root: string;
const savedEnv: Record<string, string | undefined> = {};

function gitInit(dir: string): void {
  spawnSync("git", ["init", dir], { encoding: "utf8" });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "harnery-relayclient-"));
  root = join(base, "repo");
  gitInit(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  savedEnv.HARNERY_MACHINE = process.env.HARNERY_MACHINE;
  savedEnv.HARNERY_PRESENCE = process.env.HARNERY_PRESENCE;
  savedEnv.HARNERY_SHARED_LOGS = process.env.HARNERY_SHARED_LOGS;
  process.env.HARNERY_PRESENCE = "1";
  process.env.HARNERY_MACHINE = "machine-local";
});

afterEach(async () => {
  await closeProcessLoggers();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

describe("startRelayServer (Bun host)", () => {
  test("warm-join replay + live fan-out, same semantics as the worker", async () => {
    const server = startRelayServer(0);
    try {
      const creds = await deriveRoomCredentials({
        rootCommitSha: "0123456789abcdef0123456789abcdef01234567",
        originUrl: "https://example.com/it/repo.git",
        salt: `it-${Math.random()}`,
      });
      const url = `ws://127.0.0.1:${server.port}/v1/room/${creds.roomId}`;
      const senderA = await computeSenderId(creds, "machine-a");

      const a = new WebSocket(url);
      await new Promise((res, rej) => {
        a.onopen = res;
        a.onerror = rej;
      });
      const enc = await encryptPayload(creds, '{"v":1,"machine":"machine-a","agents":[]}');
      a.send(JSON.stringify({ t: "pub", sender: senderA, ...enc }));
      await new Promise((r) => setTimeout(r, 100));

      const received: string[] = [];
      const b = new WebSocket(url);
      b.onmessage = (ev) => received.push(String(ev.data));
      await new Promise((res, rej) => {
        b.onopen = res;
        b.onerror = rej;
      });
      await new Promise((r) => setTimeout(r, 150));

      // Warm join: cached pub + hello.
      expect(received.some((m) => m.includes('"t":"pub"'))).toBe(true);
      expect(received.some((m) => m.includes('"t":"hello"'))).toBe(true);

      // Live fan-out.
      const before = received.length;
      const enc2 = await encryptPayload(creds, '{"v":1,"machine":"machine-a","agents":[],"n":2}');
      a.send(JSON.stringify({ t: "pub", sender: senderA, ...enc2 }));
      await new Promise((r) => setTimeout(r, 150));
      expect(received.length).toBe(before + 1);

      a.close();
      b.close();
    } finally {
      server.stop();
    }
  });

  test("rejects bad room ids and non-websocket requests", async () => {
    const server = startRelayServer(0);
    try {
      const bad = await fetch(`http://127.0.0.1:${server.port}/v1/room/not-a-room`);
      expect(bad.status).toBe(404);
      const noUpgrade = await fetch(`http://127.0.0.1:${server.port}/v1/room/${"a".repeat(32)}`);
      expect(noUpgrade.status).toBe(426);
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect((await health.json()).ok).toBe(true);
    } finally {
      server.stop();
    }
  });
});

describe("relay cache merge into readRemoteMachines", () => {
  test("cache files surface as remote machines", () => {
    const dir = join(root, ".harnery", "presence", "remote");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "machine-b.json"),
      JSON.stringify({
        v: 1,
        machine: "machine-b",
        published_at: new Date().toISOString(),
        agents: [{ instance_id: "x1", name: "Remo", task: "relay test" }],
      }),
    );
    const remote = readRemoteMachines(root);
    expect(remote).toHaveLength(1);
    expect(remote[0]!.machine).toBe("machine-b");
    expect(remote[0]!.agents[0]).toMatchObject({
      name: "Remo",
      activity: "unknown",
      task_state: "active",
    });
  });

  test("freshest source per machine wins (relay cache newer than nothing else)", () => {
    const dir = join(root, ".harnery", "presence", "remote");
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 3600_000).toISOString();
    writeFileSync(
      join(dir, "machine-b.json"),
      JSON.stringify({
        v: 1,
        machine: "machine-b",
        published_at: old,
        agents: [{ instance_id: "x" }],
      }),
    );
    // Stale (>15 min) → dropped by default, visible with includeStale.
    expect(readRemoteMachines(root)).toHaveLength(0);
    expect(readRemoteMachines(root, { includeStale: true })).toHaveLength(1);
  });

  test("self machine's cache file is excluded", () => {
    const dir = join(root, ".harnery", "presence", "remote");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "machine-local.json"),
      JSON.stringify({
        v: 1,
        machine: "machine-local",
        published_at: new Date().toISOString(),
        agents: [{ instance_id: "self" }],
      }),
    );
    expect(readRemoteMachines(root)).toHaveLength(0);
  });
});

describe("relayDaemonStatus", () => {
  test("not running without a pid file; live pid reports running", () => {
    expect(relayDaemonStatus(root).running).toBe(false);
    const pidPath = join(root, ".harnery", "presence", "relay-daemon.json");
    mkdirSync(join(root, ".harnery", "presence"), { recursive: true });
    // Our own live pid stands in for a daemon.
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: process.pid, url: "ws://x", started_at: new Date().toISOString() }),
    );
    expect(relayDaemonStatus(root)).toMatchObject({ running: true, pid: process.pid });
    // A dead pid reads as not running.
    writeFileSync(
      pidPath,
      JSON.stringify({ pid: 999999, url: "ws://x", started_at: new Date().toISOString() }),
    );
    expect(relayDaemonStatus(root).running).toBe(false);
  });

  test("writes one shared diagnostic path by default and one legacy path on rollback", async () => {
    delete process.env.HARNERY_SHARED_LOGS;
    expect(appendPresenceRelayDiagnostic(root, "relay.lifecycle", { message: "connected" })).toBe(
      "shared",
    );
    await closeProcessLoggers();
    const sharedPath = join(root, ".harnery", "logs", "presence-relay", "active.jsonl");
    const sharedLog = readFileSync(sharedPath, "utf8");
    expect(sharedLog).toContain('"event":"relay.lifecycle"');
    expect(sharedLog.endsWith("\n")).toBeTrue();
    expect(existsSync(join(root, ".harnery", "presence", "relay-daemon.log"))).toBeFalse();

    const rollbackRoot = join(base, "rollback-repo");
    mkdirSync(rollbackRoot, { recursive: true });
    process.env.HARNERY_SHARED_LOGS = "0";
    expect(
      appendPresenceRelayDiagnostic(rollbackRoot, "relay.lifecycle", { message: "connected" }),
    ).toBe("legacy");
    expect(
      readFileSync(join(rollbackRoot, ".harnery", "presence", "relay-daemon.log"), "utf8"),
    ).toContain('"event":"relay.lifecycle"');
    expect(
      existsSync(join(rollbackRoot, ".harnery", "logs", "presence-relay", "active.jsonl")),
    ).toBeFalse();
  });
});

describe("relay daemon code changes", () => {
  const current = { id: "1.0.0@new", root: "/pkg" };

  function writePid(record: Record<string, unknown>): void {
    mkdirSync(join(root, ".harnery", "presence"), { recursive: true });
    writeFileSync(join(root, ".harnery", "presence", "relay-daemon.json"), JSON.stringify(record));
  }

  function ensure(options: { nowMs?: number; launchOk?: boolean } = {}): {
    result: string;
    launches: number;
  } {
    let launches = 0;
    const result = ensureRelayDaemon(root, {
      relayUrl: () => "ws://relay.test",
      isAlive: (pid) => pid === process.pid,
      currentCode: () => current,
      launch: () => {
        launches += 1;
        return options.launchOk ?? true;
      },
      ...(options.nowMs !== undefined ? { nowMs: () => options.nowMs as number } : {}),
    });
    return { result, launches };
  }

  const reservationPath = () => join(root, ".harnery", "presence", "relay-launch.json");

  const pidRecord = () => ({
    pid: process.pid,
    url: "ws://relay.test",
    started_at: new Date().toISOString(),
  });

  test("ensure replaces a live daemon that runs older code and leaves a current one", () => {
    writePid({ ...pidRecord(), code: { id: "1.0.0@old", root: "/pkg" } });
    expect(ensure()).toEqual({ result: "replaced", launches: 1 });
    // The new daemon releases the reservation once it owns the pid file.
    releaseRelayLaunchReservation(root);
    // A daemon from before identity recording is replaced once.
    writePid(pidRecord());
    expect(ensure()).toEqual({ result: "replaced", launches: 1 });
    releaseRelayLaunchReservation(root);
    writePid({ ...pidRecord(), code: current });
    expect(ensure()).toEqual({ result: "running", launches: 0 });
    // An unknown recorded identity or another installation never restarts.
    writePid({ ...pidRecord(), code: { id: null, root: "/pkg" } });
    expect(ensure()).toEqual({ result: "running", launches: 0 });
    writePid({ ...pidRecord(), code: { id: "1.0.0@old", root: "/elsewhere" } });
    expect(ensure()).toEqual({ result: "running", launches: 0 });
    // A dead daemon is simply started.
    writePid({ ...pidRecord(), pid: 999_999, code: current });
    expect(ensure()).toEqual({ result: "started", launches: 1 });
  });

  test("concurrent launchers start one replacement between them (F5)", () => {
    writePid({ ...pidRecord(), code: { id: "1.0.0@old", root: "/pkg" } });
    const nowMs = Date.now();
    expect(ensure({ nowMs })).toEqual({ result: "replaced", launches: 1 });
    // A second hook before the new daemon takes the pid file launches nothing.
    expect(ensure({ nowMs: nowMs + 1_000 })).toEqual({ result: "pending", launches: 0 });
    expect(existsSync(reservationPath())).toBe(true);
    // A reservation whose launch died is taken over once it expires.
    expect(ensure({ nowMs: nowMs + RELAY_LAUNCH_RESERVATION_MS + 1 })).toEqual({
      result: "replaced",
      launches: 1,
    });
    // A failed launch gives the reservation back at once.
    releaseRelayLaunchReservation(root);
    expect(ensure({ launchOk: false })).toEqual({ result: "unavailable", launches: 1 });
    expect(existsSync(reservationPath())).toBe(false);
    expect(reserveRelayLaunch(root)).toBe(true);
    expect(reserveRelayLaunch(root)).toBe(false);
  });

  test("a replacement waits for the daemon it replaces to exit before connecting (F5)", async () => {
    let alive = true;
    let waits = 0;
    const released = await awaitPreviousRelayExit({
      previousPid: 4242,
      stillOwner: () => true,
      isAlive: () => alive,
      wait: async () => {
        waits += 1;
        if (waits === 3) alive = false;
      },
    });
    expect(released).toBe(true);
    expect(waits).toBe(3);

    // A successor of its own ends the wait without connecting.
    expect(
      await awaitPreviousRelayExit({
        previousPid: 4242,
        stillOwner: () => false,
        isAlive: () => true,
        wait: async () => {},
      }),
    ).toBe(false);

    // A previous daemon that never exits is waited on only until the deadline.
    let nowMs = 0;
    expect(
      await awaitPreviousRelayExit({
        previousPid: 4242,
        stillOwner: () => true,
        isAlive: () => true,
        wait: async (ms) => {
          nowMs += ms;
        },
        nowMs: () => nowMs,
        timeoutMs: 1_000,
      }),
    ).toBe(false);
    expect(nowMs).toBeGreaterThanOrEqual(1_000);
  });

  test("the lifecycle tick exits on a confirmed code change unless superseded", () => {
    const record = { ...pidRecord(), code: { id: "1.0.0@old", root: "/pkg" } };
    const change = { from: "1.0.0@old", to: "1.0.0@new" };
    const nowMs = Date.now();
    expect(
      relayTickDecision({ record, pid: process.pid, codeChange: null, idleSince: null, nowMs }),
    ).toBe("continue");
    expect(
      relayTickDecision({ record, pid: process.pid, codeChange: change, idleSince: null, nowMs }),
    ).toBe("code_changed");
    expect(
      relayTickDecision({
        record,
        pid: process.pid + 1,
        codeChange: change,
        idleSince: null,
        nowMs,
      }),
    ).toBe("superseded");
    expect(
      relayTickDecision({
        record: null,
        pid: process.pid,
        codeChange: null,
        idleSince: null,
        nowMs,
      }),
    ).toBe("superseded");
    expect(
      relayTickDecision({
        record,
        pid: process.pid,
        codeChange: null,
        idleSince: nowMs - 10 * 60_000,
        nowMs,
      }),
    ).toBe("idle_exit");
  });
});
