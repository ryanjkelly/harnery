/**
 * Locks the incremental identity index that replaced the whole-file
 * readInstanceIdentities scan. The invariants that matter: it only consumes
 * appended bytes (offset advances to the last complete line), it never drops a
 * start event across a torn-final-line boundary, it rebuilds when the log is
 * replaced, and it round-trips through the persisted .identity-index.json so a
 * cold process doesn't re-read the whole ledger.
 */

import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetCoordRootCache,
  type IdentityIndex,
  mergeIdentitiesFromChunk,
  readEvents,
  refreshIdentityIndex,
} from "./coord-reader.ts";

function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-idx-"));
  mkdirSync(path.join(root, ".harnery"), { recursive: true });
  return root;
}

function streamPath(root: string): string {
  return path.join(root, ".harnery", "events.ndjson");
}

function startLine(
  type: "session.start" | "subagent.start",
  instanceId: string,
  name: string | undefined,
  extra: Record<string, unknown> = {},
): string {
  const data: Record<string, unknown> = { ...extra };
  if (name !== undefined) data.name = name;
  return JSON.stringify({
    schema_version: 1,
    event_id: `01${instanceId}`,
    event_type: type,
    ts: "2026-06-04T00:00:00Z",
    instance_id: instanceId,
    session_id: type === "subagent.start" ? "parent-sess" : instanceId,
    harness: "claude-code",
    source: "test",
    data,
  });
}

const NON_START = JSON.stringify({
  schema_version: 1,
  event_id: "01tool",
  event_type: "tool.pre_use",
  ts: "2026-06-04T00:00:00Z",
  instance_id: "sess-1",
  session_id: "sess-1",
  harness: "claude-code",
  source: "test",
  data: { tool_name: "Bash" },
});

function turnStopLine(instanceId: string, model: string): string {
  return JSON.stringify({
    schema_version: 1,
    event_id: `01ts-${instanceId}`,
    event_type: "turn.stop",
    ts: "2026-06-04T00:01:00Z",
    instance_id: instanceId,
    session_id: instanceId,
    harness: "claude-code",
    source: "test",
    data: { model, tool_call_count: 1 },
  });
}

describe("mergeIdentitiesFromChunk", () => {
  test("harvests session + subagent starts, skips non-start and nameless rows", () => {
    const chunk = [
      startLine("session.start", "sess-1", "Anna", { platform: "claude_code" }),
      NON_START,
      startLine("subagent.start", "sub-1", "Bob", { agent_type: "Explore" }),
      startLine("session.start", "sess-2", undefined), // nameless → skipped
      "{ not json",
    ].join("\n");
    const out = mergeIdentitiesFromChunk(chunk, {});
    expect(Object.keys(out).sort()).toEqual(["sess-1", "sub-1"]);
    expect(out["sess-1"]!.kind).toBe("session");
    expect(out["sess-1"]!.platform).toBe("claude_code");
    expect(out["sub-1"]!.kind).toBe("subagent");
    expect(out["sub-1"]!.agent_type).toBe("Explore");
    expect(out["sub-1"]!.session_id).toBe("parent-sess");
  });

  test("latest start wins per instance_id", () => {
    const into = mergeIdentitiesFromChunk(startLine("session.start", "x", "First"), {});
    mergeIdentitiesFromChunk(startLine("session.start", "x", "Second"), into);
    expect(into["x"]!.name).toBe("Second");
  });

  test("turn.stop folds data.model onto the existing identity; latest wins", () => {
    const into = mergeIdentitiesFromChunk(
      [
        startLine("session.start", "sess-1", "Anna", { platform: "claude_code" }),
        turnStopLine("sess-1", "claude-opus-4-8"),
        turnStopLine("sess-1", "claude-fable-5"),
      ].join("\n"),
      {},
    );
    expect(into["sess-1"]!.model).toBe("claude-fable-5");
  });

  test("turn.stop with no captured identity is skipped (model without a name is unusable)", () => {
    const into = mergeIdentitiesFromChunk(turnStopLine("ghost", "gpt-5.5"), {});
    expect(Object.keys(into)).toEqual([]);
  });

  test("a re-emitted session.start (resume) preserves the harvested model", () => {
    const into = mergeIdentitiesFromChunk(
      [
        startLine("session.start", "sess-1", "Anna", { platform: "claude_code" }),
        turnStopLine("sess-1", "gpt-5.5"),
        startLine("session.start", "sess-1", "Anna", { platform: "claude_code" }),
      ].join("\n"),
      {},
    );
    expect(into["sess-1"]!.model).toBe("gpt-5.5");
  });
});

