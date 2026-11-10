import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { createStorageCatalog } from "../storage/catalog.ts";
import { closeProcessLoggers } from "../storage/logger.ts";
import { familyLogDirectory } from "../storage/segments.ts";
import { writePresenceCommit } from "./git.ts";
import { appendPresenceRelayDiagnostic, relayDaemonLogLine } from "./relay-client.ts";
import { initialReconnectState, planReconnect } from "./relay-reconnect.ts";
import {
  type HistorySource,
  type RelayLogEvent,
  relayLogPhase,
  relayStatus,
  summarizeRelayLog,
  walkRelayHistory,
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
  removeDir(base);
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

  test("reads the legacy text log the daemon writes when shared logs are off", async () => {
    process.env.HARNERY_SHARED_LOGS = "0";
    const now = new Date();
    const at = (agoSecs: number) => new Date(now.getTime() - agoSecs * 1000);
    const presence = join(root, ".harnery", "presence");
    writeFileSync(
      join(presence, "relay-daemon.json"),
      JSON.stringify({
        pid: process.pid,
        url: "ws://relay.test",
        started_at: at(900).toISOString(),
      }),
    );
    // With shared logs off the daemon's stdout is redirected to this file, so
    // its console lines (plus stray stderr text) are all the file holds.
    const drop = planReconnect(initialReconnectState(), {
      code: 1006,
      reason: "",
      wasClean: false,
      openedAt: at(600).getTime(),
      closedAt: at(500).getTime(),
    }).log;
    writeFileSync(
      join(presence, "relay-daemon.log.1"),
      `${relayDaemonLogLine(at(3600), "no live sessions; idle exit")}\n`,
    );
    writeFileSync(
      join(presence, "relay-daemon.log"),
      [
        relayDaemonLogLine(at(890), "connected room=abcd1234… as machine-local"),
        relayDaemonLogLine(at(500), String(drop?.message)),
        "some stray stderr text",
        relayDaemonLogLine(at(499), "connected room=abcd1234… as machine-local"),
        "",
      ].join("\n"),
    );
    const s = await relayStatus(root, { now });
    expect(s.log.source).toBe("legacy");
    expect(s.log.files_read).toBe(2);
    expect(s.log.last_connected?.at).toBe(at(499).toISOString());
    expect(s.log.last_disconnected).toMatchObject({
      at: at(500).toISOString(),
      event: "relay.disconnected",
      phase: "disconnected",
      fields: { code: 1006, clean: false },
    });
    expect(s.log.last_idle_exit?.at).toBe(at(3600).toISOString());
    expect(s.log.since_daemon_start).toEqual({ connects: 2, disconnects: 1 });
    expect(s.log.history_complete).toBeTrue();
    expect(s.log.truncated).toBeFalse();
  });

  test("reads sealed segments behind the active file", async () => {
    const now = new Date();
    const iso = (agoSecs: number) => new Date(now.getTime() - agoSecs * 1000).toISOString();
    writeFileSync(
      join(root, ".harnery", "presence", "relay-daemon.json"),
      JSON.stringify({ pid: process.pid, url: "ws://relay.test", started_at: iso(90_000) }),
    );
    // Active file: the drop that ended a connection lasting over a day.
    appendPresenceRelayDiagnostic(root, "relay.disconnected", {
      phase: "disconnected",
      message: "disconnected code=1001 clean=true up=25h reconnect in 1.0s",
      code: 1001,
    });
    await closeProcessLoggers();

    // A sealed segment holding that connection and the idle exit before it.
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    const family = catalog.families.find((f) => f.id === "presence-relay-log");
    if (!family) throw new Error("presence-relay-log family missing");
    const dir = familyLogDirectory(family);
    const record = (seq: number, at: string, fields: Record<string, unknown>) =>
      JSON.stringify({
        schema: "harnery.log-record/v1",
        kind: "record",
        emitted_at: at,
        family_id: family.id,
        policy_version: family.policy.policy_version,
        component_id: "presence-relay",
        level: "info",
        event: "relay.lifecycle",
        writer_id: "1-1-test",
        writer_seq: seq,
        context: {},
        fields,
      });
    const content = `${[
      record(1, iso(100_000), { message: "no live sessions; idle exit" }),
      record(2, iso(89_000), { phase: "connected", message: "connected" }),
    ].join("\n")}\n`;
    const file = "segments/00000001-00000001.jsonl.gz";
    mkdirSync(join(dir, "segments"), { recursive: true });
    writeFileSync(join(dir, file), gzipSync(Buffer.from(content)));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        schema: "harnery.log-manifest/v1",
        family_id: family.id,
        policy_version: family.policy.policy_version,
        next_sequence: 2,
        segments: [
          {
            sequence: 1,
            file,
            bytes: Buffer.byteLength(content),
            records: 2,
            first_emitted_at: iso(100_000),
            last_emitted_at: iso(89_000),
            sealed_at: iso(88_000),
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      }),
    );

    const s = await relayStatus(root, { now });
    expect(s.log.error).toBeUndefined();
    expect(s.log.files_read).toBe(2);
    expect(s.log.last_connected?.at).toBe(iso(89_000));
    expect(s.log.last_disconnected?.fields).toMatchObject({ code: 1001 });
    expect(s.log.last_idle_exit?.at).toBe(iso(100_000));
    expect(s.log.since_daemon_start).toEqual({ connects: 1, disconnects: 1 });
    expect(s.log.history_complete).toBeTrue();
    expect(s.log.oldest_record_at).toBe(iso(100_000));
  });
});

