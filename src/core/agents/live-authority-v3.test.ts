import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Adapter } from "../adapter.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { buildEventV3 } from "../events/v3/builder.ts";
import { canonicalJsonV3, sha256V3 } from "../events/v3/canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../events/v3/capabilities.ts";
import {
  type CandidateGenesisManifestV3,
  type CandidateProfileV3,
  candidateProfileDigestV3,
  EVENT_V3_GENESIS_MANIFEST,
} from "../events/v3/control.ts";
import { repairEventV3ControlPair } from "../events/v3/control-writer.ts";
import { readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../events/v3/fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../events/v3/generated.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { recordCoordinationAuthorityV3 } from "../events/v3/producers/coordination-recorder.ts";
import {
  listHookProducerStateRecordsV3,
  recordHookSignalV3,
} from "../events/v3/producers/recorder.ts";
import { reduceSafetyProjectionV3 } from "../events/v3/projection.ts";
import { EVENT_V3_LEDGER_RELATIVE_ROOT, readLedgerV3 } from "../events/v3/reader.ts";
import type { ParsedPayload } from "../hooks/adapter/parse.ts";
import {
  bootstrapLiveCoordinationAuthorityV3,
  recordLiveClaimChangeV3,
  recordLiveLifecycleChangeV3,
  recordLiveTaskChangeV3,
  restoreLiveCoordinationStateAfterEpochV3,
} from "./live-authority-v3.ts";
import {
  recordLiveResumeObservationV3,
  recordLiveSweepObservationV3,
} from "./live-lifecycle-v3.ts";
import { recordLiveCoordinationObservationV3 } from "./live-observation-v3.ts";
import { renderPromptContext } from "./render/prompt-context.ts";
import { renderSessionContext } from "./render/session-context.ts";
import type { Heartbeat } from "./state/heartbeat-reader.ts";
import { readHeartbeat } from "./state/heartbeat-writer.ts";
import { readLiveCoordinationRows } from "./state/live-coordination-view.ts";
import {
  ensureLiveCoordinationHeartbeat,
  repairLiveCoordinationHeartbeat,
} from "./state/live-coordination-writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("live V3 coordination", () => {
  test("bootstraps one missing generation without synthesizing a turn", () => {
    const root = candidateRoot("codex");

    const created = bootstrapLiveCoordinationAuthorityV3({
      coordRoot: root,
      owner: "operator",
      nativeSessionId: "native-session",
      adapter: "codex",
    });

    expect(created).toMatchObject({
      state: "created",
      adapter: "codex",
      heartbeat: {
        instance_id: "operator",
        session_id: "native-session",
        platform: "codex",
      },
    });
    expect(created.heartbeat.v3_generation_id).toBe(created.generation_id);
    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events.map((event) => event.event_type)).toEqual(["ledger.genesis", "session.started"]);
    expect(events[1]).toMatchObject({
      provenance: {
        source_event: "codex.validated-current-session-heal",
        attestation: "derived",
        confidence: "high",
      },
      payload: {
        resume: { state: "unknown", reason: "validated_current_session_heal" },
      },
    });
    const producer = listHookProducerStateRecordsV3(root);
    expect(producer).toHaveLength(1);
    expect(producer[0]?.state).toMatchObject({
      adapter: "codex",
      instance_id: "inst_operator",
      generation_id: created.generation_id,
      terminal: false,
      session_start_derivation: "validated_current_session_heal",
    });
    expect(producer[0]?.state.current_turn_id).toBeUndefined();
  });

  test("reuses the exact generation idempotently", () => {
    const root = candidateRoot("codex");
    const input = {
      coordRoot: root,
      owner: "operator",
      nativeSessionId: "native-session",
      adapter: "codex" as const,
    };

    const created = bootstrapLiveCoordinationAuthorityV3(input);
    rmSync(join(root, ".harnery/active/operator.json"));
    const reused = bootstrapLiveCoordinationAuthorityV3(input);

    expect(reused.state).toBe("reused");
    expect(reused.generation_id).toBe(created.generation_id);
    expect(existsSync(join(root, ".harnery/active/operator.json"))).toBe(true);
    expect(
      readLedgerV3(root).events.filter(({ event }) => event.event_type === "session.started"),
    ).toHaveLength(1);
    expect(listHookProducerStateRecordsV3(root)).toHaveLength(1);
  });

  test("refuses cross-adapter and cross-instance native-session collisions", () => {
    const crossAdapterRoot = candidateRoot("codex");
    bootstrapLiveCoordinationAuthorityV3({
      coordRoot: crossAdapterRoot,
      owner: "operator",
      nativeSessionId: "shared-session",
      adapter: "codex",
    });
    expect(() =>
      bootstrapLiveCoordinationAuthorityV3({
        coordRoot: crossAdapterRoot,
        owner: "operator",
        nativeSessionId: "shared-session",
        adapter: "claude-code",
      }),
    ).toThrow("event_v3_coordination_authority:cross_adapter_identity");

    const crossInstanceRoot = candidateRoot("codex");
    expect(
      recordHookSignalV3({
        coordRoot: crossInstanceRoot,
        mode: "candidate",
        signal: "session-start",
        payload: parsed({ session_id: "shared-session" }),
        adapter: "codex",
        instance_id: "inst_other",
        producer_id: "prd_agent-hook",
        build_id: "build_fixture",
        platform: "linux",
      }).state,
    ).toBe("recorded");
    expect(() =>
      bootstrapLiveCoordinationAuthorityV3({
        coordRoot: crossInstanceRoot,
        owner: "operator",
        nativeSessionId: "shared-session",
        adapter: "codex",
      }),
    ).toThrow("event_v3_coordination_authority:cross_instance_identity");
  });

  test("refuses a different native session for an existing instance generation", () => {
    const root = candidateRoot("codex");
    bootstrapLiveCoordinationAuthorityV3({
      coordRoot: root,
      owner: "operator",
      nativeSessionId: "first-session",
      adapter: "codex",
    });

    expect(() =>
      bootstrapLiveCoordinationAuthorityV3({
        coordRoot: root,
        owner: "operator",
        nativeSessionId: "second-session",
        adapter: "codex",
      }),
    ).toThrow("event_v3_coordination_authority:cross_session_identity");
    expect(
      readLedgerV3(root).events.filter(({ event }) => event.event_type === "session.started"),
    ).toHaveLength(1);
  });

  test("never resurrects a terminal native session", () => {
    const root = candidateRoot("codex");
    const input = {
      coordRoot: root,
      owner: "operator",
      nativeSessionId: "native-session",
      adapter: "codex" as const,
    };
    bootstrapLiveCoordinationAuthorityV3(input);
    expect(
      recordHookSignalV3({
        coordRoot: root,
        mode: "candidate",
        signal: "session-end",
        payload: parsed({ session_id: "native-session", clean_exit: true }),
        adapter: "codex",
        instance_id: "inst_operator",
        producer_id: "prd_agent-hook",
        build_id: "build_fixture",
        platform: "linux",
      }).state,
    ).toBe("recorded");

    expect(() => bootstrapLiveCoordinationAuthorityV3(input)).toThrow(
      "event_v3_coordination_authority:terminal_generation_forbidden",
    );
    expect(
      readLedgerV3(root).events.filter(({ event }) => event.event_type === "session.started"),
    ).toHaveLength(1);
  });

  test("fails closed on producer-generation drift and unsafe or uninitialized V3", () => {
    const driftedRoot = candidateRoot("codex");
    const input = {
      coordRoot: driftedRoot,
      owner: "operator",
      nativeSessionId: "native-session",
      adapter: "codex" as const,
    };
    bootstrapLiveCoordinationAuthorityV3(input);
    const [record] = listHookProducerStateRecordsV3(driftedRoot);
    if (!record) throw new Error("producer fixture missing");
    const producer = JSON.parse(readFileSync(record.path, "utf8")) as Record<string, unknown>;
    producer.generation_id = "gen_00000000-0000-0000-0000-000000000099";
    writeFileSync(record.path, `${JSON.stringify(producer)}\n`, { mode: 0o600 });
    expect(() => bootstrapLiveCoordinationAuthorityV3(input)).toThrow(
      "event_v3_coordination_authority:generation_control_mismatch",
    );

    const unsafeRoot = candidateRoot("codex");
    appendFileSync(join(unsafeRoot, EVENT_V3_LEDGER_RELATIVE_ROOT, "active.ndjson"), "{}\n");
    expect(() =>
      bootstrapLiveCoordinationAuthorityV3({
        coordRoot: unsafeRoot,
        owner: "operator",
        nativeSessionId: "native-session",
        adapter: "codex",
      }),
    ).toThrow("event_v3_coordination_authority:invalid:ledger_integrity_failure");

    const uninitialized = mkdtempSync(join(tmpdir(), "harnery-live-coord-v3-empty-"));
    roots.push(uninitialized);
    expect(() =>
      bootstrapLiveCoordinationAuthorityV3({
        coordRoot: uninitialized,
        owner: "operator",
        nativeSessionId: "native-session",
        adapter: "codex",
      }),
    ).toThrow("event_v3_coordination_authority:v3_not_initialized");
  });

  test("records status, presence, message, council, and decision observations without raw bodies", () => {
    const root = startedRoot();
    const record = { id: "record-1", secret_text: "never persist this record body" };

    const observations = [
      {
        event_type: "coord.status_observed" as const,
        status: "end_turn_checked",
      },
      {
        event_type: "coord.presence_changed" as const,
        prior_state: "office",
        new_state: "mobile",
        reason: "presence_cli",
      },
      {
        event_type: "coord.message_observed" as const,
        direction: "sent" as const,
        body: "message body must be fingerprinted only",
        subject: "peer",
      },
      {
        event_type: "council.state_changed" as const,
        council_id: "council-1",
        prior_state: "active",
        new_state: "closed",
        record,
      },
      {
        event_type: "decision.state_changed" as const,
        decision_id: "decision-1",
        prior_state: "filed",
        new_state: "resolved",
        record,
      },
    ];

    for (const observation of observations) {
      expect(recordLiveCoordinationObservationV3(liveInput(root, { observation })).state).toBe(
        "recorded",
      );
      expect(
        readCoordinationViewV3(root).diagnostics,
        `${observation.event_type} must preserve authority-safe projection`,
      ).toEqual([]);
    }

    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events.slice(-5).map((event) => event.event_type)).toEqual(
      observations.map((observation) => observation.event_type),
    );
    const serialized = JSON.stringify(events.slice(-5));
    expect(serialized).not.toContain("message body must be fingerprinted only");
    expect(serialized).not.toContain("never persist this record body");
    expect(serialized).toContain('"body_length":39');
    expect(serialized).toContain('"record_digest":"sha256:');
  });

  test("records task, claim, and lifecycle authority canonically", () => {
    const root = startedRoot();

    expect(existsSync(join(root, ".harnery/active/operator.json"))).toBe(false);

    expect(recordLiveTaskChangeV3(liveInput(root, { task: "Ship V3" })).state).toBe("recorded");
    expect(
      recordLiveClaimChangeV3(
        liveInput(root, {
          operation: "acquired",
          path: "src/live.ts",
          access: "write",
        }),
      ).state,
    ).toBe("recorded");
    expect(
      recordLiveLifecycleChangeV3(liveInput(root, { state: "blocked", reason: "dependency" }))
        .state,
    ).toBe("recorded");

    const coordinationEvents = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type.startsWith("coord."));
    expect(coordinationEvents.map((event) => event.event_type)).toEqual([
      "coord.task_changed",
      "coord.claim_changed",
      "coord.lifecycle_changed",
    ]);
    expect(coordinationEvents.every((event) => event.time.monotonic_ns === undefined)).toBeTrue();
    expect(readHeartbeat(root, "operator")).toMatchObject({
      schema_version: 2,
      task: "Ship V3",
      task_state: "blocked",
      files_touched: ["src/live.ts"],
      v3_instance_id: "inst_operator",
      v3_task_state: "set",
      suggested_session_name: "Agent unknown - Ship V3",
    });
    expect(readHeartbeat(root, "operator")?.task_state_reason).toBe("dependency");
    expect(JSON.stringify(coordinationEvents)).not.toContain("Ship V3");
    expect(readCoordinationViewV3(root)).toMatchObject({
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

  test("restores private coordination state after an epoch handoff", () => {
    const root = startedRoot();
    recordLiveTaskChangeV3(liveInput(root, { task: "Preserve private focus" }));
    recordLiveClaimChangeV3(
      liveInput(root, { operation: "acquired", path: "src/private-focus.ts" }),
    );
    recordLiveLifecycleChangeV3(
      liveInput(root, { state: "blocked", reason: "waiting for a dependency" }),
    );
    const prior = readHeartbeat(root, "operator");

    initializeEventLedgerV3({
      coordRoot: root,
      harneryBuild: "replacement",
      hostBuild: "fixture",
      configDigest: sha256V3("config"),
      approvalRecordId: "test-epoch-handoff",
      forceNewEpoch: true,
    });
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected replacement V3 route");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "session-start",
        payload: { session_id: "native-session", raw: {} },
        adapter: "claude-code",
        instanceId: "operator",
      }).state,
    ).toBe("recorded");

    expect(
      restoreLiveCoordinationStateAfterEpochV3({
        coordRoot: root,
        owner: "operator",
        nativeSessionId: "native-session",
        adapter: "claude-code",
        prior,
      }),
    ).toEqual({ state: "restored", task: true, claims: 1, lifecycle: true });
    expect(readHeartbeat(root, "operator")).toMatchObject({
      task: "Preserve private focus",
      files_touched: ["src/private-focus.ts"],
      task_state: "blocked",
      task_state_reason: "waiting for a dependency",
    });
    expect(JSON.stringify(readLedgerV3(root).events)).not.toContain("Preserve private focus");
    expect(
      restoreLiveCoordinationStateAfterEpochV3({
        coordRoot: root,
        owner: "operator",
        nativeSessionId: "native-session",
        adapter: "claude-code",
        prior,
      }),
    ).toEqual({ state: "unchanged", task: false, claims: 0, lifecycle: false });
  });

  test("accepts a recorder-proven same generation without projecting full history", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-live-authority-fast-path-"));
    roots.push(root);
    const generationId = "gen_00000000-0000-7000-8000-000000000001" as const;
    const prior: Heartbeat = {
      instance_id: "operator",
      session_id: "native-session",
      last_heartbeat: "2026-08-30T10:00:00.000Z",
      files_touched: [],
      v3_generation_id: generationId,
    };

    expect(
      restoreLiveCoordinationStateAfterEpochV3({
        coordRoot: root,
        owner: "operator",
        nativeSessionId: "native-session",
        adapter: "claude-code",
        prior,
        currentGenerationId: generationId,
      }),
    ).toEqual({ state: "unchanged", task: false, claims: 0, lifecycle: false });
  });

  test("releases an out-of-root claim across dot-dot and absolute forms", () => {
    const root = startedRoot();
    const external = join(dirname(root), "approved-output", "artifact.txt");

    expect(
      recordLiveClaimChangeV3(
        liveInput(root, {
          operation: "acquired",
          path: relative(root, external),
          access: "write",
        }),
      ).state,
    ).toBe("recorded");
    expect(readHeartbeat(root, "operator")?.files_touched).toEqual([external]);

    expect(
      recordLiveClaimChangeV3(
        liveInput(root, { operation: "released", path: external, access: "write" }),
      ).state,
    ).toBe("recorded");

    const read = readLedgerV3(root);
    expect(readHeartbeat(root, "operator")?.files_touched).toEqual([]);
    expect(reduceSafetyProjectionV3(read)).toMatchObject({
      authority_safe: true,
      diagnostics: [],
      claims: {},
    });
    expect(JSON.stringify(read.events)).not.toContain(external);
  });

  test("heals a new generation and replaces a stale generation cache before task and claim", () => {
    const root = startedRoot();
    const active = join(root, ".harnery/active/operator.json");
    mkdirSync(dirname(active), { recursive: true });
    writeFileSync(
      active,
      JSON.stringify({
        schema_version: 2,
        instance_id: "operator",
        session_id: "stale-session",
        platform: "cursor",
        last_heartbeat: "2020-01-01T00:00:00.000Z",
        started_at: "2020-01-01T00:00:00.000Z",
        files_touched: ["stale-generation.ts"],
        task: "stale task",
        v3_instance_id: "inst_operator",
        v3_generation_id: "gen_stale",
        v3_projection_event_id: "evt_stale",
        v3_task_state: "set",
      }),
    );

    expect(
      ensureLiveCoordinationHeartbeat(root, "operator", "native-session", "claude-code"),
    ).toMatchObject({
      schema_version: 2,
      session_id: "native-session",
      files_touched: [],
      v3_instance_id: "inst_operator",
    });
    expect(readHeartbeat(root, "operator")?.task).toBeUndefined();
    expect(recordLiveTaskChangeV3(liveInput(root, { task: "fresh V3 task" })).state).toBe(
      "recorded",
    );
    expect(
      recordLiveClaimChangeV3(
        liveInput(root, {
          operation: "acquired",
          path: "fresh-v3.ts",
          access: "write",
        }),
      ).state,
    ).toBe("recorded");
    expect(readHeartbeat(root, "operator")).toMatchObject({
      files_touched: ["fresh-v3.ts"],
      task: "fresh V3 task",
      v3_task_state: "set",
      suggested_session_name: "Agent unknown - fresh V3 task",
    });
    expect(JSON.stringify(readLedgerV3(root).events)).not.toContain("fresh V3 task");
  });

  test("repair reprojects a generation-current cache whose disposable fields drifted", () => {
    const root = startedRoot();
    const active = join(root, ".harnery/active/operator.json");
    const current = ensureLiveCoordinationHeartbeat(
      root,
      "operator",
      "native-session",
      "claude-code",
    );
    expect(current).not.toBeNull();
    writeFileSync(
      active,
      JSON.stringify({
        ...current,
        task_state: "done",
        task_state_reason: "stale derived state",
        files_touched: ["stale-claim.ts"],
      }),
    );

    expect(
      ensureLiveCoordinationHeartbeat(root, "operator", "native-session", "claude-code"),
    ).toMatchObject({
      task_state: "done",
      files_touched: ["stale-claim.ts"],
    });
    expect(
      repairLiveCoordinationHeartbeat(root, "operator", "native-session", "claude-code"),
    ).toMatchObject({
      task_state: "active",
      files_touched: [],
    });
    expect(readHeartbeat(root, "operator")).toMatchObject({
      task_state: "active",
      files_touched: [],
    });
  });

  test("carries naming evidence across a generation reopen of the same native session", () => {
    const root = startedRoot();
    const active = join(root, ".harnery/active/operator.json");
    mkdirSync(dirname(active), { recursive: true });
    writeFileSync(
      active,
      JSON.stringify({
        schema_version: 2,
        instance_id: "operator",
        session_id: "native-session",
        platform: "claude-code",
        last_heartbeat: "2026-08-21T00:00:00.000Z",
        started_at: "2026-08-21T00:00:00.000Z",
        files_touched: [],
        task: "yesterday focus",
        suggested_session_name: "Agent unknown - yesterday focus",
        session_name_seen_for: "Agent unknown - yesterday focus",
        session_name_seen_at: "2026-08-21T00:01:00.000Z",
        v3_instance_id: "inst_operator",
        v3_generation_id: "gen_stale",
        v3_projection_event_id: "evt_stale",
        v3_task_state: "set",
      }),
    );

    // The reopened generation names the same adapter tab, so the already
    // displayed title must survive instead of being re-minted and demanded
    // again on the next focus declaration.
    expect(
      ensureLiveCoordinationHeartbeat(root, "operator", "native-session", "claude-code"),
    ).toMatchObject({
      session_id: "native-session",
      suggested_session_name: "Agent unknown - yesterday focus",
      session_name_seen_for: "Agent unknown - yesterday focus",
    });
    expect(recordLiveTaskChangeV3(liveInput(root, { task: "today focus" })).state).toBe("recorded");
    expect(readHeartbeat(root, "operator")).toMatchObject({
      task: "today focus",
      suggested_session_name: "Agent unknown - yesterday focus",
      session_name_seen_for: "Agent unknown - yesterday focus",
    });
  });

  test("names a V3 session once while later task changes and clears remain disposable", () => {
    const root = startedRoot();

    expect(recordLiveTaskChangeV3(liveInput(root, { task: "First focus" })).state).toBe("recorded");
    expect(readHeartbeat(root, "operator")).toMatchObject({
      task: "First focus",
      v3_task_state: "set",
      suggested_session_name: "Agent unknown - First focus",
    });

    expect(recordLiveTaskChangeV3(liveInput(root, { task: "Second focus" })).state).toBe(
      "recorded",
    );
    expect(readHeartbeat(root, "operator")).toMatchObject({
      task: "Second focus",
      v3_task_state: "set",
      suggested_session_name: "Agent unknown - First focus",
    });

    expect(recordLiveTaskChangeV3(liveInput(root, { task: "" })).state).toBe("recorded");
    expect(readHeartbeat(root, "operator")).toMatchObject({
      v3_task_state: "cleared",
      suggested_session_name: "Agent unknown - First focus",
    });
    expect(readHeartbeat(root, "operator")?.task).toBeUndefined();
    expect(recordLiveTaskChangeV3(liveInput(root, { task: "" })).state).toBe("recorded");
    const ledger = JSON.stringify(readLedgerV3(root).events);
    expect(ledger).not.toContain("First focus");
    expect(ledger).not.toContain("Second focus");
    expect(
      readLedgerV3(root).events.filter(({ event }) => event.event_type === "coord.task_changed"),
    ).toHaveLength(4);
  });

  test("bootstraps Codex authority from runtime attestation when no cache exists", () => {
    const root = startedRoot("codex");

    // Deliberately supply the historical fallback adapter. The validated V3
    // generation is Codex and must override this guess for every authority
    // mutation before the first local cache exists.
    expect(recordLiveTaskChangeV3(liveInput(root, { task: "Codex canary" })).state).toBe(
      "recorded",
    );
    expect(readHeartbeat(root, "operator")).toMatchObject({
      platform: "codex",
      v3_task_state: "set",
    });
    expect(
      recordLiveClaimChangeV3(
        liveInput(root, { operation: "acquired", path: "codex-canary.ts", access: "write" }),
      ).state,
    ).toBe("recorded");
    expect(recordLiveLifecycleChangeV3(liveInput(root, { state: "blocked" })).state).toBe(
      "recorded",
    );
    expect(readHeartbeat(root, "operator")).toMatchObject({
      schema_version: 2,
      platform: "codex",
      files_touched: ["codex-canary.ts"],
      task_state: "blocked",
    });
  });

  test("hook context excludes populated stale-generation cache rows", () => {
    const root = startedRoot();
    const stale = join(root, ".harnery/active/stale-peer.json");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(
      stale,
      JSON.stringify({
        schema_version: 2,
        instance_id: "stale-peer",
        session_id: "stale-session",
        name: "Zombie",
        kind: "session",
        platform: "cursor",
        started_at: "2020-01-01T00:00:00.000Z",
        last_heartbeat: "2020-01-01T00:00:00.000Z",
        files_touched: ["stale-only.ts"],
        task: "stale task",
        v3_instance_id: "inst_stale-peer",
        v3_generation_id: "gen_stale-peer",
        v3_projection_event_id: "evt_stale-peer",
        v3_task_state: "set",
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
      recordHookSignalV3({
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

    expect(() => recordLiveLifecycleChangeV3(liveInput(root, { state: "done" }))).toThrow(
      "heartbeat_missing",
    );
    expect(readHeartbeat(root, "operator")?.task_state).toBe("active");
  });

  test("keeps a stale sweep provisional and clears it on native resume", () => {
    const root = startedRoot();
    expect(
      recordLiveSweepObservationV3(
        liveInput(root, { observation: "stale_heartbeat", ageMs: 600_000 }),
      ).state,
    ).toBe("recorded");
    expect(
      readCoordinationViewV3(root).instances.inst_operator?.provisional_termination,
    ).toMatchObject({ observation: "stale_heartbeat" });

    expect(recordLiveResumeObservationV3(liveInput(root, {})).state).toBe("recorded");
    expect(
      readCoordinationViewV3(root).instances.inst_operator?.provisional_termination,
    ).toBeUndefined();
    expect(
      ensureLiveCoordinationHeartbeat(root, "operator", "native-session", "claude-code"),
    ).not.toBeNull();
  });

  test("lets an unaffected peer mutate after another generation fails projection", () => {
    const root = candidateRoot("claude-code");
    for (const [owner, nativeSessionId] of [
      ["first", "native-first"],
      ["second", "native-second"],
    ] as const) {
      expect(
        recordHookSignalV3({
          coordRoot: root,
          mode: "candidate",
          signal: "session-start",
          payload: parsed({ session_id: nativeSessionId }),
          adapter: "claude-code",
          instance_id: `inst_${owner}`,
          producer_id: "prd_agent-hook",
          build_id: "build_fixture",
          platform: "linux",
        }).state,
      ).toBe("recorded");
      expect(
        ensureLiveCoordinationHeartbeat(root, owner, nativeSessionId, "claude-code"),
      ).not.toBeNull();
    }

    let firstState = sha256V3("empty");
    const clearedState = sha256V3("cleared");
    expect(
      recordCoordinationAuthorityV3({
        coordRoot: root,
        mode: "candidate",
        signal: "task-changed",
        observation: {
          native_observation_id: "invalid-first-transition",
          state: "cleared",
          prior_state: "set",
        },
        adapter: "claude-code",
        native_actor_session_id: "native-first",
        actor_instance_id: "inst_first",
        subject_instance_id: "inst_first",
        producer_id: "prd_fault-fixture",
        build_id: "build_fixture",
        platform: "linux",
        expected_prior_state_digest: firstState,
        desired_state_digest: clearedState,
        reconciler: {
          readStateDigest: () => firstState,
          apply: () => {
            firstState = clearedState;
          },
        },
      }).state,
    ).toBe("recorded");

    const faultedView = readCoordinationViewV3(root);
    expect(faultedView.authority_safe).toBeTrue();
    expect(faultedView.instances.inst_first?.authority_eligible).toBeFalse();
    expect(faultedView.instances.inst_second?.authority_eligible).toBeTrue();
    expect(
      recordLiveTaskChangeV3({
        coordRoot: root,
        owner: "second",
        nativeSessionId: "native-second",
        adapter: "claude-code",
        task: "Continue unaffected work",
      }).state,
    ).toBe("recorded");
    expect(readHeartbeat(root, "second")?.task).toBe("Continue unaffected work");
    expect(readCoordinationViewV3(root).instances.inst_second?.task_state).toBe("set");
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

function startedRoot(adapter: Adapter = "claude-code"): string {
  const root = candidateRoot(adapter);
  expect(
    recordHookSignalV3({
      coordRoot: root,
      mode: "candidate",
      signal: "session-start",
      payload: parsed({ session_id: "native-session" }),
      adapter,
      instance_id: "inst_operator",
      producer_id: "prd_agent-hook",
      build_id: "build_fixture",
      platform: "linux",
    }).state,
  ).toBe("recorded");
  return root;
}

function parsed(values: Partial<ParsedPayload>): ParsedPayload {
  return { raw: {}, ...values };
}

function candidateRoot(adapter: Adapter = "claude-code"): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-live-coord-v3-"));
  roots.push(root);
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
      `sha256:${adapterCapabilityProfileDigestV3(adapter).slice(4)}`,
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
