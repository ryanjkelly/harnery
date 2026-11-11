import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import { ReplayEventsV3 } from "./__fixtures__/ledger-replay.ts";
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import type { EventV3Catalog, EventV3SegmentManifest } from "./catalog.ts";
import type { EventV3 } from "./contract.ts";
import {
  EVENT_V3_ACTIVATION_MANIFEST,
  type EventV3ControlState,
  eventV3WriteGateOpen,
  readEventV3ControlState,
} from "./control.ts";
import {
  activeControlWitnessMatchesV3,
  candidateControlWitnessMatchesV3,
  EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH,
  publishActiveControlWitnessV3,
} from "./control-witness.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { attestationIdV3, clockIdV3, eventIdV3 } from "./ids.ts";
import { recordLiveHookSignalV3, resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";
import {
  advanceEventV3AppendValidationCheckpointV3,
  eventV3AuthorityStorageVersionV3,
  eventV3ControlCheckpointPathV3,
  readEventV3AppendValidationCheckpointV3,
  readLedgerV3,
} from "./reader.ts";
import { writeEventV3 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

const UNKNOWN_DIGEST = `sha256:${"e".repeat(64)}`;

describe("event ledger V3 witness and checkpoint schema lists", () => {
  test("both files list the schema digests present in the epoch", () => {
    const root = activeRoot();
    const witness = JSON.parse(readFileSync(witnessPath(root), "utf8"));
    const checkpoint = JSON.parse(readFileSync(eventV3ControlCheckpointPathV3(root), "utf8"));
    expect(witness.payload.format_version).toBe(3);
    expect(checkpoint.format_version).toBe(2);
    expect(witness.payload.schema_digests).toEqual([EVENT_V3_SCHEMA_DIGEST]);
    expect(checkpoint.schema_digests).toEqual([EVENT_V3_SCHEMA_DIGEST]);
    expect(checkpoint).not.toHaveProperty("accepted_schema_digests");
  });

  test("a witness listing a digest outside the lineage blocks without a full read", () => {
    const root = activeRoot();
    const control = activeControl(root);
    const checkpoint = readEventV3AppendValidationCheckpointV3(root)!;
    // The ledger itself is valid: only an authenticated witness from a newer
    // runtime says the epoch holds a schema this runtime does not know.
    const listed = {
      ...checkpoint,
      schema_digests: [EVENT_V3_SCHEMA_DIGEST, UNKNOWN_DIGEST].sort(),
    };
    expect(
      publishActiveControlWitnessV3(root, control, eventV3AuthorityStorageVersionV3(root), listed),
    ).toBeTrue();
    expect(readLedgerV3(root).complete).toBeTrue();
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "epoch_schema_unknown",
    });
    expect(activeControlWitnessMatchesV3(root, control)).toBeFalse();
    expect(resolveLiveEventLedgerRouteV3(root)).toEqual({
      state: "blocked",
      reason: "epoch_schema_unknown",
    });
  });

  test("a checkpoint listing a digest outside the runtime's group is never advanced", () => {
    const root = activeRoot();
    const checkpoint = readEventV3AppendValidationCheckpointV3(root)!;
    const events = new ReplayEventsV3();
    appendFileSync(activePath(root), `${canonicalJsonV3(events.start(events.session("next")))}\n`);
    const listed = {
      ...checkpoint,
      schema_digests: [EVENT_V3_SCHEMA_DIGEST, UNKNOWN_DIGEST].sort(),
    };
    expect(advanceEventV3AppendValidationCheckpointV3(root, listed)).toBeUndefined();
    expect(advanceEventV3AppendValidationCheckpointV3(root, checkpoint)).toBeDefined();
  });

  test("an older-format witness and checkpoint are treated as absent and rewritten", () => {
    const root = activeRoot();
    const witness = JSON.parse(readFileSync(witnessPath(root), "utf8"));
    witness.payload.format_version = 2;
    delete witness.payload.schema_digests;
    writeFileSync(witnessPath(root), `${canonicalJsonV3(witness)}\n`);
    const checkpoint = JSON.parse(readFileSync(eventV3ControlCheckpointPathV3(root), "utf8"));
    checkpoint.format_version = 1;
    checkpoint.accepted_schema_digests = checkpoint.schema_digests;
    delete checkpoint.schema_digests;
    writeFileSync(eventV3ControlCheckpointPathV3(root), `${canonicalJsonV3(checkpoint)}\n`);

    expect(activeControlWitnessMatchesV3(root, activeControl(root))).toBeTrue();
    const rewritten = JSON.parse(readFileSync(witnessPath(root), "utf8"));
    expect(rewritten.payload.format_version).toBe(3);
    expect(
      JSON.parse(readFileSync(eventV3ControlCheckpointPathV3(root), "utf8")).format_version,
    ).toBe(2);
  });
});

