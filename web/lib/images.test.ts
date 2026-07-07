/**
 * Locks the bounded tail read behind the /images feed. `readImageCaptures` used
 * to `readFileSync` the whole events.ndjson and, in a try/catch, silently return
 * [] on failure — so once the append-only ledger passed V8's ~512MB max string
 * length the feed went blank (produced screenshots stopped surfacing) with no
 * error. It now rides `scanEventsTail`. Invariants: image.captured events are
 * grouped by content hash newest-first, touches accumulate per image, and the
 * distinct-image `limit` is honoured.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetCoordRootCache } from "./coord-reader.ts";
import { readImageCaptures } from "./images.ts";

function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-img-"));
  mkdirSync(path.join(root, ".harnery"), { recursive: true });
  return root;
}

function captureLine(opts: {
  seq: number;
  hash: string;
  role?: "viewed" | "produced";
  instanceId?: string;
  ts: string;
}): string {
  const { seq, hash, role = "produced", instanceId = "sess-1", ts } = opts;
  return JSON.stringify({
    schema_version: 1,
    event_id: `01img-${seq}`,
    event_type: "image.captured",
    ts,
    instance_id: instanceId,
    session_id: instanceId,
    harness: "claude-code",
    source: "test",
    data: {
      hash,
      ext: "png",
      bytes: 1000 + seq,
      role,
      source_path: `/tmp/shot-${seq}.png`,
      tool_name: "Bash",
      intent: `screenshot ${seq}`,
    },
  });
}

const NON_IMAGE = JSON.stringify({
  schema_version: 1,
  event_id: "01noise",
  event_type: "tool.pre_use",
  ts: "2026-07-07T00:00:00Z",
  instance_id: "sess-1",
  session_id: "sess-1",
  harness: "claude-code",
  source: "test",
  data: { tool_name: "Bash" },
});

function withRoot(lines: string[], fn: () => void): void {
  const root = freshRoot();
  writeFileSync(path.join(root, ".harnery", "events.ndjson"), `${lines.join("\n")}\n`, "utf8");
  const prev = process.env.HARNERY_COORD_ROOT;
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.HARNERY_COORD_ROOT;
    else process.env.HARNERY_COORD_ROOT = prev;
    __resetCoordRootCache();
  }
}

describe("readImageCaptures", () => {
  test("groups touches by hash, images newest-first, touches newest-first", () => {
    const lines = [
      captureLine({ seq: 0, hash: "a".repeat(64), role: "produced", ts: "2026-07-07T00:00:01Z" }),
      NON_IMAGE,
      captureLine({ seq: 1, hash: "b".repeat(64), role: "produced", ts: "2026-07-07T00:00:02Z" }),
      // second touch of image A, newer, by a different agent + role
      captureLine({
        seq: 2,
        hash: "a".repeat(64),
        role: "viewed",
        instanceId: "sess-2",
        ts: "2026-07-07T00:00:03Z",
      }),
    ];
    withRoot(lines, () => {
      const resp = readImageCaptures();
      expect(resp.meta.distinct).toBe(2);
      expect(resp.meta.total_touches).toBe(3);
      // A's latest touch (00:03) is newer than B's (00:02), so A sorts first.
      expect(resp.images.map((i) => i.hash)).toEqual(["a".repeat(64), "b".repeat(64)]);
      const imgA = resp.images[0]!;
      expect(imgA.touch_count).toBe(2);
      expect(imgA.roles.sort()).toEqual(["produced", "viewed"]);
      // touches newest-first
      expect(imgA.touches.map((t) => t.ts)).toEqual([
        "2026-07-07T00:00:03Z",
        "2026-07-07T00:00:01Z",
      ]);
    });
  });

  test("honours the distinct-image limit (newest kept)", () => {
    const lines = [0, 1, 2, 3, 4].map((s) =>
      captureLine({
        seq: s,
        hash: String(s).repeat(64).slice(0, 64),
        ts: `2026-07-07T00:00:0${s}Z`,
      }),
    );
    withRoot(lines, () => {
      const resp = readImageCaptures({ limit: 2 });
      expect(resp.images.length).toBe(2);
      // Newest two by ts: seq 4 then seq 3.
      expect(resp.images.map((i) => i.hash)).toEqual(["4".repeat(64), "3".repeat(64)]);
    });
  });

  test("empty feed when the stream holds no image events", () => {
    withRoot([NON_IMAGE, NON_IMAGE], () => {
      const resp = readImageCaptures();
      expect(resp.images).toEqual([]);
      expect(resp.meta.distinct).toBe(0);
    });
  });
});
