import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Adapter } from "../../../adapter.ts";
import { readCodexArchiveObservationsV2 } from "../../../agents/codex-archive-v2.ts";
import {
  listSessionFinalizationRequestsV2,
  observeHostDisappearedV2,
  reconcileSessionFinalizationV2,
  requestSessionEndExplicitV2,
} from "../../../agents/session-finalizer-v2.ts";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
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
import {
  drainHookIntakeSpoolV2,
  readHookProducerStateV2,
  recordApprovedSessionEndV2,
  recordHookSignalV2,
} from "./recorder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 persistent hook recorder", () => {
  test("is inert without an exact candidate or active gate", () => {
    const result = recordHookSignalV2({
      ...baseInput(temporaryRoot(), "session-start", parsed({ session_id: "native" })),
      mode: "active",
    });
    expect(result).toEqual({ state: "gate_closed", reason: "closed" });
  });

  test("preserves generation, sequence, turn, span, timing, and privacy across hook processes", () => {
    const root = candidateRoot();
    const nativeSession = "native-account-session";
    const start = recordHookSignalV2(
      baseInput(root, "session-start", parsed({ session_id: nativeSession, model: "sonnet" })),
    );
    const turn = recordHookSignalV2(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-secret", prompt: "patient secret" }),
      ),
    );
    const requested = recordHookSignalV2({
      ...baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "tool-secret",
          tool_name: "Read",
          tool_input: { file_path: "/workspace/project/src/index.ts", token: "API_SECRET_123" },
        }),
      ),
      monotonic_ns: "1000000000",
    });
    const completed = recordHookSignalV2({
      ...baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "tool-secret",
          tool_name: "Read",
          tool_response: "private output",
        }),
      ),
      monotonic_ns: "1250000000",
    });

    expect([start.state, turn.state, requested.state, completed.state]).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "recorded",
    ]);
    expect(existsSync(join(root, ".harnery/private/v2-producers"))).toBeFalse();
    expect(
      readdirSync(join(root, ".harnery/ledgers/v2/private-producers/claude-code")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
    const events = readActiveLedgerV2(root).events.map(({ event }) => event);
    const hookEvents = events.filter((event) => event.producer.producer_id === "prd_hook");
    expect(hookEvents.map((event) => event.producer.sequence)).toEqual([1, 2, 3, 4]);
    expect(
      new Set(hookEvents.map((event) => (event.scope as { generation_id: string }).generation_id))
        .size,
    ).toBe(1);
    expect((hookEvents[0]?.links as { caused_by: string[] }).caused_by).toEqual([
      events[0]?.event_id,
    ]);
    const toolEvents = hookEvents.filter(
      (event) => event.event_type === "tool.requested" || event.event_type === "tool.completed",
    );
    expect(
      new Set(toolEvents.map((event) => (event.links as { span_id: string }).span_id)).size,
    ).toBe(1);
    const completion = hookEvents.find((event) => event.event_type === "tool.completed");
    expect(completion?.payload.duration_ms).toEqual({
      state: "observed",
      value: 250,
      attestation: "derived",
      confidence: "exact",
    });
    const durable = readFileSync(eventV2Paths(root).active, "utf8");
    const state = readHookProducerStateV2(root, "claude-code", nativeSession);
    expect(`${durable}${JSON.stringify(state)}`).not.toContain("patient secret");
    expect(`${durable}${JSON.stringify(state)}`).not.toContain("API_SECRET_123");
    expect(`${durable}${JSON.stringify(state)}`).not.toContain("private output");
    expect(`${durable}${JSON.stringify(state)}`).not.toContain(nativeSession);
  });

  test("replays the exact pending event after a producer crash", () => {
    const root = candidateRoot();
    const input = baseInput(root, "session-start", parsed({ session_id: "retry-session" }));
    expect(() =>
      recordHookSignalV2({
        ...input,
        writerOptions: {
          onStep: (step) => {
            if (step === "ready_published") throw new Error("simulated producer kill");
          },
        },
      }),
    ).toThrow("simulated producer kill");

    const recovered = recordHookSignalV2(input);
    expect(recovered.state).toBe("recorded");
    if (recovered.state === "recorded") expect(recovered.recovered).toBeTrue();
    const events = readActiveLedgerV2(root).events.map(({ event }) => event);
    expect(events).toHaveLength(2);
    expect(events[0]?.event_type).toBe("ledger.genesis");
    expect(events[1]?.event_type).toBe("session.started");
    expect(events[1]?.producer.sequence).toBe(1);
  });

  test("pairs child-agent start and completion without persisting the native child identity", () => {
    const root = candidateRoot();
    const nativeSession = "parent-session";
    const nativeChild = "child-account-secret";
    expect(
      recordHookSignalV2(baseInput(root, "session-start", parsed({ session_id: nativeSession })))
        .state,
    ).toBe("recorded");
    expect(
      recordHookSignalV2(
        baseInput(
          root,
          "sub-agent-start",
          parsed({
            session_id: nativeSession,
            subagent_id: nativeChild,
            raw: { agent_type: "reviewer" },
          }),
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV2(
        baseInput(
          root,
          "sub-agent-stop",
          parsed({ session_id: nativeSession, subagent_id: nativeChild, exit_status: "ok" }),
        ),
      ).state,
    ).toBe("recorded");

    const events = readActiveLedgerV2(root).events.map(({ event }) => event);
    const started = events.find((event) => event.event_type === "agent.started");
    const completed = events.find((event) => event.event_type === "agent.completed");
    expect(started?.payload.delegation_id).toBe(completed?.payload.delegation_id);
    expect(started?.payload.child_generation_id).toBe(completed?.payload.child_generation_id);
    expect(readHookProducerStateV2(root, "claude-code", nativeSession)?.delegations).toEqual([]);
    expect(readFileSync(eventV2Paths(root).active, "utf8")).not.toContain(nativeChild);
  });

  test("routes child-process tool hooks through the native session owner", () => {
    const root = candidateRoot();
    const nativeSession = "shared-parent-session";
    const parentInstance = "inst_parent" as const;
    const childInstance = "inst_child" as const;
    expect(
      recordHookSignalV2({
        ...baseInput(root, "session-start", parsed({ session_id: nativeSession })),
        instance_id: parentInstance,
      }).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV2({
        ...baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: "turn-1", prompt: "delegate" }),
        ),
        instance_id: parentInstance,
      }).state,
    ).toBe("recorded");

    const requested = recordHookSignalV2({
      ...baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "child-tool", tool_name: "Read" }),
      ),
      instance_id: childInstance,
    });
    const completed = recordHookSignalV2({
      ...baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "child-tool",
          tool_name: "Read",
          tool_response: "done",
        }),
      ),
      instance_id: childInstance,
    });

    expect([requested.state, completed.state]).toEqual(["recorded", "recorded"]);
    const toolEvents = readActiveLedgerV2(root)
      .events.map(({ event }) => event)
      .filter(
        (event) => event.event_type === "tool.requested" || event.event_type === "tool.completed",
      );
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents.every((event) => event.scope.instance_id === parentInstance)).toBeTrue();
    expect(toolEvents.some((event) => event.scope.instance_id === childInstance)).toBeFalse();
  });

  test("routes identity-less Cursor hooks through their live instance authority", () => {
    const root = candidateRoot("cursor");
    const start = recordHookSignalV2(
      baseInput(
        root,
        "session-start",
        parsed({ conversation_id: "cursor-conversation" }),
        "cursor",
      ),
    );
    const turn = recordHookSignalV2(
      baseInput(root, "user-prompt-submit", parsed({ turn_id: "cursor-turn" }), "cursor"),
    );
    const requested = recordHookSignalV2(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ tool_use_id: "cursor-tool", tool_name: "Read" }),
        "cursor",
      ),
    );
    const completed = recordHookSignalV2(
      baseInput(
        root,
        "post-tool-use",
        parsed({ tool_use_id: "cursor-tool", tool_name: "Read", tool_response: "done" }),
        "cursor",
      ),
    );

    expect([start.state, turn.state, requested.state, completed.state]).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "recorded",
    ]);
    expect(
      readdirSync(join(root, ".harnery/ledgers/v2/private-producers/cursor")).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
    const events = readActiveLedgerV2(root)
      .events.map(({ event }) => event)
      .filter((event) => event.producer.producer_id === "prd_hook");
    expect(
      new Set(events.map((event) => (event.scope as { generation_id: string }).generation_id)).size,
    ).toBe(1);
    expect(events.every((event) => event.scope.instance_id === "inst_fixture")).toBeTrue();
  });

  test("refuses unsupported Codex terminal authority even if a stale hook invokes it", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-session";
    expect(
      recordHookSignalV2(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV2(
        baseInput(
          root,
          "session-end",
          parsed({ session_id: nativeSession, clean_exit: true }),
          "codex",
        ),
      ),
    ).toEqual({ state: "gate_closed", reason: "signal_not_approved:session_end" });
    expect(readActiveLedgerV2(root).events.map(({ event }) => event.event_type)).toEqual([
      "ledger.genesis",
      "session.started",
    ]);
  });

  test("records one approved terminal and prevents resurrection", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-approved-end";
    expect(
      recordHookSignalV2(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).toBe("recorded");
    const state = readHookProducerStateV2(root, "codex", nativeSession);
    expect(state).toBeDefined();
    if (!state) throw new Error("producer state missing");
    const input = {
      coordRoot: root,
      mode: "candidate" as const,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      build_id: "build_fixture" as const,
      platform: "linux" as const,
      reason: "approved_explicit_end" as const,
      outcome: "succeeded" as const,
      coordination_finalized: true,
    };
    expect(recordApprovedSessionEndV2(input).state).toBe("recorded");
    expect(recordApprovedSessionEndV2(input).state).toBe("already_ended");
    expect(
      recordHookSignalV2(
        baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).not.toBe("recorded");
    const terminal = readActiveLedgerV2(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "session.ended");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.payload).toMatchObject({
      authority: "approved",
      reason: "approved_explicit_end",
    });
  });

  test("queues an explicit end inside a live turn and finalizes after that turn closes", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-deferred-end";
    recordHookSignalV2(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV2(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV2(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "end-command", tool_name: "Bash" }),
        "codex",
      ),
    );
    const state = readHookProducerStateV2(root, "codex", nativeSession);
    if (!state) throw new Error("producer state missing");
    expect(
      requestSessionEndExplicitV2({
        coordRoot: root,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("queued");
    expect(reconcileSessionFinalizationV2(root, { archive_observations: [] })).toMatchObject({
      finalized: 0,
      pending: 1,
    });
    recordHookSignalV2(
      baseInput(
        root,
        "post-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "end-command", tool_name: "Bash" }),
        "codex",
      ),
    );
    recordHookSignalV2(baseInput(root, "stop", parsed({ session_id: nativeSession }), "codex"));
    expect(reconcileSessionFinalizationV2(root, { archive_observations: [] })).toMatchObject({
      finalized: 1,
      pending: 0,
      cancelled: 0,
    });
    expect(readHookProducerStateV2(root, "codex", nativeSession)?.terminal).toBeTrue();
    expect(listSessionFinalizationRequestsV2(root)[0]).toMatchObject({
      trigger: "explicit_end",
      status: "completed",
    });
  });

  test("cancels a deferred explicit end when new work starts", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-cancel-deferred-end";
    recordHookSignalV2(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV2(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession }), "codex"),
    );
    const state = readHookProducerStateV2(root, "codex", nativeSession);
    if (!state) throw new Error("producer state missing");
    expect(
      requestSessionEndExplicitV2({
        coordRoot: root,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        coordination_finalized: true,
      }).state,
    ).toBe("queued");
    recordHookSignalV2(baseInput(root, "stop", parsed({ session_id: nativeSession }), "codex"));
    recordHookSignalV2(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession }), "codex"),
    );
    expect(reconcileSessionFinalizationV2(root, { archive_observations: [] })).toMatchObject({
      finalized: 0,
      cancelled: 1,
    });
    expect(readHookProducerStateV2(root, "codex", nativeSession)?.terminal).toBeFalse();
    expect(listSessionFinalizationRequestsV2(root)[0]?.status).toBe("cancelled");
  });

  test("gives verified archive a cancellation grace period before finalizing", () => {
    const root = candidateRoot("codex");
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      JSON.stringify({ coord: { finalization: { archive_grace_seconds: 60 } } }),
    );
    const nativeSession = "codex-archive-grace";
    expect(
      recordHookSignalV2(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).toBe("recorded");
    const observedAt = "2026-08-17T12:00:00.000Z";
    const first = reconcileSessionFinalizationV2(root, {
      now: new Date(observedAt),
      archive_observations: [
        {
          adapter: "codex",
          native_session_id: nativeSession,
          archived: true,
          observed_at: observedAt,
        },
      ],
    });
    expect(first).toMatchObject({ observed: 1, finalized: 0, pending: 1 });
    expect(listSessionFinalizationRequestsV2(root)[0]?.status).toBe("pending");
    const second = reconcileSessionFinalizationV2(root, {
      now: new Date("2026-08-17T12:01:01.000Z"),
      archive_observations: [],
    });
    expect(second.finalized).toBe(1);
    const terminal = readActiveLedgerV2(root)
      .events.map(({ event }) => event)
      .find((event) => event.event_type === "session.ended");
    expect(terminal?.payload).toMatchObject({
      authority: "approved",
      reason: "approved_verified_archive",
    });
  });

  test("reads only known Codex archive identities from a private database snapshot", () => {
    const root = candidateRoot("codex");
    const nativeSession = "known-codex-thread";
    expect(
      recordHookSignalV2(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
      ).state,
    ).toBe("recorded");
    const databasePath = join(root, "codex-state.sqlite");
    const database = new Database(databasePath);
    database.run(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL, archived_at INTEGER, updated_at_ms INTEGER NOT NULL)",
    );
    database.run("INSERT INTO threads VALUES (?, 1, ?, ?)", [
      nativeSession,
      1_776_668_400,
      1_776_668_400_000,
    ]);
    database.run("INSERT INTO threads VALUES (?, 1, ?, ?)", [
      "unrelated-private-thread",
      1_776_668_401,
      1_776_668_401_000,
    ]);
    database.close();
    expect(readCodexArchiveObservationsV2(root, { databasePath }).observations).toEqual([
      {
        adapter: "codex",
        native_session_id: nativeSession,
        archived: true,
        observed_at: "2026-04-20T07:00:00.000Z",
      },
    ]);
    expect(readFileSync(eventV2Paths(root).active, "utf8")).not.toContain(nativeSession);
  });

  test("keeps host loss provisional until the cascade grace expires", () => {
    const root = candidateRoot("codex");
    writeFileSync(
      join(root, ".harnery/config.jsonc"),
      JSON.stringify({ coord: { finalization: { cascade_grace_seconds: 30 } } }),
    );
    const nativeSession = "host-loss-session";
    recordHookSignalV2(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    const state = readHookProducerStateV2(root, "codex", nativeSession);
    if (!state) throw new Error("producer state missing");
    expect(
      observeHostDisappearedV2({
        coordRoot: root,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        observed_at: "2026-08-17T13:00:00.000Z",
      }).state,
    ).toBe("observed");
    expect(
      reconcileSessionFinalizationV2(root, {
        now: new Date("2026-08-17T13:00:29.000Z"),
        archive_observations: [],
      }).finalized,
    ).toBe(0);
    expect(
      reconcileSessionFinalizationV2(root, {
        now: new Date("2026-08-17T13:00:31.000Z"),
        archive_observations: [],
      }).finalized,
    ).toBe(1);
  });

  test("records Cursor pre-compaction but refuses unsupported completion telemetry", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "cursor-session";
    expect(
      recordHookSignalV2(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), "cursor"),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV2(
        baseInput(
          root,
          "pre-compact",
          parsed({ session_id: nativeSession, raw: { pre_tokens: 80, context_window_size: 100 } }),
          "cursor",
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV2(
        baseInput(
          root,
          "post-compact",
          parsed({ session_id: nativeSession, raw: { post_tokens: 20, context_window_size: 100 } }),
          "cursor",
        ),
      ),
    ).toEqual({ state: "gate_closed", reason: "signal_not_approved:post_compaction" });
  });
});