describe("event ledger V3 active-control witness", () => {
  test("publishes an authenticated witness for an active epoch", () => {
    const root = activeRoot();
    const control = activeControl(root);

    expect(existsSync(witnessPath(root))).toBeTrue();
    expect(activeControlWitnessMatchesV3(root, control)).toBeTrue();
  });

  test("advances the witness after a lease-held canonical append", () => {
    const root = activeRoot();
    const before = readFileSync(witnessPath(root), "utf8");
    const route = resolveLiveEventLedgerRouteV3(root);
    expect(route.state).toBe("v3");
    if (route.state !== "v3") throw new Error("expected V3 route");

    const recorded = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      adapter: "codex",
      instanceId: "agent-Witness",
      payload: { session_id: "witness-session", raw: {} },
    });
    expect(recorded.state).toBe("recorded");

    const control = activeControl(root);
    expect(readFileSync(witnessPath(root), "utf8")).not.toBe(before);
    expect(activeControlWitnessMatchesV3(root, control)).toBeTrue();
  });

  test("holds a schema-valid append with an unresolved attestation behind the witness", () => {
    const root = activeRoot();
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "session-start",
        adapter: "codex",
        instanceId: "agent-InvalidAppend",
        payload: { session_id: "invalid-append-session", raw: {} },
      }).state,
    ).toBe("recorded");
    const requested = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "pre-tool-use",
      adapter: "codex",
      instanceId: "agent-InvalidAppend",
      payload: {
        session_id: "invalid-append-session",
        turn_id: "invalid-append-turn",
        tool_use_id: "invalid-append-tool",
        tool_name: "Read",
        raw: {},
      },
    });
    expect(requested.state).toBe("recorded");
    if (requested.state !== "recorded") throw new Error("expected a recorded tool request");

    const invalid = structuredClone(requested.event) as EventV3;
    invalid.event_id = eventIdV3();
    invalid.time.clock_id = clockIdV3();
    invalid.producer.sequence += 1;
    invalid.attestation_id = attestationIdV3();
    // A schema-valid row the door will not admit yet waits in the queue.
    expect(writeEventV3(root, invalid)).toMatchObject({
      state: "waiting",
      reason: "unresolved_attestation",
    });

    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readEventV3ControlState(root).state).toBe("active");
    expect(activeControlWitnessMatchesV3(root, activeControl(root))).toBeTrue();
  });

  test("repairs a stale crash-gap witness only after a full valid read", () => {
    const root = activeRoot();
    const staleWitness = readFileSync(witnessPath(root), "utf8");
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    const recorded = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      adapter: "codex",
      instanceId: "agent-CrashGap",
      payload: { session_id: "crash-gap-session", raw: {} },
    });
    expect(recorded.state).toBe("recorded");

    writeFileSync(witnessPath(root), staleWitness, { mode: 0o600 });
    const control = activeControl(root);
    expect(readFileSync(witnessPath(root), "utf8")).not.toBe(staleWitness);
    expect(activeControlWitnessMatchesV3(root, control)).toBeTrue();
  });

  test("falls back and fails closed on a corrupt append", () => {
    const root = activeRoot();
    appendFileSync(activePath(root), "{}\n", "utf8");

    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
  });

  test("falls back and fails closed on a same-size rewrite", () => {
    const root = activeRoot();
    const active = activePath(root);
    const valid = readFileSync(active, "utf8");
    const corrupt = valid.replace('"major":3', '"major":4');
    expect(corrupt).not.toBe(valid);
    expect(Buffer.byteLength(corrupt)).toBe(Buffer.byteLength(valid));
    writeFileSync(active, corrupt, "utf8");
    const changedAt = new Date(Date.now() + 1_000);
    utimesSync(active, changedAt, changedAt);

    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
  });

  test("falls back and fails closed on an active inode replacement", () => {
    const root = activeRoot();
    catalogizeActive(root);
    const control = activeControl(root);
    expect(activeControlWitnessMatchesV3(root, control)).toBeTrue();

    const active = activePath(root);
    const prior = readFileSync(active);
    renameSync(active, `${active}.old`);
    writeFileSync(active, prior, { mode: 0o600 });

    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
  });

  test("falls back and fails closed on sealed-segment tampering", () => {
    const root = activeRoot();
    const segment = sealControlHistory(root);
    const control = activeControl(root);
    expect(activeControlWitnessMatchesV3(root, control)).toBeTrue();

    appendFileSync(segment, "{}\n", "utf8");
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
  });

  test("ignores a forged witness and replaces it after canonical validation", () => {
    const root = activeRoot();
    const path = witnessPath(root);
    const valid = readFileSync(path, "utf8");
    const forged = valid.replace(/sha256:[a-f0-9]{64}/, `sha256:${"0".repeat(64)}`);
    expect(forged).not.toBe(valid);
    writeFileSync(path, forged, { mode: 0o600 });

    const control = activeControl(root);
    expect(readFileSync(path, "utf8")).not.toBe(forged);
    expect(activeControlWitnessMatchesV3(root, control)).toBeTrue();
  });
});

