import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAuthorityTransactionV2 } from "../authority-outbox.ts";
import { canonicalJsonV2, sha256V2 } from "../canonical.ts";
import { attestationIdV2, generationIdV2 } from "../ids.ts";
import { validateEventV2 } from "../validate.ts";
import {
  type CoordinationProducerContextV2,
  type NormalizedCoordinationAuthorityV2,
  normalizeCoordinationAuthorityV2,
} from "./coordination.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 coordination producer", () => {
  test("fingerprints task and claim values at root scope without retaining their literals", () => {
    const taskText = "Investigate customer token SECRET_TASK_123";
    const task = normalizeCoordinationAuthorityV2(
      "task-changed",
      { native_observation_id: "native-task-1", state: "set", task: taskText },
      context("txn_11111111-1111-4111-8111-111111111111"),
    );
    expect(validateEventV2(task.event).ok).toBe(true);
    expect(task.mutation.kind).toBe("task.transition");
    if (task.event.event_type !== "coord.task_changed") throw new Error("unexpected event type");
    expect(task.event.payload.reason_fingerprint?.scope).toBe("root");
    expect(canonicalJsonV2(task)).not.toContain(taskText);

    const claimTarget = "private/customer-secrets.txt";
    const claim = normalizeCoordinationAuthorityV2(
      "claim-changed",
      {
        native_observation_id: "native-claim-1",
        operation: "acquired",
        target: { kind: "workspace_path", value: claimTarget },
        access: "write",
      },
      context("txn_22222222-2222-4222-8222-222222222222"),
    );
    expect(validateEventV2(claim.event).ok).toBe(true);
    expect(claim.mutation.kind).toBe("claim.acquire");
    if (claim.event.event_type !== "coord.claim_changed") throw new Error("unexpected event type");
    expect(claim.event.payload.target.scope).toBe("root");
    expect(canonicalJsonV2(claim)).not.toContain(claimTarget);
  });

  test("produces an outbox-bound event and mutation for every authority signal", () => {
    const cases = [
      normalizeCoordinationAuthorityV2(
        "task-changed",
        { native_observation_id: "task", state: "cleared" },
        context("txn_31000000-0000-4000-8000-000000000001"),
      ),
      normalizeCoordinationAuthorityV2(
        "lifecycle-changed",
        { native_observation_id: "lifecycle", state: "blocked", reason_code: "dependency_wait" },
        context("txn_31000000-0000-4000-8000-000000000002"),
      ),
      normalizeCoordinationAuthorityV2(
        "claim-changed",
        {
          native_observation_id: "claim",
          operation: "released",
          target: "src/fixture.ts",
          access: "write",
        },
        context("txn_31000000-0000-4000-8000-000000000003"),
      ),
      normalizeCoordinationAuthorityV2(
        "identity-attested",
        {
          native_observation_id: "identity",
          identity_id: "agent_fixture",
          method: "registry",
        },
        context("txn_31000000-0000-4000-8000-000000000004"),
      ),
      normalizeCoordinationAuthorityV2(
        "decision-state-changed",
        {
          native_observation_id: "decision",
          decision_id: "dec_fixture",
          outcome: "approved",
          record_digest: sha256V2("decision-record"),
        },
        context("txn_31000000-0000-4000-8000-000000000005"),
      ),
      normalizeCoordinationAuthorityV2(
        "wait-started",
        { native_observation_id: "wait-start", wait_id: "operator", kind: "operator_input" },
        context("txn_31000000-0000-4000-8000-000000000006"),
      ),
      normalizeCoordinationAuthorityV2(
        "wait-ended",
        { native_observation_id: "wait-end", wait_id: "operator", outcome: "succeeded" },
        context("txn_31000000-0000-4000-8000-000000000007"),
      ),
    ];

    for (const [index, normalized] of cases.entries()) {
      const root = temporaryRoot(`event-v2-coord-${index}`);
      expect(validateEventV2(normalized.event).ok).toBe(true);
      expect(() =>
        prepareAuthorityTransactionV2(root, {
          transaction_id: authorityTransactionId(normalized.event),
          expected_prior_state_digest: sha256V2(`prior-${index}`),
          desired_state_digest: sha256V2(`desired-${index}`),
          actor_instance_id: "inst_operator",
          subject_instance_id: "inst_worker",
          mutation: normalized.mutation,
          event: normalized.event,
        }),
      ).not.toThrow();
    }
  });

  test("rejects actor ambiguity and unsafe durable identifiers", () => {
    expect(() =>
      normalizeCoordinationAuthorityV2(
        "lifecycle-changed",
        { native_observation_id: "lifecycle", state: "done" },
        { ...context("txn_40000000-0000-4000-8000-000000000001"), instance_id: "inst_other" },
      ),
    ).toThrow("must be the authority actor");
    expect(() =>
      normalizeCoordinationAuthorityV2(
        "identity-attested",
        {
          native_observation_id: "identity",
          identity_id: "raw identity with spaces",
          method: "registry",
        },
        context("txn_40000000-0000-4000-8000-000000000002"),
      ),
    ).toThrow("token is invalid");
  });
});

function context(transactionId: `txn_${string}`): CoordinationProducerContextV2 {
  const generationId = generationIdV2();
  return {
    root_id: "root_fixture",
    instance_id: "inst_operator",
    session_id: `sid_${"a".repeat(64)}`,
    generation_id: generationId,
    attestation_id: attestationIdV2(),
    producer_id: "prd_coord-fixture",
    boot_id: "boot_fixture",
    sequence: 1,
    build_id: "build_fixture",
    platform: "linux",
    actor_instance_id: "inst_operator",
    subject_instance_id: "inst_worker",
    transaction_id: transactionId,
    fingerprintContext: {
      epochId: "pep_fixture",
      epochKey: Buffer.alloc(32, 0x54),
      rootId: "root_fixture",
      generationId,
    },
    attribution_method: "explicit_argument",
  };
}

function authorityTransactionId(
  event: NormalizedCoordinationAuthorityV2["event"],
): `txn_${string}` {
  switch (event.event_type) {
    case "coord.task_changed":
    case "coord.lifecycle_changed":
    case "coord.claim_changed":
    case "coord.identity_attested":
    case "decision.state_changed":
      return event.payload.authority.transaction_id as `txn_${string}`;
    case "interaction.wait_started":
      return event.payload.authority_reference as `txn_${string}`;
    case "interaction.wait_ended":
      return event.payload.resolution_reference as `txn_${string}`;
    default:
      throw new Error("unexpected authority event type");
  }
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}
