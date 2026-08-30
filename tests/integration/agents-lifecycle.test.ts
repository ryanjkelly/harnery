import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordLiveClaimChangeV3,
  recordLiveTaskChangeV3,
} from "../../src/core/agents/live-authority-v3.ts";
import { stampSessionNameSeen } from "../../src/core/agents/state/heartbeat-writer.ts";
import { ensureLiveCoordinationHeartbeat } from "../../src/core/agents/state/live-coordination-writer.ts";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";
import {
  readHookProducerStateV3,
  recordApprovedSessionEndV3,
} from "../../src/core/events/v3/producers/recorder.ts";
import { readLedgerV3 } from "../../src/core/events/v3/reader.ts";

const HARNERY_DIR = path.resolve(import.meta.dir, "../..");
const HARN = path.join(HARNERY_DIR, "bin", "harn");
const OWNER = "45f21628-043a-463d-a394-4128789f2276";
const sandboxes: string[] = [];

setDefaultTimeout(15_000);

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
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-agents-lifecycle",
  });
  writeFileSync(
    path.join(root, ".harnery", ".name-history"),
    `${JSON.stringify({ instance_id: OWNER, name: "Hollis", kind: "session", ts: new Date().toISOString() })}\n`,
  );
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected V3 route");
  recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName: "session-start",
    payload: { session_id: OWNER, raw: {}, model: "gpt-5.6" },
    adapter: "codex",
    instanceId: OWNER,
  });
  ensureLiveCoordinationHeartbeat(root, OWNER, OWNER, "codex", "gpt-5.6");
  recordLiveTaskChangeV3({
    coordRoot: root,
    owner: OWNER,
    nativeSessionId: OWNER,
    adapter: "codex",
    task: "Auth Refactor",
  });
  return root;
}

function makeMidFlightSandbox(materializeHeartbeat = true): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-lifecycle-mid-flight-"));
  sandboxes.push(root);
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(["add", "seed.txt"]);
  git(["commit", "-qm", "seed"]);
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-agents-lifecycle-mid-flight",
  });
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected V3 route");
  recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName: "user-prompt-submit",
    payload: { session_id: OWNER, turn_id: "turn-1", prompt: "Start", raw: {} },
    adapter: "codex",
    instanceId: OWNER,
  });
  if (materializeHeartbeat) {
    const hb = ensureLiveCoordinationHeartbeat(root, OWNER, OWNER, "codex", "gpt-5.6");
    if (!hb) throw new Error("expected mid-flight heartbeat");
  }
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

function harnAsync(root: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [HARN, ...args], {
      cwd: root,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
      });
    });
  });
}

function heartbeat(root: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(root, ".harnery", "active", `${OWNER}.json`), "utf8"),
  ) as Record<string, unknown>;
}