describe("event ledger V3 candidate-control witness", () => {
  test("publishes an authenticated candidate witness and answers from it", () => {
    const root = candidateRoot();
    const control = candidateControl(root);

    expect(witnessControlState(root)).toBe("candidate");
    expect(
      candidateControlWitnessMatchesV3(root, {
        genesis: control.genesis,
        candidate_manifest_digest: control.candidate_manifest_digest,
      }),
    ).toBeTrue();
    // The second read is the one a hook pays: same answer, no full parse.
    expect(readEventV3ControlState(root)).toEqual(control);
  });

  test("keeps the write gate exactly where the control state puts it", () => {
    const root = candidateRoot();
    candidateControl(root);

    expect(eventV3WriteGateOpen(root, "candidate")).toBeTrue();
    expect(eventV3WriteGateOpen(root, "active")).toBeFalse();
  });

  test("a candidate witness cannot answer the active gate", () => {
    const root = candidateRoot();
    const candidate = candidateControl(root);
    const candidateWitness = readFileSync(witnessPath(root), "utf8");

    const activated = initializeEventLedgerV3({
      ...fixtureInput(root),
      approvalRecordId: "fixture-candidate-activation",
    });
    expect(activated.control.state).toBe("active");

    // Restore the pre-activation witness: it authenticates, but it names the
    // candidate state, so the active read must validate canonically instead.
    writeFileSync(witnessPath(root), candidateWitness, { mode: 0o600 });
    const control = activeControl(root);
    expect(control.genesis).toEqual(candidate.genesis);
    expect(witnessControlState(root)).toBe("active");
    expect(activeControlWitnessMatchesV3(root, control)).toBeTrue();
  });

  test("an active witness cannot answer the candidate gate", () => {
    const root = activeRoot();
    const activeWitness = readFileSync(witnessPath(root), "utf8");
    strandActivation(root);
    writeFileSync(witnessPath(root), activeWitness, { mode: 0o600 });

    expect(readEventV3ControlState(root).state).toBe("candidate");
    expect(witnessControlState(root)).toBe("candidate");
  });

  test("falls back and fails closed on a corrupt append", () => {
    const root = candidateRoot();
    candidateControl(root);
    appendFileSync(activePath(root), "{}\n", "utf8");

    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
    expect(eventV3WriteGateOpen(root, "candidate")).toBeFalse();
  });

  test("falls back and fails closed on a same-size rewrite", () => {
    const root = candidateRoot();
    candidateControl(root);
    const active = activePath(root);
    const valid = readFileSync(active, "utf8");
    const corrupt = valid.replace('"major":3', '"major":4');
    expect(corrupt).not.toBe(valid);
    expect(Buffer.byteLength(corrupt)).toBe(Buffer.byteLength(valid));
    writeFileSync(active, corrupt, "utf8");
    const changedAt = new Date(Date.now() + 1_000);
    utimesSync(active, changedAt, changedAt);

    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
  });

  test("falls back and fails closed on an active inode replacement", () => {
    const root = candidateRoot();
    catalogizeActive(root);
    const control = candidateControl(root);
    expect(
      candidateControlWitnessMatchesV3(root, {
        genesis: control.genesis,
        candidate_manifest_digest: control.candidate_manifest_digest,
      }),
    ).toBeTrue();

    const active = activePath(root);
    const prior = readFileSync(active);
    renameSync(active, `${active}.old`);
    writeFileSync(active, prior, { mode: 0o600 });

    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
  });

  test("falls back and fails closed on sealed-segment tampering", () => {
    const root = candidateRoot();
    const segment = sealControlHistory(root);
    const control = candidateControl(root);
    expect(
      candidateControlWitnessMatchesV3(root, {
        genesis: control.genesis,
        candidate_manifest_digest: control.candidate_manifest_digest,
      }),
    ).toBeTrue();

    appendFileSync(segment, "{}\n", "utf8");
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
  });

  test("ignores a forged candidate witness and replaces it after canonical validation", () => {
    const root = candidateRoot();
    candidateControl(root);
    const path = witnessPath(root);
    const valid = readFileSync(path, "utf8");
    const forged = valid.replace(/sha256:[a-f0-9]{64}/, `sha256:${"0".repeat(64)}`);
    expect(forged).not.toBe(valid);
    writeFileSync(path, forged, { mode: 0o600 });

    const control = candidateControl(root);
    expect(readFileSync(path, "utf8")).not.toBe(forged);
    expect(
      candidateControlWitnessMatchesV3(root, {
        genesis: control.genesis,
        candidate_manifest_digest: control.candidate_manifest_digest,
      }),
    ).toBeTrue();
  });
});

