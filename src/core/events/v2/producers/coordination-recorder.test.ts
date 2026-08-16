import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { AuthorityReconcilerV2 } from "../authority-outbox.ts";
import { buildEventV2 } from "../builder.ts";
import { canonicalJsonV2, sha256V2 } from "../canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../capabilities.ts";
import {
  type CandidateGenesisManifestV2,
  type CandidateProfileV2,
  candidateProfileDigestV2,
  EVENT_V2_GENESIS_MANIFEST,
  repairEventV2ControlPair,
} from "../control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "../fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "../generated.ts";
import { readActiveLedgerV2 } from "../reader.ts";
import { eventV2Paths } from "../writer.ts";
import { recordCoordinationAuthorityV2 } from "./coordination-recorder.ts";
import { recordHookSignalV2 } from "./recorder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 persistent coordination recorder", () => {
  test("is inert until the exact control gate and actor generation are available", () => {
    const root = temporaryRoot();
    let state = sha256V2("active");
    const result = recordCoordinationAuthorityV2(
      lifecycleInput(root, "native-lifecycle-1", sha256V2("active"), sha256V2("blocked"), {
        readStateDigest: () => state,
        apply: () => {
          state = sha256V2("blocked");
        },
      }),
    );
    expect(result).toEqual({ state: "gate_closed", reason: "closed" });
  });

  test("joins the actor generation and records ordered, deduplicated authority transitions", () => {
    const root = startedRoot();
    const secretTask = "Handle account TOKEN_PRIVATE_123";
    let state = sha256V2("task-empty");
    const taskInput = {
      coordRoot: root,
      mode: "candidate" as const,
      signal: "task-changed" as const,
      observation: {
        native_observation_id: "native-task-1",
        state: "set" as const,
        task: secretTask,
      },
      adapter: "claude-code" as const,
      native_actor_session_id: "native-session",
      actor_instance_id: "inst_operator" as const,
      subject_instance_id: "inst_worker" as const,
      producer_id: "prd_coord" as const,
      build_id: "build_fixture" as const,
      platform: "linux" as const,
      expected_prior_state_digest: sha256V2("task-empty"),
      desired_state_digest: sha256V2("task-set"),
      reconciler: {
        readStateDigest: () => state,
        apply: () => {
          state = sha256V2("task-set");
        },
      },
    };
    const task = recordCoordinationAuthorityV2(taskInput);
    const duplicate = recordCoordinationAuthorityV2(taskInput);
    state = sha256V2("active");
    const lifecycle = recordCoordinationAuthorityV2(
      lifecycleInput(root, "native-lifecycle-1", state, sha256V2("blocked"), {
        readStateDigest: () => state,
        apply: () => {
          state = sha256V2("blocked");
        },
      }),
    );

    expect(task.state).toBe("recorded");
    expect(duplicate.state).toBe("already_recorded");
    expect(lifecycle.state).toBe("recorded");
    const events = readActiveLedgerV2(root)
      .events.map(({ event }) => event)
      .filter((event) => event.producer.component === "agent-coord");
    expect(events.map((event) => event.event_type)).toEqual([
      "coord.task_changed",
      "coord.lifecycle_changed",
    ]);
    expect(events.map((event) => event.producer.sequence)).toEqual([1, 2]);
    expect((events[1]?.links as { caused_by: string[] }).caused_by).toEqual([events[0]?.event_id]);
    const durable = `${readFileSync(eventV2Paths(root).active, "utf8")}\n${readPrivateProducerFiles(root)}`;
    expect(durable).not.toContain(secretTask);
    expect(durable).not.toContain("native-task-1");
  });

  test("recovers the same pending transaction and blocks an unrelated mutation", () => {
    const root = startedRoot();
    const secretTask = "Recover SECRET_PENDING_456";
    let state = sha256V2("prior");
    let fail = true;
    const input = {
      coordRoot: root,
      mode: "candidate" as const,
      signal: "task-changed" as const,
      observation: {
        native_observation_id: "pending-task",
        state: "set" as const,
        task: secretTask,
      },
      adapter: "claude-code" as const,
      native_actor_session_id: "native-session",
      actor_instance_id: "inst_operator" as const,
      subject_instance_id: "inst_worker" as const,
      producer_id: "prd_coord" as const,
      build_id: "build_fixture" as const,
      platform: "linux" as const,
      expected_prior_state_digest: sha256V2("prior"),
      desired_state_digest: sha256V2("desired"),
      reconciler: {
        readStateDigest: () => state,
        apply: () => {
          if (fail) throw new Error("simulated coordination mutation crash");
          state = sha256V2("desired");
        },
      },
    };
    expect(() => recordCoordinationAuthorityV2(input)).toThrow(
      "simulated coordination mutation crash",
    );
    const unrelated = recordCoordinationAuthorityV2(
      lifecycleInput(root, "different-observation", state, sha256V2("other"), {
        readStateDigest: () => state,
        apply: () => {
          throw new Error("must not apply unrelated transition");
        },
      }),
    );
    expect(unrelated.state).toBe("pending_transaction");

    fail = false;
    const recovered = recordCoordinationAuthorityV2(input);
    expect(recovered.state).toBe("recorded");
    if (recovered.state === "recorded") expect(recovered.recovered).toBe(true);
    const events = readActiveLedgerV2(root).events.filter(
      ({ event }) => event.producer.component === "agent-coord",
    );
    expect(events).toHaveLength(1);
    expect(readPrivateProducerFiles(root)).not.toContain(secretTask);
  });
});

