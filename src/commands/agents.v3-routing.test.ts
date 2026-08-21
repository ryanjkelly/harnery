import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJsonV3, sha256V3 } from "../core/events/v3/canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../core/events/v3/capabilities.ts";
import {
  buildCandidateGenesisManifestV3,
  EVENT_V3_GENESIS_MANIFEST,
  repairEventV3ControlPair,
} from "../core/events/v3/control.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../core/events/v3/fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../core/events/v3/generated.ts";
import { readAgentDiagnosticEventsInWindow, traceInstanceIdsForEventSource } from "./agents.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agents command V3 diagnostic routing", () => {
  test("name-history native IDs map to the prefixed V3 scope identity", () => {
    expect(traceInstanceIdsForEventSource(["native-session-id"], "v3")).toEqual([
      "inst_native-session-id",
    ]);
  });

  test("closed control is explicitly unavailable", () => {
    const root = temporaryRoot();

    const read = readAgentDiagnosticEventsInWindow(root, 0);

    expect(read).toMatchObject({ source: "v3", authoritative: false, truncated: false });
    expect(read.events).toEqual([]);
  });

  test("candidate control reads validated V3 rows", () => {
    const root = temporaryRoot();
    openCandidateGate(root);

    const read = readAgentDiagnosticEventsInWindow(root, 0);

    expect(read).toMatchObject({ source: "v3", authoritative: true, truncated: false });
    expect(read.events.map((event) => event.event_type)).toEqual(["ledger.genesis"]);
  });

  test("ambiguous V3 control returns explicit non-authoritative emptiness", () => {
    const root = temporaryRoot();
    const manifestPath = join(root, EVENT_V3_GENESIS_MANIFEST);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "{}\n", "utf8");

    const read = readAgentDiagnosticEventsInWindow(root, 0);

    expect(read).toMatchObject({ source: "v3", authoritative: false, events: [] });
    expect(read.reason).toContain("V3 control state is invalid");
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-agents-v3-route-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  return root;
}

function openCandidateGate(root: string): void {
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
}