describe("walkRelayHistory", () => {
  const ev = (at: string, phase: string): RelayLogEvent => ({
    at,
    event: "relay.lifecycle",
    phase,
    message: null,
    fields: {},
  });
  const file = (events: RelayLogEvent[], bytes = 100): HistorySource => ({
    bytes,
    read: () => ({ events, bytes, truncated: false }),
  });

  test("a size cap before daemon start reports truncated, incomplete history", () => {
    const h = walkRelayHistory(
      [file([ev("2026-01-01T02:00:00Z", "connected")]), file([], 10_000)],
      { daemonStartedAt: "2026-01-01T00:00:00Z", pruned: false, maxBytes: 1_000 },
    );
    expect(h.truncated).toBeTrue();
    expect(h.history_complete).toBeFalse();
    expect(h.files_read).toBe(1);
  });

  test("a file cap counts too", () => {
    const h = walkRelayHistory([file([ev("2026-01-01T02:00:00Z", "connected")]), file([])], {
      daemonStartedAt: "2026-01-01T00:00:00Z",
      pruned: false,
      maxFiles: 1,
    });
    expect(h.truncated).toBeTrue();
    expect(h.history_complete).toBeFalse();
  });

  test("reading every file is complete unless retention pruned after the start", () => {
    const sources = [file([ev("2026-01-01T02:00:00Z", "connected")])];
    const opts = { daemonStartedAt: "2026-01-01T00:00:00Z" };
    expect(walkRelayHistory(sources, { ...opts, pruned: false }).history_complete).toBeTrue();
    expect(walkRelayHistory(sources, { ...opts, pruned: true }).history_complete).toBeFalse();
  });

  test("stops once past daemon start with every kind found", () => {
    let readOlder = false;
    const h = walkRelayHistory(
      [
        file([
          ev("2026-01-01T00:00:00Z", "error"),
          ev("2026-01-01T00:01:00Z", "superseded"),
          ev("2026-01-01T00:02:00Z", "idle_exit"),
          ev("2026-01-01T01:00:00Z", "connected"),
          ev("2026-01-01T01:30:00Z", "disconnected"),
        ]),
        {
          read: () => {
            readOlder = true;
            return { events: [], bytes: 0, truncated: false };
          },
        },
      ],
      { daemonStartedAt: "2026-01-01T00:30:00Z", pruned: true },
    );
    expect(readOlder).toBeFalse();
    expect(h.truncated).toBeFalse();
    expect(h.history_complete).toBeTrue();
  });

  test("no running daemon leaves history_complete null", () => {
    const h = walkRelayHistory([], { daemonStartedAt: null, pruned: false });
    expect(h.history_complete).toBeNull();
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