function lifecycleInput(
  root: string,
  observationId: string,
  prior: `sha256:${string}`,
  desired: `sha256:${string}`,
  reconciler: AuthorityReconcilerV2,
) {
  return {
    coordRoot: root,
    mode: "candidate" as const,
    signal: "lifecycle-changed" as const,
    observation: {
      native_observation_id: observationId,
      state: "blocked" as const,
      reason_code: "dependency_wait",
    },
    adapter: "claude-code" as const,
    native_actor_session_id: "native-session",
    actor_instance_id: "inst_operator" as const,
    subject_instance_id: "inst_worker" as const,
    producer_id: "prd_coord" as const,
    build_id: "build_fixture" as const,
    platform: "linux" as const,
    expected_prior_state_digest: prior,
    desired_state_digest: desired,
    reconciler,
  };
}

function startedRoot(): string {
  const root = candidateRoot();
  expect(
    recordHookSignalV2({
      coordRoot: root,
      mode: "candidate",
      signal: "session-start",
      payload: parsed({ session_id: "native-session" }),
      adapter: "claude-code",
      instance_id: "inst_operator",
      producer_id: "prd_hook",
      build_id: "build_fixture",
      platform: "linux",
    }).state,
  ).toBe("recorded");
  return root;
}

function parsed(values: Partial<ParsedPayload>): ParsedPayload {
  return { raw: {}, ...values };
}

function candidateRoot(): string {
  const root = temporaryRoot();
  const keyStore = loadOrCreateFingerprintKeyStoreV2(
    root,
    () => new Date("2026-08-16T17:00:00.000Z"),
  );
  const profile: CandidateProfileV2 = {
    initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
    contract_source_digest: sha256V2("contract"),
    harnery_commit: "fixture",
    host_repository_commit: "fixture",
    producer_build_ids: ["build_fixture"],
    adapter_capability_profile_digests: [
      `sha256:${adapterCapabilityProfileDigestV2("claude-code").slice(4)}`,
    ],
    config_digest: sha256V2("config"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: keyStore.active_epoch_id,
    v1_terminal_digest: sha256V2("v1"),
    v1_terminal_bytes: 1,
    v1_terminal_rows: 1,
    candidate_created_at: "2026-08-16T18:00:00.000Z",
  };
  const event = buildEventV2("ledger.genesis", {
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 1,
      component: "recovery",
      build_id: "build_fixture",
      platform: "linux",
    },
    scope: { root_id: "root_fixture", instance_id: "inst_cutover" },
    links: { caused_by: [] },
    provenance: {
      source_event: "cutover.genesis",
      attestation: "operator",
      confidence: "exact",
      attribution: {
        method: "explicit_argument",
        state: "verified",
        subject_instance_id: "inst_cutover",
      },
    },
    payload: {
      genesis_id: "gex_00000000-0000-0000-0000-000000000001",
      genesis_profile_digest: candidateProfileDigestV2(profile),
      contract_digest: profile.contract_source_digest,
      generated_schema_digest: EVENT_V2_SCHEMA_DIGEST,
      v1_terminal_segment_digest: profile.v1_terminal_digest,
      canonicalizer: "harnery-jcs-nfc-v1",
      privacy_epoch_id: profile.privacy_key_epoch,
      candidate_created_at: profile.candidate_created_at,
    },
  });
  const manifest: CandidateGenesisManifestV2 = {
    manifest_version: 1,
    kind: "candidate_genesis",
    profile,
    event,
  };
  const path = join(root, EVENT_V2_GENESIS_MANIFEST);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV2(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV2ControlPair(root).state).toBe("candidate");
  return root;
}

function readPrivateProducerFiles(root: string): string {
  const directory = join(root, ".harnery/private/v2-producers/agent-coord");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v2-coordination-recorder-"));
  roots.push(root);
  return root;
}
