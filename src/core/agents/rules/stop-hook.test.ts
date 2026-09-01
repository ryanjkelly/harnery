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

  test("reports every missing end-of-turn signal in one verdict", () => {
    const base = [turnStarted(0), event("tool.requested", 1)];

    // Status, acknowledgement and task all missing: one block, all three named.
    const allMissing = verdict("claude-code", [...base, turnCompleted(5, ritual(false))]);
    expect(allMissing).toMatchObject({ allow: false, rule: "stop-hook.rule_1_3" });
    expect(allMissing.reason).toContain("End-of-turn rule (1/3)");
    expect(allMissing.reason).toContain("End-of-turn rule (2/3)");
    expect(allMissing.reason).toContain("End-of-turn rule (3/3)");
    expect(allMissing.reason).toContain("Repair ALL of them");

    // Acknowledgement and task missing: the verdict keeps the first rule id.
    const two = verdict("claude-code", [...base, status(2), turnCompleted(5, ritual(false))]);
    expect(two).toMatchObject({ allow: false, rule: "stop-hook.rule_2_3" });
    expect(two.reason).toContain("End-of-turn rule (2/3)");
    expect(two.reason).toContain("End-of-turn rule (3/3)");

    // A lone failure keeps its original single-rule wording.
    const one = verdict("claude-code", [...base, status(2), turnCompleted(5, ritual(true))]);
    expect(one).toMatchObject({ allow: false, rule: "stop-hook.rule_3_3" });
    expect(one.reason).toContain("End-of-turn rule (3/3)");
    expect(one.reason).not.toContain("Repair ALL of them");
  });

  test("Cursor requires both the status event and reply-text status evidence", () => {
    expect(
      verdict("cursor", [
        turnStarted(0),
        event("tool.requested", 1),
        status(2),
        task(3),
        turnCompleted(4, ritual(false)),
      ]),
    ).toMatchObject({ allow: false, rule: "stop-hook.rule_2_3" });
    expect(
      verdict("cursor", [
        turnStarted(0),
        event("tool.requested", 1),
        status(2),
        task(3),
        turnCompleted(4, ritual(true)),
      ]),
    ).toMatchObject({ allow: true, rule: "stop-hook.pass" });
  });

  test("a Cursor remediation turn inherits ritual evidence from the human turn", () => {
    const repaired = [
      turnStarted(0),
      event("tool.requested", 1),
      task(2),
      turnCompleted(3, ritual(false)),
      turnStarted(4, true),
      event("tool.requested", 5),
      status(6),
      turnCompleted(7, ritual(true)),
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

  test("a Claude continuation accumulates recovered ritual evidence without changing original-turn policy", () => {
    const recovered = [
      turnStarted(0),
      event("tool.requested", 1),
      task(2),
      turnCompleted(3, ritual(false)),
      recoveredTurnStarted(4),
      event("tool.requested", 5),
      status(6),
      turnCompleted(7, ritual(false)),
    ];

    expect(
      verdict("claude-code", recovered, {
        stop_hook_active: true,
        status_box_present_strict: true,
      }),
    ).toMatchObject({ allow: true, rule: "stop-hook.pass" });
  });

  test("Claude remediation tools do not escalate an original pure-prose turn", () => {
    const pureProseRecovery = [
      turnStarted(0),
      turnCompleted(1, ritual(false)),
      recoveredTurnStarted(2),
      event("tool.requested", 3),
      status(4),
      turnCompleted(5, ritual(true)),
    ];

    expect(
      verdict("claude-code", pureProseRecovery, {
        stop_hook_active: true,
        status_box_present_strict: true,
      }),
    ).toMatchObject({ allow: true, rule: "stop-hook.pure_prose_pass" });
  });

  test("ordinary Claude recovery does not inherit the preceding turn evidence", () => {
    const ordinaryRecovery = [
      turnStarted(0),
      task(1),
      turnCompleted(2, ritual(true)),
      recoveredTurnStarted(3),
      event("tool.requested", 4),
      status(5),
      turnCompleted(6, ritual(true)),
    ];

    expect(verdict("claude-code", ordinaryRecovery)).toMatchObject({
      allow: false,
      rule: "stop-hook.rule_3_3",
    });
  });

  test("a recovery tool can interleave inside one Claude remediation cycle without leaking past a new prompt", () => {
    const cycle = [
      turnStarted(0),
      event("tool.requested", 1),
      task(2),
      turnCompleted(3, ritual(false)),
      recoveredTurnStarted(4),
      event("tool.requested", 5),
      status(6),
      turnCompleted(7, ritual(false)),
      recoveredTurnStarted(8),
      event("tool.requested", 9),
      turnCompleted(10, ritual(true)),
    ];

    expect(
      verdict("claude-code", cycle, {
        stop_hook_active: true,
        status_box_present_strict: false,
      }),
    ).toMatchObject({ allow: true, rule: "stop-hook.pass" });

    const nextPrompt = [
      ...cycle,
      turnStarted(11),
      event("tool.requested", 12),
      status(13),
      turnCompleted(14, ritual(true)),
    ];
    expect(
      verdict("claude-code", nextPrompt, {
        stop_hook_active: false,
        status_box_present_strict: true,
      }),
    ).toMatchObject({ allow: false, rule: "stop-hook.rule_3_3" });
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

function verdict(
  adapter: "claude-code" | "cursor",
  events: EventV3[],
  request: { stop_hook_active?: boolean; status_box_present_strict?: boolean } = {},
) {
  return evaluateStopHookV3Events(
    root(),
    {
      rule: "stop-hook",
      instance_id: "operator",
      adapter,
      now_ms: Math.max(...events.map((event) => Date.parse(event.time.observed_at))) + 1_000,
      ...request,
    },
    events,
  );
}

function recoveredTurnStarted(second: number): EventV3 {
  const value = turnStarted(second);
  fixtureObject(value.provenance).source_event = "claude-code.recovery";
  fixtureObject(value.provenance).attestation = "derived";
  return value;
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
