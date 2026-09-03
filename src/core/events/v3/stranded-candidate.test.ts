import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireNoClobberLease } from "../../workflow/workspaces/leases.ts";
import {
  EVENT_V3_STRANDED_CANDIDATE_APPROVAL_RECORD_ID,
  initializeEventLedgerV3,
  repairStrandedEventLedgerV3Candidate,
  rotateOversizedEventLedgerV3,
} from "./bootstrap.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import { ADAPTER_CAPABILITY_PROFILES_V3 } from "./capabilities.ts";
import {
  buildCandidateGenesisManifestV3,
  EVENT_V3_ACTIVATION_MANIFEST,
  EVENT_V3_GENESIS_MANIFEST,
  eventV3WriteGateOpen,
  liveGenesisIdV3,
  readEventV3ControlState,
} from "./control.ts";
import { repairEventV3ControlPair } from "./control-writer.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "./fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";
import { liveEventV3BuildId, livePlatformV3 } from "./runtime-build.ts";
import { eventV3Paths } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 stranded candidate epochs", () => {
  test("a hook-boundary rotation that never activated is repaired at the next boundary", () => {
    const root = freshRoot();
    initialize(root, "2026-09-02T05:43:52.006Z");

    // The hook boundary rotates the oversized epoch: the prior epoch moves
    // whole into the archive and the successor's genesis is published.
    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
    expect(rotated.state).toBe("rotated");
    expect(rotated.archived_epoch).toBeDefined();
    // Then the process stops before the activation manifest is published,
    // which is the residue the 2026-09-02 epoch was found in.
    strandActivation(root);

    expect(readEventV3ControlState(root).state).toBe("candidate");
    expect(eventV3WriteGateOpen(root, "active")).toBeFalse();
    expect(eventV3WriteGateOpen(root, "candidate")).toBeTrue();

    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "active" });
    const control = readEventV3ControlState(root);
    expect(control.state).toBe("active");
    if (control.state !== "active") throw new Error("expected an active control state");
    expect(control.activation.approval_record_id).toBe(
      EVENT_V3_STRANDED_CANDIDATE_APPROVAL_RECORD_ID,
    );
    expect(eventV3WriteGateOpen(root, "active")).toBeTrue();
  });

  test("repairs a candidate whose pre-minted genesis event is also missing", () => {
    const root = freshRoot();
    initialize(root, "2026-09-02T09:57:40.996Z");
    writeFileSync(eventV3Paths(root).active, "", "utf8");
    unlinkSync(join(root, EVENT_V3_ACTIVATION_MANIFEST));
    expect(readEventV3ControlState(root)).toMatchObject({
      state: "repairable",
      reason: "genesis_event_missing",
    });

    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "active" });
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("initialization resumes a stranded candidate without an explicit flag", () => {
    const root = freshRoot();
    initialize(root, "2026-09-02T09:57:40.996Z");
    const genesisBefore = liveGenesisIdV3(root);
    strandActivation(root);

    const resumed = initialize(root, "2026-09-03T10:29:26.416Z");

    expect(resumed.control.state).toBe("active");
    expect(resumed.archived_epoch).toBeUndefined();
    expect(liveGenesisIdV3(root)).toBe(genesisBefore!);
    expect(archives(root)).toEqual([]);
  });

  test("an explicit opt-out still reports the candidate instead of activating it", () => {
    const root = freshRoot();
    initialize(root, "2026-09-02T09:57:40.996Z");
    strandActivation(root);

    expect(() =>
      initializeEventLedgerV3({
        ...baseInput(root, "2026-09-03T10:29:26.416Z"),
        resumeCandidate: false,
      }),
    ).toThrow("event_v3_candidate_requires_explicit_activation_or_epoch_replacement");
    expect(readEventV3ControlState(root).state).toBe("candidate");
  });

  test("a live bootstrap lease leaves the candidate serving until it clears", () => {
    const root = freshRoot();
    initialize(root, "2026-09-02T09:57:40.996Z");
    strandActivation(root);
    const lease = acquireNoClobberLease({
      path: join(root, ".harnery", "private", "event-v3-bootstrap-lease"),
      scope: "event-v3-bootstrap",
      authoritySha256: createHash("sha256").update(root).digest("hex"),
      staleAfterMs: 10_000,
      validateStaleOwner: (owner) => owner.host === hostname() && owner.pid !== process.pid,
    });

    expect(repairStrandedEventLedgerV3Candidate(root)).toMatchObject({ state: "unavailable" });
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "candidate" });

    lease.release();
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "active" });
  });

  test("rotates an oversized candidate epoch instead of refusing it", () => {
    const root = freshRoot();
    initialize(root, "2026-09-02T09:57:40.996Z");
    strandActivation(root);
    const strandedBytes = readFileSync(eventV3Paths(root).active);

    const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });

    expect(rotated.state).toBe("rotated");
    expect(rotated.control?.state).toBe("active");
    expect(rotated.archived_epoch).toBeDefined();
    expect(readFileSync(join(rotated.archived_epoch!, "active.ndjson"))).toEqual(strandedBytes);
    expect(existsSync(join(rotated.archived_epoch!, "activation.json"))).toBeFalse();
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("an unusable approval record leaves the current epoch whole", () => {
    const root = freshRoot();
    initialize(root, "2026-09-02T09:57:40.996Z");
    const genesisBefore = liveGenesisIdV3(root);
    const activeBefore = readFileSync(eventV3Paths(root).active);

    expect(() =>
      initializeEventLedgerV3({
        ...baseInput(root, "2026-09-03T10:29:26.416Z"),
        approvalRecordId: "not a usable approval record",
        forceNewEpoch: true,
      }),
    ).toThrow();

    expect(liveGenesisIdV3(root)).toBe(genesisBefore!);
    expect(readFileSync(eventV3Paths(root).active)).toEqual(activeBefore);
    expect(archives(root)).toEqual([]);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("a deliberate cutover candidate is never activated automatically", () => {
    const root = cutoverCandidateRoot();
    const genesis = liveGenesisIdV3(root);
    expect(readEventV3ControlState(root).state).toBe("candidate");

    expect(repairStrandedEventLedgerV3Candidate(root)).toMatchObject({
      state: "not_stranded",
      reason: "candidate_not_bootstrap_created",
    });
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "candidate" });
    expect(() => initialize(root, "2026-09-03T10:29:26.416Z")).toThrow(
      "event_v3_candidate_requires_explicit_activation_or_epoch_replacement",
    );

    expect(readEventV3ControlState(root).state).toBe("candidate");
    expect(liveGenesisIdV3(root)).toBe(genesis!);
  });

  test("a leftover control temp file from a crashed publish does not wedge activation", () => {
    const root = freshRoot();
    const activationPath = join(root, EVENT_V3_ACTIVATION_MANIFEST);
    mkdirSync(dirname(activationPath), { recursive: true, mode: 0o700 });
    writeFileSync(`${activationPath}.tmp.${process.pid}`, "partial", { mode: 0o600 });

    expect(initialize(root, "2026-09-03T10:29:26.416Z").control.state).toBe("active");
    expect(readEventV3ControlState(root).state).toBe("active");
  });
});

