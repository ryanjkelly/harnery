import { describe, expect, test } from "bun:test";

import { buildEventV3 } from "../../../src/core/events/v3/builder";
import { fingerprintV3, sha256V3 } from "../../../src/core/events/v3/canonical";
import type { EventTypeV3 } from "../../../src/core/events/v3/contract";
import {
  attestationIdV3,
  eventIdV3,
  generationIdV3,
  spanIdV3,
} from "../../../src/core/events/v3/ids";
import { categorizeOperation, categorizeTool, sanitizeEvent, sanitizeLine } from "./sanitize";

const BASE = {
  schema_version: 1,
  event_id: "01J0000000000000000000000",
  ts: "2026-08-16T10:00:00.000Z",
  instance_id: "inst-1",
  session_id: "sess-1",
  adapter: "claude-code",
  source: "agent-hooks",
};

/** Sentinels that must never survive sanitization. */
const SECRET_PROMPT = "SENTINEL_PROMPT_BODY";
const SECRET_INPUT = "SENTINEL_TOOL_INPUT";

describe("sanitizeEvent", () => {
  test("rejects non-V3 rows, unknown types, and unsupported schema versions", () => {
    expect(
      sanitizeEvent({
        ...BASE,
        event_type: "tool.requested",
        data: { tool_name: "Read", intent: "read the schema" },
      }),
    ).toBeNull();
    expect(
      sanitizeEvent({ ...BASE, event_type: "council.contribution", data: { body_summary: "x" } }),
    ).toBeNull();
    expect(
      sanitizeEvent({ ...BASE, schema_version: 2, event_type: "turn.completed", data: {} }),
    ).toBeNull();
    expect(sanitizeEvent(null)).toBeNull();
    expect(sanitizeEvent("row")).toBeNull();
  });

  test("sanitizeLine drops malformed rows silently", () => {
    expect(sanitizeLine("")).toBeNull();
    expect(sanitizeLine("{not json")).toBeNull();
  });

  test("validates and maps V3 lifecycle, tool, command, and context evidence", () => {
    const started = sanitizeEvent(v3Event("session.started", startedPayload()));
    expect(started).toMatchObject({ event_type: "session.started", instance_id: "inst_fixture" });

    const requested = sanitizeEvent(
      v3Event(
        "tool.requested",
        {
          tool: { namespace: "fixture", name: "Read" },
          input: { storage: "omitted", media_type: "application/json", bytes: 42 },
          exact_input: fixtureFingerprint("input"),
          targets: [],
        },
        true,
      ),
    );
    expect(requested).toMatchObject({
      event_type: "tool.requested",
      tool_name: "Read",
      category: "research",
      outcome: "started",
    });

    const completed = sanitizeEvent(
      v3Event(
        "tool.completed",
        {
          tool: { namespace: "fixture", name: "Edit" },
          outcome: "failed",
          duration_ms: { state: "unknown", reason: "not_reported" },
          span: fixtureSpan({ state: "unknown", reason: "not_reported" }),
          result: { storage: "omitted", media_type: "text/plain", bytes: 0 },
          error: { class: "tool_error" },
        },
        true,
      ),
    );
    expect(completed).toMatchObject({
      event_type: "tool.completed",
      category: "edit",
      outcome: "error",
    });

    const lifecycle = sanitizeEvent(
      v3Event("coord.lifecycle_changed", {
        actor_instance_id: "inst_fixture",
        subject_instance_id: "inst_fixture",
        new_state: "blocked",
        reason: "dependency_wait",
        reason_fingerprint: fixtureFingerprint(SECRET_PROMPT),
        authority: { transaction_id: "txn_11111111-1111-4111-8111-111111111111" },
      }),
    );
    expect(lifecycle).toMatchObject({
      event_type: "coord.lifecycle_changed",
      task_state: "blocked",
    });
    expect(JSON.stringify(lifecycle)).not.toContain(SECRET_PROMPT);

    const context = sanitizeEvent(
      v3Event("context.observed", {
        measurement: {
          state: "observed",
          value: {
            used_tokens: 750,
            limit_tokens: 1000,
            measured_at: "2026-08-16T10:00:00.000Z",
            method: "native_hook",
          },
          attestation: "native",
          confidence: "exact",
        },
      }),
    );
    expect(context).toMatchObject({
      event_type: "context.observed",
      used_percent: 75,
      context_confidence: "exact",
    });
  });

  test("does not treat command intent_kind as operator-visible intent", () => {
    const command = sanitizeEvent(
      v3Event(
        "command.started",
        {
          executable: "rg",
          executable_class: "cli",
          exact_command: fixtureFingerprint("argv"),
          intent_kind: "build",
          intent_length: 12,
          sensitive_argument_count: 0,
        },
        { tool: true },
      ),
    );
    expect(command).toMatchObject({
      event_type: "command.started",
      category: "diagnostic",
      outcome: "started",
    });
    expect(command?.intent).toBeUndefined();
    expect(JSON.stringify(command)).not.toContain("build");
  });

  test("lifts only privacy-safe span, output, target, artifact, and telemetry scalars", () => {
    const requested = sanitizeEvent(
      v3Event(
        "tool.requested",
        {
          tool: { namespace: "functions", name: "apply_patch" },
          input: { storage: "omitted", media_type: "application/json", bytes: 900 },
          exact_input: fixtureFingerprint("private patch body"),
          targets: [
            {
              kind: "workspace_path",
              access: "write",
              display: SECRET_INPUT,
              fingerprint: fixtureFingerprint("private target path"),
              extractor_version: "fixture",
            },
          ],
        },
        true,
      ),
    );
    expect(requested).toMatchObject({
      event_type: "tool.requested",
      tool_namespace: "functions",
      tool_name: "apply_patch",
      category: "edit",
      target_kind: "workspace_path",
      target_access: "write",
    });
    expect(requested?.span_id).toMatch(/^span_/);
    expect(requested?.operation_fingerprint?.digest).toMatch(/^sha256:/);
    expect(requested?.target_fingerprint?.digest).toMatch(/^sha256:/);
    expect(JSON.stringify(requested)).not.toContain(SECRET_INPUT);
    expect(JSON.stringify(requested)).not.toContain("private patch body");
    expect(JSON.stringify(requested)).not.toContain("private target path");

    const output = sanitizeEvent(
      v3Event(
        "command.output_observed",
        {
          stream: "combined",
          bytes: 512,
          lines: 12,
          content_fingerprint: fixtureFingerprint(SECRET_INPUT),
        },
        { tool: true },
      ),
    );
    expect(output).toMatchObject({
      event_type: "command.output_observed",
      output_stream: "combined",
      output_bytes: 512,
      output_lines: 12,
    });
    expect(JSON.stringify(output)).not.toContain(SECRET_INPUT);

    const artifact = sanitizeEvent(
      v3Event("artifact.observed", {
        artifact: {
          artifact_id: "art_fixture",
          kind: "report",
          media_type: "text/markdown",
          bytes: 2048,
          retention_class: "workspace",
          workspace_path: SECRET_INPUT,
        },
        operation: "published",
      }),
    );
    expect(artifact).toMatchObject({
      artifact_kind: "report",
      artifact_operation: "published",
    });
    expect(JSON.stringify(artifact)).not.toContain(SECRET_INPUT);

    const drift = sanitizeEvent(
      v3Event("health.capability_drift", {
        signal: "tool_spans",
        promised: "native",
        expected_count: 3,
        observed_count: 2,
        generation_ended: true,
      }),
    );
    expect(drift?.telemetry_issue).toBe("capability-drift");
  });

  test("maps waits, recovery, subject instance, and generation parentage", () => {
    const parentGen = generationId;
    const childGen = generationIdV3();
    const wait = sanitizeEvent(
      v3Event("wait.started", { wait_id: "wait_perm", kind: "permission" }),
    );
    expect(wait).toMatchObject({ event_type: "wait.started" });

    const waitEnded = sanitizeEvent(
      v3Event("wait.ended", {
        wait_id: "wait_perm",
        outcome: "succeeded",
        span: fixtureSpan({
          state: "observed",
          value: 10,
          attestation: "derived",
          confidence: "high",
        }),
      }),
    );
    expect(waitEnded).toMatchObject({ event_type: "wait.ended" });

    const progress = sanitizeEvent(
      v3Event("progress.observed", {
        kind: "write",
        evidence_event_ids: [eventIdV3()],
        reducer_build_id: "build_fixture",
      }),
    );
    expect(progress).toMatchObject({
      event_type: "progress.observed",
      category: "edit",
      outcome: "ok",
    });

    const childStart = sanitizeEvent(
      v3Event("session.started", startedPayload(), {
        instanceId: "inst_child",
        parentGenerationId: parentGen,
        generationId: childGen,
      }),
    );
    expect(childStart).toMatchObject({
      event_type: "session.started",
      instance_id: "inst_child",
      generation_id: childGen,
      parent_generation_id: parentGen,
    });
    expect(childStart?.parent_session_id).toBeUndefined();

    const delegated = sanitizeEvent(
      v3Event("agent.started", {
        delegation_id: `del_${generationIdV3().slice(4)}`,
        child_generation_id: childGen,
        role: "explore",
      }),
    );
    expect(delegated).toMatchObject({
      event_type: "agent.started",
      child_generation_id: childGen,
    });

    const recovered = sanitizeEvent(
      v3Event("lifecycle.recovered", {
        subject_instance_id: "inst_subject",
        recovery_kind: "span_salvage",
        new_digest: `sha256:${"a".repeat(64)}`,
      }),
    );
    expect(recovered).toMatchObject({
      instance_id: "inst_subject",
      recovered: true,
    });

    const requestedEventId = eventIdV3();
    const recoveredTerminal = sanitizeEvent(
      v3Event(
        "tool.completed",
        {
          tool: { namespace: "codex", name: "apply_patch" },
          outcome: "unknown",
          duration_ms: {
            state: "unknown",
            reason: "completion_not_observed_before_turn_end",
          },
          span: fixtureSpan({
            state: "unknown",
            reason: "completion_not_observed_before_turn_end",
          }),
          result: { storage: "omitted", media_type: "application/json", bytes: 0 },
          recovery: {
            reason: "completion_not_observed_before_turn_end",
            requested_event_id: requestedEventId,
          },
        },
        { tool: true, attestation: "derived" },
      ),
    );
    expect(recoveredTerminal).toMatchObject({
      recovered: true,
      recovery_reason: "completion_not_observed_before_turn_end",
      recovery_requested_event_id: requestedEventId,
    });

    const staleTerm = sanitizeEvent(
      v3Event("session.termination_observed", {
        observation: "stale",
        observer_instance_id: "inst_fixture",
        subject_instance_id: "inst_subject",
        provisional: true,
        reason: "idle_timeout",
      }),
    );
    expect(staleTerm).toBeNull();

    const killed = sanitizeEvent(
      v3Event("session.termination_observed", {
        observation: "killed",
        observer_instance_id: "inst_fixture",
        subject_instance_id: "inst_subject",
        provisional: true,
        reason: "host_killed",
      }),
    );
    expect(killed).toMatchObject({
      event_type: "session.termination_observed",
      instance_id: "inst_subject",
    });
  });

  test("rejects V3 lookalikes, unknown digests, and forbidden extra payload fields", () => {
    expect(
      sanitizeEvent({
        contract: { name: "harnery.event", major: 2, schema_digest: sha256V3("foreign") },
        event_type: "session.started",
      }),
    ).toBeNull();
    const valid = v3Event(
      "tool.requested",
      {
        tool: { namespace: "fixture", name: "Read" },
        input: { storage: "omitted", media_type: "application/json", bytes: 1 },
        exact_input: fixtureFingerprint("input"),
        targets: [],
      },
      true,
    );
    const smuggled = {
      ...valid,
      payload: { ...valid.payload, raw_input: SECRET_INPUT },
    };
    expect(sanitizeEvent(smuggled)).toBeNull();
  });
});

