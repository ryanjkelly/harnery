import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { requestSessionEndExplicitV2 } from "../core/agents/session-finalizer-v2.ts";
import { canonicalJsonV2, sha256V2 } from "../core/events/v2/canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../core/events/v2/capabilities.ts";
import {
  buildCandidateGenesisManifestV2,
  EVENT_V2_GENESIS_MANIFEST,
  repairEventV2ControlPair,
} from "../core/events/v2/control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "../core/events/v2/fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "../core/events/v2/generated.ts";
import {
  appendHookIntakeRecordV2,
  writeProducerDiagnosticV2,
} from "../core/events/v2/producers/intake.ts";
import {
  readHookProducerStateV2,
  recordHookSignalV2,
} from "../core/events/v2/producers/recorder.ts";
import type { ParsedPayload } from "../core/hooks/adapter/parse.ts";
import { collectEventLedgerHealthV2 } from "./agents.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event-ledger health counters", () => {
  test("degrades to unavailable when no V2 ledger route is live", () => {
    const root = temporaryRoot();

    const health = collectEventLedgerHealthV2(root);

    expect(health).toEqual({
      state: "unavailable",
      reason: "V1 stream is live (no V2 ledger)",
    });
  });

  test("reports an orphan open span, a pending explicit end, and spool depths", () => {
    const root = candidateRoot();
    const nativeSession = "native-health-session";
    const adapter = "cursor" as const;

    // session-start + turn + pre-tool-use (opens a span) + stop (closes the
    // turn, leaving the span open with no open turn: the orphan signature).
    expect(
      recordHookSignalV2(
        baseInput(root, "session-start", parsed({ session_id: nativeSession }), adapter),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV2(
        baseInput(
          root,
          "user-prompt-submit",
          parsed({ session_id: nativeSession, turn_id: "turn-1", prompt: "go" }),
          adapter,
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV2(
        baseInput(
          root,
          "pre-tool-use",
          parsed({ session_id: nativeSession, tool_use_id: "tool-1", tool_name: "Read" }),
          adapter,
        ),
      ).state,
    ).toBe("recorded");
    expect(
      recordHookSignalV2(
        baseInput(root, "stop", parsed({ session_id: nativeSession, turn_id: "turn-1" }), adapter),
      ).state,
    ).toBe("recorded");

    const producer = readHookProducerStateV2(root, adapter, nativeSession);
    if (!producer) throw new Error("expected producer state");
    expect(producer.spans).toHaveLength(1);
    expect(producer.current_turn_id).toBeUndefined();

    // Explicit end with an open span queues a pending finalization request.
    const requested = requestSessionEndExplicitV2({
      coordRoot: root,
      instance_id: producer.instance_id,
      generation_id: producer.generation_id,
      coordination_finalized: true,
    });
    expect(requested.state).toBe("queued");

    // One queued intake record + one diagnostics-spool entry, for depth counts.
    appendHookIntakeRecordV2(root, `hid_${"a".repeat(64)}`, {
      format: "harnery-v2-hook-intake",
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
    expect(writeProducerDiagnosticV2(root, "unpairable_tool", { note: "fixture" })).toBeDefined();

    const health = collectEventLedgerHealthV2(root);
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
  });
});

function candidateRoot(): string {
  const root = temporaryRoot();
  const keyStore = loadOrCreateFingerprintKeyStoreV2(root);
  const manifest = buildCandidateGenesisManifestV2({
    profile: {
      initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
      contract_source_digest: sha256V2("contract"),
      harnery_commit: "fixture",
      host_repository_commit: "fixture",
      producer_build_ids: ["build_fixture"],
      adapter_capability_profile_digests: [
        `sha256:${adapterCapabilityProfileDigestV2("claude-code").slice(4)}`,
        `sha256:${adapterCapabilityProfileDigestV2("cursor").slice(4)}`,
      ],
      config_digest: sha256V2("config"),
      canonicalizer_version: "harnery-jcs-nfc-v1",
      fingerprint_version: "hmac-sha256-v1",
      privacy_key_epoch: keyStore.active_epoch_id,
      v1_terminal_digest: sha256V2("v1"),
      v1_terminal_bytes: 1,
      v1_terminal_rows: 1,
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
  const manifestPath = join(root, EVENT_V2_GENESIS_MANIFEST);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${canonicalJsonV2(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV2ControlPair(root).state).toBe("candidate");
  return root;
}

function baseInput(
  root: string,
  signal: Parameters<typeof recordHookSignalV2>[0]["signal"],
  payload: ParsedPayload,
  adapter: "claude-code" | "cursor" = "claude-code",
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
  const root = mkdtempSync(join(tmpdir(), "harn-agents-ledger-health-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  return root;
}
