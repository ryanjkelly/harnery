import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventV3Fixture,
  eventV3Fixture,
  fixtureObject,
} from "../../../../tests/helpers/event-v3.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import type { EventV3Catalog, EventV3SegmentManifest } from "./catalog.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { EVENT_V3_LEDGER_RELATIVE_ROOT, readLedgerV3, readLedgerV3Since } from "./reader.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 filesystem discovery", () => {
  test("reads a fresh pre-rotation active epoch at stable segment ordinal one", () => {
    const root = temporaryRoot();
    const genesis = eventV3Fixture("ledger.genesis", 1);
    writeFreshActive(root, [genesis]);

    const read = readLedgerV3(root);
    expect(read.diagnostics).toEqual([]);
    expect(read.complete).toBe(true);
    expect(read.events[0]?.position).toEqual({ segment_ordinal: 1, byte_offset: 0 });
    expect(read.bytes).toBe(Buffer.byteLength(`${canonicalJsonV3(genesis)}\n`, "utf8"));
  });

  test("preserves a pre-rotation cursor after the active file becomes segment one", () => {
    const root = temporaryRoot();
    const genesis = eventV3Fixture("ledger.genesis", 1);
    writeFreshActive(root, [genesis]);
    const first = readLedgerV3Since(root);
    expect(first.cursor).toMatchObject({ segment_ordinal: 1, byte_offset: 0 });

    const next = eventV3Fixture("ledger.comparability_advanced", 2);
    writeCatalogedLedger(root, [genesis], [next]);
    const resumed = readLedgerV3Since(root, first.cursor);
    expect(resumed.diagnostics).toEqual([]);
    expect(resumed.reset_required).toBe(false);
    expect(resumed.events.map(({ event }) => fixtureObject(event).event_type)).toEqual([
      "ledger.comparability_advanced",
    ]);
    expect(resumed.cursor).toMatchObject({ segment_ordinal: 2, byte_offset: 0 });
  });

  test("reads catalog-bound sealed history and the inode-bound active tail", () => {
    const root = temporaryRoot();
    const genesis = eventV3Fixture("ledger.genesis", 1);
    const next = eventV3Fixture("ledger.comparability_advanced", 2);
    writeCatalogedLedger(root, [genesis], [next]);

    const read = readLedgerV3(root);
    expect(read.diagnostics).toEqual([]);
    expect(read.events.map(({ position }) => position.segment_ordinal)).toEqual([1, 2]);
    expect(read.events.map(({ event }) => fixtureObject(event).event_type)).toEqual([
      "ledger.genesis",
      "ledger.comparability_advanced",
    ]);
  });

  test("fails closed on a missing catalog when sealed metadata exists", () => {
    const root = temporaryRoot();
    const paths = ledgerPaths(root);
    mkdirSync(paths.segments, { recursive: true });
    writeFileSync(join(paths.segments, "000000000001.ndjson"), "{}\n", "utf8");

    const read = readLedgerV3(root);
    expect(read.complete).toBe(false);
    expect(read.events).toEqual([]);
    expect(read.diagnostics.map(({ code }) => code)).toEqual([
      "catalog_invalid",
      "missing_genesis",
    ]);
  });

  test("detects segment tampering and active-file replacement", () => {
    const tamperedRoot = temporaryRoot();
    const genesis = eventV3Fixture("ledger.genesis", 1);
    const next = eventV3Fixture("ledger.comparability_advanced", 2);
    writeCatalogedLedger(tamperedRoot, [genesis], [next]);
    const tamperedPaths = ledgerPaths(tamperedRoot);
    writeFileSync(
      join(tamperedPaths.segments, "000000000001.ndjson"),
      `${canonicalJsonV3(genesis)}\n{}\n`,
      "utf8",
    );
    expect(readLedgerV3(tamperedRoot).diagnostics.map(({ code }) => code)).toContain(
      "segment_digest_mismatch",
    );

    const replacedRoot = temporaryRoot();
    writeCatalogedLedger(replacedRoot, [genesis], [next]);
    const replacedActive = ledgerPaths(replacedRoot).active;
    const prior = readFileSync(replacedActive);
    renameSync(replacedActive, `${replacedActive}.old`);
    writeFileSync(replacedActive, prior);
    expect(readLedgerV3(replacedRoot).diagnostics.map(({ code }) => code)).toContain(
      "active_replaced",
    );
  });

  test("keeps valid active frames but reports a torn final frame", () => {
    const root = temporaryRoot();
    const genesis = eventV3Fixture("ledger.genesis", 1);
    const paths = ledgerPaths(root);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.active, `${canonicalJsonV3(genesis)}\n{"partial"`, "utf8");

    const read = readLedgerV3(root);
    expect(read.events).toHaveLength(1);
    expect(read.complete).toBe(false);
    expect(read.diagnostics.map(({ code }) => code)).toEqual(["partial_final_frame"]);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "event-v3-reader-"));
  roots.push(root);
  return root;
}

function ledgerPaths(coordRoot: string) {
  const root = join(coordRoot, EVENT_V3_LEDGER_RELATIVE_ROOT);
  return {
    root,
    active: join(root, "active.ndjson"),
    catalog: join(root, "catalog.json"),
    segments: join(root, "segments"),
  };
}

function writeFreshActive(root: string, events: EventV3Fixture[]): void {
  const paths = ledgerPaths(root);
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.active, rows(events));
}

function writeCatalogedLedger(
  root: string,
  sealedEvents: EventV3Fixture[],
  activeEvents: EventV3Fixture[],
): void {
  const paths = ledgerPaths(root);
  mkdirSync(paths.segments, { recursive: true });
  const segmentFile = "000000000001.ndjson";
  const manifestFile = "000000000001.manifest.json";
  const segmentBytes = Buffer.from(rows(sealedEvents), "utf8");
  writeFileSync(join(paths.segments, segmentFile), segmentBytes);
  const manifest: EventV3SegmentManifest = {
    format: "harnery-event-v3-segment",
    format_version: 1,
    ordinal: 1,
    segment_file: segmentFile,
    bytes: segmentBytes.length,
    row_count: sealedEvents.length,
    segment_digest: sha256V3(segmentBytes),
    schema_digests: [EVENT_V3_SCHEMA_DIGEST],
    first_event_id: sealedEvents[0]?.event_id as string,
    last_event_id: sealedEvents.at(-1)?.event_id as string,
    sealed_at: "2026-08-18T14:00:00.000Z",
  };
  const manifestText = `${canonicalJsonV3(manifest)}\n`;
  writeFileSync(join(paths.segments, manifestFile), manifestText, "utf8");
  writeFileSync(paths.active, rows(activeEvents), "utf8");
  const activeStat = statSync(paths.active);
  const activeBigintStat = statSync(paths.active, { bigint: true });
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
        bytes: segmentBytes.length,
        row_count: sealedEvents.length,
      },
    ],
    active: {
      ordinal: 2,
      device: String(activeStat.dev),
      inode: String(activeStat.ino),
      birthtime_ns: String(activeBigintStat.birthtimeNs),
    },
  };
  writeFileSync(paths.catalog, `${canonicalJsonV3(catalog)}\n`, "utf8");
}

function rows(events: EventV3Fixture[]): string {
  return events.map((event) => `${canonicalJsonV3(event)}\n`).join("");
}