describe("categorizeTool", () => {
  test("maps known tools and falls back to other", () => {
    expect(categorizeTool("Grep")).toBe("research");
    expect(categorizeTool("Write")).toBe("edit");
    expect(categorizeTool("Workflow")).toBe("coordinate");
    expect(categorizeTool("SomeNewTool")).toBe("other");
    expect(categorizeTool(undefined)).toBe("other");
  });
});

describe("categorizeOperation", () => {
  test("classifies representative Claude Code, Codex, and Cursor V3 rows", () => {
    const fixtures = [
      { adapter: "claude-code", name: "Read", expected: "research" },
      { adapter: "claude-code", name: "Edit", expected: "edit" },
      { adapter: "claude-code", name: "Bash", expected: "diagnostic" },
      { adapter: "codex", name: "apply_patch", expected: "edit" },
      { adapter: "codex", name: "exec_command", expected: "diagnostic" },
      { adapter: "codex", name: "view_image", expected: "research" },
      { adapter: "cursor", name: "Write", expected: "edit" },
      { adapter: "cursor", name: "StrReplace", expected: "edit" },
      { adapter: "cursor", name: "Shell", expected: "diagnostic" },
      { adapter: "cursor", name: "list_dir", expected: "research" },
    ] as const;

    for (const fixture of fixtures) {
      const sanitized = sanitizeEvent(
        v3Event(
          "tool.requested",
          {
            tool: { namespace: fixture.adapter, name: fixture.name },
            input: { storage: "omitted", media_type: "application/json", bytes: 0 },
            exact_input: fixtureFingerprint(`${fixture.adapter}:${fixture.name}`),
            targets: [],
          },
          true,
        ),
      );
      expect(sanitized?.category).toBe(fixture.expected);
      expect(sanitized?.tool_namespace).toBe(fixture.adapter);
      expect(sanitized?.tool_name).toBe(fixture.name);
    }

    expect(categorizeOperation("cursor", "unknown_future_tool")).toBe("other");
  });
});

