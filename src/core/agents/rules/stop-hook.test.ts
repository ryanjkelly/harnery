import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventV3Fixture, fixtureObject } from "../../../../tests/helpers/event-v3.ts";
import { initializeEventLedgerV3 } from "../../events/v3/bootstrap.ts";
import type { EventV3 } from "../../events/v3/contract.ts";
import { startWorkflowChildSessionV3 } from "../../workflow/live-session-v3.ts";
import { evaluateStopHook, evaluateStopHookV3Events } from "./stop-hook.ts";

const roots: string[] = [];
const OWNER = "inst_operator";
const GENERATION = "gen_00000000-0000-7000-8000-000000000111";
const START = Date.parse("2026-08-18T14:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harn-stop-v3-"));
  roots.push(value);
  return value;
}

describe("evaluateStopHook on the universal V3 ledger", () => {
  test("explicit bypass, workflow children, and Codex remain unconditional allows", () => {
    expect(
      evaluateStopHook(root(), {
        rule: "stop-hook",
        instance_id: "operator",
        adapter: "claude-code",
        bypass: true,
      }),
    ).toMatchObject({ allow: true, rule: "stop-hook.bypass" });
    expect(
      evaluateStopHook(root(), {
        rule: "stop-hook",
        instance_id: "operator",
        adapter: "cursor",
        workflow_child: true,
      }),
    ).toMatchObject({ allow: true, rule: "stop-hook.workflow_child" });
    expect(
      evaluateStopHook(root(), {
        rule: "stop-hook",
        instance_id: "operator",
        adapter: "codex",
      }),
    ).toMatchObject({ allow: true, rule: "stop-hook.codex_observe_only" });
  });

  test("fails open when no authoritative V3 control boundary exists", () => {
    expect(
      evaluateStopHook(root(), {
        rule: "stop-hook",
        instance_id: "operator",
        adapter: "claude-code",
      }),
    ).toMatchObject({ allow: true, rule: "stop-hook.v3_evidence_unavailable" });
  });

  test("requires the visible Claude Code acknowledgement even on a prose-only turn", () => {
    const missing = [turnStarted(0), turnCompleted(1, ritual(false))];
    expect(verdict("claude-code", missing)).toMatchObject({
      allow: false,
      rule: "stop-hook.rule_2_3",
    });

    const toolResultOnly = [turnStarted(0), turnCompleted(1, ritual(false, undefined, true))];
    expect(verdict("claude-code", toolResultOnly)).toMatchObject({
      allow: false,
      rule: "stop-hook.rule_2_3",
    });

    const present = [turnStarted(0), turnCompleted(1, ritual(true))];
    expect(verdict("claude-code", present)).toMatchObject({
      allow: true,
      rule: "stop-hook.pure_prose_pass",
    });
  });

  test("enforces status, reply acknowledgement, and task evidence in order on tool turns", () => {
    const base = [turnStarted(0), event("tool.requested", 1)];
    expect(verdict("claude-code", [...base, turnCompleted(5, ritual(true))])).toMatchObject({
      allow: false,
      rule: "stop-hook.rule_1_3",
    });
    expect(
      verdict("claude-code", [...base, status(2), task(3), turnCompleted(5, ritual(false))]),
    ).toMatchObject({ allow: false, rule: "stop-hook.rule_2_3" });
    expect(
      verdict("claude-code", [...base, status(2), turnCompleted(5, ritual(true))]),
    ).toMatchObject({ allow: false, rule: "stop-hook.rule_3_3" });
    expect(
      verdict("claude-code", [...base, status(2), task(3), turnCompleted(5, ritual(true))]),
    ).toMatchObject({ allow: true, rule: "stop-hook.pass" });
  });

  test("Cursor uses the inline status event and does not require reply-text evidence", () => {
    expect(
      verdict("cursor", [
        turnStarted(0),
        event("tool.requested", 1),
        status(2),
        task(3),
        turnCompleted(4),
      ]),
    ).toMatchObject({ allow: true, rule: "stop-hook.pass" });
  });

  test("a Cursor remediation turn inherits ritual evidence from the human turn", () => {
    const repaired = [
      turnStarted(0),
      event("tool.requested", 1),
      task(2),
      turnCompleted(3),
      turnStarted(4, true),
      event("tool.requested", 5),
      status(6),
      turnCompleted(7),
    ];
    expect(verdict("cursor", repaired)).toMatchObject({
      allow: true,
      rule: "stop-hook.pass",
    });

    const nextHumanTurn = repaired.map((item) => structuredClone(item));
    fixtureObject(nextHumanTurn[4]!.payload).stop_remediation = false;
    expect(verdict("cursor", nextHumanTurn)).toMatchObject({
      allow: false,
      rule: "stop-hook.rule_3_3",
    });
  });

  test("enforces the Claude Code session-name observation without retaining the name", () => {
    const base = [turnStarted(0), event("tool.requested", 1), status(2), task(3)];
    expect(
      verdict("claude-code", [
        ...base,
        turnCompleted(4, ritual(true, { required: true, present: false })),
      ]),
    ).toMatchObject({ allow: false, rule: "stop-hook.session_name" });
    expect(
      verdict("claude-code", [
        ...base,
        turnCompleted(4, ritual(true, { required: true, present: true })),
      ]),
    ).toMatchObject({ allow: true, rule: "stop-hook.pass" });
  });

  test("fails open when a Claude Code terminal predates structural ritual evidence", () => {
    expect(verdict("claude-code", [turnStarted(0), turnCompleted(1)])).toMatchObject({
      allow: true,
      rule: "stop-hook.v3_evidence_unavailable",
    });
  });

  test("a stamped sighting on the live row breaks the remediation block loop", () => {
    // Remediation stops cannot land fresh turn.completed events (the first
    // stop closed the turn span), so when the first terminal recorded
    // present: false (flush race), in-window evidence never changes. The
    // sighting stamp written by sessionNamePresence is the durable record
    // that the name was shown; the rule must honor it instead of blocking
    // every retry forever.
    const NAME = "Agent Maya - Auth refactor";
    const events = [
      turnStarted(0),
      event("tool.requested", 1),
      status(2),
      task(3),
      turnCompleted(4, ritual(true, { required: true, present: false })),
    ];
    const request = {
      rule: "stop-hook" as const,
      instance_id: "operator",
      adapter: "claude-code",
      now_ms: START + 10_000,
    };
    expect(evaluateStopHookV3Events(stampedRoot(NAME, NAME), request, events)).toMatchObject({
      allow: true,
      rule: "stop-hook.pass",
    });
    // A stamp for a stale (since re-minted) name does not satisfy the rule.
    expect(
      evaluateStopHookV3Events(stampedRoot(NAME, "Agent Prior - Old focus"), request, events),
    ).toMatchObject({ allow: false, rule: "stop-hook.session_name" });
  });
});

