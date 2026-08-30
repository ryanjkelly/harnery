import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import type { EventV3Catalog, EventV3SegmentManifest } from "./catalog.ts";
import type { EventV3 } from "./contract.ts";
import { type EventV3ControlState, readEventV3ControlState } from "./control.ts";
import {
  activeControlWitnessMatchesV3,
  EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH,
} from "./control-witness.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { attestationIdV3, clockIdV3, eventIdV3 } from "./ids.ts";
import { recordLiveHookSignalV3, resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";
import { readLedgerV3 } from "./reader.ts";
import { writeEventV3 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
    expect(writeEventV3(root, invalid).state).toBe("ready");

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

function activeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-control-witness-"));
  roots.push(root);
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("fixture-config"),
    approvalRecordId: "fixture-control-witness",
    now: () => new Date("2026-08-30T09:00:00.000Z"),
  });
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