const generationId = generationIdV3();
const attestationId = attestationIdV3();

function v3Event(
  eventType: EventTypeV3,
  payload: Record<string, unknown>,
  opts:
    | boolean
    | {
        tool?: boolean;
        attestation?: "native" | "derived";
        instanceId?: string;
        parentGenerationId?: string;
        generationId?: string;
      } = false,
) {
  const options = typeof opts === "boolean" ? { tool: opts } : opts;
  const tool = options.tool === true;
  const instanceId = options.instanceId ?? "inst_fixture";
  const eventGenerationId = options.generationId ?? generationId;
  const eventId = eventIdV3();
  const needsTurn =
    tool ||
    eventType.startsWith("command.") ||
    eventType === "tool.requested" ||
    eventType === "tool.completed" ||
    eventType === "agent.started";
  const eventSpanId = spanIdV3();
  const boundPayload =
    eventType === "session.started"
      ? {
          ...payload,
          runtime_attestation: {
            ...(payload.runtime_attestation as Record<string, unknown>),
            generation_id: eventGenerationId,
            declared_by_event_id: eventId,
          },
        }
      : "span" in payload
        ? {
            ...payload,
            span: { ...(payload.span as Record<string, unknown>), span_id: eventSpanId },
          }
        : payload;
  return buildEventV3(eventType, {
    event_id: eventId,
    producer: {
      producer_id: "prd_codec-fixture",
      boot_id: "boot_fixture",
      sequence: 1,
      component: "agent-hook",
      build_id: "build_fixture",
      platform: "linux",
    },
    scope: {
      root_id: "root_fixture",
      instance_id: instanceId,
      session_id: `sid_${"a".repeat(64)}`,
      generation_id: eventGenerationId,
      ...(needsTurn ? { turn_id: `tid_${"b".repeat(64)}` } : {}),
    },
    attestation_id: attestationId,
    links: {
      caused_by: [],
      ...(needsTurn ? { span_id: eventSpanId } : {}),
      ...(eventType === "agent.started" ? { parent_span_id: spanIdV3() } : {}),
      ...(options.parentGenerationId ? { parent_generation_id: options.parentGenerationId } : {}),
    },
    provenance: {
      source_event: "fixture.codec",
      // Native mirrors production hook tool events; ADR 0078 forbids derived
      // tool events that carry no recovery block.
      attestation: options.attestation ?? "native",
      confidence: "exact",
      attribution: {
        method: "explicit_argument",
        state: "verified",
        observer_instance_id: instanceId,
        subject_instance_id: instanceId,
      },
    },
    observed_at: "2026-08-16T10:00:00.000Z",
    recorded_at: "2026-08-16T10:00:00.000Z",
    payload: boundPayload,
  } as never);
}

function fixtureSpan(duration_ms: Record<string, unknown>) {
  return {
    span_id: spanIdV3(),
    opened_at: "2026-08-16T09:59:59.000Z",
    duration_ms,
  };
}

function fixtureFingerprint(value: string) {
  return fingerprintV3(
    {
      epochId: "pep_fixture",
      epochKey: Buffer.alloc(32, 0x43),
      rootId: "root_fixture",
      generationId,
    },
    "codec-fixture",
    value,
  );
}

function startedPayload() {
  return {
    runtime_attestation: {
      attestation_id: attestationId,
      generation_id: generationId,
      adapter: {
        state: "observed",
        value: { id: "claude-code" },
        attestation: "native",
        confidence: "exact",
      },
      harness: {
        state: "observed",
        value: { id: "fixture" },
        attestation: "native",
        confidence: "exact",
      },
      model: { state: "unsupported", capability: "model_identity" },
      capability_profile: `cap_${"c".repeat(64)}`,
      declared_by_event_id: "evt_00000000-0000-7000-8000-000000000000",
    },
    resume: { state: "not_applicable" },
  };
}
