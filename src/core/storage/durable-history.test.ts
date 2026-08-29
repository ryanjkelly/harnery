import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
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
import {
  appendDurableHistoryRecord,
  appendSegmentedJsonlFile,
  readDurableHistorySync,
  readSegmentedJsonlFileSync,
  rewriteCrashSafeJsonlFile,
} from "./durable-history.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable history", () => {
  test("rotates without imposing an aggregate history ceiling", () => {
    const root = fixture();
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      appendDurableHistoryRecord(root, { sequence, body: "x".repeat(30) }, limits());
    }
    expect(
      readDurableHistorySync<{ sequence: number }>(root, { max_record_bytes: 256 }),
    ).toHaveLength(40);
    expect(existsSync(join(root, "segments", "00000001.jsonl"))).toBeTrue();
  });

  test("fault after rotation preserves the sealed prefix", () => {
    const root = fixture();
    appendDurableHistoryRecord(root, { sequence: 1, body: "x".repeat(160) }, limits());
    expect(() =>
      appendDurableHistoryRecord(
        root,
        { sequence: 2, body: "y".repeat(160) },
        {
          ...limits(),
          fault: (boundary) => {
            if (boundary === "after_segment_rename") throw new Error("kill");
          },
        },
      ),
    ).toThrow("kill");
    expect(readDurableHistorySync<{ sequence: number }>(root, { max_record_bytes: 256 })).toEqual([
      expect.objectContaining({ sequence: 1 }),
    ]);
  });

  test("segments an existing active JSONL path without changing its name", () => {
    const root = fixture();
    const path = join(root, "events.jsonl");
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      appendSegmentedJsonlFile(path, { sequence, body: "x".repeat(40) }, limits());
    }
    expect(readSegmentedJsonlFileSync(path, { max_record_bytes: 256 })).toHaveLength(20);
    expect(existsSync(path)).toBeTrue();
    expect(existsSync(`${path}.segments`)).toBeTrue();
  });

  test("rewrite publishes either the prior or complete replacement", async () => {
    const root = fixture();
    const path = join(root, "history.jsonl");
    await rewriteCrashSafeJsonlFile(path, [{ id: "one" }], 256);
    await expect(
      rewriteCrashSafeJsonlFile(path, [{ id: "two" }], 256, (boundary) => {
        if (boundary === "after_rewrite_temp_sync") throw new Error("kill");
      }),
    ).rejects.toThrow("kill");
    expect(readFileSync(path, "utf8")).toContain('"one"');
  });

  test("rejects symlinked roots and active targets", () => {
    const parent = fixture();
    const target = fixture();
    const linkedRoot = join(parent, "linked");
    symlinkSync(target, linkedRoot, "dir");
    expect(() => appendDurableHistoryRecord(linkedRoot, { id: 1 }, limits())).toThrow("symlink");

    const activeTarget = join(target, "outside.jsonl");
    writeFileSync(activeTarget, '{"id":"outside"}\n');
    const root = fixture();
    symlinkSync(activeTarget, join(root, "active.jsonl"));
    expect(() => appendDurableHistoryRecord(root, { id: 2 }, limits())).toThrow("symlink");
    expect(readFileSync(activeTarget, "utf8")).toBe('{"id":"outside"}\n');
  });

  test("write-all loop survives forced short writes before issuing a synced receipt", () => {
    const root = fixture();
    let calls = 0;
    const receipt = appendDurableHistoryRecord(
      root,
      { id: "short-write" },
      {
        ...limits(),
        write_sync: (fd, buffer, offset, length) => {
          calls += 1;
          return writeSync(fd, buffer, offset, Math.min(length, 3));
        },
      },
    );
    expect(calls).toBeGreaterThan(1);
    expect(receipt.synced).toBeTrue();
    expect(readDurableHistorySync(root, { max_record_bytes: 256 })).toEqual([
      { id: "short-write" },
    ]);
  });

  test("recovers only owner-bound stale leases", () => {
    const root = fixture();
    const lease = join(root, ".append.lease");
    mkdirSync(lease);
    writeFileSync(
      join(lease, "owner.json"),
      `${JSON.stringify({
        owner_id: "crashed-owner",
        pid: 2_147_483_647,
        acquired_at: "2000-01-01T00:00:00.000Z",
      })}\n`,
    );
    expect(appendDurableHistoryRecord(root, { id: "recovered" }, limits()).synced).toBeTrue();

    const blocked = fixture();
    const unboundLease = join(blocked, ".append.lease");
    mkdirSync(unboundLease);
    writeFileSync(
      join(unboundLease, "owner.json"),
      `${JSON.stringify({ pid: 2_147_483_647, acquired_at: "2000-01-01T00:00:00.000Z" })}\n`,
    );
    expect(() => appendDurableHistoryRecord(blocked, { id: "blocked" }, limits())).toThrow(
      "lease busy",
    );
  });
});

function limits() {
  return { max_record_bytes: 256, max_segment_bytes: 256 };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-durable-history-"));
  roots.push(root);
  return root;
}
