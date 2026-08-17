import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildEventV2 } from "../events/v2/builder.ts";
import { canonicalJsonV2, sha256V2 } from "../events/v2/canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../events/v2/capabilities.ts";
import { recoverEventV2Catalog } from "../events/v2/catalog.ts";
import {
  type CandidateGenesisManifestV2,
  type CandidateProfileV2,
  candidateProfileDigestV2,
  EVENT_V2_GENESIS_MANIFEST,
  repairEventV2ControlPair,
} from "../events/v2/control.ts";
import { readCoordinationViewV2 } from "../events/v2/coordination-view.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "../events/v2/fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "../events/v2/generated.ts";
import { recordHookSignalV2 } from "../events/v2/producers/recorder.ts";
import { readActiveLedgerV2 } from "../events/v2/reader.ts";
import type { ParsedPayload } from "../hooks/adapter/parse.ts";
import {
  recordLiveClaimChangeV2,
  recordLiveLifecycleChangeV2,
  recordLiveTaskChangeV2,
} from "./live-authority-v2.ts";
import {
  recordLiveResumeObservationV2,
  recordLiveSweepObservationV2,
} from "./live-lifecycle-v2.ts";
import { renderPromptContext } from "./render/prompt-context.ts";
import { renderSessionContext } from "./render/session-context.ts";
import { healHeartbeat, readHeartbeat } from "./state/heartbeat-writer.ts";
import {
  ensureLiveCoordinationHeartbeat,
  readLiveCoordinationRows,
} from "./state/live-coordination-view.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("live V2 coordination cutover", () => {
  test("records task, claim, and lifecycle authority without writing a V1 row", () => {
    const root = startedRoot();

    expect(existsSync(join(root, ".harnery/active/operator.json"))).toBe(false);

    expect(recordLiveTaskChangeV2(liveInput(root, { task: "Ship V2" })).state).toBe("recorded");
    expect(
      recordLiveClaimChangeV2(
        liveInput(root, {
          operation: "acquired",
          path: "src/live.ts",
          access: "write",
        }),
      ).state,
    ).toBe("recorded");
    expect(
      recordLiveLifecycleChangeV2(liveInput(root, { state: "blocked", reason: "dependency" }))
        .state,
    ).toBe("recorded");

    const coordinationEvents = readActiveLedgerV2(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type.startsWith("coord."));
    expect(coordinationEvents.map((event) => event.event_type)).toEqual([
      "coord.task_changed",
      "coord.claim_changed",
      "coord.lifecycle_changed",
    ]);
    expect(coordinationEvents.every((event) => event.time.monotonic_ns === undefined)).toBeTrue();
    expect(existsSync(join(root, ".harnery/events.ndjson"))).toBe(false);
    expect(readHeartbeat(root, "operator")).toMatchObject({
      schema_version: 2,
      task_state: "blocked",
      files_touched: ["src/live.ts"],
      v2_instance_id: "inst_operator",
      v2_task_state: "set",
    });
    expect(readHeartbeat(root, "operator")?.task).toBeUndefined();
    expect(readHeartbeat(root, "operator")?.task_state_reason).toBeUndefined();
    expect(readCoordinationViewV2(root)).toMatchObject({
      source_complete: true,
      authority_safe: true,
      instances: {
        inst_operator: {
          task_state: "set",
          lifecycle_state: "blocked",
          files_touched: ["src/live.ts"],
        },
      },
    });
  });

  test("heals a new generation and replaces stale V1 cache state before task and claim", () => {
    const root = startedRoot();
    const active = join(root, ".harnery/active/operator.json");
    mkdirSync(dirname(active), { recursive: true });
    writeFileSync(
      active,
      JSON.stringify({
        schema_version: 1,
        instance_id: "operator",
        session_id: "stale-session",
        platform: "cursor",
        last_heartbeat: "2020-01-01T00:00:00.000Z",
        started_at: "2020-01-01T00:00:00.000Z",
        files_touched: ["stale-v1.ts"],
        task: "stale V1 task",
      }),
    );

    expect(
      ensureLiveCoordinationHeartbeat(root, "operator", "native-session", "claude-code"),
    ).toMatchObject({
      schema_version: 2,
      session_id: "native-session",
      files_touched: [],
      v2_instance_id: "inst_operator",
    });
    expect(readHeartbeat(root, "operator")?.task).toBeUndefined();
    expect(recordLiveTaskChangeV2(liveInput(root, { task: "fresh V2 task" })).state).toBe(
      "recorded",
    );
    expect(
      recordLiveClaimChangeV2(
        liveInput(root, {
          operation: "acquired",
          path: "fresh-v2.ts",
          access: "write",
        }),
      ).state,
    ).toBe("recorded");
    expect(readHeartbeat(root, "operator")).toMatchObject({
      files_touched: ["fresh-v2.ts"],
      v2_task_state: "set",
    });
    expect(JSON.stringify(readHeartbeat(root, "operator"))).not.toContain("fresh V2 task");
  });

  test("hook context excludes populated stale V1 active rows in candidate mode", () => {
    const root = startedRoot();
    const stale = join(root, ".harnery/active/stale-peer.json");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(
      stale,
      JSON.stringify({
        schema_version: 1,
        instance_id: "stale-peer",
        session_id: "stale-session",
        name: "Zombie",
        kind: "session",
        platform: "cursor",
        started_at: "2020-01-01T00:00:00.000Z",
        last_heartbeat: "2020-01-01T00:00:00.000Z",
        files_touched: ["stale-only.ts"],
        task: "legacy task",
      }),
    );

    expect(readLiveCoordinationRows(root).map((row) => row.instance_id)).toEqual(["operator"]);
    const session = renderSessionContext({
      coordRoot: root,
      instanceId: "operator",
      sessionId: "native-session",
      agentName: "Operator",
    });
    const prompt = renderPromptContext({
      coordRoot: root,
      instanceId: "operator",
      sessionId: "native-session",
    });
    expect(`${session}\n${prompt}`).not.toContain("Zombie");
    expect(`${session}\n${prompt}`).not.toContain("stale-only.ts");
  });

  test("fails closed when a terminal hook wins the lifecycle race", () => {
    const root = startedRoot();
    expect(
      ensureLiveCoordinationHeartbeat(root, "operator", "native-session", "claude-code"),
    ).not.toBeNull();
    expect(
      recordHookSignalV2({
        coordRoot: root,
        mode: "candidate",
        signal: "session-end",
        payload: parsed({ session_id: "native-session", clean_exit: true }),
        adapter: "claude-code",
        instance_id: "inst_operator",
        producer_id: "prd_agent-hook",
        build_id: "build_fixture",
        platform: "linux",
      }).state,
    ).toBe("recorded");

    expect(() => recordLiveLifecycleChangeV2(liveInput(root, { state: "done" }))).toThrow(
      "heartbeat_missing",
    );
    expect(readHeartbeat(root, "operator")?.task_state).toBe("active");
  });

  test("keeps a stale sweep provisional and clears it on native resume", () => {
    const root = startedRoot();
    expect(
      recordLiveSweepObservationV2(
        liveInput(root, { observation: "stale_heartbeat", ageMs: 600_000 }),
      ).state,
    ).toBe("recorded");
    expect(
      readCoordinationViewV2(root).instances.inst_operator?.provisional_termination,
    ).toMatchObject({ observation: "stale_heartbeat" });

    expect(recordLiveResumeObservationV2(liveInput(root, {})).state).toBe("recorded");
    expect(
      readCoordinationViewV2(root).instances.inst_operator?.provisional_termination,
    ).toBeUndefined();
    expect(
      healHeartbeat(root, "operator", "native-session", undefined, "claude-code"),
    ).not.toBeNull();
  });
});

function liveInput<T extends object>(root: string, extra: T) {
  return {
    coordRoot: root,
    owner: "operator",
    nativeSessionId: "native-session",
    adapter: "claude-code" as const,
    ...extra,
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
      producer_id: "prd_agent-hook",
      build_id: "build_fixture",
      platform: "linux",
    }).state,
  ).toBe("recorded");
  recoverEventV2Catalog(root);
  return root;
}

function parsed(values: Partial<ParsedPayload>): ParsedPayload {
  return { raw: {}, ...values };
}

function candidateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-live-coord-v2-"));
  roots.push(root);
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
