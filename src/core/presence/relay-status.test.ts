import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeProcessLoggers } from "../storage/logger.ts";
import { writePresenceCommit } from "./git.ts";
import { appendPresenceRelayDiagnostic } from "./relay-client.ts";
import {
  type RelayLogEvent,
  relayLogPhase,
  relayStatus,
  summarizeRelayLog,
} from "./relay-status.ts";

let base: string;
let root: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HARNERY_MACHINE",
  "HARNERY_PRESENCE",
  "HARNERY_PRESENCE_RELAY",
  "HARNERY_SHARED_LOGS",
] as const;

function git(...args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  return r.stdout.trim();
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  base = mkdtempSync(join(tmpdir(), "harnery-relaystatus-"));
  root = join(base, "repo");
  spawnSync("git", ["init", root], { encoding: "utf8", windowsHide: true });
  mkdirSync(join(root, ".harnery", "presence", "remote"), { recursive: true });
  process.env.HARNERY_PRESENCE = "1";
  process.env.HARNERY_MACHINE = "machine-local";
  delete process.env.HARNERY_PRESENCE_RELAY;
  delete process.env.HARNERY_SHARED_LOGS;
});

afterEach(async () => {
  await closeProcessLoggers();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(base, { recursive: true, force: true });
});

describe("relayStatus", () => {
  test("unconfigured relay in a repo with no commits reports nothing running", async () => {
    const s = await relayStatus(root);
    expect(s.machine).toBe("machine-local");
    expect(s.relay).toEqual({ configured: false, url: null });
    expect(s.room).toEqual({ id_prefix: null, salted: false, reason: "repository has no commits" });
    expect(s.daemon).toMatchObject({ pid_record: null, pid_alive: false, running: false });
    expect(s.log.last_connected).toBeNull();
    expect(s.relay_cache).toEqual([]);
    expect(s.git_refs).toEqual([]);
    expect(s.publish_state).toBeNull();
  });

  test("assembles daemon, log, cache, refs and publish state from fixture files", async () => {
    process.env.HARNERY_PRESENCE_RELAY = "ws://relay.test";
    const now = new Date();
    const iso = (agoSecs: number) => new Date(now.getTime() - agoSecs * 1000).toISOString();

    // Room derivation needs a commit and an origin.
    const sha = writePresenceCommit(root, "seed");
    expect(sha).toBeTruthy();
    git("update-ref", "HEAD", sha as string);
    git("remote", "add", "origin", "https://example.com/acme/repo.git");

    const presence = join(root, ".harnery", "presence");
    writeFileSync(
      join(presence, "relay-daemon.json"),
      JSON.stringify({ pid: process.pid, url: "ws://relay.test", started_at: iso(600) }),
    );
    writeFileSync(
      join(presence, "publish-state.json"),
      JSON.stringify({ basis_hash: "abc", pushed_at: iso(120), agents: 2 }),
    );
    writeFileSync(
      join(presence, "remote", "machine-b.json"),
      JSON.stringify({
        v: 1,
        machine: "machine-b",
        published_at: iso(30),
        agents: [{ instance_id: "a", task: "secret task text" }, { instance_id: "b" }],
      }),
    );
    writeFileSync(join(presence, "remote", "broken.json"), "{not json");

    const refBlob = JSON.stringify({
      v: 1,
      machine: "machine-c",
      published_at: iso(3600),
      agents: [{ instance_id: "c", task: "another task" }],
    });
    const refSha = writePresenceCommit(root, refBlob);
    git("update-ref", "refs/harnery/presence/machine-c", refSha as string);

    appendPresenceRelayDiagnostic(root, "relay.lifecycle", {
      phase: "connected",
      message: "connected room=abcd1234… as machine-local",
    });
    appendPresenceRelayDiagnostic(root, "relay.disconnected", {
      phase: "disconnected",
      message: "disconnected code=1006 clean=false up=36.0s reconnect in 1.0s",
      code: 1006,
      clean: false,
      up_ms: 36_000,
      reconnect_ms: 1_000,
    });
    appendPresenceRelayDiagnostic(root, "relay.lifecycle", {
      message: "connected room=abcd1234… as machine-local",
    });
    await closeProcessLoggers();

    const s = await relayStatus(root, { now });
    expect(s.relay).toEqual({ configured: true, url: "ws://relay.test" });
    expect(s.room.id_prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(s)).not.toContain("key");
    expect(s.daemon).toMatchObject({
      pid_alive: true,
      running: true,
      url_matches_config: true,
      uptime_secs: 600,
    });
    expect(s.log.source).toBe("shared");
    expect(s.log.last_connected?.phase).toBe("connected");
    expect(s.log.last_disconnected?.fields).toMatchObject({ code: 1006, up_ms: 36_000 });
    expect(s.log.since_daemon_start).toEqual({ connects: 2, disconnects: 1 });
    expect(s.relay_cache).toEqual([
      {
        machine: "broken",
        self: false,
        published_at: null,
        age_secs: null,
        stale: true,
        agents: null,
      },
      {
        machine: "machine-b",
        self: false,
        published_at: iso(30),
        age_secs: 30,
        stale: false,
        agents: 2,
      },
    ]);
    expect(s.git_refs).toEqual([
      {
        machine: "machine-c",
        self: false,
        published_at: iso(3600),
        age_secs: 3600,
        stale: true,
        agents: 1,
      },
    ]);
    expect(JSON.stringify(s)).not.toContain("task");
    expect(s.publish_state).toEqual({ pushed_at: iso(120), age_secs: 120, agents: 2 });
  });

  test("a dead pid and a stale relay URL are reported, not hidden", async () => {
    process.env.HARNERY_PRESENCE_RELAY = "ws://relay.new";
    writeFileSync(
      join(root, ".harnery", "presence", "relay-daemon.json"),
      JSON.stringify({ pid: 999_999, url: "ws://relay.old", started_at: "2026-01-01T00:00:00Z" }),
    );
    const s = await relayStatus(root);
    expect(s.daemon).toMatchObject({
      pid_record: { pid: 999_999, url: "ws://relay.old" },
      pid_alive: false,
      running: false,
      url_matches_config: false,
      uptime_secs: null,
    });
    expect(s.log.since_daemon_start).toBeNull();
  });

  test("reads the legacy text log when shared logs are off", async () => {
    process.env.HARNERY_SHARED_LOGS = "0";
    appendPresenceRelayDiagnostic(root, "relay.lifecycle", {
      message: "no live sessions; idle exit",
    });
    const s = await relayStatus(root);
    expect(s.log.source).toBe("legacy");
    expect(s.log.last_idle_exit?.message).toBe("no live sessions; idle exit");
  });
});