function candidateRoot(adapter: Adapter = "claude-code"): string {
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
      `sha256:${adapterCapabilityProfileDigestV2(adapter).slice(4)}`,
    ],
    config_digest: sha256V2("config"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: keyStore.active_epoch_id,
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

function baseInput(
  root: string,
  signal: Parameters<typeof recordHookSignalV2>[0]["signal"],
  payload: ParsedPayload,
  adapter: Adapter = "claude-code",
) {
  return {
    coordRoot: root,
    mode: "candidate" as const,
    signal,
    payload,
    adapter,
    instance_id: "inst_fixture" as const,
    producer_id: "prd_hook" as const,
    build_id: "build_fixture" as const,
    platform: "linux" as const,
    adapterVersion: "1.0.0",
    harnessVersion: "1.0.0",
  };
}

function parsed(values: Partial<ParsedPayload>): ParsedPayload {
  return { raw: {}, ...values };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v2-recorder-"));
  roots.push(root);
  return root;
}

describe("event ledger V2 hook intake spool", () => {
  const LEDGER_ROOT = ".harnery/ledgers/v2";

  function statePathFor(root: string, adapter = "claude-code"): string {
    const directory = join(root, LEDGER_ROOT, "private-producers", adapter);
    const name = readdirSync(directory).find((entry) => entry.endsWith(".json"));
    if (!name) throw new Error("no producer state file");
    return join(directory, name);
  }

  function holdStateLease(root: string, statePath: string) {
    return acquireNoClobberLease({
      path: `${statePath}.lease`,
      scope: "event-v2-hook-producer",
      authoritySha256: createHash("sha256")
        .update(join(root))
        .update("\0")
        .update(statePath)
        .digest("hex"),
      staleAfterMs: 5_000,
    });
  }

  function intakeDir(root: string, adapter = "claude-code"): string {
    return join(root, LEDGER_ROOT, "intake", "hook", adapter);
  }

  function intakeEntryCount(root: string, adapter = "claude-code"): number {
    const directory = intakeDir(root, adapter);
    if (!existsSync(directory)) return 0;
    return readdirSync(directory)
      .map((group) => readdirSync(join(directory, group)).length)
      .reduce((sum, count) => sum + count, 0);
  }

  function diagnosticsFiles(root: string): string[] {
    const directory = join(root, LEDGER_ROOT, "diagnostics");
    return existsSync(directory) ? readdirSync(directory) : [];
  }

  test("a lease-contended signal spools durably and the next signal drains it in order", () => {
    const root = candidateRoot();
    const nativeSession = "spool-session";
    recordHookSignalV2(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    const statePath = statePathFor(root);
    const lease = holdStateLease(root, statePath);
    try {
      const contended = recordHookSignalV2(
        baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: "turn-a", prompt: "queued" }),
        ),
      );
      expect(contended).toEqual({ state: "spooled" });
      expect(intakeEntryCount(root)).toBe(1);
    } finally {
      lease.release();
    }
    const next = recordHookSignalV2(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "call-1", tool_name: "Bash" }),
      ),
    );
    expect(next.state).toBe("recorded");
    expect(intakeEntryCount(root)).toBe(0);
    const ledger = readActiveLedgerV2(root);
    const types = ledger.events.map(({ event }) => event.event_type);
    expect(types).toContain("turn.started");
    const requested = ledger.events.find(({ event }) => event.event_type === "tool.requested");
    const turn = ledger.events.find(({ event }) => event.event_type === "turn.started");
    expect((requested?.event.scope as { turn_id?: string }).turn_id).toBe(
      (turn?.event.scope as { turn_id?: string }).turn_id,
    );
  });

  test("reconcile-style drain records a marooned final signal with no later hook", () => {
    const root = candidateRoot();
    const nativeSession = "marooned-session";
    recordHookSignalV2(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    const statePath = statePathFor(root);
    const lease = holdStateLease(root, statePath);
    try {
      const contended = recordHookSignalV2(
        baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: "turn-final", prompt: "last signal" }),
        ),
      );
      expect(contended).toEqual({ state: "spooled" });
    } finally {
      lease.release();
    }
    const drained = drainHookIntakeSpoolV2(root);
    expect(drained.groups_with_records).toBe(1);
    expect(drained.groups_drained).toBe(1);
    expect(intakeEntryCount(root)).toBe(0);
    const ledger = readActiveLedgerV2(root);
    expect(ledger.events.map(({ event }) => event.event_type)).toContain("turn.started");
  });

  test("an unpairable post on a recovery-disabled adapter is preserved in diagnostics with content redacted", () => {
    const root = candidateRoot("cursor");
    const nativeSession = "unpairable-session";
    recordHookSignalV2(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "cursor"),
    );
    const result = recordHookSignalV2(
      baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "never-seen",
          tool_name: "Bash",
          tool_response: { output: "RAW_TOOL_OUTPUT_SECRET" },
        }),
        "cursor",
      ),
    );
    expect(result).toEqual({ state: "unpairable_tool", reason: "no_open_span" });
    const files = diagnosticsFiles(root).filter((name) => name.startsWith("unpairable_tool-"));
    expect(files.length).toBe(1);
    const contents = readFileSync(join(root, LEDGER_ROOT, "diagnostics", files[0]!), "utf8");
    expect(contents).not.toContain("RAW_TOOL_OUTPUT_SECRET");
    expect(contents).toContain("no_open_span");
    expect(contents).not.toContain("never-seen");
    expect(contents).toContain("sha256");
  });

  test("an unmatched post on a recovery-enabled adapter mints a derived request and pairs the native completion", () => {
    const root = candidateRoot();
    const nativeSession = "recovered-post-session";
    recordHookSignalV2(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    const result = recordHookSignalV2(
      baseInput(
        root,
        "post-tool-use",
        parsed({
          session_id: nativeSession,
          tool_use_id: "request-lost",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
          tool_response: { output: "RAW_TOOL_OUTPUT_SECRET" },
        }),
      ),
    );
    expect(result.state).toBe("recorded");
    if (result.state !== "recorded") throw new Error("expected recorded");
    expect(result.event.event_type).toBe("tool.completed");
    expect(result.event.provenance.attestation).toBe("native");

    const rows = readActiveLedgerV2(root).events.map((entry) => entry.event);
    const derivedRequest = rows.find((event) => event.event_type === "tool.requested");
    if (derivedRequest?.event_type !== "tool.requested") {
      throw new Error("derived request missing");
    }
    expect(derivedRequest.provenance.attestation).toBe("derived");
    expect(derivedRequest.provenance.confidence).toBe("high");
    expect(derivedRequest.payload.recovery).toEqual({ reason: "request_not_observed" });
    expect((derivedRequest.links as { span_id: string }).span_id).toBe(
      (result.event.links as { span_id: string }).span_id,
    );
    // The pair closed the span: it lives in closed-span memory, not open spans.
    const state = readHookProducerStateV2(root, "claude-code", nativeSession);
    expect(state?.spans.length).toBe(0);
    expect(state?.closed_spans.length).toBe(1);
  });

  test("late signals for a closed span are suppressed, never re-opened", () => {
    const root = candidateRoot();
    const nativeSession = "late-signal-session";
    const base = { session_id: nativeSession, tool_use_id: "call-1", tool_name: "Read" };
    recordHookSignalV2(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    recordHookSignalV2(baseInput(root, "pre-tool-use", parsed(base)));
    recordHookSignalV2(baseInput(root, "post-tool-use", parsed(base)));

    const latePost = recordHookSignalV2(baseInput(root, "post-tool-use", parsed(base)));
    expect(latePost).toEqual({ state: "suppressed", reason: "closed_span" });
    const latePre = recordHookSignalV2(baseInput(root, "pre-tool-use", parsed(base)));
    expect(latePre).toEqual({ state: "suppressed", reason: "closed_span" });
    expect(readHookProducerStateV2(root, "claude-code", nativeSession)?.spans.length).toBe(0);
    expect(
      diagnosticsFiles(root).filter((name) => name.startsWith("late_pre_suppressed-")).length,
    ).toBe(1);
    expect(
      diagnosticsFiles(root).filter((name) => name.startsWith("late_post_suppressed-")).length,
    ).toBe(1);
  });

  test("closes permission waits on a matching tool signal and on turn interruption", () => {
    const resolvedRoot = candidateRoot();
    const resolvedSession = "resolved-wait-session";
    recordHookSignalV2(
      baseInput(resolvedRoot, "session-start", parsed({ session_id: resolvedSession })),
    );
    recordHookSignalV2(
      baseInput(
        resolvedRoot,
        "user-prompt-submit",
        parsed({ session_id: resolvedSession, turn_id: "turn-1", prompt: "go" }),
      ),
    );
    recordHookSignalV2(
      baseInput(
        resolvedRoot,
        "permission-request",
        parsed({ session_id: resolvedSession, tool_use_id: "permission-1" }),
      ),
    );
    recordHookSignalV2(
      baseInput(
        resolvedRoot,
        "pre-tool-use",
        parsed({
          session_id: resolvedSession,
          tool_use_id: "permission-1",
          tool_name: "Bash",
        }),
      ),
    );
    const resolved = readActiveLedgerV2(resolvedRoot)
      .events.map(({ event }) => event)
      .filter(
        (event) =>
          event.event_type === "interaction.wait_started" ||
          event.event_type === "interaction.wait_ended" ||
          event.event_type === "tool.requested",
      );
    expect(resolved.map(({ event_type }) => event_type)).toEqual([
      "interaction.wait_started",
      "interaction.wait_ended",
      "tool.requested",
    ]);
    const started = resolved[0];
    const ended = resolved[1];
    expect(ended?.payload).toMatchObject({
      wait_id: (started?.payload as { wait_id: string }).wait_id,
      outcome: "succeeded",
      resolution_reference: "pre-tool-use",
    });
    expect(readHookProducerStateV2(resolvedRoot, "claude-code", resolvedSession)?.waits).toEqual(
      [],
    );

    const interruptedRoot = candidateRoot();
    const interruptedSession = "interrupted-wait-session";
    recordHookSignalV2(
      baseInput(interruptedRoot, "session-start", parsed({ session_id: interruptedSession })),
    );
    recordHookSignalV2(
      baseInput(
        interruptedRoot,
        "user-prompt-submit",
        parsed({ session_id: interruptedSession, turn_id: "turn-1", prompt: "go" }),
      ),
    );
    recordHookSignalV2(
      baseInput(
        interruptedRoot,
        "permission-request",
        parsed({ session_id: interruptedSession, tool_use_id: "permission-2" }),
      ),
    );
    recordHookSignalV2(
      baseInput(
        interruptedRoot,
        "stop-failure",
        parsed({ session_id: interruptedSession, turn_id: "turn-1" }),
      ),
    );
    const interrupted = readActiveLedgerV2(interruptedRoot)
      .events.map(({ event }) => event)
      .filter(
        (event) =>
          event.event_type === "interaction.wait_ended" || event.event_type === "turn.completed",
      );
    expect(interrupted.map(({ event_type }) => event_type)).toEqual([
      "interaction.wait_ended",
      "turn.completed",
    ]);
    expect(interrupted[0]?.payload).toMatchObject({
      outcome: "interrupted",
      resolution_reference: "turn_terminal",
    });
  });

  test("a stop boundary terminalizes the ending turn's stamped spans before turn.completed", () => {
    const root = candidateRoot();
    const nativeSession = "boundary-session";
    recordHookSignalV2(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    recordHookSignalV2(
      baseInput(root, "user-prompt-submit", parsed({ session_id: nativeSession, prompt: "go" })),
    );
    recordHookSignalV2(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "lost-call", tool_name: "Bash" }),
      ),
    );
    recordHookSignalV2(baseInput(root, "stop", parsed({ session_id: nativeSession })));

    const rows = readActiveLedgerV2(root).events.map((entry) => entry.event);
    const derived = rows.find(
      (event) =>
        event.event_type === "tool.completed" && event.provenance.attestation === "derived",
    );
    if (derived?.event_type !== "tool.completed") {
      throw new Error("derived terminal missing");
    }
    expect(derived.payload.outcome).toBe("unknown");
    expect(derived.payload.recovery?.reason).toBe("completion_not_observed_before_turn_end");
    expect(derived.payload.recovery?.requested_event_id).toBeDefined();
    const turnCompleted = rows.find((event) => event.event_type === "turn.completed");
    expect(rows.indexOf(derived)).toBeLessThan(rows.indexOf(turnCompleted as never));
    expect(readHookProducerStateV2(root, "claude-code", nativeSession)?.spans.length).toBe(0);
  });

  test("a lost stop is recovered at the next turn start", () => {
    const root = candidateRoot("codex");
    const nativeSession = "lost-stop-session";
    recordHookSignalV2(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV2(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-1" }),
        "codex",
      ),
    );
    recordHookSignalV2(
      baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          turn_id: "turn-1",
          tool_use_id: "abandoned",
          tool_name: "shell",
        }),
        "codex",
      ),
    );
    // Stop hook lost; the next prompt starts turn-2.
    recordHookSignalV2(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-2" }),
        "codex",
      ),
    );
    const rows = readActiveLedgerV2(root).events.map((entry) => entry.event);
    const derived = rows.find(
      (event) =>
        event.event_type === "tool.completed" && event.provenance.attestation === "derived",
    );
    if (derived?.event_type !== "tool.completed") {
      throw new Error("derived terminal missing");
    }
    expect(derived.payload.recovery?.reason).toBe("completion_not_observed_before_next_turn");
    expect(derived.provenance.confidence).toBe("low");
    expect(readHookProducerStateV2(root, "codex", nativeSession)?.spans.length).toBe(0);
  });

  test("a mid-flight session onboards with a derived session.started; a terminal one never resurrects", () => {
    const root = candidateRoot();
    const nativeSession = "mid-flight-session";
    const result = recordHookSignalV2(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "first-signal", tool_name: "Bash" }),
      ),
    );
    expect(result.state).toBe("recorded");
    const rows = readActiveLedgerV2(root).events.map((entry) => entry.event);
    const started = rows.find((event) => event.event_type === "session.started");
    if (started?.event_type !== "session.started") {
      throw new Error("derived session.started missing");
    }
    expect(started.provenance.attestation).toBe("derived");
    expect(started.payload.resume).toEqual({
      state: "unknown",
      reason: "mid_flight_onboarding",
    });

    // Authoritative termination still refuses later signals.
    const state = readHookProducerStateV2(root, "claude-code", nativeSession);
    if (!state) throw new Error("missing state");
    recordHookSignalV2(baseInput(root, "stop", parsed({ session_id: nativeSession })));
    expect(
      recordApprovedSessionEndV2({
        coordRoot: root,
        mode: "candidate",
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        build_id: "build_fixture",
        platform: "linux",
        reason: "approved_explicit_end",
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("recorded");
    const afterEnd = recordHookSignalV2(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "zombie", tool_name: "Bash" }),
      ),
    );
    expect(afterEnd.state).toBe("missing_session_start");
  });

  test("a poison intake record is quarantined and the drain continues", () => {
    const root = candidateRoot();
    const nativeSession = "poison-session";
    recordHookSignalV2(baseInput(root, "session-start", parsed({ session_id: nativeSession })));
    const adapterDir = intakeDir(root);
    const group = readdirSync(adapterDir)[0]!;
    writeFileSync(join(adapterDir, group, "0000000000000-poison.json"), "not json", {
      mode: 0o600,
    });
    const next = recordHookSignalV2(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-b", prompt: "after poison" }),
      ),
    );
    expect(next.state).toBe("recorded");
    expect(intakeEntryCount(root)).toBe(0);
    const files = diagnosticsFiles(root).filter((name) => name.startsWith("intake_unreadable-"));
    expect(files.length).toBe(1);
  });
});

