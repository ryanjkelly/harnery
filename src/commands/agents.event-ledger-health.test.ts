import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { requestSessionEndExplicitV3 } from "../core/agents/session-finalizer-v3.ts";
import { canonicalJsonV3, sha256V3 } from "../core/events/v3/canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../core/events/v3/capabilities.ts";
import {
  buildCandidateGenesisManifestV3,
  EVENT_V3_GENESIS_MANIFEST,
} from "../core/events/v3/control.ts";
import { repairEventV3ControlPair } from "../core/events/v3/control-writer.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../core/events/v3/fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../core/events/v3/generated.ts";
import { recordCoordinationAuthorityV3 } from "../core/events/v3/producers/coordination-recorder.ts";
import {
  appendHookIntakeRecordV3,
  writeProducerDiagnosticV3,
} from "../core/events/v3/producers/intake.ts";
import {
  readHookProducerStateV3,
  recordHookSignalV3,
} from "../core/events/v3/producers/recorder.ts";
import type { ParsedPayload } from "../core/hooks/adapter/parse.ts";
import { collectEventLedgerHealthV3 } from "./agents.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event-ledger health counters", () => {
  test("degrades to unavailable when no V3 ledger route is live", () => {
    const root = temporaryRoot();

    const health = collectEventLedgerHealthV3(root);

    expect(health).toEqual({
      state: "unavailable",
      reason: "closed: no_candidate",
    });
  });

  test("reports an orphan open span, a pending explicit end, and spool depths", () => {
    const root = candidateRoot();
    const nativeSession = "native-health-session";
    const adapter = "cursor" as const;

    // session-start + pre-tool-use before any turn (opens an unstamped span) +
    // turn + stop (closes the turn while the unowned span remains: the orphan
    // signature). A span stamped to the open turn is now correctly swept.
    expect(
      recordHookSignalV3(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), adapter),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "pre-tool-use",
          parsed({ session_id: nativeSession, tool_use_id: "tool-1", tool_name: "Read" }),
          adapter,
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: "turn-1", prompt: "go" }),
          adapter,
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(root, "stop", parsed({ session_id: nativeSession, turn_id: "turn-1" }), adapter),
      ).state,
    ).toBe("recorded");

    const producer = readHookProducerStateV3(root, adapter, nativeSession);
    if (!producer) throw new Error("expected producer state");
    expect(producer.spans).toHaveLength(1);
    expect(producer.current_turn_id).toBeUndefined();

    // Explicit end with an open span queues a pending finalization request.
    const requested = requestSessionEndExplicitV3({
      coordRoot: root,
      instance_id: producer.instance_id,
      generation_id: producer.generation_id,
      coordination_finalized: true,
    });
    expect(requested.state).toBe("queued");

    // One queued intake record + one diagnostics-spool entry, for depth counts.
    appendHookIntakeRecordV3(root, `hid_${"a".repeat(64)}`, {
      format: "harnery-v3-hook-intake",
      format_version: 1,
      mode: "candidate",
      signal: "post-tool-use",
      payload: parsed({ session_id: "other-session", tool_use_id: "tool-9" }),
      adapter,
      instance_id: "inst_fixture",
      producer_id: "prd_hook",
      build_id: "build_fixture",
      platform: "linux",
    });
    expect(writeProducerDiagnosticV3(root, "unpairable_tool", { note: "fixture" })).toBeDefined();

    const health = collectEventLedgerHealthV3(root);
    if (health.state !== "live") throw new Error(`expected live health, got ${health.reason}`);

    expect(health.mode).toBe("candidate");
    expect(health.collection_errors).toEqual([]);

    // 1 open span whose generation has no open turn (orphan signature).
    expect(health.open_spans.total).toBe(1);
    expect(health.open_spans.generations).toHaveLength(1);
    expect(health.open_spans.generations[0]).toMatchObject({
      instance_id: producer.instance_id,
      generation_id: producer.generation_id,
      adapter,
      span_count: 1,
      turn_open: false,
    });

    // 1 pending explicit-end request carrying the allowed open span.
    expect(health.pending_finalizations).toHaveLength(1);
    const pending = health.pending_finalizations[0];
    if (!pending) throw new Error("expected pending finalization");
    expect(pending.trigger).toBe("explicit_end");
    expect(pending.generation_id).toBe(producer.generation_id);
    expect(pending.allowed_open_span_count).toBe(1);
    expect(pending.age_ms).toBeGreaterThanOrEqual(0);

    // Spool depths: one queued intake record, one diagnostics entry (last-24h).
    expect(health.intake_spool.total).toBe(1);
    expect(health.intake_spool.groups).toEqual([
      {
        adapter,
        session_hash: `hid_${"a".repeat(64)}`,
        count: 1,
      },
    ]);
    expect(health.diagnostics_spool.total).toBe(1);
    expect(health.diagnostics_spool.last_24h).toBe(1);
    expect(health.diagnostics_spool.by_category).toEqual({
      unpairable_tool: { total: 1, last_24h: 1 },
    });

    // No producer is near the span cap.
    expect(health.span_pressure).toEqual([]);
    expect(health.coordination_authority).toEqual({
      safe: true,
      global_diagnostics: 0,
      isolated_diagnostics: 0,
      affected_generations: [],
      codes: [],
    });
  });

  test("reports a generation-isolated authority diagnostic on its first health read", () => {
    const root = candidateRoot();
    const firstSession = "native-health-first";
    const secondSession = "native-health-second";
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "session-start",
          parsed({ session_id: firstSession }),
          "cursor",
          "inst_first",
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV3(
        baseInput(
          root,
          "session-start",
          parsed({ session_id: secondSession }),
          "cursor",
          "inst_second",
        ),
      ).state,
    ).toBe("recorded");
    const first = readHookProducerStateV3(root, "cursor", firstSession);
    const second = readHookProducerStateV3(root, "cursor", secondSession);
    if (!first || !second) throw new Error("expected two producer generations");
    let authorityState = sha256V3("empty");
    const desiredState = sha256V3("cleared");
    expect(
      recordCoordinationAuthorityV3({
        coordRoot: root,
        mode: "candidate",
        signal: "task-changed",
        observation: {
          native_observation_id: "mismatched-first-task",
          state: "cleared",
          prior_state: "set",
        },
        adapter: "cursor",
        native_actor_session_id: firstSession,
        actor_instance_id: first.instance_id,
        subject_instance_id: first.instance_id,
        producer_id: "prd_coord",
        build_id: "build_fixture",
        platform: "linux",
        expected_prior_state_digest: authorityState,
        desired_state_digest: desiredState,
        reconciler: {
          readStateDigest: () => authorityState,
          apply: () => {
            authorityState = desiredState;
          },
        },
      }).state,
    ).toBe("recorded");

    const health = collectEventLedgerHealthV3(root);
    if (health.state !== "live") throw new Error(`expected live health, got ${health.reason}`);

    expect(health.coordination_authority).toEqual({
      safe: true,
      global_diagnostics: 0,
      isolated_diagnostics: 1,
      affected_generations: [first.generation_id],
      codes: ["transition_prior_mismatch"],
    });
    expect(health.coordination_authority.affected_generations).not.toContain(second.generation_id);
  });
});