describe("relay log classification", () => {
  test("older records without a phase classify by message", () => {
    expect(relayLogPhase("relay.lifecycle", { message: "connected room=x" })).toBe("connected");
    expect(relayLogPhase("relay.lifecycle", { message: "no live sessions; idle exit" })).toBe(
      "idle_exit",
    );
    expect(relayLogPhase("relay.lifecycle", { message: "pid file superseded; exiting" })).toBe(
      "superseded",
    );
    expect(relayLogPhase("relay.runtime_error", { message: "x" })).toBe("error");
    expect(relayLogPhase("relay.disconnected", { phase: "connect_failed" })).toBe("connect_failed");
  });

  test("summary picks the latest of each kind and counts only since daemon start", () => {
    const ev = (at: string, phase: string): RelayLogEvent => ({
      at,
      event: "relay.lifecycle",
      phase,
      message: null,
      fields: {},
    });
    const events = [
      ev("2026-01-01T00:00:00Z", "connected"),
      ev("2026-01-01T00:10:00Z", "idle_exit"),
      ev("2026-01-01T01:00:00Z", "connected"),
      ev("2026-01-01T01:05:00Z", "disconnected"),
      ev("2026-01-01T01:05:01Z", "connect_failed"),
      ev("2026-01-01T01:06:00Z", "connected"),
    ];
    const s = summarizeRelayLog(events, "2026-01-01T00:59:00Z");
    expect(s.last_connected?.at).toBe("2026-01-01T01:06:00Z");
    expect(s.last_disconnected?.at).toBe("2026-01-01T01:05:01Z");
    expect(s.last_idle_exit?.at).toBe("2026-01-01T00:10:00Z");
    expect(s.since_daemon_start).toEqual({ connects: 2, disconnects: 2 });
  });
});
