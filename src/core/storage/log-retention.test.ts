import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "./catalog.ts";
import type { HarneryRegisteredStorageFamily } from "./contract.ts";
import { encodeLogRecord, type HarneryLogRecordV1 } from "./jsonl.ts";
import {
  createStructuredLogRetentionProvider,
  inspectStructuredLogRetention,
  STRUCTURED_LOG_RETENTION_SCOPE,
} from "./log-retention.ts";
import { FileSegmentSink, familyLogDirectory, readSegmentManifest } from "./segments.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("structured log retention", () => {
  test("separates managed pressure from unknown siblings and stays read-only when dormant", async () => {
    const root = fixture();
    const family = retainedFamily(root, 1_000_000, 7);
    const dormant = inspectStructuredLogRetention(family);
    expect(dormant).toMatchObject({
      usage: { managed_bytes: 0, unmanaged_bytes: 0 },
      pressure: { state: "within_budget" },
      retention: { state: "active", enforcement: "manual" },
    });
    expect(existsSync(join(root, ".harnery"))).toBeFalse();

    const directory = familyLogDirectory(family);
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1)], {}, false, new Date("2026-08-01T00:00:00.000Z"));
    await sink.append([record(family, 2)], {}, false, new Date("2026-08-02T00:00:00.000Z"));
    writeFileSync(join(directory, "unmanaged.bin"), "unmanaged");
    const inspection = inspectStructuredLogRetention(family, new Date("2026-08-03T00:00:00.000Z"));
    expect(inspection.usage.managed_bytes).toBeGreaterThan(0);
    expect(inspection.usage.unmanaged_bytes).toBe(9);
    expect(inspection.pressure.reason_codes).toContain("unmanaged_bytes_present");
    expect(inspection.sealed_segments).toHaveLength(1);
  });

  test("selects age-expired or byte-pressure segments oldest first and bounds snapshots", async () => {
    const root = fixture();
    const family = retainedFamily(root, 1, 7);
    const directory = familyLogDirectory(family);
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1)], {}, false, new Date("2026-08-01T00:00:00.000Z"));
    await sink.append([record(family, 2)], {}, false, new Date("2026-08-02T00:00:00.000Z"));
    await sink.append([record(family, 3)], {}, false, new Date("2026-08-03T00:00:00.000Z"));
    const provider = createStructuredLogRetentionProvider(family);
    const planned = await provider.plan({
      coord_root: root,
      pressure: pressure(family.id),
      budget: { max_duration_ms: 1_000, max_files: 10, max_bytes: 1_000_000 },
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(planned.actions.map(({ kind }) => kind)).toEqual([
      "prune-log-manifest-snapshot",
      "prune-log-manifest-snapshot",
      "prune-log-segment",
      "prune-log-segment",
    ]);
    expect(planned.actions.every(({ destructive }) => destructive)).toBeTrue();
    expect(
      planned.actions.every(
        ({ authorization_scope }) => authorization_scope === STRUCTURED_LOG_RETENTION_SCOPE,
      ),
    ).toBeTrue();
    expect(planned.actions.map(({ target_ref }) => target_ref)).not.toContain("active.jsonl");
    expect(planned.actions.map(({ target_ref }) => target_ref)).not.toContain("manifest.json");
  });

  test("applies exact targets and refuses changed policy or hard-linked sources", async () => {
    const root = fixture();
    const family = retainedFamily(root, 1, 7);
    const directory = familyLogDirectory(family);
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1)]);
    await sink.append([record(family, 2)]);
    const provider = createStructuredLogRetentionProvider(family);
    const plan = await provider.plan({
      coord_root: root,
      pressure: pressure(family.id),
      budget: { max_duration_ms: 1_000, max_files: 10, max_bytes: 1_000_000 },
      now: new Date(),
    });
    const segment = plan.actions.find(({ kind }) => kind === "prune-log-segment")!;
    const target = join(directory, segment.target_ref);
    linkSync(target, join(root, "hard-link.gz"));
    await expect(
      provider.apply({
        coord_root: root,
        transaction_id: "fixture",
        action: segment,
        now: new Date(),
      }),
    ).rejects.toThrow("hard-linked");
    rmSync(join(root, "hard-link.gz"));
    expect(
      await provider.apply({
        coord_root: root,
        transaction_id: "fixture",
        action: { ...segment, effective_policy_fingerprint: "f".repeat(64) },
        now: new Date(),
      }),
    ).toMatchObject({ outcome: "refused" });
    expect(
      await provider.apply({
        coord_root: root,
        transaction_id: "fixture",
        action: segment,
        now: new Date(),
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(readSegmentManifest(directory, family).pruned_through_sequence).toBe(1);
  });

  test("blocks unsafe manifested files without treating them as deletion candidates", async () => {
    const root = fixture();
    const family = retainedFamily(root, 1, 7);
    const directory = familyLogDirectory(family);
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1)]);
    await sink.append([record(family, 2)]);
    const segment = readSegmentManifest(directory, family).segments[0]!;
    rmSync(join(directory, segment.file));
    const inspection = inspectStructuredLogRetention(family);
    expect(inspection).toMatchObject({
      pressure: { state: "unknown" },
      retention: { state: "blocked", enforcement: "none" },
    });
    expect(inspection.retention.reason_codes).toContain("missing_manifest_segment");
    expect(
      await createStructuredLogRetentionProvider(family).plan({
        coord_root: root,
        pressure: pressure(family.id),
        budget: { max_duration_ms: 1_000, max_files: 10, max_bytes: 1_000_000 },
        now: new Date(),
      }),
    ).toEqual({ actions: [] });
  });

  test("blocks symlinked or wrong-type managed subdirectories", () => {
    const segmentRoot = fixture();
    const segmentFamily = retainedFamily(segmentRoot, 1, 7);
    const segmentDirectory = familyLogDirectory(segmentFamily);
    mkdirSync(segmentDirectory, { recursive: true });
    symlinkSync(segmentRoot, join(segmentDirectory, "segments"));
    expect(inspectStructuredLogRetention(segmentFamily)).toMatchObject({
      pressure: { state: "unknown" },
      retention: { state: "blocked", reason_codes: ["unsafe_managed_path"] },
    });

    const manifestRoot = fixture();
    const manifestFamily = retainedFamily(manifestRoot, 1, 7);
    const manifestDirectory = familyLogDirectory(manifestFamily);
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(join(manifestDirectory, "manifests"), "wrong type");
    expect(inspectStructuredLogRetention(manifestFamily)).toMatchObject({
      pressure: { state: "unknown" },
      retention: { state: "blocked", reason_codes: ["unsafe_managed_path"] },
    });
  });

  test("removes committed snapshots before pruning and leaves current manifest authoritative", async () => {
    const root = fixture();
    const family = retainedFamily(root, 1, 7);
    const directory = familyLogDirectory(family);
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1)]);
    await sink.append([record(family, 2)]);
    const provider = createStructuredLogRetentionProvider(family);
    const plan = await provider.plan({
      coord_root: root,
      pressure: pressure(family.id),
      budget: { max_duration_ms: 1_000, max_files: 10, max_bytes: 1_000_000 },
      now: new Date(),
    });
    for (const action of plan.actions) {
      await provider.apply({
        coord_root: root,
        transaction_id: "fixture",
        action,
        now: new Date(),
      });
    }
    expect(readdirSync(join(directory, "manifests"))).toEqual([]);
    expect(readSegmentManifest(directory, family)).toMatchObject({
      pruned_through_sequence: 1,
      segments: [],
    });
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-log-retention-"));
  roots.push(root);
  return root;
}

