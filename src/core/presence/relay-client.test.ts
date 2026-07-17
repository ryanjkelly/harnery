import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelayServer } from "../../commands/relay.ts";
import { readRemoteMachines } from "./index.ts";
import { relayDaemonStatus } from "./relay-client.ts";
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
  process.env.HARNERY_PRESENCE = "1";
  process.env.HARNERY_MACHINE = "machine-local";
});

afterEach(() => {
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
    expect(remote[0]!.agents[0]!.name).toBe("Remo");
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
});