describe("refreshIdentityIndex: incremental consumption", () => {
  test("cold start reads the whole file and advances offset to EOF", () => {
    const root = freshRoot();
    const body = `${startLine("session.start", "sess-1", "Anna")}\n${startLine("subagent.start", "sub-1", "Bob")}\n`;
    writeFileSync(streamPath(root), body, "utf8");

    const idx = refreshIdentityIndex(root, null);
    expect(Object.keys(idx.identities).sort()).toEqual(["sess-1", "sub-1"]);
    expect(idx.offset).toBe(Buffer.byteLength(body, "utf8"));
  });

  test("a second refresh with no new bytes is a no-op (steady-state fast path)", () => {
    const root = freshRoot();
    const body = `${startLine("session.start", "sess-1", "Anna")}\n`;
    writeFileSync(streamPath(root), body, "utf8");
    const first = refreshIdentityIndex(root, null);
    const second = refreshIdentityIndex(root, first);
    expect(second.offset).toBe(first.offset);
    expect(Object.keys(second.identities)).toEqual(["sess-1"]);
  });

  test("appended start events are picked up on the next refresh", () => {
    const root = freshRoot();
    writeFileSync(streamPath(root), `${startLine("session.start", "sess-1", "Anna")}\n`, "utf8");
    const first = refreshIdentityIndex(root, null);
    expect(Object.keys(first.identities)).toEqual(["sess-1"]);

    appendFileSync(streamPath(root), `${startLine("subagent.start", "sub-9", "Zed")}\n`, "utf8");
    const second = refreshIdentityIndex(root, first);
    expect(Object.keys(second.identities).sort()).toEqual(["sess-1", "sub-9"]);
    expect(second.offset).toBeGreaterThan(first.offset);
  });

  test("a torn final line is NOT consumed until completed (no dropped start)", () => {
    const root = freshRoot();
    const annaLine = startLine("session.start", "sess-1", "Anna");
    const bobLine = startLine("subagent.start", "sub-2", "Bob");
    // File ends mid-Bob; only Anna's line is terminated.
    writeFileSync(streamPath(root), `${annaLine}\n${bobLine.slice(0, 20)}`, "utf8");
    const first = refreshIdentityIndex(root, null);
    expect(Object.keys(first.identities)).toEqual(["sess-1"]);
    expect(first.offset).toBe(Buffer.byteLength(`${annaLine}\n`, "utf8")); // stopped after Anna

    // The writer completes Bob's line.
    writeFileSync(streamPath(root), `${annaLine}\n${bobLine}\n`, "utf8");
    const second = refreshIdentityIndex(root, first);
    expect(Object.keys(second.identities).sort()).toEqual(["sess-1", "sub-2"]);
  });

  test("a shrunk active file resets the offset but keeps prior identities", () => {
    // A shrink means a rotation happened (the active file rolled to an archive),
    // so the offset must reset to re-read the fresh file — but prior identities
    // must be KEPT, not wiped: the rolled-out agents live on in the archive (and
    // are re-resolvable by folding it), and wiping them would reintroduce the
    // exact "rolled agents lose their names" bug rotation exists to avoid.
    const root = freshRoot();
    const big = `${startLine("session.start", "old-1", "Old")}\n${startLine("session.start", "old-2", "Older")}\n`;
    writeFileSync(streamPath(root), big, "utf8");
    const first = refreshIdentityIndex(root, null);
    expect(first.offset).toBe(Buffer.byteLength(big, "utf8"));

    // Replace with a smaller file (size < prior offset), as a fresh post-roll
    // active file would be. No archive on disk here, so the fold step is a no-op
    // and we're asserting the in-memory-cache retention path specifically.
    const small = `${startLine("session.start", "new-1", "New")}\n`;
    writeFileSync(streamPath(root), small, "utf8");
    const second = refreshIdentityIndex(root, first);
    expect(Object.keys(second.identities).sort()).toEqual(["new-1", "old-1", "old-2"]);
    expect(second.offset).toBe(Buffer.byteLength(small, "utf8"));
  });

  test("missing stream returns the prior index unchanged", () => {
    const root = freshRoot();
    const prev: IdentityIndex = { offset: 0, identities: {} };
    expect(refreshIdentityIndex(root, prev)).toBe(prev);
  });
});

