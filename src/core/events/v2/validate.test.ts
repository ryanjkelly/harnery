import { describe, expect, test } from "bun:test";
import { buildEventV2 } from "./builder.ts";
import { fingerprintV2 } from "./canonical.ts";
import { attestationIdV2, eventIdV2, generationIdV2, spanIdV2 } from "./ids.ts";
import { validateEventV2 } from "./validate.ts";

const generationId = generationIdV2();
const attestationId = attestationIdV2();
const producer = {
  producer_id: "prd_fixture",
  boot_id: "boot_fixture",
  sequence: 1,
  component: "agent-coord" as const,
  build_id: "build_fixture",
  platform: "linux" as const,
};
const scope = {
  root_id: "root_fixture",
  instance_id: "inst_actor",
  session_id: `sid_${"a".repeat(64)}` as const,
  generation_id: generationId,
};
const provenance = {
  source_event: "agent-coord.lifecycle",
  attestation: "native" as const,
  confidence: "exact" as const,
  attribution: {
    method: "explicit_argument" as const,
    state: "verified" as const,
    subject_instance_id: "inst_actor",
  },
};

describe("event ledger V2 semantic validation", () => {
  test("rejects self-causal rows", () => {
    const eventId = eventIdV2();
    const event = buildEventV2("coord.status_observed", {
      event_id: eventId,
      producer,
      scope,
      attestation_id: attestationId,
      links: { caused_by: [eventId] },
      provenance,
      payload: {
        observer_instance_id: "inst_actor",
        subject_instance_id: "inst_subject",
        status: "active",
      },
    });

    expect(validateEventV2(event).issues).toContain("/links/caused_by:self_reference");
  });

  test("requires durable transaction identity for authority transitions", () => {
    const event = buildEventV2("coord.lifecycle_changed", {
      producer,
      scope,
      attestation_id: attestationId,
      links: { caused_by: [] },
      provenance,
      payload: {
        actor_instance_id: "inst_actor",
        subject_instance_id: "inst_subject",
        new_state: "done",
        reason: "operator_transition",
        authority: {},
      },
    });

    expect(validateEventV2(event).issues).toContain(
      "/payload/authority/transaction_id:required_for_authority_transition",
    );
  });

  test("rejects parent traversal in durable artifact paths", () => {
    const event = buildEventV2("artifact.observed", {
      producer,
      scope,
      attestation_id: attestationId,
      links: { caused_by: [] },
      provenance,
      payload: {
        artifact: {
          artifact_id: "art_fixture",
          kind: "test_report",
          media_type: "text/plain",
          bytes: 10,
          retention_class: "workspace",
          integrity: fingerprintV2(
            {
              epochId: "pep_fixture",
              epochKey: Buffer.alloc(32, 0x44),
              rootId: "root_fixture",
              generationId,
            },
            "artifact",
            "fixture",
          ),
          workspace_path: "../outside.txt",
        },
        operation: "created",
      },
    });

    expect(validateEventV2(event).ok).toBeFalse();
  });

  test("allows only safe workspace-relative target displays", () => {
    const fingerprint = fingerprintV2(
      {
        epochId: "pep_fixture",
        epochKey: Buffer.alloc(32, 0x44),
        rootId: "root_fixture",
        generationId,
      },
      "target",
      "fixture",
    );
    const event = buildEventV2("tool.requested", {
      producer,
      scope: { ...scope, turn_id: `tid_${"d".repeat(64)}` },
      attestation_id: attestationId,
      links: { caused_by: [], span_id: spanIdV2() },
      provenance,
      payload: {
        tool: { namespace: "fixture", name: "Read" },
        input: { storage: "omitted", media_type: "application/json", bytes: 1 },
        exact_input: fingerprint,
        targets: [
          {
            kind: "external_path",
            access: "read",
            display: "/home/operator/secret.txt",
            fingerprint,
            extractor_version: "fixture-v1",
          },
          {
            kind: "workspace_path",
            access: "read",
            display: "../escape.txt",
            fingerprint,
            extractor_version: "fixture-v1",
          },
        ],
      },
    });

    expect(validateEventV2(event).issues).toEqual([
      "/payload/targets/0/display:forbidden_for_target_kind",
      "/payload/targets/1/display:workspace_path_invalid",
    ]);
  });

  const turnScope = { ...scope, turn_id: `tid_${"d".repeat(64)}` as const };
  const derivedProvenance = { ...provenance, attestation: "derived" as const };
  const toolCompletedPayload = {
    tool: { namespace: "fixture", name: "Read" },
    outcome: "unknown" as const,
    duration_ms: { state: "unknown" as const, reason: "not_observed" },
    result: { storage: "omitted" as const, media_type: "application/json", bytes: 0 },
  };
  const commandCompletedPayload = {
    outcome: "unknown" as const,
    duration_ms: 0,
  };

  function toolCompleted(overrides: {
    provenance?: typeof provenance | typeof derivedProvenance;
    payload?: Record<string, unknown>;
  }) {
    return buildEventV2("tool.completed", {
      producer,
      scope: turnScope,
      attestation_id: attestationId,
      links: { caused_by: [], span_id: spanIdV2() },
      provenance: overrides.provenance ?? provenance,
      payload: { ...toolCompletedPayload, ...overrides.payload } as never,
    });
  }

  test("requires recovery on derived tool events and forbids it on native ones", () => {
    expect(validateEventV2(toolCompleted({ provenance: derivedProvenance })).issues).toContain(
      "/payload/recovery:required_for_derived_tool_event",
    );
    expect(
      validateEventV2(
        toolCompleted({
          payload: { recovery: { reason: "completion_not_observed_before_turn_end" } },
        }),
      ).issues,
    ).toContain("/payload/recovery:requires_derived_attestation");
    expect(
      validateEventV2(
        toolCompleted({
          provenance: derivedProvenance,
          payload: { recovery: { reason: "completion_not_observed_before_turn_end" } },
        }),
      ).ok,
    ).toBeTrue();
  });

  test("pins recovered completions to an unknown outcome", () => {
    expect(
      validateEventV2(
        toolCompleted({
          provenance: derivedProvenance,
          payload: {
            outcome: "succeeded",
            recovery: { reason: "explicit_end_salvage", requested_event_id: eventIdV2() },
          },
        }),
      ).issues,
    ).toContain("/payload/outcome:recovery_requires_unknown_outcome");
  });

  test("binds recovery reasons to their event types", () => {
    expect(
      validateEventV2(
        toolCompleted({
          provenance: derivedProvenance,
          payload: { recovery: { reason: "request_not_observed" } },
        }),
      ).issues,
    ).toContain("/payload/recovery/reason:invalid_for_tool_completed");

    const derivedRequest = buildEventV2("tool.requested", {
      producer,
      scope: turnScope,
      attestation_id: attestationId,
      links: { caused_by: [], span_id: spanIdV2() },
      provenance: derivedProvenance,
      payload: {
        tool: { namespace: "fixture", name: "Read" },
        input: { storage: "omitted", media_type: "application/json", bytes: 1 },
        exact_input: fingerprintV2(
          {
            epochId: "pep_fixture",
            epochKey: Buffer.alloc(32, 0x44),
            rootId: "root_fixture",
            generationId,
          },
          "input",
          "fixture",
        ),
        targets: [],
        recovery: { reason: "request_not_observed", requested_event_id: eventIdV2() },
      },
    });
    expect(validateEventV2(derivedRequest).issues).toContain(
      "/payload/recovery/requested_event_id:forbidden_on_derived_request",
    );
  });

  test("recovered commands carry zero duration, no exit code, and the command reason", () => {
    const command = (payload: Record<string, unknown>) =>
      buildEventV2("command.completed", {
        producer: { ...producer, component: "session-tee" as const },
        scope: turnScope,
        attestation_id: attestationId,
        links: { caused_by: [], span_id: spanIdV2() },
        provenance: derivedProvenance,
        payload: { ...commandCompletedPayload, ...payload } as never,
      });

    expect(validateEventV2(command({})).ok).toBeTrue();
    expect(
      validateEventV2(command({ recovery: { reason: "command_completion_not_observed" } })).ok,
    ).toBeTrue();
    expect(
      validateEventV2(
        command({
          duration_ms: 12,
          exit_code: 1,
          recovery: { reason: "explicit_end_salvage" },
        }),
      ).issues,
    ).toEqual([
      "/payload/recovery/reason:invalid_for_command_completed",
      "/payload/duration_ms:recovery_requires_zero_duration",
      "/payload/exit_code:forbidden_on_recovered_command",
    ]);
  });
});
