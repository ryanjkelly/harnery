import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelayServer } from "../../commands/relay.ts";
import { acquireInstanceLock, instanceLockEndpoint } from "../single-instance.ts";
import { closeProcessLoggers } from "../storage/logger.ts";
import { readRemoteMachines } from "./index.ts";
import {
  appendPresenceRelayDiagnostic,
  closeRelaySocket,
  ensureRelayDaemon,
  RELAY_LAUNCH_RESERVATION_MS,
  readRelayLockState,
  relayDaemonStatus,
  relayInstanceLockEndpoint,
  relayStartupGate,
  relayTickDecision,
  releaseRelayLaunchReservation,
  reserveRelayLaunch,
} from "./relay-client.ts";
import { computeSenderId, deriveRoomCredentials, encryptPayload } from "./relay-protocol.ts";
import { relayStatus } from "./relay-status.ts";

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
  // Stands in for the launched daemon releasing the reservation it inherited.
  const clearReservation = () => rmSync(reservationPath(), { force: true });

  const pidRecord = () => ({
    pid: process.pid,
    url: "ws://relay.test",
    started_at: new Date().toISOString(),
  });

  test("ensure replaces a live daemon that runs older code and leaves a current one", () => {
    writePid({ ...pidRecord(), code: { id: "1.0.0@old", root: "/pkg" } });
    expect(ensure()).toEqual({ result: "replaced", launches: 1 });
    // The new daemon releases the reservation once it owns the pid file.
    clearReservation();
    // A live daemon from before identity recording is left running.
    writePid(pidRecord());
    expect(ensure()).toEqual({ result: "running", launches: 0 });
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
    clearReservation();
    expect(ensure({ launchOk: false })).toEqual({ result: "unavailable", launches: 1 });
    expect(existsSync(reservationPath())).toBe(false);
    expect(reserveRelayLaunch(root)).toBeTruthy();
    expect(reserveRelayLaunch(root)).toBeNull();
    // An expired reservation is simply overwritten; only its token releases it.
    const late = reserveRelayLaunch(root, Date.now() + RELAY_LAUNCH_RESERVATION_MS + 1);
    expect(late).toBeTruthy();
    releaseRelayLaunchReservation(root, "someone-else");
    expect(existsSync(reservationPath())).toBe(true);
    releaseRelayLaunchReservation(root, late ?? undefined);
    expect(existsSync(reservationPath())).toBe(false);
  });

  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const holdLock = async () => {
    const result = await acquireInstanceLock(relayInstanceLockEndpoint(root));
    if (result.status !== "acquired") throw new Error(`lock not acquired: ${result.status}`);
    return result.lock;
  };
  const pidPath = () => join(root, ".harnery", "presence", "relay-daemon.json");
  const daemon = (pid: number, code = current) => ({ ...pidRecord(), pid, code });

  test("exactly one of several concurrent daemons connects (F4)", async () => {
    // Every daemon opens its socket only after the gate says connect, so the
    // gate outcome is the connection count.
    const live = new Set([7001, 7002, 7003]);
    const logs: string[] = [];
    const outcomes = await Promise.all(
      [7001, 7002, 7003].map((pid) =>
        relayStartupGate(root, daemon(pid), {
          isAlive: (p) => live.has(p),
          wait: () => sleep(5),
          timeoutMs: 300,
          log: (phase) => logs.push(phase),
        }),
      ),
    );
    const connected = outcomes.filter((outcome) => outcome.outcome === "connect");
    expect(connected).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === "duplicate")).toHaveLength(2);
    // A duplicate exits with one log line each.
    expect(logs).toEqual(["duplicate", "duplicate"]);
    await connected[0]?.lock?.close();
  });

  test("the F4 interleaving cannot produce two connections", async () => {
    // O holds the lock and runs older code. B and C are both launched (the
    // reservation was lost) and both read O as the owner before either writes.
    const owner = await holdLock();
    writePid(daemon(4242, { id: "1.0.0@old", root: "/pkg" }));
    const live = new Set([4242, 5001, 5002]);
    const gate = (pid: number) =>
      relayStartupGate(root, daemon(pid), {
        isAlive: (p) => live.has(p),
        wait: () => sleep(10),
        timeoutMs: 3_000,
        log: () => {},
      });
    const b = gate(5001);
    const c = gate(5002);
    await sleep(100);
    // Nobody connects while O still holds the lock.
    expect(JSON.parse(readFileSync(pidPath(), "utf8")).state).toBe("handover");
    live.delete(4242);
    await owner?.close();
    const outcomes = await Promise.all([b, c]);
    const connected = outcomes.filter((outcome) => outcome.outcome === "connect");
    expect(connected).toHaveLength(1);
    await connected[0]?.lock?.close();
  });

  test("a successor that cannot get the lock in time gives the pid file back (F8)", async () => {
    const owner = await holdLock();
    const previous = daemon(4242, { id: "1.0.0@old", root: "/pkg" });
    writePid(previous);
    const token = reserveRelayLaunch(root) ?? undefined;
    let nowMs = 0;
    const phases: string[] = [];
    const startup = await relayStartupGate(root, daemon(5001), {
      isAlive: (p) => p === 4242 || p === 5001,
      wait: async (ms) => {
        nowMs += ms;
      },
      nowMs: () => nowMs,
      timeoutMs: 1_000,
      reservationToken: token,
      log: (phase) => phases.push(phase),
    });
    expect(startup.outcome).toBe("gave_up");
    expect(startup.lock).toBeUndefined();
    expect(JSON.parse(readFileSync(pidPath(), "utf8")).pid).toBe(4242);
    expect(existsSync(reservationPath())).toBe(false);
    expect(phases).toEqual(["handover_timeout"]);
    await owner?.close();
  });

  test("a successor that crashed while waiting on a pre-lock owner passes that owner on (F1)", async () => {
    // O predates the lock: it holds none, so B gets the lock at once and must
    // wait for O's pid, recording O as the original owner.
    const freeLock = async () => ({
      status: "acquired" as const,
      lock: { endpoint: relayInstanceLockEndpoint(root), nonce: "n", close: async () => {} },
    });
    writePid({ ...pidRecord(), pid: 4242 });
    // B crashes during its first wait, leaving its handover record behind.
    await expect(
      relayStartupGate(root, daemon(5001), {
        isAlive: (p) => p === 4242 || p === 5001,
        wait: async () => {
          throw new Error("B crashed");
        },
        log: () => {},
        acquire: freeLock,
      }),
    ).rejects.toThrow("B crashed");
    const bRecord = JSON.parse(readFileSync(pidPath(), "utf8"));
    expect(bRecord).toMatchObject({ pid: 5001, state: "handover", original: { pid: 4242 } });

    // C finds B dead and O alive: it must wait for O, recording O in turn,
    // and connect only after O exits.
    const seen: unknown[] = [];
    let cWaits = 0;
    const c = await relayStartupGate(root, daemon(5002), {
      isAlive: (p) => p === 5002 || (p === 4242 && cWaits < 3),
      wait: async () => {
        cWaits += 1;
        seen.push(JSON.parse(readFileSync(pidPath(), "utf8")).original?.pid);
      },
      log: () => {},
      acquire: freeLock,
    });
    expect(c.outcome).toBe("connect");
    expect(cWaits).toBe(3);
    expect(seen).toEqual([4242, 4242, 4242]);
    expect(JSON.parse(readFileSync(pidPath(), "utf8")).state).toBe("connected");
  });

  test("a foreign program on the lock port stops the relay from connecting and shows in status", async () => {
    // The real loopback TCP lock, as on Linux and macOS.
    const endpoint = instanceLockEndpoint("relay", root, "linux");
    if (endpoint.kind !== "tcp") throw new Error("expected a tcp endpoint");
    const foreign = createServer((socket) => socket.end("SSH-2.0-something\r\n"));
    await new Promise<void>((done) =>
      foreign.listen({ host: "127.0.0.1", port: endpoint.port }, done),
    );
    try {
      writePid(daemon(4242, { id: "1.0.0@old", root: "/pkg" }));
      const token = reserveRelayLaunch(root) ?? undefined;
      const phases: string[] = [];
      const startup = await relayStartupGate(root, daemon(5001), {
        isAlive: (p) => p === 5001,
        lockEndpoint: endpoint,
        reservationToken: token,
        log: (phase) => phases.push(phase),
      });
      expect(startup.outcome).toBe("unavailable");
      expect(startup.lock).toBeUndefined();
      // Logged once; the pid file was not taken; the reservation is free for
      // the next launcher call to retry.
      expect(phases).toEqual(["lock_unavailable"]);
      expect(JSON.parse(readFileSync(pidPath(), "utf8")).pid).toBe(4242);
      expect(existsSync(reservationPath())).toBe(false);
      expect(readRelayLockState(root)).toMatchObject({
        state: "unavailable",
        reason: "port_in_use_by_other_program",
        port: endpoint.port,
      });
      const status = await relayStatus(root);
      expect(status.lock).toMatchObject({
        state: "unavailable",
        reason: "port_in_use_by_other_program",
        port: endpoint.port,
      });
    } finally {
      await new Promise((done) => foreign.close(done));
    }
    // Once the port is free, a daemon takes the lock and clears the report.
    const startup = await relayStartupGate(root, daemon(5002), {
      isAlive: (p) => p === 5002,
      lockEndpoint: endpoint,
      log: () => {},
    });
    expect(startup.outcome).toBe("connect");
    expect(readRelayLockState(root)).toBeNull();
    await startup.lock?.close();
  });

  test("an exiting daemon keeps the lock until its relay socket has closed (F4)", async () => {
    const lock = await holdLock();
    let onClose: () => void = () => {};
    let closeCalls = 0;
    const socket = {
      readyState: 1,
      close: () => {
        closeCalls += 1;
      },
      addEventListener: (_type: "close", listener: () => void) => {
        onClose = listener;
      },
    };
    let closed = false;
    const shutdown = closeRelaySocket(socket, "idle", 5_000).then(() => {
      closed = true;
    });
    await sleep(20);
    expect(closeCalls).toBe(1);
    expect(closed).toBe(false);
    // Still held while the socket is closing.
    expect((await acquireInstanceLock(relayInstanceLockEndpoint(root))).status).toBe("busy");
    onClose();
    await shutdown;
    expect(closed).toBe(true);
    // Shutdown never releases the lock itself; process exit does.
    expect((await acquireInstanceLock(relayInstanceLockEndpoint(root))).status).toBe("busy");
    await lock?.close();
    // A socket that never reports closing is waited for only until the bound.
    const silent = { ...socket, addEventListener: () => {} };
    const started = Date.now();
    await closeRelaySocket(silent, "idle", 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    await closeRelaySocket(null, "idle");
  });

  test("a current daemon holding the lock is never superseded by a duplicate", async () => {
    const owner = await holdLock();
    writePid(daemon(4242));
    const startup = await relayStartupGate(root, daemon(5001), {
      isAlive: (p) => p === 4242 || p === 5001,
      log: () => {},
    });
    expect(startup.outcome).toBe("duplicate");
    expect(JSON.parse(readFileSync(pidPath(), "utf8")).pid).toBe(4242);
    await owner?.close();
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
