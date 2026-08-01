import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePolicy } from "../policy/index.ts";
import { acceptWorkItem, createWorkItem, readWorkItem } from "../work/index.ts";
import {
  configureGovernorService,
  readGovernorServiceConfig,
  readGovernorServiceRuntime,
  readGovernorServiceStatus,
  runGovernorServiceDaemon,
  runGovernorServiceSweep,
} from "./service.ts";
import { createGovernor, readGovernor } from "./state.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { accept?: boolean; goalId?: string; workId?: string } = {}) {
  const root = mkdtempSync(join("/tmp", "harnery-governor-service-"));
  roots.push(root);
  const workflow = join(root, "passing.mjs");
  writeFileSync(
    workflow,
    `
      export const meta = {
        acceptance: [{ id: "done", statement: "The service step is complete" }],
      };
      export default async ({ evidence }) => {
        evidence({ kind: "review", status: "passed", label: "verified", acceptanceIds: ["done"] });
        return { ok: true };
      };
    `,
  );
  const workId = options.workId ?? "service-work";
  const goalId = options.goalId ?? "service-goal";
  createWorkItem({
    coordRoot: root,
    id: workId,
    title: "Service work",
    objective: "Complete through the background service",
    workflowPath: workflow,
  });
  createGovernor({
    coordRoot: root,
    id: goalId,
    rootWorkId: workId,
    specialists: {},
    automation: { accept_passing_proof: options.accept ?? false },
  });
  return { root, workId, goalId };
}