describe("pending explicit-end expiry", () => {
  test("a wedged explicit end (turn never closes) is cancelled after the grace period, never terminalized", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-wedged-end";
    recordHookSignalV2(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    recordHookSignalV2(
      baseInput(
        root,
        "user-prompt-submit",
        parsed({ session_id: nativeSession, turn_id: "turn-w" }),
        "codex",
      ),
    );
    recordHookSignalV2(
      baseInput(
        root,
        "pre-tool-use",
        parsed({
          session_id: nativeSession,
          turn_id: "turn-w",
          tool_use_id: "orphan-call",
          tool_name: "Bash",
        }),
        "codex",
      ),
    );
    // The stop hook is lost: the turn never closes, so salvage stays
    // ineligible (open turn) and the wedge this expiry mechanism targets forms.
    const state = readHookProducerStateV2(root, "codex", nativeSession);
    if (!state) throw new Error("missing producer state");
    const queued = requestSessionEndExplicitV2({
      coordRoot: root,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      outcome: "succeeded",
      coordination_finalized: true,
    });
    expect(queued.state).toBe("queued");

    // A second explicit end reports the exact blocker instead of a bare refusal.
    const repeated = requestSessionEndExplicitV2({
      coordRoot: root,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      outcome: "succeeded",
      coordination_finalized: true,
    });
    expect(repeated.state).toBe("already_requested");
    if (repeated.state === "already_requested") {
      expect(repeated.blocker.open_span_ids.length).toBe(1);
      expect(repeated.blocker.current_turn_open).toBeTrue();
    }

    // Inside the grace period the request stays pending.
    expect(reconcileSessionFinalizationV2(root, { archive_observations: [] })).toMatchObject({
      pending: 1,
      cancelled: 0,
    });
    // Past the grace period it is cancelled (a safe, reversible transition) —
    // never terminalized from age alone.
    const future = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const expired = reconcileSessionFinalizationV2(root, {
      archive_observations: [],
      now: future,
    });
    expect(expired.cancelled).toBe(1);
    expect(
      expired.diagnostics.some((d) => d.startsWith("expired_pending_explicit_end:")),
    ).toBeTrue();
    expect(readHookProducerStateV2(root, "codex", nativeSession)?.terminal).toBeFalse();
    expect(listSessionFinalizationRequestsV2(root)[0]).toMatchObject({ status: "cancelled" });
  });

  test("a closed-turn explicit end with approved orphan spans salvages instead of expiring", () => {
    const root = candidateRoot("codex");
    const nativeSession = "codex-salvage-end";
    recordHookSignalV2(
      baseInput(root, "session-start", parsed({ session_id: nativeSession }), "codex"),
    );
    // No turn context: the orphan span stays unstamped, survives the stop
    // boundary sweep (fail closed), and only explicit-end salvage can reach it.
    recordHookSignalV2(
      baseInput(
        root,
        "pre-tool-use",
        parsed({ session_id: nativeSession, tool_use_id: "orphan-call", tool_name: "Bash" }),
        "codex",
      ),
    );
    recordHookSignalV2(baseInput(root, "stop", parsed({ session_id: nativeSession }), "codex"));
    expect(readHookProducerStateV2(root, "codex", nativeSession)?.spans.length).toBe(1);

    const state = readHookProducerStateV2(root, "codex", nativeSession);
    if (!state) throw new Error("missing producer state");
    const queued = requestSessionEndExplicitV2({
      coordRoot: root,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      outcome: "succeeded",
      coordination_finalized: true,
    });
    expect(queued.state).toBe("queued");

    const reconciled = reconcileSessionFinalizationV2(root, { archive_observations: [] });
    expect(reconciled.finalized).toBe(1);
    expect(reconciled.diagnostics.some((d) => d.startsWith("salvaged_explicit_end:"))).toBeTrue();
    const rows = readActiveLedgerV2(root).events.map(({ event }) => event);
    const salvage = rows.find(
      (event) =>
        event.event_type === "tool.completed" &&
        event.payload.recovery?.reason === "explicit_end_salvage",
    );
    if (salvage?.event_type !== "tool.completed") {
      throw new Error("salvage terminal missing");
    }
    expect(salvage.payload.outcome).toBe("unknown");
    const ended = rows.find((event) => event.event_type === "session.ended");
    expect(ended).toBeDefined();
    expect(readHookProducerStateV2(root, "codex", nativeSession)?.terminal).toBeTrue();
    expect(listSessionFinalizationRequestsV2(root)[0]).toMatchObject({ status: "completed" });
  });
});
