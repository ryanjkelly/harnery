import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordLiveClaimChangeV2,
  recordLiveLifecycleChangeV2,
  recordLiveTaskChangeV2,
} from "../agents/live-authority-v2.ts";
import { ensureLiveCoordinationHeartbeat } from "../agents/state/live-coordination-view.ts";
import { initializeEventLedgerV2 } from "../events/v2/bootstrap.ts";
import { sha256V2 } from "../events/v2/canonical.ts";
import {
  recordLiveHookSignalV2,
  resolveLiveEventLedgerRouteV2,
} from "../events/v2/live-routing.ts";
import { buildPresenceBlob } from "./blob.ts";
import { PRESENCE_REF_PREFIX, parseForEachRefOutput, sanitizeRefComponent } from "./git.ts";
import { fetchPresence, publishPresence, readRemoteMachines } from "./index.ts";

/**
 * End-to-end coverage of the git-refs presence transport (ADR 0016) against
 * real git repos: a bare "origin" plus two clones standing in for two
 * machines. Machine identity is driven via HARNERY_MACHINE.
 */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function seedHeartbeat(
  root: string,
  instanceId: string,
  overrides: Record<string, unknown> = {},
): void {
  const now = new Date().toISOString();
  const route = resolveLiveEventLedgerRouteV2(root);
  if (route.state !== "v2") throw new Error("expected V2 route");
  writeFileSync(
    join(root, ".harnery", ".name-history"),
    `${JSON.stringify({ instance_id: instanceId, name: "Testa", kind: "session", ts: now })}\n`,
    { flag: "a" },
  );
  recordLiveHookSignalV2({
    coordRoot: root,
    route,
    eventName: "session-start",
    payload: { session_id: instanceId, raw: {} },
    adapter: "claude-code",
    instanceId,
  });
  ensureLiveCoordinationHeartbeat(root, instanceId, instanceId, "claude-code");
  recordLiveTaskChangeV2({
    coordRoot: root,
    owner: instanceId,
    nativeSessionId: instanceId,
    adapter: "claude-code",
    task: typeof overrides.task === "string" ? overrides.task : "testing presence",
  });
  recordLiveClaimChangeV2({
    coordRoot: root,
    owner: instanceId,
    nativeSessionId: instanceId,
    adapter: "claude-code",
    operation: "acquired",
    path: "src/a.ts",
    access: "write",
  });
  if (overrides.activity === "needs_input") {
    recordLiveHookSignalV2({
      coordRoot: root,
      route,
      eventName: "permission-request",
      payload: { session_id: instanceId, raw: { permission_type: "command" } },
      adapter: "claude-code",
      instanceId,
    });
  }
  if (overrides.task_state === "blocked") {
    recordLiveLifecycleChangeV2({
      coordRoot: root,
      owner: instanceId,
      nativeSessionId: instanceId,
      adapter: "claude-code",
      state: "blocked",
      reason:
        typeof overrides.task_state_reason === "string" ? overrides.task_state_reason : undefined,
    });
  }
  if (overrides.kind === "transient") {
    const cachePath = join(root, ".harnery", "active", `${instanceId}.json`);
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    writeFileSync(cachePath, JSON.stringify({ ...cache, kind: "transient" }));
  }
}

let base: string;
let origin: string;
let cloneA: string;
let cloneB: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "harnery-presence-"));
  origin = join(base, "origin.git");
  cloneA = join(base, "a");
  cloneB = join(base, "b");
  spawnSync("git", ["init", "--bare", origin], { encoding: "utf8" });
  spawnSync("git", ["init", cloneA], { encoding: "utf8" });
  git(cloneA, "remote", "add", "origin", origin);
  spawnSync("git", ["init", cloneB], { encoding: "utf8" });
  git(cloneB, "remote", "add", "origin", origin);
  mkdirSync(join(cloneA, ".harnery"), { recursive: true });
  mkdirSync(join(cloneB, ".harnery"), { recursive: true });
  for (const root of [cloneA, cloneB]) {
    initializeEventLedgerV2({
      coordRoot: root,
      harneryBuild: "presence-test",
      hostBuild: "host-test",
      configDigest: sha256V2("config"),
      approvalRecordId: "presence-test",
    });
  }
  savedEnv.HARNERY_MACHINE = process.env.HARNERY_MACHINE;
  savedEnv.HARNERY_PRESENCE = process.env.HARNERY_PRESENCE;
  process.env.HARNERY_PRESENCE = "1";
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

