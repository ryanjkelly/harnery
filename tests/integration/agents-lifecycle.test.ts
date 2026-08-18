import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordLiveClaimChangeV2,
  recordLiveTaskChangeV2,
} from "../../src/core/agents/live-authority-v2.ts";
import { ensureLiveCoordinationHeartbeat } from "../../src/core/agents/state/live-coordination-view.ts";
import { initializeEventLedgerV2 } from "../../src/core/events/v2/bootstrap.ts";
import { sha256V2 } from "../../src/core/events/v2/canonical.ts";
import {
  recordLiveHookSignalV2,
  resolveLiveEventLedgerRouteV2,
} from "../../src/core/events/v2/live-routing.ts";
import { readActiveLedgerV2 } from "../../src/core/events/v2/reader.ts";

const HARNERY_DIR = path.resolve(import.meta.dir, "../..");
const HARN = path.join(HARNERY_DIR, "bin", "harn");
const OWNER = "45f21628-043a-463d-a394-4128789f2276";
const sandboxes: string[] = [];

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function makeSandbox(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-lifecycle-"));
  sandboxes.push(root);
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(["add", "seed.txt"]);
  git(["commit", "-qm", "seed"]);
  initializeEventLedgerV2({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V2("config"),
    approvalRecordId: "test-agents-lifecycle",
  });
  writeFileSync(
    path.join(root, ".harnery", ".name-history"),
    `${JSON.stringify({ instance_id: OWNER, name: "Hollis", kind: "session", ts: new Date().toISOString() })}\n`,
  );
  const route = resolveLiveEventLedgerRouteV2(root);
  if (route.state !== "v2") throw new Error("expected V2 route");
  recordLiveHookSignalV2({
    coordRoot: root,
    route,
    eventName: "session-start",
    payload: { session_id: OWNER, raw: {}, model: "gpt-5.6" },
    adapter: "codex",
    instanceId: OWNER,
  });
  ensureLiveCoordinationHeartbeat(root, OWNER, OWNER, "codex", "gpt-5.6");
  recordLiveTaskChangeV2({
    coordRoot: root,
    owner: OWNER,
    nativeSessionId: OWNER,
    adapter: "codex",
    task: "Auth Refactor",
  });
  return root;
}

function harn(root: string, args: string[]): RunResult {
  const result = spawnSync("bash", [HARN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function heartbeat(root: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(root, ".harnery", "active", `${OWNER}.json`), "utf8"),
  ) as Record<string, unknown>;
}

function lifecycleEvents(root: string) {
  return readActiveLedgerV2(root)
    .events.map(({ event }) => event)
    .filter((event) => event.event_type === "coord.lifecycle_changed");
}

function outputObject(result: RunResult): Record<string, unknown> {
  const line = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((value) => value.trim())
    .reverse()
    .find((value) => value.startsWith("{"));
  if (!line) throw new Error(`missing JSON output:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line) as Record<string, unknown>;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const root = sandboxes.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("harn agents lifecycle on the V2 ledger", () => {
  test("blocks, re-mints the title, and records one canonical lifecycle event", () => {
    const root = makeSandbox();
    const result = harn(root, [
      "agents",
      "lifecycle",
      "blocked",
      "--reason",
      "waiting for access",
      "--session-id",
      OWNER,
    ]);
    expect(result).toMatchObject({ status: 0 });
    expect(outputObject(result)).toMatchObject({
      task_state: "blocked",
      prior_state: "active",
      changed: true,
      name_reminted: true,
    });
    expect(heartbeat(root)).toMatchObject({
      schema_version: 2,
      task_state: "blocked",
      task_state_reason: "waiting for access",
      suggested_session_name: "[BLOCKED] - Agent Hollis - Auth Refactor",
    });
    expect(lifecycleEvents(root)).toHaveLength(1);
    expect(lifecycleEvents(root)[0]?.payload).toMatchObject({
      new_state: "blocked",
    });
  });

  test("repeating the same state is an event-free no-op and reopening records active", () => {
    const root = makeSandbox();
    expect(
      harn(root, ["agents", "lifecycle", "blocked", "--reason", "waiting", "--session-id", OWNER])
        .status,
    ).toBe(0);
    const count = lifecycleEvents(root).length;
    const retry = harn(root, [
      "agents",
      "lifecycle",
      "blocked",
      "--reason",
      "waiting",
      "--session-id",
      OWNER,
    ]);
    expect(outputObject(retry)).toMatchObject({ changed: false, name_reminted: false });
    expect(lifecycleEvents(root)).toHaveLength(count);
    expect(harn(root, ["agents", "lifecycle", "active", "--session-id", OWNER]).status).toBe(0);
    expect(heartbeat(root)).toMatchObject({
      task_state: "active",
      suggested_session_name: "Agent Hollis - Auth Refactor",
    });
  });

  test("done refuses dirty owned work, then succeeds after Git finalization", () => {
    const root = makeSandbox();
    writeFileSync(path.join(root, "owned.txt"), "dirty\n");
    recordLiveClaimChangeV2({
      coordRoot: root,
      owner: OWNER,
      nativeSessionId: OWNER,
      adapter: "codex",
      operation: "acquired",
      path: "owned.txt",
      access: "write",
    });
    const refused = harn(root, ["agents", "lifecycle", "done", "--session-id", OWNER]);
    expect(refused.status).not.toBe(0);
    expect(outputObject(refused).error).toMatchObject({ code: "git_not_finalized" });
    expect(lifecycleEvents(root)).toHaveLength(0);

    spawnSync("git", ["add", "owned.txt"], { cwd: root, stdio: "ignore" });
    spawnSync("git", ["commit", "-qm", "complete"], { cwd: root, stdio: "ignore" });
    const completed = harn(root, [
      "agents",
      "lifecycle",
      "done",
      "--reason",
      "verified",
      "--session-id",
      OWNER,
    ]);
    expect(completed.status).toBe(0);
    expect(heartbeat(root)).toMatchObject({
      task_state: "done",
      suggested_session_name: "[DONE] - Agent Hollis - Auth Refactor",
    });
    expect(lifecycleEvents(root)[0]?.payload).toMatchObject({ new_state: "done" });
  });

  test("validates blocked reasons and rejects non-human-facing caches", () => {
    const root = makeSandbox();
    const missingReason = harn(root, ["agents", "lifecycle", "blocked", "--session-id", OWNER]);
    expect(outputObject(missingReason).error).toMatchObject({ code: "blocked_reason_required" });

    const cachePath = path.join(root, ".harnery", "active", `${OWNER}.json`);
    writeFileSync(cachePath, JSON.stringify({ ...heartbeat(root), kind: "subagent" }));
    const nonHuman = harn(root, [
      "agents",
      "lifecycle",
      "blocked",
      "--reason",
      "waiting",
      "--session-id",
      OWNER,
    ]);
    expect(nonHuman.status).not.toBe(0);
    expect(outputObject(nonHuman).error).toMatchObject({ code: "lifecycle_not_human_facing" });
  });
});
