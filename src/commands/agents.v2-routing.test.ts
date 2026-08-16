import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJsonV2, sha256V2 } from "../core/events/v2/canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../core/events/v2/capabilities.ts";
import {
  buildCandidateGenesisManifestV2,
  EVENT_V2_GENESIS_MANIFEST,
  repairEventV2ControlPair,
} from "../core/events/v2/control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "../core/events/v2/fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "../core/events/v2/generated.ts";
import { readAgentDiagnosticEventsInWindow, traceInstanceIdsForEventSource } from "./agents.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agents command V2 diagnostic routing", () => {
  test("name-history native IDs map to the prefixed V2 scope identity", () => {
    expect(traceInstanceIdsForEventSource(["native-session-id"], "v2")).toEqual([
      "inst_native-session-id",
    ]);
    expect(traceInstanceIdsForEventSource(["native-session-id"], "v1")).toEqual([
      "native-session-id",
    ]);
  });

  test("closed control preserves the bounded V1 diagnostic reader", () => {
    const root = temporaryRoot();
    writeV1Event(root, "v1.closed");

    const read = readAgentDiagnosticEventsInWindow(root, 0);

    expect(read).toMatchObject({ source: "v1", authoritative: true, truncated: false });
    expect(read.events.map((event) => event.event_type)).toEqual(["v1.closed"]);
  });

  test("candidate control reads validated V2 and never includes fenced V1 rows", () => {
    const root = temporaryRoot();
    writeV1Event(root, "v1.must_not_be_read");
    openCandidateGate(root);

    const read = readAgentDiagnosticEventsInWindow(root, 0);

    expect(read).toMatchObject({ source: "v2", authoritative: true, truncated: false });
    expect(read.events.map((event) => event.event_type)).toEqual(["ledger.genesis"]);
    expect(read.events.some((event) => event.event_type.startsWith("v1."))).toBe(false);
  });

  test("ambiguous V2 control returns explicit non-authoritative emptiness", () => {
    const root = temporaryRoot();
    writeV1Event(root, "v1.must_not_be_read");
    const manifestPath = join(root, EVENT_V2_GENESIS_MANIFEST);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "{}\n", "utf8");

    const read = readAgentDiagnosticEventsInWindow(root, 0);

    expect(read).toMatchObject({ source: "v2", authoritative: false, events: [] });
    expect(read.reason).toContain("fenced V1 event history was not read");
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-agents-v2-route-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  return root;
}

function writeV1Event(root: string, eventType: string): void {
  writeFileSync(
    join(root, ".harnery", "events.ndjson"),
    `${JSON.stringify({
      schema_version: 1,
      event_id: "v1-event",
      event_type: eventType,
      ts: "2026-08-16T18:00:00.000Z",
      instance_id: "legacy-owner",
      data: {},
    })}\n`,
    "utf8",
  );
}

function openCandidateGate(root: string): void {
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
}
