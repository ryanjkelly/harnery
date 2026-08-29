import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "./catalog.ts";
import { encodeLogRecord, type HarneryLogRecordV1 } from "./jsonl.ts";
import { queryLogs, readLogFollow, rotationFollowCursor } from "./query.ts";
import {
  FileSegmentSink,
  HarneryLogLeaseError,
  logManifestFingerprint,
  pruneSealedLogSegment,
  readSegmentManifest,
} from "./segments.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared log segments and query", () => {
  test("rotates through a sealed manifest and queries with global budgets", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-segments-"));
    roots.push(root);
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1, "first")]);
    await sink.append([record(family, 2, "second")]);
    expect(readSegmentManifest(directory, family).segments).toHaveLength(1);
    const result = await queryLogs([family], { max_records: 10, max_bytes: 100_000 });
    expect(result.records.map((item) => item.event)).toEqual(["first", "second"]);
    const bounded = await queryLogs([family], { max_records: 1, max_bytes: 100_000 });
    expect(bounded.truncated).toBeTrue();
  });

  test("follows an active file across rotation and rejects a wrong-type lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-follow-"));
    roots.push(root);
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1, "first")]);
    const cursor = rotationFollowCursor(family);
    await sink.append([record(family, 2, "second")]);
    const followed = await readLogFollow(family, cursor, 100_000);
    expect(followed.rotated).toBeTrue();
    expect(followed.records[0]?.event).toBe("second");
    writeFileSync(join(directory, ".append-lease"), "wrong type");
    await expect(sink.append([record(family, 3, "third")])).rejects.toBeInstanceOf(
      HarneryLogLeaseError,
    );
    expect(readFileSync(join(directory, "active.jsonl"), "utf8")).toContain("second");
  });

  test("rejects symlinked active targets and writes every short-write remainder", async () => {
    const root = fixture("harnery-segment-symlink-");
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    mkdirSync(directory, { recursive: true });
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, "");
    symlinkSync(outside, join(directory, "active.jsonl"));
    await expect(
      new FileSegmentSink({ directory, family }).append([record(family, 1, "bad")]),
    ).rejects.toThrow("symlink");
    expect(readFileSync(outside, "utf8")).toBe("");

    rmSync(join(directory, "active.jsonl"));
    let calls = 0;
    const sink = new FileSegmentSink({
      directory,
      family,
      write_sync: (fd, buffer, offset, length) => {
        calls += 1;
        return writeSync(fd, buffer, offset, Math.min(length, 5));
      },
    });
    const result = await sink.append([record(family, 2, "short")], {}, true);
    expect(calls).toBeGreaterThan(1);
    expect(result.synced).toBeTrue();
    expect(
      (await queryLogs([family], { max_records: 10, max_bytes: 100_000 })).records,
    ).toHaveLength(1);
  });

  test("recovers an owner-bound stale lease but refuses an unbound orphan", async () => {
    const root = fixture("harnery-segment-stale-");
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const lease = join(directory, ".append-lease");
    mkdirSync(lease, { recursive: true });
    writeFileSync(
      join(lease, "owner.json"),
      `${JSON.stringify({
        owner_id: "crashed-owner",
        pid: 2_147_483_647,
        acquired_at: "2000-01-01T00:00:00.000Z",
      })}\n`,
    );
    const sink = new FileSegmentSink({
      directory,
      family,
      lease_stale_ms: 1,
      lease_timeout_ms: 10,
      lease_retry_ms: 1,
    });
    expect((await sink.append([record(family, 1, "recovered")])).appended_records).toBe(1);

    mkdirSync(lease);
    writeFileSync(
      join(lease, "owner.json"),
      `${JSON.stringify({ pid: 2_147_483_647, acquired_at: "2000-01-01T00:00:00.000Z" })}\n`,
    );
    await expect(sink.append([record(family, 2, "blocked")])).rejects.toBeInstanceOf(
      HarneryLogLeaseError,
    );
  });

  test("refuses partial and malformed active JSONL before sealing", async () => {
    for (const [name, content] of [
      ["partial", '{"schema":"harnery.log-record/v1"}'],
      ["malformed", "not-json\n"],
    ] as const) {
      const root = fixture(`harnery-segment-${name}-`);
      const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
      const directory = join(root, ".harnery", "logs", "agent-hook-debug");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "active.jsonl"), content);
      const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
      await expect(sink.append([record(family, 1, "next")])).rejects.toThrow(
        name === "partial" ? "partial JSONL" : "malformed JSONL",
      );
      expect(existsSync(join(directory, "manifest.json"))).toBeFalse();
      expect(readFileSync(join(directory, "active.jsonl"), "utf8")).toBe(content);
    }
  });

  test("bounds oversized corrupt lines and rejects partial query records", async () => {
    const root = fixture("harnery-query-bounds-");
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const active = join(directory, "active.jsonl");
    mkdirSync(directory, { recursive: true });
    const maximum = family.policy.records.max_record_bytes.limit ?? 1024 * 1024;
    writeFileSync(active, `${"x".repeat(maximum)}\n`);
    await expect(queryLogs([family], { max_records: 10, max_bytes: maximum + 10 })).rejects.toThrow(
      "record exceeds",
    );
    await expect(
      readLogFollow(
        family,
        { family_id: family.id, manifest_sequence: 0, active_offset: 0 },
        maximum + 10,
      ),
    ).rejects.toThrow("record exceeds");

    writeFileSync(active, JSON.stringify({ schema: "harnery.log-record/v1" }));
    await expect(queryLogs([family], { max_records: 10, max_bytes: 100_000 })).rejects.toThrow(
      "partial JSONL",
    );
  });

  test("expires only the oldest sequence and keeps lifetime numbering monotonic", async () => {
    const root = fixture("harnery-segment-prune-");
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1, "first")]);
    await sink.append([record(family, 2, "second")]);
    await sink.append([record(family, 3, "third")]);
    const before = readSegmentManifest(directory, family);
    const first = before.segments[0]!;
    const target = join(directory, first.file);
    const fileBytes = readFileSync(target);
    expect(
      await pruneSealedLogSegment({
        directory,
        family,
        sequence: first.sequence,
        file: first.file,
        expected_bytes: fileBytes.byteLength,
        expected_file_sha256: createHash("sha256").update(fileBytes).digest("hex"),
        expected_content_sha256: first.sha256,
        ...manifestTransition(directory, family, first.sequence),
      }),
    ).toBe("applied");
    const after = readSegmentManifest(directory, family);
    expect(after).toMatchObject({
      pruned_through_sequence: 1,
      next_sequence: before.next_sequence,
    });
    expect(after.segments.map(({ sequence }) => sequence)).toEqual([2]);
    const query = await queryLogs([family], { max_records: 10, max_bytes: 100_000 });
    expect(query.records.map(({ event }) => event)).toEqual(["second", "third"]);
    expect(query.expired_through).toEqual({ [family.id]: 1 });
    const followed = await readLogFollow(
      family,
      { family_id: family.id, manifest_sequence: 1, active_offset: 0 },
      100_000,
    );
    expect(followed.history_expired).toBeTrue();
  });

  test("replays manifest-first pruning and fails closed on the opposite crash state", async () => {
    const root = fixture("harnery-segment-prune-replay-");
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1, "first")]);
    await sink.append([record(family, 2, "second")]);
    const first = readSegmentManifest(directory, family).segments[0]!;
    const target = join(directory, first.file);
    const bytes = readFileSync(target);
    const input = {
      directory,
      family,
      sequence: first.sequence,
      file: first.file,
      expected_bytes: bytes.byteLength,
      expected_file_sha256: createHash("sha256").update(bytes).digest("hex"),
      expected_content_sha256: first.sha256,
      ...manifestTransition(directory, family, first.sequence),
    };
    await expect(
      pruneSealedLogSegment({
        ...input,
        after_manifest_commit: () => {
          throw new Error("fixture crash");
        },
      }),
    ).rejects.toThrow("fixture crash");
    expect(existsSync(target)).toBeTrue();
    expect(await pruneSealedLogSegment(input)).toBe("applied");
    expect(await pruneSealedLogSegment(input)).toBe("already_applied");

    const secondRoot = fixture("harnery-segment-prune-absent-");
    const secondFamily = createStorageCatalog({ coord_root: secondRoot }).require(
      "agent-hook-debug-log",
    );
    const secondDirectory = join(secondRoot, ".harnery", "logs", "agent-hook-debug");
    const secondSink = new FileSegmentSink({
      directory: secondDirectory,
      family: secondFamily,
      max_segment_bytes: 1,
    });
    await secondSink.append([record(secondFamily, 1, "first")]);
    await secondSink.append([record(secondFamily, 2, "second")]);
    const second = readSegmentManifest(secondDirectory, secondFamily).segments[0]!;
    const secondTarget = join(secondDirectory, second.file);
    const secondBytes = readFileSync(secondTarget);
    rmSync(secondTarget);
    await expect(
      pruneSealedLogSegment({
        directory: secondDirectory,
        family: secondFamily,
        sequence: second.sequence,
        file: second.file,
        expected_bytes: secondBytes.byteLength,
        expected_file_sha256: createHash("sha256").update(secondBytes).digest("hex"),
        expected_content_sha256: second.sha256,
        ...manifestTransition(secondDirectory, secondFamily, second.sequence),
      }),
    ).rejects.toThrow("absent while the manifest still references it");
  });

  test("refuses hard-linked retention targets without advancing the manifest", async () => {
    const root = fixture("harnery-segment-prune-link-");
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1, "first")]);
    await sink.append([record(family, 2, "second")]);
    const before = readSegmentManifest(directory, family);
    const first = before.segments[0]!;
    const target = join(directory, first.file);
    const bytes = readFileSync(target);
    linkSync(target, join(root, "linked-segment.gz"));
    await expect(
      pruneSealedLogSegment({
        directory,
        family,
        sequence: first.sequence,
        file: first.file,
        expected_bytes: bytes.byteLength,
        expected_file_sha256: createHash("sha256").update(bytes).digest("hex"),
        expected_content_sha256: first.sha256,
        ...manifestTransition(directory, family, first.sequence),
      }),
    ).rejects.toThrow("hard-linked");
    expect(readSegmentManifest(directory, family)).toEqual(before);
  });

  test("refuses a planned prune after rotation changes the manifest generation", async () => {
    const root = fixture("harnery-segment-prune-stale-");
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([record(family, 1, "first")]);
    await sink.append([record(family, 2, "second")]);
    const before = readSegmentManifest(directory, family);
    const first = before.segments[0]!;
    const bytes = readFileSync(join(directory, first.file));
    const input = {
      directory,
      family,
      sequence: first.sequence,
      file: first.file,
      expected_bytes: bytes.byteLength,
      expected_file_sha256: createHash("sha256").update(bytes).digest("hex"),
      expected_content_sha256: first.sha256,
      ...manifestTransition(directory, family, first.sequence),
    };
    await sink.append([record(family, 3, "third")]);
    await expect(pruneSealedLogSegment(input)).rejects.toThrow("changed after planning");
    expect(existsSync(join(directory, first.file))).toBeTrue();
    expect(readSegmentManifest(directory, family).pruned_through_sequence).toBeUndefined();
  });
});

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function manifestTransition(
  directory: string,
  family: ReturnType<typeof createStorageCatalog>["families"][number],
  sequence: number,
): { expected_manifest_fingerprint: string; result_manifest_fingerprint: string } {
  const manifest = readSegmentManifest(directory, family);
  return {
    expected_manifest_fingerprint: logManifestFingerprint(manifest),
    result_manifest_fingerprint: logManifestFingerprint({
      ...manifest,
      pruned_through_sequence: sequence,
      segments: manifest.segments.slice(1),
    }),
  };
}

function record(
  family: ReturnType<typeof createStorageCatalog>["families"][number],
  sequence: number,
  event: string,
): Buffer {
  const value: HarneryLogRecordV1 = {
    schema: "harnery.log-record/v1",
    kind: "record",
    emitted_at: new Date(sequence * 1_000).toISOString(),
    family_id: family.id,
    policy_version: family.policy.policy_version,
    component_id: "canary",
    level: "info",
    event,
    writer_id: "writer",
    writer_seq: sequence,
    context: {},
    fields: {},
  };
  return encodeLogRecord(value, family);
}