/** The exact residue of a crash between the genesis append and the activation publish. */
function strandActivation(root: string): void {
  const active = activePath(root);
  const genesisRow = readFileSync(active, "utf8").split("\n")[0];
  writeFileSync(active, `${genesisRow}\n`, "utf8");
  unlinkSync(join(root, EVENT_V3_ACTIVATION_MANIFEST));
}

function candidateRoot(): string {
  const root = activeRoot();
  strandActivation(root);
  return root;
}

function candidateControl(root: string): Extract<EventV3ControlState, { state: "candidate" }> {
  const control = readEventV3ControlState(root);
  if (control.state !== "candidate") {
    throw new Error(`expected candidate control, got ${control.state}`);
  }
  return control;
}

function witnessControlState(root: string): string {
  const witness = JSON.parse(readFileSync(witnessPath(root), "utf8")) as {
    payload: { control_state: string };
  };
  return witness.payload.control_state;
}

function fixtureInput(root: string) {
  return {
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("fixture-config"),
    approvalRecordId: "fixture-control-witness",
    now: () => new Date("2026-08-30T09:00:00.000Z"),
  };
}

function activeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-control-witness-"));
  roots.push(root);
  initializeEventLedgerV3(fixtureInput(root));
  return root;
}

function activeControl(root: string): Extract<EventV3ControlState, { state: "active" }> {
  const control = readEventV3ControlState(root);
  if (control.state !== "active") throw new Error(`expected active control, got ${control.state}`);
  return control;
}

function witnessPath(root: string): string {
  return join(root, EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH);
}

function ledgerRoot(root: string): string {
  return join(root, ".harnery", "ledgers", "v3");
}

function activePath(root: string): string {
  return join(ledgerRoot(root), "active.ndjson");
}

function catalogizeActive(root: string): void {
  const active = activePath(root);
  const stat = statSync(active);
  const bigintStat = statSync(active, { bigint: true });
  const catalog: EventV3Catalog = {
    format: "harnery-event-v3-catalog",
    format_version: 1,
    segments: [],
    active: {
      ordinal: 1,
      device: String(stat.dev),
      inode: String(stat.ino),
      birthtime_ns: String(bigintStat.birthtimeNs),
    },
  };
  writeFileSync(join(ledgerRoot(root), "catalog.json"), `${canonicalJsonV3(catalog)}\n`, {
    mode: 0o600,
  });
}

function sealControlHistory(root: string): string {
  const rootPath = ledgerRoot(root);
  const active = activePath(root);
  const bytes = readFileSync(active);
  const events = bytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((row) => JSON.parse(row) as EventV3);
  const segments = join(rootPath, "segments");
  mkdirSync(segments, { recursive: true, mode: 0o700 });
  const segmentFile = "000000000001.ndjson";
  const manifestFile = "000000000001.manifest.json";
  const segmentPath = join(segments, segmentFile);
  writeFileSync(segmentPath, bytes, { mode: 0o600 });
  const manifest: EventV3SegmentManifest = {
    format: "harnery-event-v3-segment",
    format_version: 1,
    ordinal: 1,
    segment_file: segmentFile,
    bytes: bytes.length,
    row_count: events.length,
    segment_digest: sha256V3(bytes),
    schema_digests: [EVENT_V3_SCHEMA_DIGEST],
    first_event_id: events[0]!.event_id,
    last_event_id: events.at(-1)!.event_id,
    sealed_at: "2026-08-30T09:01:00.000Z",
  };
  const manifestText = `${canonicalJsonV3(manifest)}\n`;
  writeFileSync(join(segments, manifestFile), manifestText, { mode: 0o600 });
  writeFileSync(active, "", { mode: 0o600 });
  const stat = statSync(active);
  const bigintStat = statSync(active, { bigint: true });
  const catalog: EventV3Catalog = {
    format: "harnery-event-v3-catalog",
    format_version: 1,
    segments: [
      {
        ordinal: 1,
        segment_file: segmentFile,
        manifest_file: manifestFile,
        segment_digest: manifest.segment_digest,
        manifest_digest: sha256V3(manifestText),
        bytes: bytes.length,
        row_count: events.length,
      },
    ],
    active: {
      ordinal: 2,
      device: String(stat.dev),
      inode: String(stat.ino),
      birthtime_ns: String(bigintStat.birthtimeNs),
    },
  };
  writeFileSync(join(rootPath, "catalog.json"), `${canonicalJsonV3(catalog)}\n`, {
    mode: 0o600,
  });
  return segmentPath;
}