describe("governor background service", () => {
  test("freezes a private canonical service configuration for explicit goals", () => {
    const { root, goalId } = fixture();
    const config = configureGovernorService({
      coordRoot: root,
      goalIds: [goalId, goalId],
      wakeIntervalMs: 250,
      heartbeatIntervalMs: 100,
      errorBackoffBaseMs: 500,
      errorBackoffMaxMs: 4_000,
      engine: {
        subscription_only: true,
        default_adapter: "codex",
        policy: normalizePolicy({ name: "frozen-service-policy", network: "ask" }),
      },
    });
    expect(config.goal_ids).toEqual([goalId]);
    expect(config.engine).toMatchObject({
      default_adapter: "codex",
      cwd: root,
      subscription_only: true,
      allow_api_billing: false,
      policy: { name: "frozen-service-policy", network: "ask" },
    });
    expect(readGovernorServiceConfig(root)).toEqual(config);
    expect(statSync(join(root, ".harnery", "governor-service", "config.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(() => configureGovernorService({ coordRoot: root, goalIds: ["missing-goal"] })).toThrow(
      "does not exist",
    );
  });

  test("continues ready ticks, then quiesces after accepted success", async () => {
    const { root, goalId, workId } = fixture({ accept: true });
    const config = configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    const first = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      engine: { spawners: {} },
    });
    expect(first.outcomes).toEqual([
      expect.objectContaining({ goal_id: goalId, action: "tick", stop_reason: "tick_complete" }),
    ]);
    expect(readWorkItem(root, workId).projection.state).toBe("in_review");
    expect(readGovernorServiceRuntime(root)?.goals[goalId]?.state).toBe("idle");

    const second = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      engine: { spawners: {} },
    });
    expect(second.outcomes[0]).toMatchObject({
      goal_id: goalId,
      action: "tick",
      stop_reason: "succeeded",
    });
    expect(readGovernor(root, goalId).projection.state).toBe("succeeded");

    const third = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      engine: { spawners: {} },
    });
    expect(third.outcomes[0]).toMatchObject({
      goal_id: goalId,
      action: "skip",
      reason: "durable goal state has not changed",
    });
  });

  test("waits without model churn when a goal needs explicit attention", async () => {
    const { root, goalId, workId } = fixture();
    const config = configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    const first = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      engine: { spawners: {} },
    });
    expect(first.outcomes[0]).toMatchObject({ action: "tick", stop_reason: "tick_complete" });
    expect(readWorkItem(root, workId).projection.state).toBe("in_review");
    const second = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      engine: { spawners: {} },
    });
    expect(second.outcomes[0]).toMatchObject({
      action: "skip",
      reason: "durable goal state has not changed",
    });

    acceptWorkItem(root, workId, { actor: "reviewer", reason: "review passed" });
    const third = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      engine: { spawners: {} },
    });
    expect(third.outcomes[0]).toMatchObject({ action: "skip" });
    expect(third.outcomes[0]?.reason).toContain("goal is succeeded");
  });

  test("persists exponential error backoff and bypasses it on durable change", async () => {
    const { root, goalId } = fixture();
    const config = configureGovernorService({
      coordRoot: root,
      goalIds: [goalId],
      errorBackoffBaseMs: 1_000,
      errorBackoffMaxMs: 8_000,
    });
    const timestamp = Date.parse("2026-07-22T12:00:00.000Z");
    let attempts = 0;
    let changed = false;
    const base = readGovernor(root, goalId);
    const readGoal = () =>
      changed
        ? {
            ...base,
            projection: { ...base.projection, attempts_used: base.projection.attempts_used + 1 },
          }
        : base;
    const runGoal = async () => {
      attempts++;
      throw new Error("temporary adapter outage");
    };

    const first = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      now: () => timestamp,
      readGoal,
      runGoal,
    });
    expect(first.outcomes[0]).toMatchObject({ action: "backoff" });
    expect(readGovernorServiceRuntime(root)?.goals[goalId]).toMatchObject({
      state: "backoff",
      consecutive_errors: 1,
      next_wake_at: "2026-07-22T12:00:01.000Z",
    });

    const skipped = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      now: () => timestamp,
      readGoal,
      runGoal,
    });
    expect(skipped.outcomes[0]).toMatchObject({ action: "skip" });
    expect(attempts).toBe(1);

    changed = true;
    const bypassed = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      now: () => timestamp,
      readGoal,
      runGoal,
    });
    expect(bypassed.outcomes[0]).toMatchObject({ action: "backoff" });
    expect(attempts).toBe(2);
    expect(readGovernorServiceRuntime(root)?.goals[goalId]).toMatchObject({
      consecutive_errors: 2,
      next_wake_at: "2026-07-22T12:00:02.000Z",
    });
  });

  test("reconstructs from durable goal state when recoverable runtime is corrupt", async () => {
    const { root, goalId } = fixture({ accept: true });
    const config = configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    const runtimePath = join(root, ".harnery", "governor-service", "runtime.json");
    writeFileSync(runtimePath, "{not-json\n");
    const report = await runGovernorServiceSweep({
      coordRoot: root,
      config,
      engine: { spawners: {} },
    });
    expect(report.outcomes[0]).toMatchObject({ action: "tick" });
    expect(readGovernorServiceRuntime(root)?.config_created_at).toBe(config.created_at);
  });

  test("writes heartbeat, audit, and terminal status around a foreground service sweep", async () => {
    const { root, goalId } = fixture();
    configureGovernorService({
      coordRoot: root,
      goalIds: [goalId],
      wakeIntervalMs: 50,
      heartbeatIntervalMs: 25,
    });
    const status = await runGovernorServiceDaemon({
      coordRoot: root,
      engine: { spawners: {} },
      maxSweeps: 1,
    });
    expect(status).toMatchObject({ state: "stopped", sweep_count: 1 });
    expect(readGovernorServiceStatus(root)).toMatchObject({
      running: false,
      stale: false,
      record: { state: "stopped", sweep_count: 1 },
    });
    const events = readFileSync(join(root, ".harnery", "governor-service", "events.jsonl"), "utf8");
    expect(events).toContain('"event":"service.started"');
    expect(events).toContain('"event":"service.stopped"');
  });
});