function retainedFamily(root: string, maxBytes: number, maxAgeDays: number) {
  const source = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
  return {
    ...source,
    effective_log_retention: {
      state: "valid",
      max_bytes: maxBytes,
      max_age_days: maxAgeDays,
      max_age_ms: maxAgeDays * 24 * 60 * 60 * 1_000,
      effective_policy_fingerprint: "a".repeat(64),
      provenance: {
        max_bytes: { source: "built-in", selector: source.id },
        max_age_days: { source: "built-in", selector: source.id },
      },
      diagnostics: [],
    },
  } satisfies HarneryRegisteredStorageFamily;
}

function pressure(family_id: string) {
  return {
    family_id,
    logical_bytes: 1_000_000,
    regular_files: 10,
    needs_maintenance: true,
    observed_at: new Date().toISOString(),
  };
}

function record(family: HarneryRegisteredStorageFamily, sequence: number): Buffer {
  const value: HarneryLogRecordV1 = {
    schema: "harnery.log-record/v1",
    kind: "record",
    emitted_at: new Date(sequence * 1_000).toISOString(),
    family_id: family.id,
    policy_version: family.policy.policy_version,
    component_id: "retention-canary",
    level: "info",
    event: `retention.${sequence}`,
    writer_id: "fixture",
    writer_seq: sequence,
    context: {},
    fields: {},
  };
  return encodeLogRecord(value, family);
}
