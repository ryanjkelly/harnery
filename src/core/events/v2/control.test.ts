import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildEventV2 } from "./builder.ts";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";
import {
  type ActivationManifestV2,
  type CandidateGenesisManifestV2,
  type CandidateProfileV2,
  candidateManifestDigestV2,
  candidateProfileDigestV2,
  EVENT_V2_ACTIVATION_MANIFEST,
  EVENT_V2_GENESIS_MANIFEST,
  eventV2WriteGateOpen,
  readEventV2ControlState,
  repairEventV2ControlPair,
} from "./control.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "./generated.ts";
import { eventIdV2 } from "./ids.ts";
import { writeEventV2 } from "./writer.ts";

const CREATED_AT = "2026-08-16T18:00:00.000Z";
const APPROVED_AT = "2026-08-16T19:00:00.000Z";

describe("event ledger V2 candidate and activation control gate", () => {
  test("stays closed without control records and rejects an unbound genesis event", () => {
    const emptyRoot = tempRoot();
    expect(readEventV2ControlState(emptyRoot)).toEqual({ state: "closed", reason: "no_candidate" });
    expect(eventV2WriteGateOpen(emptyRoot, "candidate")).toBeFalse();
    expect(eventV2WriteGateOpen(emptyRoot, "active")).toBeFalse();

    const orphanRoot = tempRoot();
    const genesis = candidateManifest().event;
    expect(writeEventV2(orphanRoot, genesis).state).toBe("committed");
    expect(readEventV2ControlState(orphanRoot)).toEqual({
      state: "invalid",
      reason: "control_event_without_manifest",
    });
  });

  test("repairs manifest-first crashes with the exact pre-minted events", () => {
    const root = tempRoot();
    const genesis = candidateManifest();
    writeManifest(root, EVENT_V2_GENESIS_MANIFEST, genesis);
    expect(readEventV2ControlState(root).state).toBe("repairable");

    const candidate = repairEventV2ControlPair(root);
    expect(candidate.state).toBe("candidate");
    expect(eventV2WriteGateOpen(root, "candidate")).toBeTrue();
    expect(eventV2WriteGateOpen(root, "active")).toBeFalse();

    const activation = activationManifest(genesis);
    writeManifest(root, EVENT_V2_ACTIVATION_MANIFEST, activation);
    expect(readEventV2ControlState(root).state).toBe("repairable");

    const active = repairEventV2ControlPair(root);
    expect(active.state).toBe("active");
    expect(eventV2WriteGateOpen(root, "candidate")).toBeFalse();
    expect(eventV2WriteGateOpen(root, "active")).toBeTrue();
  });

  test("rejects profile drift and an activation bound to another candidate", () => {
    const profileDriftRoot = tempRoot();
    const drifted = candidateManifest();
    drifted.profile.config_digest = sha256V2("changed-config");
    writeManifest(profileDriftRoot, EVENT_V2_GENESIS_MANIFEST, drifted);
    expect(readEventV2ControlState(profileDriftRoot)).toEqual({
      state: "invalid",
      reason: "genesis_profile_binding_mismatch",
    });

    const activationDriftRoot = tempRoot();
    const genesis = candidateManifest();
    writeManifest(activationDriftRoot, EVENT_V2_GENESIS_MANIFEST, genesis);
    expect(repairEventV2ControlPair(activationDriftRoot).state).toBe("candidate");
    const activation = activationManifest(genesis);
    activation.candidate_manifest_digest = sha256V2("another-candidate");
    writeManifest(activationDriftRoot, EVENT_V2_ACTIVATION_MANIFEST, activation);
    expect(readEventV2ControlState(activationDriftRoot)).toEqual({
      state: "invalid",
      reason: "activation_candidate_digest_mismatch",
    });
  });

  test("rejects an activation event that has no immutable approval manifest", () => {
    const root = tempRoot();
    const genesis = candidateManifest();
    writeManifest(root, EVENT_V2_GENESIS_MANIFEST, genesis);
    expect(repairEventV2ControlPair(root).state).toBe("candidate");
    const activation = activationManifest(genesis);
    expect(writeEventV2(root, activation.event).state).toBe("committed");
    expect(readEventV2ControlState(root)).toEqual({
      state: "invalid",
      reason: "activation_event_without_manifest",
    });
  });
});

function candidateManifest(): CandidateGenesisManifestV2 {
  const profile: CandidateProfileV2 = {
    initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
    harnery_commit: "harnery-fixture",
    host_repository_commit: "host-fixture",
    producer_build_ids: ["build_fixture"],
    adapter_capability_profile_digests: [sha256V2("capability-fixture")],
    config_digest: sha256V2("config-fixture"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: "pep_fixture",
    v1_terminal_digest: sha256V2("v1-terminal"),
    v1_terminal_bytes: 1024,
    v1_terminal_rows: 4,
    candidate_created_at: CREATED_AT,
  };
  const event = buildEventV2("ledger.genesis", {
    producer: producer(1),
    scope: { root_id: "root_fixture", instance_id: "inst_cutover" },
    links: { caused_by: [] },
    provenance: provenance("cutover.genesis"),
    payload: {
      genesis_id: "gex_00000000-0000-0000-0000-000000000001",
      genesis_profile_digest: candidateProfileDigestV2(profile),
      contract_digest: sha256V2("contract-source"),
      generated_schema_digest: EVENT_V2_SCHEMA_DIGEST,
      v1_terminal_segment_digest: profile.v1_terminal_digest,
      canonicalizer: "harnery-jcs-nfc-v1",
      privacy_epoch_id: profile.privacy_key_epoch,
      candidate_created_at: CREATED_AT,
    },
  });
  return { manifest_version: 1, kind: "candidate_genesis", profile, event };
}

function activationManifest(genesis: CandidateGenesisManifestV2): ActivationManifestV2 {
  const eventId = eventIdV2();
  const candidateDigest = candidateManifestDigestV2(genesis);
  const event = buildEventV2("ledger.activated", {
    event_id: eventId,
    producer: producer(2),
    scope: { root_id: "root_fixture", instance_id: "inst_cutover" },
    links: { caused_by: [genesis.event.event_id] },
    provenance: provenance("cutover.activation"),
    payload: {
      activation_id: "act_00000000-0000-0000-0000-000000000001",
      genesis_id: genesis.event.payload.genesis_id,
      candidate_digest: candidateDigest,
      approval_record_id: "approval_fixture",
      eligible_after_event_id: eventId,
      activated_at: APPROVED_AT,
    },
  });
  return {
    manifest_version: 1,
    kind: "activation",
    activation_id: "act_00000000-0000-0000-0000-000000000001",
    genesis_id: genesis.event.payload.genesis_id as `gex_${string}`,
    candidate_manifest_digest: candidateDigest,
    approval_record_id: "approval_fixture",
    activation_approved_at: APPROVED_AT,
    event,
  };
}

function producer(sequence: number) {
  return {
    producer_id: "prd_cutover",
    boot_id: "boot_cutover",
    sequence,
    component: "recovery" as const,
    build_id: "build_fixture",
    platform: "linux" as const,
  };
}

function provenance(sourceEvent: string) {
  return {
    source_event: sourceEvent,
    attestation: "operator" as const,
    confidence: "exact" as const,
    attribution: {
      method: "explicit_argument" as const,
      state: "verified" as const,
      subject_instance_id: "inst_cutover",
    },
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "harnery-v2-control-"));
}

function writeManifest(root: string, relativePath: string, value: unknown): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV2(value)}\n`, { mode: 0o600 });
}
