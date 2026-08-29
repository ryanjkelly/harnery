import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJsonV3, sha256V3 } from "../core/events/v3/canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../core/events/v3/capabilities.ts";
import {
  buildCandidateGenesisManifestV3,
  EVENT_V3_GENESIS_MANIFEST,
} from "../core/events/v3/control.ts";
import { repairEventV3ControlPair } from "../core/events/v3/control-writer.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../core/events/v3/fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../core/events/v3/generated.ts";
import { writeProducerDiagnosticV3 } from "../core/events/v3/producers/intake.ts";
import {
  collectActiveAgentHealth,
  collectEventLedgerHealthV3,
  collectStatusPeerHealth,
  readHookErrors,
} from "./agents.ts";

const roots: string[] = [];
let sharedCandidateRoot = "";

beforeAll(() => {
  sharedCandidateRoot = candidateRoot();
}, 15_000);

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent health follow-up diagnostics", () => {
  test("uses V3 generations instead of stale heartbeat caches for active health", () => {
    const root = sharedCandidateRoot;
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    const staleCache = join(root, ".harnery/active/stale-generation.json");
    mkdirSync(dirname(staleCache), { recursive: true });
    writeFileSync(
      staleCache,
      JSON.stringify({
        schema_version: 2,
        instance_id: "stale-generation",
        last_heartbeat: "2020-01-01T00:00:00.000Z",
        platform: "claude-code",
        kind: "session",
        v3_instance_id: "inst_stale-generation",
        v3_generation_id: "gen_stale-generation",
        v3_projection_event_id: "evt_stale-generation",
        v3_task_state: "cleared",
      }),
    );

    expect(
      collectActiveAgentHealth(
        root,
        now,
        () => [
          {
            instance_id: "live",
            platform: "claude-code",
            kind: "session",
            schema_version: 3,
            last_heartbeat: "2026-08-29T12:00:00.000Z",
          },
        ],
        600,
      ),
    ).toMatchObject({
      source: "event-ledger-v3",
      total: 1,
      by_schema_version: { v3: 1 },
      stale: 0,
    });
  });

  test("uses V3 generations instead of stale heartbeat caches for status peers", () => {
    const root = sharedCandidateRoot;
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    const staleCache = join(root, ".harnery/active/stale-generation.json");
    mkdirSync(dirname(staleCache), { recursive: true });
    writeFileSync(
      staleCache,
      JSON.stringify({
        schema_version: 2,
        instance_id: "stale-generation",
        last_heartbeat: "2020-01-01T00:00:00.000Z",
        v3_instance_id: "inst_stale-generation",
        v3_generation_id: "gen_stale-generation",
        v3_projection_event_id: "evt_stale-generation",
        v3_task_state: "cleared",
      }),
    );

    const status = collectStatusPeerHealth(
      root,
      "self",
      now,
      () => [
        { instance_id: "self", last_heartbeat: "2026-08-29T12:00:00.000Z" },
        { instance_id: "peer", last_heartbeat: "2026-08-29T12:00:00.000Z" },
      ],
      600,
    );
    expect(status.stale).toBe(0);
    expect(status.livePeers.map((peer) => peer.instance_id)).toEqual(["peer"]);
  });

  test("reports category recency separately from cumulative diagnostic counts", () => {
    const root = sharedCandidateRoot;
    expect(writeProducerDiagnosticV3(root, "command_emit_rejected", {})).toBeDefined();
    const health = collectEventLedgerHealthV3(root);
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

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-health-followup-"));
  roots.push(root);
  return root;
}
