import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import type { AuthorityReconcilerV3 } from "../authority-outbox.ts";
import { buildEventV3 } from "../builder.ts";
import { canonicalJsonV3, sha256V3 } from "../canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../capabilities.ts";
import {
  type CandidateGenesisManifestV3,
  type CandidateProfileV3,
  candidateProfileDigestV3,
  EVENT_V3_GENESIS_MANIFEST,
  repairEventV3ControlPair,
} from "../control.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../generated.ts";
import { readLedgerV3 } from "../reader.ts";
import { eventV3Paths } from "../writer.ts";
import { recordCoordinationAuthorityV3 } from "./coordination-recorder.ts";
import { recordHookSignalV3 } from "./recorder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 persistent coordination recorder", () => {
  test("is inert until the exact control gate and actor generation are available", () => {
    const root = temporaryRoot();
    let state = sha256V3("active");
    const result = recordCoordinationAuthorityV3(
      lifecycleInput(root, "native-lifecycle-1", sha256V3("active"), sha256V3("blocked"), {
        readStateDigest: () => state,
        apply: () => {
          state = sha256V3("blocked");
        },
      }),
    );
    expect(result).toEqual({ state: "gate_closed", reason: "closed" });
  });

  test("joins the actor generation and records ordered, deduplicated authority transitions", () => {
    const root = startedRoot();
    const secretTask = "Handle account TOKEN_PRIVATE_123";
    let state = sha256V3("task-empty");
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
      expected_prior_state_digest: sha256V3("task-empty"),
      desired_state_digest: sha256V3("task-set"),
      reconciler: {
        readStateDigest: () => state,
        apply: () => {
          state = sha256V3("task-set");
        },
      },
    };
    const task = recordCoordinationAuthorityV3(taskInput);
    const duplicate = recordCoordinationAuthorityV3(taskInput);
    state = sha256V3("active");
    const lifecycle = recordCoordinationAuthorityV3(
      lifecycleInput(root, "native-lifecycle-1", state, sha256V3("blocked"), {
        readStateDigest: () => state,
        apply: () => {
          state = sha256V3("blocked");
        },
      }),
    );

    expect(task.state).toBe("recorded");
    expect(duplicate.state).toBe("already_recorded");
    expect(lifecycle.state).toBe("recorded");
    const events = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.producer.component === "agent-coord");
    expect(events.map((event) => event.event_type)).toEqual([
      "coord.task_changed",
      "coord.lifecycle_changed",
    ]);
    expect(events.map((event) => event.producer.sequence)).toEqual([1, 2]);
    expect((events[1]?.links as { caused_by: string[] }).caused_by).toEqual([events[0]?.event_id]);
    const durable = `${readFileSync(eventV3Paths(root).active, "utf8")}\n${readPrivateProducerFiles(root)}`;
    expect(durable).not.toContain(secretTask);
    expect(durable).not.toContain("native-task-1");
  });

  test("joins a delegated child by exact instance when its command retains the parent session", () => {
    const root = startedRoot();
    const childInstance = "inst_native-child" as const;
    const delegation = recordHookSignalV3({
      coordRoot: root,
      mode: "candidate",
      signal: "sub-agent-start",
      payload: parsed({ session_id: "native-session", agent_id: "native-child" }),
      adapter: "claude-code",
      instance_id: "inst_operator",
      producer_id: "prd_hook",
      build_id: "build_fixture",
      platform: "linux",
    });
    if (delegation.state !== "recorded" || delegation.event.event_type !== "agent.started") {
      throw new Error("expected native delegation");
    }
    const childGeneration = delegation.event.payload.child_generation_id as `gen_${string}`;
    expect(
      recordHookSignalV3({
        coordRoot: root,
        mode: "candidate",
        signal: "session-start",
        payload: parsed({ session_id: "native-child" }),
        adapter: "claude-code",
        instance_id: childInstance,
        producer_id: "prd_hook",
        build_id: "build_fixture",
        platform: "linux",
        delegated_child: {
          generation_id: childGeneration,
          parent_generation_id: (
            delegation.event.links as unknown as { parent_generation_id: `gen_${string}` }
          ).parent_generation_id,
          delegation_id: delegation.event.payload.delegation_id as `del_${string}`,
          caused_by_event_id: delegation.event.event_id as `evt_${string}`,
        },
      }).state,
    ).toBe("recorded");
    let state = sha256V3("task-empty");
    const result = recordCoordinationAuthorityV3({
      coordRoot: root,
      mode: "candidate",
      signal: "task-changed",
      observation: {
        native_observation_id: "native-child-task",
        state: "set",
        task: "Inspect the child bridge",
      },
      adapter: "claude-code",
      native_actor_session_id: "native-session",
      actor_instance_id: childInstance,
      subject_instance_id: childInstance,
      producer_id: "prd_coord",
      build_id: "build_fixture",
      platform: "linux",
      expected_prior_state_digest: state,
      desired_state_digest: sha256V3("task-set"),
      reconciler: {
        readStateDigest: () => state,
        apply: () => {
          state = sha256V3("task-set");
        },
      },
    });

    expect(result.state).toBe("recorded");
    const task = readLedgerV3(root).events
      .map(({ event }) => event)
      .find((event) => event.event_type === "coord.task_changed");
    expect(task?.scope).toMatchObject({
      instance_id: childInstance,
      generation_id: childGeneration,
    });
  });

  test("recovers the same pending transaction and blocks an unrelated mutation", () => {
    const root = startedRoot();
    const secretTask = "Recover SECRET_PENDING_456";
    let state = sha256V3("prior");
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
      expected_prior_state_digest: sha256V3("prior"),
      desired_state_digest: sha256V3("desired"),
      reconciler: {
        readStateDigest: () => state,
        apply: () => {
          if (fail) throw new Error("simulated coordination mutation crash");
          state = sha256V3("desired");
        },
      },
    };
    expect(() => recordCoordinationAuthorityV3(input)).toThrow(
      "simulated coordination mutation crash",
    );
    const unrelated = recordCoordinationAuthorityV3(
      lifecycleInput(root, "different-observation", state, sha256V3("other"), {
        readStateDigest: () => state,
        apply: () => {
          throw new Error("must not apply unrelated transition");
        },
      }),
    );
    expect(unrelated.state).toBe("pending_transaction");

    fail = false;
    const recovered = recordCoordinationAuthorityV3(input);
    expect(recovered.state).toBe("recorded");
    if (recovered.state === "recorded") expect(recovered.recovered).toBe(true);
    const events = readLedgerV3(root).events.filter(
      ({ event }) => event.producer.component === "agent-coord",
    );
    expect(events).toHaveLength(1);
    expect(readPrivateProducerFiles(root)).not.toContain(secretTask);
  });

  test("completes a reconcilable stale pending transaction left by a crashed writer", () => {
    const root = startedRoot();
    let state = sha256V3("prior");
    const input = {
      coordRoot: root,
      mode: "candidate" as const,
      signal: "task-changed" as const,
      observation: {
        native_observation_id: "crashed-task",
        state: "set" as const,
        task: "Crash between apply and bookkeeping",
      },
      adapter: "claude-code" as const,
      native_actor_session_id: "native-session",
      actor_instance_id: "inst_operator" as const,
      subject_instance_id: "inst_worker" as const,
      producer_id: "prd_coord" as const,
      build_id: "build_fixture" as const,
      platform: "linux" as const,
      expected_prior_state_digest: sha256V3("prior"),
      desired_state_digest: sha256V3("desired"),
      reconciler: {
        readStateDigest: () => state,
        apply: () => {
          // The mutation lands durably, then the writer dies before the
          // recorder clears its pending bookkeeping.
          state = sha256V3("desired");
          throw new Error("simulated writer death after apply");
        },
      },
    };
    expect(() => recordCoordinationAuthorityV3(input)).toThrow(
      "simulated writer death after apply",
    );

    // A DIFFERENT observation used to be refused forever (the crashed hook
    // observation never retries). The stale transaction reconciles cleanly
    // (state already at its desired digest), so it completes and the new
    // observation records normally.
    const next = recordCoordinationAuthorityV3(
      lifecycleInput(root, "later-observation", state, sha256V3("after"), {
        readStateDigest: () => state,
        apply: () => {
          state = sha256V3("after");
        },
      }),
    );
    expect(next.state).toBe("recorded");
    if (next.state === "recorded") expect(next.recovered).toBe(false);
    const events = readLedgerV3(root).events.filter(
      ({ event }) => event.producer.component === "agent-coord",
    );
    expect(events).toHaveLength(2);
  });
});

