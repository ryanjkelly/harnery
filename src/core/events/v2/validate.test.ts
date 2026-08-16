import { describe, expect, test } from "bun:test";
import { buildEventV2 } from "./builder.ts";
import { fingerprintV2 } from "./canonical.ts";
import { attestationIdV2, eventIdV2, generationIdV2 } from "./ids.ts";
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
});
