import { describe, expect, test } from "bun:test";

import { buildEventV2 } from "../../../src/core/events/v2/builder";
import { fingerprintV2, sha256V2 } from "../../../src/core/events/v2/canonical";
import type { EventTypeV2 } from "../../../src/core/events/v2/contract";
import {
  attestationIdV2,
  eventIdV2,
  generationIdV2,
  spanIdV2,
} from "../../../src/core/events/v2/ids";
import { categorizeTool, sanitizeEvent, sanitizeLine } from "./sanitize";

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
const SECRET_OUTPUT = "SENTINEL_TOOL_OUTPUT";
const SECRET_ERROR = "SENTINEL_ERROR_BODY";
const SECRET_CMD = "SENTINEL_COMMAND_BODY";

describe("sanitizeEvent", () => {
  test("drops unknown event types and unsupported schema versions", () => {
    expect(
      sanitizeEvent({ ...BASE, event_type: "council.contribution", data: { body_summary: "x" } }),
    ).toBeNull();
    expect(
      sanitizeEvent({ ...BASE, schema_version: 2, event_type: "turn.stop", data: {} }),
    ).toBeNull();
    expect(sanitizeEvent(null)).toBeNull();
    expect(sanitizeEvent("row")).toBeNull();
  });

  test("tool events keep name/category/outcome and drop inputs and outputs", () => {
    const pre = sanitizeEvent({
      ...BASE,
      event_type: "tool.pre_use",
      data: { tool_name: "Read", tool_input: SECRET_INPUT, intent: "read the schema" },
    });
    expect(pre).toMatchObject({
      tool_name: "Read",
      category: "research",
      outcome: "started",
      intent: "read the schema",
    });

    const post = sanitizeEvent({
      ...BASE,
      event_type: "tool.post_use",
      data: { tool_name: "Edit", output_summary: SECRET_OUTPUT, exit_status: "error" },
    });
    expect(post).toMatchObject({ tool_name: "Edit", category: "edit", outcome: "error" });

    const failure = sanitizeEvent({
      ...BASE,
      event_type: "tool.post_use_failure",
      data: { tool_name: "Bash", error: SECRET_ERROR, duration_ms: 5 },
    });
    expect(failure).toMatchObject({ tool_name: "Bash", category: "diagnostic", outcome: "error" });

    for (const evidence of [pre, post, failure]) {
      expect(JSON.stringify(evidence)).not.toContain("SENTINEL");
    }
  });

  test("prompts and commands cross as envelope-only / bounded-intent evidence", () => {
    const prompt = sanitizeEvent({
      ...BASE,
      event_type: "user_prompt.submit",
      data: { prompt_text: SECRET_PROMPT },
    });
    expect(prompt).not.toBeNull();
    expect(JSON.stringify(prompt)).not.toContain(SECRET_PROMPT);

    const command = sanitizeEvent({
      ...BASE,
      event_type: "command.start",
      data: { cmd_id: "c1", cmd: SECRET_CMD, intent: "check peers" },
    });
    expect(command).toMatchObject({
      category: "diagnostic",
      outcome: "started",
      intent: "check peers",
    });
    expect(JSON.stringify(command)).not.toContain(SECRET_CMD);
  });

  test("labels are clamped to the bounded length", () => {
    const long = "x".repeat(500);
    const taskSet = sanitizeEvent({
      ...BASE,
      event_type: "state.task_set",
      data: { task: long, cleared: false },
    });
    expect(taskSet?.task?.length).toBeLessThanOrEqual(120);
  });

  test("context, task state, and identity lift only their allowed scalars", () => {
    const ctx = sanitizeEvent({
      ...BASE,
      event_type: "context.sampled",
      data: { used_percent: 71, confidence: "reported", model: "m", used_tokens: 1 },
    });
    expect(ctx).toMatchObject({ used_percent: 71, context_confidence: "reported" });
    expect(JSON.stringify(ctx)).not.toContain("used_tokens");

    const state = sanitizeEvent({
      ...BASE,
      event_type: "state.task_state",
      data: { state: "blocked", reason: "waiting on a docket ruling about credentials" },
    });
    expect(state).toMatchObject({ task_state: "blocked" });
    expect(JSON.stringify(state)).not.toContain("docket ruling");

    const identity = sanitizeEvent({
      ...BASE,
      event_type: "identity.assumed",
      data: { name: "Sara", agent_id: "a1" },
    });
    expect(identity).toMatchObject({ identity_name: "Sara" });
  });

  test("state.ping lifts the recipient id and drops the message body", () => {
    const ping = sanitizeEvent({
      ...BASE,
      event_type: "state.ping",
      data: { peer_instance_id: "inst-2", peer_name: "Tony", body_summary: SECRET_PROMPT },
    });
    expect(ping).toMatchObject({ ping_to: "inst-2" });
    expect(JSON.stringify(ping)).not.toContain(SECRET_PROMPT);
    expect(JSON.stringify(ping)).not.toContain("Tony");
  });

  test("sanitizeLine drops malformed rows silently", () => {
    expect(sanitizeLine("")).toBeNull();
    expect(sanitizeLine("{not json")).toBeNull();
  });

  test("validates and maps V2 lifecycle, tool, command, and context evidence", () => {
    const started = sanitizeEvent(v2Event("session.started", startedPayload()));
    expect(started).toMatchObject({ event_type: "session.start", instance_id: "inst_fixture" });

    const requested = sanitizeEvent(
      v2Event(
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
      event_type: "tool.pre_use",
      tool_name: "Read",
      category: "research",
      outcome: "started",
    });

    const completed = sanitizeEvent(
      v2Event(
        "tool.completed",
        {
          tool: { namespace: "fixture", name: "Edit" },
          outcome: "failed",
          duration_ms: { state: "unknown", reason: "not_reported" },
          result: { storage: "omitted", media_type: "text/plain", bytes: 0 },
          error: { class: "tool_error" },
        },
        true,
      ),
    );
    expect(completed).toMatchObject({
      event_type: "tool.post_use",
      category: "edit",
      outcome: "error",
    });

    const lifecycle = sanitizeEvent(
      v2Event("coord.lifecycle_changed", {
        actor_instance_id: "inst_fixture",
        subject_instance_id: "inst_fixture",
        new_state: "blocked",
        reason: "dependency_wait",
        reason_fingerprint: fixtureFingerprint(SECRET_PROMPT),
        authority: { transaction_id: "txn_11111111-1111-4111-8111-111111111111" },
      }),
    );
    expect(lifecycle).toMatchObject({ event_type: "state.task_state", task_state: "blocked" });
    expect(JSON.stringify(lifecycle)).not.toContain(SECRET_PROMPT);

    const context = sanitizeEvent(
      v2Event("context.observed", {
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
      event_type: "context.sampled",
      used_percent: 75,
      context_confidence: "exact",
    });
  });

  test("rejects V2 lookalikes, unknown digests, and forbidden extra payload fields", () => {
    expect(
      sanitizeEvent({
        contract: { name: "harnery.event", major: 2, schema_digest: sha256V2("foreign") },
        event_type: "session.started",
      }),
    ).toBeNull();
    const valid = v2Event(
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

const generationId = generationIdV2();
const attestationId = attestationIdV2();

function v2Event(eventType: EventTypeV2, payload: Record<string, unknown>, tool = false) {
  const eventId = eventIdV2();
  const boundPayload =
    eventType === "session.started"
      ? {
          ...payload,
          runtime_attestation: {
            ...(payload.runtime_attestation as Record<string, unknown>),
            declared_by_event_id: eventId,
          },
        }
      : payload;
  return buildEventV2(eventType, {
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
      instance_id: "inst_fixture",
      session_id: `sid_${"a".repeat(64)}`,
      generation_id: generationId,
      ...(tool ? { turn_id: `tid_${"b".repeat(64)}` } : {}),
    },
    attestation_id: attestationId,
    links: { caused_by: [], ...(tool ? { span_id: spanIdV2() } : {}) },
    provenance: {
      source_event: "fixture.codec",
      attestation: "derived",
      confidence: "exact",
      attribution: {
        method: "explicit_argument",
        state: "verified",
        observer_instance_id: "inst_fixture",
        subject_instance_id: "inst_fixture",
      },
    },
    observed_at: "2026-08-16T10:00:00.000Z",
    recorded_at: "2026-08-16T10:00:00.000Z",
    payload: boundPayload,
  } as never);
}

function fixtureFingerprint(value: string) {
  return fingerprintV2(
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