describe("refreshIdentityIndex: persisted index round-trip", () => {
  test("persists .identity-index.json and a cold refresh (prev=null) reloads it", () => {
    const root = freshRoot();
    writeFileSync(streamPath(root), `${startLine("session.start", "sess-1", "Anna")}\n`, "utf8");
    const first = refreshIdentityIndex(root, null);
    expect(existsSync(path.join(root, ".harnery", ".identity-index.json"))).toBe(true);

    // Append, then simulate a fresh process (prev=null): the persisted index is
    // loaded so only the appended delta is read, and the prior identity survives.
    appendFileSync(streamPath(root), `${startLine("session.start", "sess-2", "Cara")}\n`, "utf8");
    const cold = refreshIdentityIndex(root, null);
    expect(Object.keys(cold.identities).sort()).toEqual(["sess-1", "sess-2"]);
    expect(cold.offset).toBeGreaterThanOrEqual(first.offset);
  });
});

/**
 * Locks the bounded backward-chunked tail read that replaced the whole-file
 * `readFileSync` in `readEvents`. The whole-file read crashed once events.ndjson
 * (an append-only ledger) passed ~512MB — V8's max string length — with "Cannot
 * create a string longer than 0x1fffffe8 characters". The invariants: newest
 * events first, `limit` respected, filters honoured, and — the boundary case —
 * lines that straddle a chunk boundary are reconstituted, not corrupted.
 */