/** The residue of a crash between the genesis append and the activation publish. */
function strandActivation(root: string): void {
  const active = eventV3Paths(root).active;
  const genesisRow = readFileSync(active, "utf8").split("\n")[0];
  writeFileSync(active, `${genesisRow}\n`, "utf8");
  unlinkSync(join(root, EVENT_V3_ACTIVATION_MANIFEST));
}

/** A candidate published by an operator cutover, not by this initializer. */
function cutoverCandidateRoot(): string {
  const root = freshRoot();
  const keys = loadOrCreateFingerprintKeyStoreV3(root, () => new Date("2026-09-02T09:00:00.000Z"));
  const manifest = buildCandidateGenesisManifestV3({
    profile: {
      initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      contract_source_digest: EVENT_V3_SCHEMA_DIGEST,
      harnery_commit: "fixture",
      host_repository_commit: "fixture-host",
      producer_build_ids: [liveEventV3BuildId("fixture")],
      adapter_capability_profile_digests: Object.values(ADAPTER_CAPABILITY_PROFILES_V3)
        .map((profile) => sha256V3(canonicalJsonV3(profile)))
        .sort(),
      config_digest: sha256V3("config"),
      canonicalizer_version: "harnery-jcs-nfc-v1",
      fingerprint_version: "hmac-sha256-v1",
      privacy_key_epoch: keys.active_epoch_id,
      candidate_created_at: "2026-09-02T09:30:00.000Z",
    },
    root_id: "root_cutover",
    instance_id: "inst_cutover",
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 1,
      build_id: liveEventV3BuildId("fixture"),
      platform: livePlatformV3(),
    },
  });
  const path = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  if (repairEventV3ControlPair(root).state !== "candidate") {
    throw new Error("expected a cutover candidate");
  }
  return root;
}

function initialize(root: string, timestamp: string) {
  return initializeEventLedgerV3(baseInput(root, timestamp));
}

function baseInput(root: string, timestamp: string) {
  return {
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("config"),
    approvalRecordId: "fixture-stranded-candidate",
    now: () => new Date(timestamp),
  };
}

function archives(root: string): string[] {
  const directory = join(root, ".harnery", "ledgers", "v3-archives");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-stranded-"));
  roots.push(root);
  return root;
}
