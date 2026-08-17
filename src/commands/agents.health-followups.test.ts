import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJsonV2, sha256V2 } from "../core/events/v2/canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../core/events/v2/capabilities.ts";
import { recoverEventV2Catalog } from "../core/events/v2/catalog.ts";
import {
  buildCandidateGenesisManifestV2,
  EVENT_V2_GENESIS_MANIFEST,
  repairEventV2ControlPair,
} from "../core/events/v2/control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "../core/events/v2/fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "../core/events/v2/generated.ts";
import { writeProducerDiagnosticV2 } from "../core/events/v2/producers/intake.ts";
import { recordHookSignalV2 } from "../core/events/v2/producers/recorder.ts";
import type { ParsedPayload } from "../core/hooks/adapter/parse.ts";
import { collectActiveAgentHealth, collectEventLedgerHealthV2, readHookErrors } from "./agents.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent health follow-up diagnostics", () => {
  test("uses V2 generations instead of stale heartbeat caches for active health", () => {
    const root = candidateRoot();
    expect(
      recordHookSignalV2({
        coordRoot: root,
        mode: "candidate",
        signal: "session-start",
        payload: parsed({ session_id: "live-session" }),
        adapter: "claude-code",
        instance_id: "inst_live",
        producer_id: "prd_hook",
        build_id: "build_fixture",
        platform: "linux",
      }).state,
    ).toBe("recorded");
    recoverEventV2Catalog(root);
    const staleCache = join(root, ".harnery/active/stale-v1.json");
    mkdirSync(dirname(staleCache), { recursive: true });
    writeFileSync(
      staleCache,
      JSON.stringify({
        schema_version: 1,
        instance_id: "stale-v1",
        last_heartbeat: "2020-01-01T00:00:00.000Z",
        platform: "claude-code",
        kind: "session",
      }),
    );

    expect(collectActiveAgentHealth(root)).toMatchObject({
      source: "event-ledger-v2",
      total: 1,
      by_schema_version: { v2: 1 },
      stale: 0,
    });
  });

  test("reports category recency separately from cumulative diagnostic counts", () => {
    const root = candidateRoot();
    expect(writeProducerDiagnosticV2(root, "command_emit_rejected", {})).toBeDefined();
    const health = collectEventLedgerHealthV2(root);
    if (health.state !== "live") throw new Error("expected live health");

    expect(health.diagnostics_spool.by_category.command_emit_rejected).toEqual({
      total: 1,
      last_24h: 1,
    });
    expect(health.diagnostics_spool.last_1h).toBe(1);
    expect(health.diagnostics_spool.recent_by_category.command_emit_rejected).toMatchObject({
      last_1h: 1,
    });
    expect(
      health.diagnostics_spool.recent_by_category.command_emit_rejected?.latest_at,
    ).not.toBeNull();
  });

  test("separates exact hook errors and active-hour recency from phase totals", () => {
    const root = temporaryRoot();
    const now = Date.parse("2026-08-17T20:00:00.000Z");
    const path = join(root, ".harnery/debug/agent-hook.errors.ndjson");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({
          ts: "2026-08-17T19:30:00.000Z",
          error: "ReferenceError: emit is not defined",
        }),
        JSON.stringify({ ts: "2026-08-17T18:30:00.000Z", error: "Error: authority mismatch" }),
        JSON.stringify({ ts: "2026-08-17T18:31:00.000Z", error: "Error: authority mismatch" }),
      ].join("\n"),
    );

    const summary = readHookErrors(root, now - 24 * 60 * 60 * 1000, now);
    expect(summary.total).toBe(3);
    expect(summary.last1h).toBe(1);
    expect(summary.byPhase).toEqual({ "(unknown)": 3 });
    expect(summary.byError).toEqual({
      "Error: authority mismatch": 2,
      "ReferenceError: emit is not defined": 1,
    });
    expect(summary.topErrors[0]).toMatchObject({ error: "Error: authority mismatch", count: 2 });
    expect(summary.recentTopErrors).toEqual([
      {
        error: "ReferenceError: emit is not defined",
        count: 1,
        phase: "(unknown)",
      },
    ]);
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

function parsed(values: Partial<ParsedPayload>): ParsedPayload {
  return { raw: {}, ...values };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-health-followup-"));
  roots.push(root);
  return root;
}