function lifecycleInput(
  root: string,
  observationId: string,
  prior: `sha256:${string}`,
  desired: `sha256:${string}`,
  reconciler: AuthorityReconcilerV3,
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
    recordHookSignalV3({
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
  const keyStore = loadOrCreateFingerprintKeyStoreV3(
    root,
    () => new Date("2026-08-16T17:00:00.000Z"),
  );
  const profile: CandidateProfileV3 = {
    initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
    contract_source_digest: sha256V3("contract"),
    harnery_commit: "fixture",
    host_repository_commit: "fixture",
    producer_build_ids: ["build_fixture"],
    adapter_capability_profile_digests: [
      `sha256:${adapterCapabilityProfileDigestV3("claude-code").slice(4)}`,
    ],
    config_digest: sha256V3("config"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: keyStore.active_epoch_id,
    candidate_created_at: "2026-08-16T18:00:00.000Z",
  };
  const event = buildEventV3("ledger.genesis", {
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
      genesis_profile_digest: candidateProfileDigestV3(profile),
      contract_digest: profile.contract_source_digest,
      generated_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      canonicalizer: "harnery-jcs-nfc-v1",
      privacy_epoch_id: profile.privacy_key_epoch,
      candidate_created_at: profile.candidate_created_at,
    },
  });
  const manifest: CandidateGenesisManifestV3 = {
    manifest_version: 1,
    kind: "candidate_genesis",
    profile,
    event,
  };
  const path = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV3ControlPair(root).state).toBe("candidate");
  return root;
}

function readPrivateProducerFiles(root: string): string {
  const directory = join(root, ".harnery/ledgers/v3/private-producers/agent-coord");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-coordination-recorder-"));
  roots.push(root);
  return root;
}
