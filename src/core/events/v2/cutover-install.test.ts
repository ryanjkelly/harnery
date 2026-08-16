import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256V2 } from "./canonical.ts";
import { buildActivationManifestV2, readEventV2ControlState } from "./control.ts";
import {
  archiveEpochAndRollbackV2,
  buildCandidateInstallPacketV2,
  type CandidateProfileBaseV2,
  type EpochCutoverV2Step,
  installActivationV2,
  installCandidateV2,
} from "./cutover-install.ts";
import { readLedgerV2 } from "./reader.ts";
import { writeEventV2 } from "./writer.ts";

const roots: string[] = [];
const NOW = () => Date.parse("2026-08-16T23:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const path of [
      join(root, ".harnery", "events.ndjson"),
      join(root, ".harnery", "ledgers", "v2"),
    ]) {
      try {
        if (existsSync(path)) chmodSync(path, 0o700);
      } catch {
        // Killed-boundary cleanup is best effort.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("event ledger V2 installation and epoch rollback", () => {
  test("derives terminal facts, opens candidate and activation gates, then archives every V2 byte", () => {
    const fixture = installedCandidate();
    expect(fixture.result.candidate.profile).toMatchObject({
      v1_terminal_digest: fixture.result.seal.terminal_digest,
      v1_terminal_bytes: fixture.result.seal.terminal_bytes,
      v1_terminal_rows: 2,
    });
    expect(readEventV2ControlState(fixture.root).state).toBe("candidate");
    expect(readLedgerV2(fixture.root)).toMatchObject({
      complete: true,
      diagnostics: [],
    });

    const activation = activationFor(fixture.result.candidate);
    const active = installActivationV2({
      coordRoot: fixture.root,
      artifactRoot: fixture.artifactRoot,
      activation,
    });
    expect(active.state).toBe("active");
    expect(readEventV2ControlState(fixture.root).state).toBe("active");

    writeFileSync(join(fixture.root, ".harnery", "active", "agent.json"), '{"changed":true}\n');
    const rollback = archiveEpochAndRollbackV2({
      coordRoot: fixture.root,
      artifactRoot: fixture.artifactRoot,
      candidate: fixture.result.candidate,
      snapshot: fixture.result.snapshot,
      seal: fixture.result.seal,
      now: NOW,
    });
    expect(rollback.state).toBe("v1_restored");
    const archived = join(fixture.root, rollback.archive_relative_path);
    expect(readFileSync(join(archived, "genesis.json"), "utf8")).toContain("candidate_genesis");
    expect(readFileSync(join(archived, "activation.json"), "utf8")).toContain("activation");
    const v2Fence = join(fixture.root, ".harnery", "ledgers", "v2");
    expect(lstatSync(v2Fence).isFile()).toBeTrue();
    expect(readFileSync(join(fixture.root, ".harnery", "events.ndjson"), "utf8")).toBe("");
    expect(readFileSync(join(fixture.root, ".harnery", "active", "agent.json"), "utf8")).toBe(
      '{"task":"before"}\n',
    );
    expect(() => writeEventV2(fixture.root, fixture.result.candidate.event)).toThrow();
    expect(
      archiveEpochAndRollbackV2({
        coordRoot: fixture.root,
        artifactRoot: fixture.artifactRoot,
        candidate: fixture.result.candidate,
        snapshot: fixture.result.snapshot,
        seal: fixture.result.seal,
        now: NOW,
      }),
    ).toEqual(rollback);
  });

  test("repairs an exact candidate after a manifest-first crash", () => {
    const root = fixtureRoot();
    const artifactRoot = join(root, ".harnery", "cutover-artifacts");
    const packet = packetFixture();
    let killed = false;
    expect(() =>
      installCandidateV2({
        coordRoot: root,
        artifactRoot,
        packet,
        projectionPaths: [".harnery/active", ".harnery/.events-cursor"],
        now: NOW,
        onStep(step) {
          if (!killed && step === "genesis_manifest_installed") {
            killed = true;
            throw new Error("killed:genesis_manifest_installed");
          }
        },
      }),
    ).toThrow("killed:genesis_manifest_installed");
    expect(readEventV2ControlState(root)).toMatchObject({
      state: "repairable",
      reason: "genesis_event_missing",
    });
    const result = installCandidateV2({
      coordRoot: root,
      artifactRoot,
      packet,
      projectionPaths: [".harnery/active", ".harnery/.events-cursor"],
      now: NOW,
    });
    expect(result.state).toBe("candidate");
  });

  test("repairs an exact candidate after catalog initialization", () => {
    const root = fixtureRoot();
    const artifactRoot = join(root, ".harnery", "cutover-artifacts");
    const packet = packetFixture();
    let killed = false;
    expect(() =>
      installCandidateV2({
        coordRoot: root,
        artifactRoot,
        packet,
        projectionPaths: [".harnery/active", ".harnery/.events-cursor"],
        now: NOW,
        onStep(step) {
          if (!killed && step === "catalog_initialized") {
            killed = true;
            throw new Error("killed:catalog_initialized");
          }
        },
      }),
    ).toThrow("killed:catalog_initialized");
    expect(readLedgerV2(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(
      installCandidateV2({
        coordRoot: root,
        artifactRoot,
        packet,
        projectionPaths: [".harnery/active", ".harnery/.events-cursor"],
        now: NOW,
      }).state,
    ).toBe("candidate");
  });

  test("repairs an exact activation after a manifest-first crash", () => {
    const fixture = installedCandidate();
    const activation = activationFor(fixture.result.candidate);
    let killed = false;
    expect(() =>
      installActivationV2({
        coordRoot: fixture.root,
        artifactRoot: fixture.artifactRoot,
        activation,
        onStep(step) {
          if (!killed && step === "activation_manifest_installed") {
            killed = true;
            throw new Error("killed:activation_manifest_installed");
          }
        },
      }),
    ).toThrow("killed:activation_manifest_installed");
    expect(readEventV2ControlState(fixture.root)).toMatchObject({
      state: "repairable",
      reason: "activation_event_missing",
    });
    expect(
      installActivationV2({
        coordRoot: fixture.root,
        artifactRoot: fixture.artifactRoot,
        activation,
      }).state,
    ).toBe("active");
  });

  test("opens a replacement candidate only after verifying the archived-epoch fence", () => {
    const fixture = installedCandidate();
    const rollback = archiveEpochAndRollbackV2({
      coordRoot: fixture.root,
      artifactRoot: fixture.artifactRoot,
      candidate: fixture.result.candidate,
      snapshot: fixture.result.snapshot,
      seal: fixture.result.seal,
      now: NOW,
    });
    const archivedGenesis = readFileSync(
      join(fixture.root, rollback.archive_relative_path, "genesis.json"),
      "utf8",
    );
    const replacement = installCandidateV2({
      coordRoot: fixture.root,
      artifactRoot: join(fixture.root, ".harnery", "cutover-artifacts-replacement"),
      packet: replacementPacketFixture(),
      projectionPaths: [".harnery/active", ".harnery/.events-cursor"],
      now: NOW,
    });
    expect(replacement.state).toBe("candidate");
    expect(replacement.candidate.event.payload.genesis_id).not.toBe(
      fixture.result.candidate.event.payload.genesis_id,
    );
    expect(readLedgerV2(fixture.root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(
      readFileSync(join(fixture.root, rollback.archive_relative_path, "genesis.json"), "utf8"),
    ).toBe(archivedGenesis);
  });

  for (const killedAt of [
    "v2_archive_manifest_committed",
    "v2_rollback_intent_committed",
    "v2_root_archived",
    "v2_archive_fence_installed",
    "v2_archive_verified",
    "v2_archive_record_committed",
  ] satisfies EpochCutoverV2Step[]) {
    test(`recovers the exact archive and V1 rollback after a kill at ${killedAt}`, () => {
      const fixture = installedCandidate();
      let killed = false;
      expect(() =>
        archiveEpochAndRollbackV2({
          coordRoot: fixture.root,
          artifactRoot: fixture.artifactRoot,
          candidate: fixture.result.candidate,
          snapshot: fixture.result.snapshot,
          seal: fixture.result.seal,
          now: NOW,
          onStep(step) {
            if (!killed && step === killedAt) {
              killed = true;
              throw new Error(`killed:${step}`);
            }
          },
        }),
      ).toThrow(`killed:${killedAt}`);
      const result = archiveEpochAndRollbackV2({
        coordRoot: fixture.root,
        artifactRoot: fixture.artifactRoot,
        candidate: fixture.result.candidate,
        snapshot: fixture.result.snapshot,
        seal: fixture.result.seal,
        now: NOW,
      });
      expect(result.state).toBe("v1_restored");
      expect(
        existsSync(join(fixture.root, result.archive_relative_path, "genesis.json")),
      ).toBeTrue();
    });
  }
});

function installedCandidate() {
  const root = fixtureRoot();
  const artifactRoot = join(root, ".harnery", "cutover-artifacts");
  const result = installCandidateV2({
    coordRoot: root,
    artifactRoot,
    packet: packetFixture(),
    projectionPaths: [".harnery/active", ".harnery/.events-cursor"],
    now: NOW,
  });
  return { root, artifactRoot, result };
}

function packetFixture() {
  return buildCandidateInstallPacketV2({
    profile_base: profileBase(),
    root_id: "root_fixture",
    instance_id: "inst_operator",
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 1,
      build_id: "build_fixture",
      platform: "linux",
    },
    genesis_id: "gex_00000000-0000-7000-8000-000000000001",
    event_id: "evt_00000000-0000-7000-8000-000000000002",
  });
}

function replacementPacketFixture() {
  return buildCandidateInstallPacketV2({
    profile_base: {
      ...profileBase(),
      candidate_created_at: "2026-08-16T23:02:00.000Z",
    },
    root_id: "root_fixture",
    instance_id: "inst_operator",
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_replacement",
      sequence: 1,
      build_id: "build_fixture",
      platform: "linux",
    },
    genesis_id: "gex_00000000-0000-7000-8000-000000000005",
    event_id: "evt_00000000-0000-7000-8000-000000000006",
  });
}

function activationFor(candidate: ReturnType<typeof installedCandidate>["result"]["candidate"]) {
  return buildActivationManifestV2({
    candidate,
    approval_record_id: "approval_fixture",
    activation_approved_at: "2026-08-16T23:01:00.000Z",
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 2,
      build_id: "build_fixture",
      platform: "linux",
    },
    activation_id: "act_00000000-0000-7000-8000-000000000003",
    event_id: "evt_00000000-0000-7000-8000-000000000004",
  });
}

function profileBase(): CandidateProfileBaseV2 {
  return {
    initial_schema_digest:
      "sha256:f302cc7e0aef30779efb7f2be9ac9e3f200e0394be26a73f94afe9cbeb70cc35",
    contract_source_digest: sha256V2("contract-source"),
    harnery_commit: "harnery-fixture",
    host_repository_commit: "host-fixture",
    producer_build_ids: ["build_fixture"],
    adapter_capability_profile_digests: [sha256V2("capability-fixture")],
    config_digest: sha256V2("config-fixture"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: "pep_fixture",
    candidate_created_at: "2026-08-16T23:00:00.000Z",
  };
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-install-v2-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
  writeFileSync(
    join(root, ".harnery", "events.ndjson"),
    '{"event_id":"evt_1"}\n{"event_id":"evt_2"}\n',
    "utf8",
  );
  writeFileSync(join(root, ".harnery", "active", "agent.json"), '{"task":"before"}\n');
  writeFileSync(join(root, ".harnery", ".events-cursor"), "evt_before\n");
  return root;
}