function candidateRoot(): string {
  const root = temporaryRoot();
  const keyStore = loadOrCreateFingerprintKeyStoreV3(root);
  const manifest = buildCandidateGenesisManifestV3({
    profile: {
      initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      contract_source_digest: sha256V3("contract"),
      harnery_commit: "fixture",
      host_repository_commit: "fixture",
      producer_build_ids: ["build_fixture"],
      adapter_capability_profile_digests: [
        `sha256:${adapterCapabilityProfileDigestV3("claude-code").slice(4)}`,
        `sha256:${adapterCapabilityProfileDigestV3("cursor").slice(4)}`,
      ],
      config_digest: sha256V3("config"),
      canonicalizer_version: "harnery-jcs-nfc-v1",
      fingerprint_version: "hmac-sha256-v1",
      privacy_key_epoch: keyStore.active_epoch_id,
      candidate_created_at: "2026-08-16T18:00:00.000Z",
    },
    root_id: "root_fixture",
    instance_id: "inst_cutover",
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 1,
      build_id: "build_fixture",
      platform: "linux",
    },
  });
  const manifestPath = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV3ControlPair(root).state).toBe("candidate");
  return root;
}

function baseInput(
  root: string,
  signal: Parameters<typeof recordHookSignalV3>[0]["signal"],
  payload: ParsedPayload,
  adapter: "claude-code" | "cursor" = "claude-code",
  instanceId: `inst_${string}` = "inst_fixture",
) {
  return {
    coordRoot: root,
    mode: "candidate" as const,
    signal,
    payload,
    adapter,
    instance_id: instanceId,
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
  const root = mkdtempSync(join(tmpdir(), "harn-agents-ledger-health-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  return root;
}