describe("sanitizeRefComponent", () => {
  test("lowercases and strips invalid chars", () => {
    expect(sanitizeRefComponent("Joe's MacBook Pro")).toBe("joe-s-macbook-pro");
    expect(sanitizeRefComponent("ryan-desktop")).toBe("ryan-desktop");
    expect(sanitizeRefComponent("..weird")).toBe("weird");
    expect(sanitizeRefComponent("")).toBe("unknown");
  });
});

describe("buildPresenceBlob", () => {
  test("includes live V2 generations and excludes transient caches", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    seedHeartbeat(cloneA, "live-1");
    seedHeartbeat(cloneA, "transient-1", { kind: "transient" });
    const { blob } = buildPresenceBlob(cloneA);
    expect(blob.machine).toBe("machine-a");
    expect(blob.agents.map((a) => a.instance_id)).toEqual(["live-1"]);
    expect(blob.agents[0]!.task).toBe("testing presence");
    expect(blob.agents[0]).toMatchObject({ activity: "idle", task_state: "active" });
  });

  test("basis hash changes on task change, not on heartbeat churn", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    seedHeartbeat(cloneA, "live-1");
    const h1 = buildPresenceBlob(cloneA).basisHash;
    // Heartbeat-only churn: same basis.
    seedHeartbeat(cloneA, "live-1", {
      last_heartbeat: new Date(Date.now() + 5000).toISOString(),
    });
    expect(buildPresenceBlob(cloneA).basisHash).toBe(h1);
    // Task change: new basis.
    seedHeartbeat(cloneA, "live-1", { task: "different focus" });
    expect(buildPresenceBlob(cloneA).basisHash).not.toBe(h1);
  });

  test("basis hash changes on activity or lifecycle changes without task churn", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    seedHeartbeat(cloneA, "live-1", {
      activity: "idle",
      task_state: "active",
    });
    const active = buildPresenceBlob(cloneA);
    expect(active.blob.agents[0]).toMatchObject({
      activity: "idle",
      task_state: "active",
    });

    seedHeartbeat(cloneA, "live-1", {
      activity: "needs_input",
      task_state: "blocked",
      task_state_reason: "waiting for approval",
    });
    const blocked = buildPresenceBlob(cloneA);
    expect(blocked.basisHash).not.toBe(active.basisHash);
    expect(blocked.blob.agents[0]).toMatchObject({
      activity: "needs_input",
      task_state: "blocked",
      task_state_reason: "waiting for approval",
    });
  });
});

