import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  mkdirSync(path.join(root, ".harnery", "active"), { recursive: true });
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(["add", "seed.txt"]);
  git(["commit", "-qm", "seed"]);
  return root;
}

function seedHeartbeat(root: string, overrides: Record<string, unknown> = {}): void {
  const now = new Date().toISOString();
  writeFileSync(
    path.join(root, ".harnery", "active", `${OWNER}.json`),
    JSON.stringify({
      schema_version: 2,
      instance_id: OWNER,
      session_id: OWNER,
      kind: "session",
      name: "Hollis",
      platform: "codex",
      started_at: now,
      last_heartbeat: now,
      files_touched: [],
      task: "Auth Refactor",
      suggested_session_name: "Agent Hollis - Auth Refactor",
      task_state: "active",
      ...overrides,
    }),
  );
}

function harn(root: string, args: string[]): RunResult {
  const result = spawnSync("bash", [HARN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function heartbeat(root: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(root, ".harnery", "active", `${OWNER}.json`), "utf8"),
  ) as Record<string, unknown>;
}

function events(root: string): Array<Record<string, unknown>> {
  const pathName = path.join(root, ".harnery", "events.ndjson");
  try {
    return readFileSync(pathName, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function outputObject(result: RunResult): Record<string, unknown> {
  const line = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((value) => value.trim())
    .reverse()
    .find((value: string) => value.startsWith("{"));
  if (!line) throw new Error(`missing JSON output:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line) as Record<string, unknown>;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const root = sandboxes.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("harn agents lifecycle", () => {
  test("blocks with a reason, re-mints the title, and records one durable event", () => {
    const root = makeSandbox();
    seedHeartbeat(root);

    const result = harn(root, [
      "agents",
      "lifecycle",
      "blocked",
      "--reason",
      "waiting for access",
      "--session-id",
      OWNER,
    ]);

    expect(result.status).toBe(0);
    expect(outputObject(result)).toMatchObject({
      task_state: "blocked",
      prior_state: "active",
      changed: true,
      name_reminted: true,
      suggested_session_name: "[BLOCKED] - Agent Hollis - Auth Refactor",
    });
    expect(heartbeat(root)).toMatchObject({
      task_state: "blocked",
      task_state_reason: "waiting for access",
      suggested_session_name: "[BLOCKED] - Agent Hollis - Auth Refactor",
      session_name_seen_for: "Agent Hollis - Auth Refactor",
    });
    const lifecycleEvents = events(root).filter((event) => event.event_type === "state.task_state");
    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0]?.data).toMatchObject({
      state: "blocked",
      prior_state: "active",
      reason: "waiting for access",
      name_reminted: true,
      git_finalization_checked: false,
    });
  });

  test("repeating the same state and reason is an event-free no-op", () => {
    const root = makeSandbox();
    seedHeartbeat(root, {
      task_state: "blocked",
      task_state_reason: "waiting for access",
      suggested_session_name: "[BLOCKED] - Agent Hollis - Auth Refactor",
    });

    const result = harn(root, [
      "agents",
      "lifecycle",
      "blocked",
      "--reason",
      "waiting for access",
      "--session-id",
      OWNER,
    ]);

    expect(result.status).toBe(0);
    expect(outputObject(result)).toMatchObject({ changed: false, name_reminted: false });
    expect(events(root).filter((event) => event.event_type === "state.task_state")).toHaveLength(0);
  });

  test("reopening clears the blocker reason and restores the active title", () => {
    const root = makeSandbox();
    seedHeartbeat(root, {
      task_state: "blocked",
      task_state_reason: "waiting for access",
      suggested_session_name: "[BLOCKED] - Agent Hollis - Auth Refactor",
    });

    const result = harn(root, ["agents", "lifecycle", "active", "--session-id", OWNER]);

    expect(result.status).toBe(0);
    expect(heartbeat(root)).toMatchObject({
      task_state: "active",
      suggested_session_name: "Agent Hollis - Auth Refactor",
    });
    expect(heartbeat(root).task_state_reason).toBeUndefined();
  });

  test("done refuses dirty owned work and writes no lifecycle event", () => {
    const root = makeSandbox();
    writeFileSync(path.join(root, "owned.txt"), "dirty\n");
    seedHeartbeat(root, { files_touched: ["owned.txt"] });

    const result = harn(root, ["agents", "lifecycle", "done", "--session-id", OWNER]);

    expect(result.status).not.toBe(0);
    expect(outputObject(result).error).toMatchObject({ code: "git_not_finalized" });
    expect(heartbeat(root).task_state).toBe("active");
    expect(events(root).filter((event) => event.event_type === "state.task_state")).toHaveLength(0);
  });

  test("done succeeds after owned work is committed and records the finalization gate", () => {
    const root = makeSandbox();
    writeFileSync(path.join(root, "owned.txt"), "complete\n");
    spawnSync("git", ["add", "owned.txt"], { cwd: root, stdio: "ignore" });
    spawnSync("git", ["commit", "-qm", "complete"], { cwd: root, stdio: "ignore" });
    seedHeartbeat(root, { files_touched: ["owned.txt"] });

    const result = harn(root, [
      "agents",
      "lifecycle",
      "done",
      "--reason",
      "verified",
      "--session-id",
      OWNER,
    ]);

    expect(result.status).toBe(0);
    expect(heartbeat(root)).toMatchObject({
      task_state: "done",
      task_state_reason: "verified",
      suggested_session_name: "[DONE] - Agent Hollis - Auth Refactor",
    });
    const lifecycle = events(root).find((event) => event.event_type === "state.task_state");
    expect(lifecycle?.data).toMatchObject({
      state: "done",
      git_finalization_checked: true,
    });
  });

  test("blocked requires a reason and done requires a current task", () => {
    const root = makeSandbox();
    seedHeartbeat(root, { task: undefined });

    const blocked = harn(root, ["agents", "lifecycle", "blocked", "--session-id", OWNER]);
    expect(outputObject(blocked).error).toMatchObject({ code: "blocked_reason_required" });

    const done = harn(root, ["agents", "lifecycle", "done", "--session-id", OWNER]);
    expect(outputObject(done).error).toMatchObject({ code: "task_required_for_done" });
    expect(events(root).filter((event) => event.event_type === "state.task_state")).toHaveLength(0);
  });

  test("refuses lifecycle declarations from non-human-facing sessions", () => {
    const root = makeSandbox();

    for (const overrides of [
      { kind: "subagent" },
      { kind: "transient" },
      { workflow_run_id: "workflow-123" },
    ]) {
      seedHeartbeat(root, overrides);
      const result = harn(root, [
        "agents",
        "lifecycle",
        "blocked",
        "--reason",
        "waiting for access",
        "--session-id",
        OWNER,
      ]);

      expect(result.status).not.toBe(0);
      expect(outputObject(result).error).toMatchObject({
        code: "lifecycle_not_human_facing",
      });
      expect(events(root).filter((event) => event.event_type === "state.task_state")).toHaveLength(
        0,
      );
    }
  });

  test("set-task warns under non-active lifecycle without reopening it", () => {
    const root = makeSandbox();
    seedHeartbeat(root, {
      task_state: "done",
      task_state_reason: "verified",
      suggested_session_name: "[DONE] - Agent Hollis - Auth Refactor",
    });

    const result = harn(root, ["agents", "set-task", "New topic", "--session-id", OWNER]);

    expect(result.status).toBe(0);
    expect(String(outputObject(result).warning)).toContain("lifecycle is done");
    expect(heartbeat(root)).toMatchObject({ task: "New topic", task_state: "done" });
  });
});
