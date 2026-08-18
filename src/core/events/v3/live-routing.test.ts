import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "./capabilities.ts";
import {
  buildCandidateGenesisManifestV3,
  type CandidateProfileV3,
  EVENT_V3_GENESIS_MANIFEST,
} from "./control.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "./fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import {
  liveEventV3BuildId,
  liveInstanceIdV3,
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "./live-routing.ts";
import { readLedgerV3 } from "./reader.ts";
import { eventV3Paths } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("live V3 ledger routing", () => {
  test("blocks an uninitialized root", () => {
    expect(resolveLiveEventLedgerRouteV3(temporaryRoot())).toEqual({
      state: "blocked",
      reason: "v3_not_initialized",
    });
  });

  test("repairs a candidate packet and records through the canonical route", () => {
    const root = candidateRoot("claude-code");
    const route = resolveLiveEventLedgerRouteV3(root);
    expect(route).toEqual({ state: "v3", mode: "candidate", build_id: "build_fixture" });
    if (route.state !== "v3") throw new Error("expected V3 route");

    const result = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { session_id: "native-session", raw: {} },
      adapter: "claude-code",
      instanceId: "agent-Helene",
    });

    expect(result.state).toBe("recorded");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "user-prompt-submit",
        payload: { session_id: "native-session", prompt: "continue", raw: {} },
        adapter: "claude-code",
        instanceId: "agent-Helene",
      }).state,
    ).toBe("recorded");
    const ledger = readLedgerV3(root);
    expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
    expect(
      ledger.events
        .filter(({ event }) => event.producer.producer_id === "prd_agent-hook")
        .every(({ event }) => event.time.monotonic_ns === undefined),
    ).toBeTrue();
    expect(liveInstanceIdV3("agent-Helene")).toBe("inst_agent-Helene");
  });

  test("refuses an unsupported Cursor signal", () => {
    const root = candidateRoot("cursor");
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    const started = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { conversation_id: "cursor-session", raw: {} },
      adapter: "cursor",
      instanceId: "cursor-session",
    });
    expect(started.state).toBe("recorded");

    const ended = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "post-compact",
      payload: { conversation_id: "cursor-session", raw: {} },
      adapter: "cursor",
      instanceId: "cursor-session",
    });
    expect(ended).toEqual({
      state: "gate_closed",
      reason: "signal_not_approved:post_compaction",
    });
  });

  test("blocks a candidate that did not approve the live producer build", () => {
    const root = candidateRoot("claude-code", ["build_other"]);
    expect(resolveLiveEventLedgerRouteV3(root)).toEqual({
      state: "blocked",
      reason: "live_producer_build_not_approved",
    });
  });

  test("candidate rollback blocks producers and restores the exact packet", () => {
    const root = candidateRoot("claude-code");
    expect(resolveLiveEventLedgerRouteV3(root).state).toBe("v3");
    const current = eventV3Paths(root).root;
    const parked = `${current}.rollback-rehearsal`;

    renameSync(current, parked);
    expect(resolveLiveEventLedgerRouteV3(root)).toEqual({
      state: "blocked",
      reason: "v3_not_initialized",
    });
    renameSync(parked, current);
    expect(resolveLiveEventLedgerRouteV3(root)).toEqual({
      state: "v3",
      mode: "candidate",
      build_id: "build_fixture",
    });
  });
});

function candidateRoot(
  adapter: "claude-code" | "cursor" | "codex",
  builds: string[] = [liveEventV3BuildId("fixture")],
): string {
  const root = temporaryRoot();
  const keys = loadOrCreateFingerprintKeyStoreV3(root, () => new Date("2026-08-16T17:00:00.000Z"));
  const profile: CandidateProfileV3 = {
    initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
    contract_source_digest: sha256V3("contract"),
    harnery_commit: "fixture",
    host_repository_commit: "fixture",
    producer_build_ids: builds,
    adapter_capability_profile_digests: [
      `sha256:${adapterCapabilityProfileDigestV3(adapter).slice(4)}`,
    ],
    config_digest: sha256V3("config"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: keys.active_epoch_id,
    candidate_created_at: "2026-08-16T18:00:00.000Z",
  };
  const manifest = buildCandidateGenesisManifestV3({
    profile,
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
  const path = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  return root;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-live-routing-"));
  roots.push(root);
  return root;
}
