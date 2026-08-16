import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "./capabilities.ts";
import {
  buildCandidateGenesisManifestV2,
  type CandidateProfileV2,
  EVENT_V2_GENESIS_MANIFEST,
} from "./control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "./fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "./generated.ts";
import {
  liveEventV2BuildId,
  liveInstanceIdV2,
  recordLiveHookSignalV2,
  resolveLiveEventLedgerRouteV2,
} from "./live-routing.ts";
import { readActiveLedgerV2 } from "./reader.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("live V2 ledger routing", () => {
  test("keeps V1 until a candidate exists", () => {
    expect(resolveLiveEventLedgerRouteV2(temporaryRoot())).toEqual({ state: "v1" });
  });

  test("repairs a candidate packet and records V2 without opening a V1 fallback", () => {
    const root = candidateRoot("claude-code");
    const route = resolveLiveEventLedgerRouteV2(root);
    expect(route).toEqual({ state: "v2", mode: "candidate", build_id: "build_fixture" });
    if (route.state !== "v2") throw new Error("expected V2 route");

    const result = recordLiveHookSignalV2({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { session_id: "native-session", raw: {} },
      adapter: "claude-code",
      instanceId: "agent-Helene",
    });

    expect(result.state).toBe("recorded");
    expect(
      recordLiveHookSignalV2({
        coordRoot: root,
        route,
        eventName: "user-prompt-submit",
        payload: { session_id: "native-session", prompt: "continue", raw: {} },
        adapter: "claude-code",
        instanceId: "agent-Helene",
      }).state,
    ).toBe("recorded");
    const ledger = readActiveLedgerV2(root);
    expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
    expect(
      ledger.events
        .filter(({ event }) => event.producer.producer_id === "prd_agent-hook")
        .every(({ event }) => event.time.monotonic_ns === undefined),
    ).toBeTrue();
    expect(liveInstanceIdV2("agent-Helene")).toBe("inst_agent-Helene");
    expect(Bun.file(join(root, ".harnery/events.ndjson")).size).toBe(0);
  });

  test("does not downgrade an unsupported Cursor signal to V1", () => {
    const root = candidateRoot("cursor");
    const route = resolveLiveEventLedgerRouteV2(root);
    if (route.state !== "v2") throw new Error("expected V2 route");
    const started = recordLiveHookSignalV2({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { conversation_id: "cursor-session", raw: {} },
      adapter: "cursor",
      instanceId: "cursor-session",
    });
    expect(started.state).toBe("recorded");

    const ended = recordLiveHookSignalV2({
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
    expect(Bun.file(join(root, ".harnery/events.ndjson")).size).toBe(0);
  });

  test("blocks a candidate that did not approve the live producer build", () => {
    const root = candidateRoot("claude-code", ["build_other"]);
    expect(resolveLiveEventLedgerRouteV2(root)).toEqual({
      state: "blocked",
      reason: "live_producer_build_not_approved",
    });
  });
});

function candidateRoot(
  adapter: "claude-code" | "cursor" | "codex",
  builds: string[] = [liveEventV2BuildId("fixture")],
): string {
  const root = temporaryRoot();
  const keys = loadOrCreateFingerprintKeyStoreV2(root, () => new Date("2026-08-16T17:00:00.000Z"));
  const profile: CandidateProfileV2 = {
    initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
    contract_source_digest: sha256V2("contract"),
    harnery_commit: "fixture",
    host_repository_commit: "fixture",
    producer_build_ids: builds,
    adapter_capability_profile_digests: [
      `sha256:${adapterCapabilityProfileDigestV2(adapter).slice(4)}`,
    ],
    config_digest: sha256V2("config"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: keys.active_epoch_id,
    v1_terminal_digest: sha256V2("v1"),
    v1_terminal_bytes: 1,
    v1_terminal_rows: 1,
    candidate_created_at: "2026-08-16T18:00:00.000Z",
  };
  const manifest = buildCandidateGenesisManifestV2({
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
  const path = join(root, EVENT_V2_GENESIS_MANIFEST);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV2(manifest)}\n`, { mode: 0o600 });
  return root;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-live-routing-"));
  roots.push(root);
  return root;
}
