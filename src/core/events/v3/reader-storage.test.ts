import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  appendFileSync,
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
const PERFORMANCE_LEDGER_BYTES = 12 * 1024 * 1024;

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

  test("reads only appended bytes after a 12 MB snapshot, for cursor reads too", () => {
    const root = temporaryRoot();
    const row = `${canonicalJsonV3(eventV3Fixture("ledger.genesis", 1))}\n`;
    const rowBytes = Buffer.byteLength(row, "utf8");
    const rows = Math.ceil(PERFORMANCE_LEDGER_BYTES / rowBytes);
    const paths = ledgerPaths(root);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.active, row.repeat(rows), "utf8");

    const wholeReads = spyOn(fs, "readFileSync");
    const rangeReads = spyOn(fs, "readSync");
    const rangeBytesRead = () =>
      rangeReads.mock.results.reduce(
        (total, result) => total + (result.type === "return" ? result.value : 0),
        0,
      );
    try {
      const full = readLedgerV3(root);
      expect(full.complete).toBe(true);
      expect(full.bytes).toBeGreaterThanOrEqual(PERFORMANCE_LEDGER_BYTES);
      expect(wholeReads.mock.calls.filter(([path]) => path === paths.active)).toHaveLength(1);
      wholeReads.mockClear();
      rangeReads.mockClear();

      appendFileSync(paths.active, row, "utf8");
      const appended = readLedgerV3(root);
      expect(appended.complete).toBe(true);
      expect(appended.events[0]).toBe(full.events[0]);
      expect(wholeReads.mock.calls.filter(([path]) => path === paths.active)).toHaveLength(0);
      expect(rangeBytesRead()).toBe(rowBytes);

      // A tail poller must ride the same snapshot: before 2026-09-06 readLedgerV3Since
      // rediscovered and revalidated every frame per call (about 0.5 s for a 24.5 MB
      // ledger, once a second, from the semantic service).
      const tail = readLedgerV3Since(root);
      expect(tail.cursor).toBeDefined();
      expect(rangeBytesRead()).toBe(rowBytes);
      wholeReads.mockClear();
      rangeReads.mockClear();
      // A distinct event: the repeated genesis row above collapses to one event per id.
      const nextRow = `${canonicalJsonV3(eventV3Fixture("ledger.comparability_advanced", 2))}\n`;
      appendFileSync(paths.active, nextRow, "utf8");
      const since = readLedgerV3Since(root, tail.cursor);
      expect(since.complete).toBe(true);
      expect(since.reset_required).toBe(false);
      expect(since.events).toHaveLength(1);
      expect(wholeReads.mock.calls.filter(([path]) => path === paths.active)).toHaveLength(0);
      expect(rangeBytesRead()).toBe(Buffer.byteLength(nextRow, "utf8"));
    } finally {
      wholeReads.mockRestore();
      rangeReads.mockRestore();
    }
  }, 15_000);

  test("reuses one validated snapshot until ledger storage changes", () => {
    const root = temporaryRoot();
    const genesis = eventV3Fixture("ledger.genesis", 1);
    writeFreshActive(root, [genesis]);

    const first = readLedgerV3(root);
    expect(readLedgerV3(root)).toBe(first);

    const next = eventV3Fixture("ledger.comparability_advanced", 2);
    writeFreshActive(root, [genesis, next]);
    const appended = readLedgerV3(root);
    expect(appended).not.toBe(first);
    expect(appended.events).toHaveLength(2);
    expect(appended.events[0]).toBe(first.events[0]);
    expect(readLedgerV3(root)).toBe(appended);
  });

  test("surfaces authority diagnostics from an incrementally read frame", () => {
    const root = temporaryRoot();
    const genesis = eventV3Fixture("ledger.genesis", 1);
    writeFreshActive(root, [genesis]);
    expect(readLedgerV3(root).complete).toBe(true);

    appendFileSync(ledgerPaths(root).active, "{}\n", "utf8");
    const corrupt = readLedgerV3(root);
    expect(corrupt.complete).toBe(false);
    expect(corrupt.diagnostics.map(({ code }) => code)).toContain("unsupported_major");
  });

  test("invalidates a cached snapshot after a same-size corrupt rewrite", () => {
    const root = temporaryRoot();
    const genesis = eventV3Fixture("ledger.genesis", 1);
    writeFreshActive(root, [genesis]);
    const first = readLedgerV3(root);
    const active = ledgerPaths(root).active;
    const valid = readFileSync(active, "utf8");
    const corrupt = valid.replace('"major":3', '"major":4');
    expect(corrupt).not.toBe(valid);
    expect(Buffer.byteLength(corrupt)).toBe(Buffer.byteLength(valid));
    writeFileSync(active, corrupt, "utf8");
    const changedAt = new Date(Date.now() + 1_000);
    utimesSync(active, changedAt, changedAt);

    const rewritten = readLedgerV3(root);
    expect(rewritten).not.toBe(first);
    expect(rewritten.complete).toBe(false);
    expect(rewritten.diagnostics.map(({ code }) => code)).toContain("unsupported_major");
  });

  test("keeps validation options in the snapshot cache key", () => {
    const root = temporaryRoot();
    const genesis = eventV3Fixture("ledger.genesis", 1);
    writeFreshActive(root, [genesis]);

    const candidate = readLedgerV3(root);
    const active = readLedgerV3(root, { authority: "active" });
    expect(active).not.toBe(candidate);
    expect(active.diagnostics.map(({ code }) => code)).toContain("missing_activation");
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
    expect(readLedgerV3(tamperedRoot).complete).toBe(true);
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
    expect(readLedgerV3(replacedRoot).complete).toBe(true);
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