describe("publish → fetch → read round-trip", () => {
  test("machine B sees machine A's sessions; self is excluded", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    seedHeartbeat(cloneA, "live-1");
    const pub = publishPresence(cloneA, { sync: true });
    expect(pub.status).toBe("published");

    // The ref landed on origin.
    const refs = git(origin, "for-each-ref", `${PRESENCE_REF_PREFIX}*`);
    expect(refs).toContain(`${PRESENCE_REF_PREFIX}machine-a`);

    // Machine B fetches and reads it.
    process.env.HARNERY_MACHINE = "machine-b";
    const f = fetchPresence(cloneB, { force: true, sync: true });
    expect(f.status).toBe("fetched");
    const remote = readRemoteMachines(cloneB);
    expect(remote).toHaveLength(1);
    expect(remote[0]!.machine).toBe("machine-a");
    expect(remote[0]!.agents[0]!.name).toBe("Testa");
    expect(remote[0]!.agents[0]!.files_touched).toEqual(["src/a.ts"]);

    // Machine A reading its own refs sees nothing (self excluded).
    process.env.HARNERY_MACHINE = "machine-a";
    expect(readRemoteMachines(cloneA)).toHaveLength(0);
  });

  test("unchanged state within keepalive is skipped; --force publishes", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    seedHeartbeat(cloneA, "live-1");
    expect(publishPresence(cloneA, { sync: true }).status).toBe("published");
    const second = publishPresence(cloneA, { sync: true });
    expect(second.status).toBe("skipped");
    expect(publishPresence(cloneA, { sync: true, force: true }).status).toBe("published");
  });

  test("no live sessions and none published before → skipped quiet", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    const r = publishPresence(cloneA, { sync: true });
    expect(r.status).toBe("skipped");
  });

  test("disabled via HARNERY_PRESENCE=0", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    process.env.HARNERY_PRESENCE = "0";
    seedHeartbeat(cloneA, "live-1");
    expect(publishPresence(cloneA, { sync: true }).status).toBe("skipped");
    expect(fetchPresence(cloneA, { sync: true }).status).toBe("skipped");
    expect(readRemoteMachines(cloneA)).toHaveLength(0);
  });

  test("fetch is throttled by the stamp; --force bypasses", () => {
    process.env.HARNERY_MACHINE = "machine-b";
    expect(fetchPresence(cloneB, { force: true, sync: true }).status).toBe("fetched");
    expect(fetchPresence(cloneB, { sync: true }).status).toBe("skipped");
  });

  test("stale remote blobs are dropped unless includeStale", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    seedHeartbeat(cloneA, "live-1");
    expect(publishPresence(cloneA, { sync: true }).status).toBe("published");
    process.env.HARNERY_MACHINE = "machine-b";
    expect(fetchPresence(cloneB, { force: true, sync: true }).status).toBe("fetched");
    // Rewrite the fetched ref with an old published_at to simulate staleness.
    const remote = readRemoteMachines(cloneB);
    expect(remote).toHaveLength(1);
    const stale = {
      v: 1,
      machine: "machine-a",
      published_at: new Date(Date.now() - 3600_000).toISOString(),
      agents: remote[0]!.agents,
    };
    const sha = git(
      cloneB,
      "commit-tree",
      git(cloneB, "mktree").trim(),
      "-m",
      JSON.stringify(stale),
    ).trim();
    git(cloneB, "update-ref", `${PRESENCE_REF_PREFIX}machine-a`, sha);
    expect(readRemoteMachines(cloneB)).toHaveLength(0);
    expect(readRemoteMachines(cloneB, { includeStale: true })).toHaveLength(1);
  });

  test("publish-state survives on disk", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    seedHeartbeat(cloneA, "live-1");
    publishPresence(cloneA, { sync: true });
    const state = JSON.parse(
      readFileSync(join(cloneA, ".harnery", "presence", "publish-state.json"), "utf8"),
    ) as { basis_hash?: string; agents?: number };
    expect(state.agents).toBe(1);
    expect(state.basis_hash).toBeTruthy();
  });
});

describe("parseForEachRefOutput", () => {
  test("parses refname/contents records (NUL-separated, SOH-terminated)", () => {
    const out =
      `${PRESENCE_REF_PREFIX}machine-a\u0000{"v":1}\n\u0001\n` +
      `${PRESENCE_REF_PREFIX}machine-b\u0000{"v":1,"x":2}\n\u0001\n`;
    const rows = parseForEachRefOutput(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.machine).toBe("machine-a");
    expect(rows[0]!.message).toBe('{"v":1}');
    expect(rows[1]!.message).toBe('{"v":1,"x":2}');
  });

  test("ignores junk", () => {
    expect(parseForEachRefOutput("")).toHaveLength(0);
    expect(parseForEachRefOutput("refs/heads/main\u0000nope")).toHaveLength(0);
  });
});
