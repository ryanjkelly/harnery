import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { processStartToken } from "../agents/state/proc-start.ts";
import { installedHarneryBuild } from "../events/v3/runtime-build.ts";
import { normalizePolicy } from "../policy/index.ts";
import { closeProcessLoggers } from "../storage/logger.ts";
import { acceptWorkItem, createWorkItem, readWorkItem } from "../work/index.ts";
import {
  appendGovernorServiceDiagnostic,
  configureGovernorService,
  type GovernorServiceStatusRecord,
  governorServiceLogPath,
  readGovernorServiceConfig,
  requestGovernorServiceStop,
  runGovernorServiceDaemon,
  runGovernorServiceSweep,
  spawnGovernorService,
} from "./service.ts";
import { readGovernorServiceRuntime, readGovernorServiceStatus } from "./service-read.ts";
import { createGovernor, readGovernor } from "./state.ts";

const roots: string[] = [];
const originalSharedLogs = process.env.HARNERY_SHARED_LOGS;

afterEach(async () => {
  await closeProcessLoggers();
  if (originalSharedLogs === undefined) delete process.env.HARNERY_SHARED_LOGS;
  else process.env.HARNERY_SHARED_LOGS = originalSharedLogs;
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

function serviceRecord(root: string, overrides: Partial<GovernorServiceStatusRecord> = {}) {
  const now = new Date().toISOString();
  const record: GovernorServiceStatusRecord = {
    schema_version: 1,
    pid: process.pid,
    host: hostname(),
    nonce: "service-fixture",
    state: "running",
    start_token: processStartToken(process.pid) ?? undefined,
    running_build: installedHarneryBuild(),
    started_at: now,
    heartbeat_at: now,
    config_created_at: now,
    sweep_count: 0,
    ...overrides,
  };
  writeFileSync(join(root, ".harnery", "governor-service", "status.json"), JSON.stringify(record));
  return record;
}

describe("governor service process safety", () => {
  test("does not signal a reused PID and preserves the durable stop request", () => {
    const { root, goalId } = fixture();
    configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    serviceRecord(root, { start_token: "replacement-generation" });
    let signals = 0;
    const status = requestGovernorServiceStop(root, { kill: () => signals++ });
    expect(status).toMatchObject({
      running: false,
      stale: true,
      generation: "different",
      liveness: "stopped",
      signal_sent: false,
      signal_verdict: "different",
    });
    expect(signals).toBe(0);
    expect(existsSync(join(root, ".harnery", "governor-service", "stop.json"))).toBe(true);
  });

  test("missing tokens block a second start and use the durable stop fallback", async () => {
    const { root, goalId } = fixture();
    configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    serviceRecord(root, { start_token: undefined, running_build: undefined });
    const before = readFileSync(join(root, ".harnery", "governor-service", "status.json"), "utf8");
    expect(readGovernorServiceStatus(root)).toMatchObject({
      running: false,
      generation: "unknown",
      liveness: "unknown",
      running_build: null,
      restart_needed: true,
      build_status: "running build unknown; restart needed",
    });
    expect(() => configureGovernorService({ coordRoot: root, goalIds: [goalId] })).toThrow(
      "governor service stop",
    );
    await expect(spawnGovernorService(root)).rejects.toThrow("durable stop request");
    await expect(
      runGovernorServiceDaemon({ coordRoot: root, engine: { spawners: {} }, maxSweeps: 1 }),
    ).rejects.toThrow("process generation is unknown");
    expect(readFileSync(join(root, ".harnery", "governor-service", "status.json"), "utf8")).toBe(
      before,
    );
    let signals = 0;
    expect(requestGovernorServiceStop(root, { kill: () => signals++ })).toMatchObject({
      signal_sent: false,
      signal_verdict: "unknown",
    });
    expect(signals).toBe(0);
    expect(existsSync(join(root, ".harnery", "governor-service", "stop.json"))).toBe(true);
  });

  test("unreadable tokens stay unknown and never authorize a signal", () => {
    const { root, goalId } = fixture();
    configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    serviceRecord(root);
    let signals = 0;
    const status = requestGovernorServiceStop(root, {
      readToken: () => {
        throw new Error("token probe failed");
      },
      probePid: () => true,
      kill: () => signals++,
    });
    expect(status).toMatchObject({
      generation: "unknown",
      liveness: "unknown",
      signal_sent: false,
      signal_verdict: "unknown",
    });
    expect(signals).toBe(0);
  });

  test("a terminal marker cannot hide an unknown live process generation", async () => {
    const { root, goalId } = fixture();
    configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    serviceRecord(root, { state: "stopped", start_token: undefined });
    expect(readGovernorServiceStatus(root)).toMatchObject({
      running: false,
      generation: "unknown",
      liveness: "unknown",
    });
    await expect(spawnGovernorService(root)).rejects.toThrow("process generation is unknown");
    await expect(
      runGovernorServiceDaemon({ coordRoot: root, engine: { spawners: {} }, maxSweeps: 1 }),
    ).rejects.toThrow("process generation is unknown");
    let signals = 0;
    expect(requestGovernorServiceStop(root, { kill: () => signals++ })).toMatchObject({
      signal_sent: false,
      signal_verdict: "unknown",
    });
    expect(signals).toBe(0);
    expect(existsSync(join(root, ".harnery", "governor-service", "stop.json"))).toBe(true);
  });

  test("rechecks the token after the durable request and before the signal", () => {
    const { root, goalId } = fixture();
    configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    serviceRecord(root, { start_token: "recorded" });
    let reads = 0;
    let signals = 0;
    const stopPath = join(root, ".harnery", "governor-service", "stop.json");
    const status = requestGovernorServiceStop(root, {
      readToken: () => {
        reads++;
        if (reads === 1) return "recorded";
        expect(existsSync(stopPath)).toBe(true);
        return "replacement";
      },
      probePid: () => true,
      kill: () => signals++,
    });
    expect(reads).toBe(3);
    expect(status).toMatchObject({ signal_sent: false, signal_verdict: "different" });
    expect(signals).toBe(0);
  });

  test("signals a verified generation and preserves a failed signal result", () => {
    const { root, goalId } = fixture();
    configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    const record = serviceRecord(root);
    let signals = 0;
    expect(
      requestGovernorServiceStop(root, {
        kill: (pid, signal) => {
          expect(pid).toBe(record.pid);
          expect(signal).toBe("SIGTERM");
          signals++;
        },
      }),
    ).toMatchObject({ signal_sent: true, signal_verdict: "same" });
    expect(signals).toBe(1);
    expect(
      requestGovernorServiceStop(root, {
        kill: () => {
          throw new Error("signal refused");
        },
      }),
    ).toMatchObject({
      signal_sent: false,
      signal_verdict: "same",
    });
  });

  test("unknown lease ownership blocks a daemon without changing the lease or stop file", async () => {
    const { root, goalId } = fixture();
    configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    const leasePath = join(root, ".harnery", "governor-service", "lease.json");
    const stopPath = join(root, ".harnery", "governor-service", "stop.json");
    const lease = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      nonce: "previous",
      created_at: new Date().toISOString(),
    });
    writeFileSync(leasePath, lease);
    writeFileSync(stopPath, "preserve this stop request");
    await expect(
      runGovernorServiceDaemon({ coordRoot: root, engine: { spawners: {} }, maxSweeps: 1 }),
    ).rejects.toThrow("durable stop request");
    expect(readFileSync(leasePath, "utf8")).toBe(lease);
    expect(readFileSync(stopPath, "utf8")).toBe("preserve this stop request");
  });

  test("an unreadable status blocks startup and still accepts a durable stop request", async () => {
    const { root, goalId } = fixture();
    configureGovernorService({ coordRoot: root, goalIds: [goalId] });
    const statusPath = join(root, ".harnery", "governor-service", "status.json");
    writeFileSync(statusPath, "{invalid");
    expect(readGovernorServiceStatus(root)).toMatchObject({
      generation: "unknown",
      liveness: "unknown",
    });
    await expect(spawnGovernorService(root)).rejects.toThrow("process generation is unknown");
    let signals = 0;
    expect(requestGovernorServiceStop(root, { kill: () => signals++ })).toMatchObject({
      signal_sent: false,
      signal_verdict: "unknown",
    });
    expect(signals).toBe(0);
    expect(readFileSync(statusPath, "utf8")).toBe("{invalid");
    expect(existsSync(join(root, ".harnery", "governor-service", "stop.json"))).toBe(true);
  });
});

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
    delete process.env.HARNERY_SHARED_LOGS;
    const { root, goalId } = fixture();
    configureGovernorService({
      coordRoot: root,
      goalIds: [goalId],
      wakeIntervalMs: 50,
      heartbeatIntervalMs: 25,
    });
    let lease: Record<string, unknown> | undefined;
    const status = await runGovernorServiceDaemon({
      coordRoot: root,
      engine: { spawners: {} },
      maxSweeps: 1,
      onLog: (line) => {
        if (line.startsWith("governor service started")) {
          lease = JSON.parse(
            readFileSync(join(root, ".harnery", "governor-service", "lease.json"), "utf8"),
          );
        }
      },
    });
    expect(status).toMatchObject({ state: "stopped", sweep_count: 1 });
    expect(status.start_token).toBe(processStartToken(process.pid) ?? undefined);
    expect(status.running_build).toEqual(installedHarneryBuild());
    expect(lease).toMatchObject({
      pid: process.pid,
      start_token: processStartToken(process.pid) ?? undefined,
      running_build: installedHarneryBuild(),
    });
    expect(readGovernorServiceStatus(root)).toMatchObject({
      running: false,
      stale: false,
      record: { state: "stopped", sweep_count: 1 },
    });
    const eventsPath = join(root, ".harnery", "logs", "governor-service", "active.jsonl");
    expect(governorServiceLogPath(root)).toBe(eventsPath);
    const events = readFileSync(eventsPath, "utf8");
    expect(events).toContain('"event":"service.started"');
    expect(events).toContain('"event":"service.stopped"');
    expect(events.endsWith("\n")).toBeTrue();
    expect(existsSync(join(root, ".harnery", "governor-service", "events.jsonl"))).toBeFalse();
    expect(existsSync(join(root, ".harnery", "governor-service", "service.log"))).toBeFalse();
  });

  test("uses the legacy event stream only when shared logging is rolled back", async () => {
    process.env.HARNERY_SHARED_LOGS = "0";
    const { root } = fixture();
    expect(appendGovernorServiceDiagnostic(root, { event: "service.started", goals: 1 })).toBe(
      "legacy",
    );
    await closeProcessLoggers();
    expect(
      readFileSync(join(root, ".harnery", "governor-service", "events.jsonl"), "utf8"),
    ).toContain('"event":"service.started"');
    expect(governorServiceLogPath(root)).toBe(
      join(root, ".harnery", "governor-service", "service.log"),
    );
    expect(
      existsSync(join(root, ".harnery", "logs", "governor-service", "active.jsonl")),
    ).toBeFalse();
  });
});