function lifecycleEvents(root: string) {
  return readLedgerV3(root)
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

describe("harn agents lifecycle on the V3 ledger", () => {
  test("first set-task assigns a real name to a mid-flight-onboarded session", () => {
    const root = makeMidFlightSandbox();
    expect(heartbeat(root)).toMatchObject({ name: "" });

    const result = harn(root, ["agents", "set-task", "Recovered focus", "--session-id", OWNER]);

    expect(result.status).toBe(0);
    expect(outputObject(result)).toMatchObject({
      name: "Anna",
      first_of_session: true,
      session_name_retry: false,
      suggested_session_name: "Agent Anna - Recovered focus",
    });
    expect(heartbeat(root)).toMatchObject({
      name: "Anna",
      task: "Recovered focus",
      suggested_session_name: "Agent Anna - Recovered focus",
    });
    expect(
      existsSync(path.join(root, ".harnery", "active", ".set-task-leases", `${OWNER}.lease`)),
    ).toBeTrue();
    expect(existsSync(path.join(root, ".harnery", "private", "agent-set-task-leases"))).toBeFalse();
  });

  test("overlapping first set-task calls name a mid-flight session before its heartbeat exists", async () => {
    const root = makeMidFlightSandbox(false);
    expect(existsSync(path.join(root, ".harnery", "active", `${OWNER}.json`))).toBeFalse();

    const args = ["agents", "set-task", "Recovered focus", "--session-id", OWNER];
    const results = await Promise.all([harnAsync(root, args), harnAsync(root, args)]);

    for (const result of results) {
      if (result.status !== 0) {
        throw new Error(`overlapping set-task failed:\n${result.stdout}\n${result.stderr}`);
      }
      expect(outputObject(result)).toMatchObject({
        name: "Anna",
        suggested_session_name: "Agent Anna - Recovered focus",
      });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("Agent unknown");
    }
    expect(heartbeat(root)).toMatchObject({
      name: "Anna",
      task: "Recovered focus",
      suggested_session_name: "Agent Anna - Recovered focus",
    });
  });

  test("routine set-task stays title-silent and suggest-name explicitly retries", () => {
    const pendingRoot = makeSandbox();
    const repeated = harn(pendingRoot, [
      "agents",
      "set-task",
      "Current Work",
      "--session-id",
      OWNER,
    ]);
    expect(repeated.status).toBe(0);
    expect(outputObject(repeated)).toMatchObject({
      first_of_session: false,
      session_name_retry: false,
      suggested_session_name: null,
    });

    const retry = harn(pendingRoot, ["agents", "suggest-name", "--json", "--session-id", OWNER]);
    expect(retry.status).toBe(0);
    expect(outputObject(retry)).toMatchObject({
      session_name_retry: true,
      suggested_session_name: "Agent Hollis - Auth Refactor",
    });

    const root = makeSandbox();
    stampSessionNameSeen(root, OWNER, "Agent Hollis - Auth Refactor");
    const alreadySeen = harn(root, ["agents", "set-task", "Auth Refactor", "--session-id", OWNER]);
    expect(alreadySeen.status).toBe(0);
    expect(outputObject(alreadySeen)).toMatchObject({
      first_of_session: false,
      session_name_retry: false,
      suggested_session_name: null,
    });

    const reprint = harn(root, ["agents", "suggest-name", "--json", "--session-id", OWNER]);
    expect(outputObject(reprint)).toMatchObject({ session_name_retry: false });
  });

  test("does not reissue an already-seen done title after a native generation restart", () => {
    const root = makeSandbox();
    const completed = harn(root, ["agents", "lifecycle", "done", "--session-id", OWNER]);
    expect(completed.status).toBe(0);
    const doneName = "[DONE] Agent Hollis - Auth Refactor";
    stampSessionNameSeen(root, OWNER, doneName);

    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    const terminalState = readHookProducerStateV3(root, "codex", OWNER);
    if (!terminalState) throw new Error("expected hook producer state");
    expect(
      recordApprovedSessionEndV3({
        coordRoot: root,
        mode: route.mode,
        instance_id: terminalState.instance_id,
        generation_id: terminalState.generation_id,
        build_id: route.build_id,
        platform: "linux",
        reason: "approved_explicit_end",
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("recorded");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "session-start",
        payload: { session_id: OWNER, raw: {}, model: "gpt-5.6" },
        adapter: "codex",
        instanceId: OWNER,
      }).state,
    ).toBe("recorded");

    const restarted = harn(root, ["agents", "set-task", "Follow-up review", "--session-id", OWNER]);
    expect(restarted.status).toBe(0);
    expect(outputObject(restarted)).toMatchObject({
      first_of_session: false,
      session_name_retry: false,
      suggested_session_name: null,
    });
    expect(heartbeat(root)).toMatchObject({
      task: "Follow-up review",
      suggested_session_name: doneName,
      session_name_seen_for: doneName,
    });
  });

  test("blocks without changing the title and records one canonical lifecycle event", () => {
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
      name_reminted: false,
      suggested_session_name: null,
    });
    expect(heartbeat(root)).toMatchObject({
      schema_version: 2,
      task_state: "blocked",
      task_state_reason: "waiting for access",
      suggested_session_name: "Agent Hollis - Auth Refactor",
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
    expect(
      harn(root, ["agents", "set-task", "Final verification", "--session-id", OWNER]).status,
    ).toBe(0);
    expect(heartbeat(root)).toMatchObject({
      task: "Final verification",
      suggested_session_name: "Agent Hollis - Auth Refactor",
    });
    writeFileSync(path.join(root, "owned.txt"), "dirty\n");
    recordLiveClaimChangeV3({
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
    expect(outputObject(completed)).toMatchObject({
      name_reminted: true,
      suggested_session_name: "[DONE] Agent Hollis - Auth Refactor",
    });
    expect(heartbeat(root)).toMatchObject({
      task_state: "done",
      suggested_session_name: "[DONE] Agent Hollis - Auth Refactor",
    });
    expect(lifecycleEvents(root)[0]?.payload).toMatchObject({ new_state: "done" });
  });

  test("active opens a fresh derived generation after an authoritative terminal", () => {
    const root = makeSandbox();
    expect(harn(root, ["agents", "lifecycle", "done", "--session-id", OWNER]).status).toBe(0);
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    const terminalState = readHookProducerStateV3(root, "codex", OWNER);
    if (!terminalState) throw new Error("expected hook producer state");
    const priorGenerationId = terminalState.generation_id;
    expect(
      recordApprovedSessionEndV3({
        coordRoot: root,
        mode: route.mode,
        instance_id: terminalState.instance_id,
        generation_id: priorGenerationId,
        build_id: route.build_id,
        platform: "linux",
        reason: "approved_explicit_end",
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("recorded");

    const reopened = harn(root, ["agents", "lifecycle", "active", "--session-id", OWNER]);
    expect(reopened.status).toBe(0);
    expect(outputObject(reopened)).toMatchObject({
      task_state: "active",
      prior_state: null,
      changed: true,
      generation_reopened: true,
      prior_generation_id: priorGenerationId,
      generation_id: expect.stringMatching(/^gen_/),
      name_reminted: false,
    });

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const starts = events.filter((event) => event.event_type === "session.started");
    const terminals = events.filter((event) => event.event_type === "session.ended");
    expect(starts).toHaveLength(2);
    expect(terminals).toHaveLength(1);
    const latestStart = starts.at(-1);
    if (latestStart?.event_type !== "session.started") {
      throw new Error("expected reopened session start");
    }
    const priorTerminal = terminals[0];
    if (priorTerminal?.event_type !== "session.ended") {
      throw new Error("expected prior session terminal");
    }
    if (!("generation_id" in latestStart.scope) || !("generation_id" in priorTerminal.scope)) {
      throw new Error("expected generation-scoped session events");
    }
    const reopenedGenerationId = latestStart.scope.generation_id;
    expect(latestStart).toMatchObject({
      provenance: {
        attestation: "derived",
        confidence: "high",
        attribution: { method: "session_env", state: "verified" },
      },
      payload: {
        resume: { state: "unknown", reason: "approved_lifecycle_reopen" },
      },
    });
    expect(reopenedGenerationId).not.toBe(priorGenerationId);
    expect(priorTerminal.scope.generation_id).toBe(priorGenerationId);
    expect(heartbeat(root)).toMatchObject({
      task_state: "active",
      v3_generation_id: reopenedGenerationId,
    });
    expect(
      harn(root, ["agents", "set-task", "Follow-up review", "--session-id", OWNER]).status,
    ).toBe(0);
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
