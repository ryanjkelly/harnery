import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listPendingAuthorityTransactionsV2,
  prepareAuthorityTransactionV2,
  reconcileAuthorityTransactionV2,
} from "./authority-outbox.ts";
import { buildEventV2 } from "./builder.ts";
import { sha256V2 } from "./canonical.ts";
import type { EventV2 } from "./contract.ts";
import { attestationIdV2, eventIdV2, generationIdV2 } from "./ids.ts";
import { readActiveLedgerV2 } from "./reader.ts";
import { eventV2Paths } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 authority outbox", () => {
  test("flushes before mutation and replaces the full transaction with a hash-only receipt", () => {
    const root = temporaryRoot("event-v2-outbox");
    const prior = sha256V2("active");
    const desired = sha256V2("done");
    const event = minimalStartedEvent();
    const transaction = prepareAuthorityTransactionV2(root, {
      expected_prior_state_digest: prior,
      desired_state_digest: desired,
      actor_instance_id: "inst_operator",
      subject_instance_id: "inst_worker",
      mutation: { kind: "lifecycle.transition", state: "done", reason_code: "verified" },
      event,
    });
    expect(listPendingAuthorityTransactionsV2(root)).toHaveLength(1);

    let state = prior;
    const receipt = reconcileAuthorityTransactionV2(root, transaction.transaction_id, {
      readStateDigest: () => state,
      apply: () => {
        expect(listPendingAuthorityTransactionsV2(root)).toHaveLength(1);
        state = desired;
      },
      now: () => new Date("2026-08-16T12:00:00.000Z"),
    });
    expect(receipt.desired_state_digest).toBe(desired);
    expect(listPendingAuthorityTransactionsV2(root)).toEqual([]);
    expect(readActiveLedgerV2(root).events[0]?.event.event_id).toBe(event.event_id);
    const committedPath = join(
      eventV2Paths(root).authorityOutbox,
      `${transaction.transaction_id}.committed.json`,
    );
    const committed = readFileSync(committedPath, "utf8");
    expect(committed).not.toContain('"event_row":');
    expect(committed).not.toContain("lifecycle.transition");
  });

  test("recognizes an already-applied desired state after a crash and does not mutate twice", () => {
    const root = temporaryRoot("event-v2-outbox-replay");
    const prior = sha256V2("prior");
    const desired = sha256V2("desired");
    const transaction = prepareAuthorityTransactionV2(root, {
      expected_prior_state_digest: prior,
      desired_state_digest: desired,
      actor_instance_id: "inst_operator",
      subject_instance_id: "inst_worker",
      mutation: { kind: "identity.assume", identity_id: "persona_verified" },
      event: minimalStartedEvent(),
    });
    let applyCount = 0;
    const receipt = reconcileAuthorityTransactionV2(root, transaction.transaction_id, {
      readStateDigest: () => desired,
      apply: () => {
        applyCount += 1;
      },
    });
    expect(receipt.transaction_id).toBe(transaction.transaction_id);
    expect(applyCount).toBe(0);
    expect(
      reconcileAuthorityTransactionV2(root, transaction.transaction_id, {
        readStateDigest: () => desired,
        apply: () => {
          applyCount += 1;
        },
      }),
    ).toEqual(receipt);
    expect(applyCount).toBe(0);
  });

  test("leaves the ready transaction intact on mutation failure or prior-state conflict", () => {
    const root = temporaryRoot("event-v2-outbox-fail");
    const prior = sha256V2("prior");
    const desired = sha256V2("desired");
    const transaction = prepareAuthorityTransactionV2(root, {
      expected_prior_state_digest: prior,
      desired_state_digest: desired,
      actor_instance_id: "inst_operator",
      subject_instance_id: "inst_worker",
      mutation: {
        kind: "claim.acquire",
        target_fingerprint: sha256V2("target"),
        access: "write",
      },
      event: minimalStartedEvent(),
    });
    expect(() =>
      reconcileAuthorityTransactionV2(root, transaction.transaction_id, {
        readStateDigest: () => prior,
        apply: () => {
          throw new Error("mutation failed");
        },
      }),
    ).toThrow("mutation failed");
    expect(listPendingAuthorityTransactionsV2(root)).toHaveLength(1);

    expect(() =>
      reconcileAuthorityTransactionV2(root, transaction.transaction_id, {
        readStateDigest: () => sha256V2("foreign"),
        apply: () => {},
      }),
    ).toThrow("conflicts with current state");
    expect(listPendingAuthorityTransactionsV2(root)).toHaveLength(1);
  });

  test("rejects mutation fields that could smuggle free-form authority text", () => {
    const root = temporaryRoot("event-v2-outbox-secret");
    expect(() =>
      prepareAuthorityTransactionV2(root, {
        expected_prior_state_digest: sha256V2("prior"),
        desired_state_digest: sha256V2("desired"),
        actor_instance_id: "inst_operator",
        subject_instance_id: "inst_worker",
        mutation: {
          kind: "lifecycle.transition",
          state: "blocked",
          reason_code: "waiting",
          raw_reason: "API_SECRET_12345",
        } as never,
        event: minimalStartedEvent(),
      }),
    ).toThrow("invalid");
    expect(existsSync(join(root, ".harnery/ledgers/v2/authority-outbox"))).toBe(false);
  });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

function minimalStartedEvent(): EventV2 {
  const generationId = generationIdV2();
  const attestationId = attestationIdV2();
  const eventId = eventIdV2();
  return buildEventV2("session.started", {
    event_id: eventId,
    producer: {
      producer_id: "prd_outbox-fixture",
      boot_id: "boot_fixture",
      sequence: 1,
      component: "agent-coord",
      build_id: "build_fixture",
      platform: "linux",
    },
    scope: {
      root_id: "root_fixture",
      instance_id: "inst_worker",
      session_id: `sid_${"b".repeat(64)}`,
      generation_id: generationId,
    },
    attestation_id: attestationId,
    links: { caused_by: [] },
    provenance: {
      source_event: "fixture.authority",
      attestation: "derived",
      confidence: "exact",
      attribution: { method: "explicit_argument", state: "verified" },
    },
    payload: {
      runtime_attestation: {
        attestation_id: attestationId,
        generation_id: generationId,
        adapter: { state: "unsupported", capability: "adapter_identity" },
        harness: { state: "unsupported", capability: "harness_identity" },
        model: { state: "unsupported", capability: "model_identity" },
        capability_profile: `cap_${"c".repeat(64)}`,
        declared_by_event_id: eventId,
      },
      resume: { state: "not_applicable" },
    },
  }) as EventV2;
}