describe("readEvents", () => {
  function eventLine(
    seq: number,
    opts: { type?: string; instanceId?: string; pad?: number } = {},
  ): string {
    const { type = "tool.pre_use", instanceId = "sess-1", pad = 0 } = opts;
    return JSON.stringify({
      schema_version: 1,
      event_id: `01ev-${seq}`,
      event_type: type,
      ts: "2026-06-04T00:00:00Z",
      instance_id: instanceId,
      session_id: instanceId,
      harness: "claude-code",
      source: "test",
      data: { seq, filler: "x".repeat(pad) },
    });
  }

  function withRoot(body: string, fn: () => void): void {
    const root = freshRoot();
    writeFileSync(streamPath(root), body, "utf8");
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

  test("returns newest-first and respects limit", () => {
    const body = `${[0, 1, 2, 3, 4].map((s) => eventLine(s)).join("\n")}\n`;
    withRoot(body, () => {
      const resp = readEvents({ limit: 3 });
      expect(resp.rows.map((r) => r.data?.seq)).toEqual([4, 3, 2]);
      expect(resp.meta.returned).toBe(3);
    });
  });

  test("filters by instanceId and type", () => {
    const body = `${[
      eventLine(0, { instanceId: "a", type: "turn.stop" }),
      eventLine(1, { instanceId: "b", type: "tool.pre_use" }),
      eventLine(2, { instanceId: "a", type: "tool.pre_use" }),
      eventLine(3, { instanceId: "a", type: "turn.stop" }),
    ].join("\n")}\n`;
    withRoot(body, () => {
      expect(readEvents({ instanceId: "a" }).rows.map((r) => r.data?.seq)).toEqual([3, 2, 0]);
      expect(readEvents({ type: "turn.stop" }).rows.map((r) => r.data?.seq)).toEqual([3, 0]);
      expect(
        readEvents({ instanceId: "a", type: "tool.pre_use" }).rows.map((r) => r.data?.seq),
      ).toEqual([2]);
    });
  });

  test("tolerates a torn final line (no trailing newline, in-progress append)", () => {
    // Last line is valid JSON but unterminated; a mid-write torn line would be
    // dropped by JSON.parse — either way no crash.
    const body = `${eventLine(0)}\n${eventLine(1)}\n${eventLine(2)}`;
    withRoot(body, () => {
      expect(readEvents({ limit: 10 }).rows.map((r) => r.data?.seq)).toEqual([2, 1, 0]);
    });
  });

  test("reconstitutes lines across the chunk boundary on a multi-chunk file", () => {
    // Force many backward chunks: ~9000 rows padded to ~600B each ≈ 5.4MB,
    // spanning more than one EVENTS_CHUNK_BYTES (4MB) window. If carry-gluing
    // were wrong, the rows straddling each 4MB boundary would fail to parse and
    // the count/order would drift.
    const rows = 9000;
    const body = `${Array.from({ length: rows }, (_, s) => eventLine(s, { pad: 500 })).join("\n")}\n`;
    expect(body.length).toBeGreaterThan(4_000_000);
    withRoot(body, () => {
      const resp = readEvents({ limit: rows });
      expect(resp.rows.length).toBe(rows);
      // Newest-first, contiguous, no gaps or dupes → every boundary line parsed.
      expect(resp.rows.map((r) => r.data?.seq)).toEqual(
        Array.from({ length: rows }, (_, i) => rows - 1 - i),
      );
    });
  });
});

function archivePath(root: string, name: string): string {
  return path.join(root, ".harnery", name);
}

function withCoordRoot(root: string, fn: () => void): void {
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

function evLine(seq: number, instanceId = "sess-1"): string {
  return JSON.stringify({
    schema_version: 1,
    event_id: `01ev-${seq}`,
    event_type: "tool.pre_use",
    ts: "2026-06-04T00:00:00Z",
    instance_id: instanceId,
    session_id: instanceId,
    harness: "claude-code",
    source: "test",
    data: { seq },
  });
}

describe("scanEventsTail spans rotation archives", () => {
  test("a tail scan continues from the active file into an archive, newest-first", () => {
    const root = freshRoot();
    // Older events live in a rolled archive; newer ones in the active file.
    writeFileSync(archivePath(root, "events-2026-07-06.ndjson"), `${evLine(0)}\n${evLine(1)}\n`);
    writeFileSync(streamPath(root), `${evLine(2)}\n${evLine(3)}\n`);
    withCoordRoot(root, () => {
      const seqs = readEvents({ limit: 10 }).rows.map((r) => r.data?.seq);
      // Active (3,2) first, then the archive (1,0) — the roll boundary is invisible.
      expect(seqs).toEqual([3, 2, 1, 0]);
    });
  });

  test("limit is satisfied from the active file alone without touching archives", () => {
    const root = freshRoot();
    writeFileSync(archivePath(root, "events-2026-07-06.ndjson"), `${evLine(0)}\n`);
    writeFileSync(streamPath(root), `${evLine(2)}\n${evLine(3)}\n`);
    withCoordRoot(root, () => {
      expect(readEvents({ limit: 2 }).rows.map((r) => r.data?.seq)).toEqual([3, 2]);
    });
  });
});

describe("refreshIdentityIndex survives rotation", () => {
  test("folds a pre-existing archive so a rolled-out agent still resolves", () => {
    const root = freshRoot();
    writeFileSync(
      archivePath(root, "events-2026-07-05.ndjson"),
      `${startLine("session.start", "old", "Older")}\n`,
    );
    writeFileSync(streamPath(root), `${startLine("session.start", "new", "Newer")}\n`);

    const idx = refreshIdentityIndex(root, null);
    expect(idx.identities.old?.name).toBe("Older");
    expect(idx.identities.new?.name).toBe("Newer");
    expect(idx.foldedArchives).toContain("events-2026-07-05.ndjson");
  });

  test("a live roll (active shrinks) keeps prior identities via the archive fold", () => {
    const root = freshRoot();
    writeFileSync(streamPath(root), `${startLine("session.start", "a", "Alice")}\n`);
    let idx = refreshIdentityIndex(root, null);
    expect(idx.identities.a?.name).toBe("Alice");

    // Simulate rotation: the active file becomes a dated archive; a fresh, empty
    // active file takes its place, then a new agent appends to it.
    renameSync(streamPath(root), archivePath(root, "events-2026-07-07.ndjson"));
    writeFileSync(streamPath(root), "");
    appendFileSync(streamPath(root), `${startLine("session.start", "b", "Bob")}\n`);

    idx = refreshIdentityIndex(root, idx);
    expect(idx.identities.a?.name).toBe("Alice"); // survived the roll
    expect(idx.identities.b?.name).toBe("Bob");
    expect(idx.foldedArchives).toContain("events-2026-07-07.ndjson");
  });

  test("each archive is folded exactly once across repeated refreshes", () => {
    const root = freshRoot();
    writeFileSync(
      archivePath(root, "events-2026-07-05.ndjson"),
      `${startLine("session.start", "old", "Older")}\n`,
    );
    writeFileSync(streamPath(root), `${startLine("session.start", "new", "Newer")}\n`);

    const first = refreshIdentityIndex(root, null);
    const second = refreshIdentityIndex(root, first);
    // Steady state: same folded set, no re-fold work.
    expect(second.foldedArchives).toEqual(first.foldedArchives);
    expect(second.offset).toBe(first.offset);
  });
});
