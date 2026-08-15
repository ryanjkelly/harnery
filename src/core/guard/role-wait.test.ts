import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Heartbeat } from "../agents/index.ts";
import { resolveRunQualityRoleWait } from "./role-wait.ts";
import type { CanonicalGuardEvent } from "./storage.ts";

const roots: string[] = [];
const now = "2026-08-15T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run-quality role/wait normalization", () => {
  test("attests an open approval and stops exempting it after resolution", () => {
    const project = root();
    const dir = join(project, ".harnery", "approvals", "approval-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "request.json"), "{}\n");
    const hb = heartbeat({ approval_id: "approval-a", role: "reviewer" });
    expect(resolveRunQualityRoleWait(project, hb, [], now)).toMatchObject({
      role: "reviewer",
      wait_kind: "approval",
      fresh: true,
    });
    writeFileSync(join(dir, "decision.json"), "{}\n");
    expect(resolveRunQualityRoleWait(project, hb, [], now).wait_kind).toBe("none");
  });

  test("attests open decision records and rejects terminal ones", () => {
    const project = root();
    const dir = join(project, ".harnery", "decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "decision-a.json"), JSON.stringify({ status: "deliberating" }));
    const hb = heartbeat({ decision_id: "decision-a" });
    expect(resolveRunQualityRoleWait(project, hb, [], now).wait_kind).toBe("decision");
    writeFileSync(join(dir, "decision-a.json"), JSON.stringify({ status: "archived" }));
    expect(resolveRunQualityRoleWait(project, hb, [], now).wait_kind).toBe("none");
  });

  test("scheduled waits require a future wake and fresh needs-input requires no resume", () => {
    const project = root();
    const serviceDir = join(project, ".harnery", "governor-service");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "runtime.json"),
      JSON.stringify({
        schema_version: 1,
        config_created_at: now,
        updated_at: now,
        goals: {
          "goal-a": {
            state: "backoff",
            consecutive_errors: 1,
            next_wake_at: "2026-08-15T00:01:00Z",
          },
        },
      }),
    );
    expect(
      resolveRunQualityRoleWait(
        project,
        heartbeat({ governor_goal_id: "goal-a", next_wake_at: "2026-08-15T00:01:00Z" }),
        [],
        now,
      ).wait_kind,
    ).toBe("scheduled");
    expect(
      resolveRunQualityRoleWait(
        project,
        heartbeat({ governor_goal_id: "goal-a", next_wake_at: "2026-08-14T23:59:00Z" }),
        [],
        now,
      ).wait_kind,
    ).toBe("none");

    const input = event("02", "interaction.input_requested");
    expect(resolveRunQualityRoleWait(project, heartbeat(), [input], now).wait_kind).toBe(
      "needs_input",
    );
    expect(
      resolveRunQualityRoleWait(
        project,
        heartbeat(),
        [input, event("03", "user_prompt.submit")],
        now,
      ).wait_kind,
    ).toBe("none");
  });

  test("conflicting fresh wait evidence grants no exemption", () => {
    const project = root();
    const dir = join(project, ".harnery", "approvals", "approval-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "request.json"), "{}\n");
    const result = resolveRunQualityRoleWait(
      project,
      heartbeat({ approval_id: "approval-a" }),
      [event("02", "interaction.input_requested")],
      now,
    );
    expect(result).toMatchObject({ wait_kind: "unknown", fresh: false });
  });

  test("resolves a workflow specialist from durable run evidence", () => {
    const project = root();
    const dir = join(project, ".harnery", "workflows", "run-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({ event: "agent.start", id: "a1", specialist: "reviewer" })}\n`,
    );
    const start = event("01", "session.start");
    start.data.workflow_agent_id = "a1";
    expect(
      resolveRunQualityRoleWait(project, heartbeat({ workflow_run_id: "run-a" }), [start], now)
        .role,
    ).toBe("reviewer");
  });
});

function root(): string {
  const path = join(
    tmpdir(),
    `harnery-run-quality-wait-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(join(path, ".harnery"), { recursive: true });
  roots.push(path);
  return path;
}

function heartbeat(extra: Partial<Heartbeat> = {}): Heartbeat {
  return {
    instance_id: "instance-a",
    session_id: "session-a",
    agent_id: "agent-a",
    model: "fixture",
    started_at: now,
    last_heartbeat: now,
    files_touched: [],
    ...extra,
  };
}

function event(eventId: string, eventType: string): CanonicalGuardEvent {
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    ts: now,
    instance_id: "instance-a",
    session_id: "session-a",
    adapter: "claude-code",
    data: {},
    segment: ".harnery/events.ndjson",
  };
}