function stampedRoot(suggestedName: string, seenFor: string): string {
  const value = mkdtempSync(join(tmpdir(), "harn-stop-v3-"));
  roots.push(value);
  initializeEventLedgerV3({
    coordRoot: value,
    harneryBuild: "stop-hook-test",
    hostBuild: "host-test",
    configDigest: `sha256:${"0".repeat(64)}`,
    approvalRecordId: "stop-hook-test",
  });
  startWorkflowChildSessionV3({
    coordRoot: value,
    instanceId: "operator",
    runId: "stop-hook-test",
    agentId: "operator",
    adapter: "codex",
  });
  const cachePath = join(value, ".harnery", "active", "operator.json");
  const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
  writeFileSync(
    cachePath,
    JSON.stringify({
      ...cache,
      suggested_session_name: suggestedName,
      session_name_seen_for: seenFor,
    }),
    "utf8",
  );
  return value;
}

function verdict(adapter: "claude-code" | "cursor", events: EventV3[]) {
  return evaluateStopHookV3Events(
    root(),
    {
      rule: "stop-hook",
      instance_id: "operator",
      adapter,
      now_ms: START + 10_000,
    },
    events,
  );
}

function event(eventType: string, second: number): EventV3 {
  const value = eventV3Fixture(eventType, second + 1);
  const scope = fixtureObject(value.scope);
  scope.instance_id = OWNER;
  scope.generation_id = GENERATION;
  const time = fixtureObject(value.time);
  const stamp = new Date(START + second * 1_000).toISOString();
  time.observed_at = stamp;
  time.recorded_at = stamp;
  return value as unknown as EventV3;
}

function turnStarted(second: number, stopRemediation = false): EventV3 {
  const value = event("turn.started", second);
  fixtureObject(value.payload).stop_remediation = stopRemediation;
  return value;
}

function turnCompleted(second: number, turnRitual?: Record<string, unknown>): EventV3 {
  const value = event("turn.completed", second);
  if (turnRitual) fixtureObject(value.payload).ritual = turnRitual;
  return value;
}

function status(second: number): EventV3 {
  const value = event("coord.status_observed", second);
  const payload = fixtureObject(value.payload);
  payload.observer_instance_id = OWNER;
  payload.subject_instance_id = OWNER;
  payload.status = "box_checked";
  return value;
}

function task(second: number): EventV3 {
  const value = event("coord.task_changed", second);
  const payload = fixtureObject(value.payload);
  payload.actor_instance_id = OWNER;
  payload.subject_instance_id = OWNER;
  payload.new_state = "set";
  return value;
}

function ritual(
  statusBoxPresent: boolean,
  sessionName: { required: boolean; present: boolean } = { required: false, present: false },
  looseStatusBoxPresent = statusBoxPresent,
): Record<string, unknown> {
  return {
    status_box_present: observed(looseStatusBoxPresent),
    status_box_present_strict: observed(statusBoxPresent),
    session_name: observed(sessionName),
  };
}

function observed(value: unknown): Record<string, unknown> {
  return { state: "observed", value, attestation: "derived", confidence: "exact" };
}
