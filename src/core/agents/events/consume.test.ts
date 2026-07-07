/**
 * Locks the read strategy of consumeSince: the bounded tail fast-path, the
 * full-read fallback when the cursor is older than the window, and the
 * replay-all behaviour when the cursor has been rotated out entirely. The
 * fallback paths must be correct regardless of window size: undersizing the
 * tail can never lose events, only cost a wider read.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumeSince, writeCursor } from "./consume.ts";

function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-consume-"));
  mkdirSync(path.join(root, ".harnery"), { recursive: true });
  return root;
}

function ev(id: string): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: id,
    event_type: "tool.pre_use",
    ts: "2026-06-04T00:00:00Z",
    instance_id: "owner-1",
    session_id: "owner-1",
    harness: "claude-code",
    source: "test",
    data: {},
  };
}

/** Write `ids` as an ndjson stream, padding each line to `padTo` bytes so the
 *  on-disk size is predictable enough to drive the tail window in tests. */
function writeStream(root: string, ids: string[], padTo = 0): void {
  const lines = ids.map((id) => {
    const obj = ev(id);
    if (padTo > 0) {
      const base = JSON.stringify(obj);
      const pad = Math.max(0, padTo - base.length - 1);
      (obj as { _pad?: string })._pad = "x".repeat(pad);
    }
    return JSON.stringify(obj);
  });
  writeFileSync(path.join(root, ".harnery", "events.ndjson"), `${lines.join("\n")}\n`, "utf8");
}

describe("consumeSince: cursorless reads", () => {
  test("no cursor returns every event (first run)", () => {
    const root = freshRoot();
    writeStream(root, ["a", "b", "c"]);
    const res = consumeSince(root);
    expect(res.events.map((e) => e.event_id)).toEqual(["a", "b", "c"]);
    expect(res.lastEventId).toBe("c");
  });

  test("replayAll ignores the cursor and returns everything", () => {
    const root = freshRoot();
    writeStream(root, ["a", "b", "c"]);
    writeCursor(root, "b");
    const res = consumeSince(root, { replayAll: true });
    expect(res.events.map((e) => e.event_id)).toEqual(["a", "b", "c"]);
  });

  test("missing stream file returns empty", () => {
    const root = freshRoot();
    const res = consumeSince(root);
    expect(res.events).toEqual([]);
    expect(res.lastEventId).toBeNull();
    expect(res.streamBytes).toBe(0);
  });
});

describe("consumeSince: cursor at/near the tail", () => {
  test("returns only events after the cursor (full-read path, small file)", () => {
    const root = freshRoot();
    writeStream(root, ["a", "b", "c", "d"]);
    writeCursor(root, "b");
    const res = consumeSince(root);
    expect(res.events.map((e) => e.event_id)).toEqual(["c", "d"]);
    expect(res.lastEventId).toBe("d");
  });

  test("cursor on the last line returns no new events", () => {
    const root = freshRoot();
    writeStream(root, ["a", "b", "c"]);
    writeCursor(root, "c");
    const res = consumeSince(root);
    expect(res.events).toEqual([]);
    expect(res.lastEventId).toBe("c"); // unchanged
  });
});

describe("consumeSince: bounded tail fast-path", () => {
  // Pad each event to ~200 bytes so a tiny tailBytes window deterministically
  // covers only the final lines, forcing the tail path to engage.
  test("tail window covers the cursor → returns the new tail without a full read", () => {
    const root = freshRoot();
    writeStream(root, ["a", "b", "c", "d", "e", "f"], 200);
    writeCursor(root, "e");
    // Window large enough to include 'e' and 'f' (~400+ bytes) but far smaller
    // than the whole file (~1200 bytes).
    const res = consumeSince(root, { tailBytes: 500 });
    expect(res.events.map((e) => e.event_id)).toEqual(["f"]);
    expect(res.lastEventId).toBe("f");
  });

  test("cursor OLDER than the tail window falls back to a full read (no events lost)", () => {
    const root = freshRoot();
    writeStream(root, ["a", "b", "c", "d", "e", "f"], 200);
    writeCursor(root, "a"); // oldest, definitely not in a 500-byte tail
    const res = consumeSince(root, { tailBytes: 500 });
    expect(res.events.map((e) => e.event_id)).toEqual(["b", "c", "d", "e", "f"]);
    expect(res.lastEventId).toBe("f");
  });

  test("a partial leading line in the tail is discarded but its event still arrives via fallback", () => {
    const root = freshRoot();
    // Cursor 'd' sits right around the window boundary; whether it lands in the
    // discarded partial line or not, the result must be ['e','f'].
    writeStream(root, ["a", "b", "c", "d", "e", "f"], 200);
    writeCursor(root, "d");
    const res = consumeSince(root, { tailBytes: 450 });
    expect(res.events.map((e) => e.event_id)).toEqual(["e", "f"]);
  });
});

describe("consumeSince: cursor rotated out", () => {
  test("cursor naming a vanished event triggers a full replay", () => {
    const root = freshRoot();
    writeStream(root, ["c", "d", "e"]); // 'a' and 'b' have been rotated away
    writeCursor(root, "b"); // no longer present
    const res = consumeSince(root);
    expect(res.events.map((e) => e.event_id)).toEqual(["c", "d", "e"]);
    expect(res.lastEventId).toBeNull(); // signals "replayed all"
  });

  test("rotated-out cursor with a large file still replays (tail miss → full miss → replay)", () => {
    const root = freshRoot();
    writeStream(root, ["c", "d", "e", "f", "g"], 200);
    writeCursor(root, "zzz"); // never existed / rotated
    const res = consumeSince(root, { tailBytes: 300 });
    expect(res.events.map((e) => e.event_id)).toEqual(["c", "d", "e", "f", "g"]);
    expect(res.lastEventId).toBeNull();
  });
});

describe("consumeSince: bounded fall-through cap", () => {
  // The fall-through read is capped so the unbounded events.ndjson can never
  // overflow V8's ~512MB max string length via readFileSync (the crash that
  // silently blanked the web feed and could abort heartbeat projection). These
  // drive the cap tiny to prove the fall-through reads only a window, not the
  // whole file.
  test("fall-through is capped: an old cursor replays only the capped tail, not the whole file", () => {
    const root = freshRoot();
    writeStream(root, ["a", "b", "c", "d", "e", "f"], 200);
    writeCursor(root, "a"); // oldest; misses both the tail window and the cap window
    // tail window (250B) misses 'a' → fall-through; cap (450B) covers ~2 lines.
    const res = consumeSince(root, { tailBytes: 250, fallbackCapBytes: 450 });
    // Bounded: the read never reached 'a'..'d'; the newest events survive.
    expect(res.events.map((e) => e.event_id)).toEqual(["e", "f"]);
    expect(res.events.length).toBeLessThan(6); // proves the cap bounded the read
    expect(res.lastEventId).toBeNull(); // cursor not found in window → replay signal
  });

  test("cursor found inside the capped fall-through window → returns events after it", () => {
    const root = freshRoot();
    writeStream(root, ["a", "b", "c", "d", "e", "f"], 200);
    writeCursor(root, "d");
    // tail window (250B) misses 'd' → fall-through; cap (700B) covers ~3 lines
    // ('d','e','f' after dropping the partial leading line), so 'd' is found.
    const res = consumeSince(root, { tailBytes: 250, fallbackCapBytes: 700 });
    expect(res.events.map((e) => e.event_id)).toEqual(["e", "f"]);
    expect(res.lastEventId).toBe("f");
  });
});
