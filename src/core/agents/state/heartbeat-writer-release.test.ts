/**
 * Locks releaseClaim's path-form robustness: files_touched can hold either
 * absolute-under-coordRoot or canonical monorepo-relative entries, and a
 * release by either form must match (the old exact-string filter silently
 * no-op'd on a form mismatch — the bug behind the "release-claim does nothing"
 * coord-layer friction).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupUnclaim, releaseClaim } from "./heartbeat-writer.ts";

let root: string;
let activeDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `agent-coord-release-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  activeDir = join(root, ".harnery", "active");
  mkdirSync(activeDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

function seedSelf(files: string[]): void {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(
    join(activeDir, "self.json"),
    JSON.stringify({
      schema_version: 1,
      instance_id: "self",
      session_id: "self",
      files_touched: files,
      last_heartbeat: ts,
      started_at: ts,
    }),
    "utf8",
  );
}
function selfFiles(): string[] {
  return JSON.parse(readFileSync(join(activeDir, "self.json"), "utf8")).files_touched;
}

describe("releaseClaim path-form robustness", () => {
  test("relative arg releases a relative entry", () => {
    seedSelf(["docs/a.md", "docs/b.md"]);
    releaseClaim(root, "self", "docs/a.md");
    expect(selfFiles()).toEqual(["docs/b.md"]);
  });

  test("relative arg releases an absolute-under-coordRoot entry", () => {
    seedSelf([join(root, "docs/a.md"), "docs/b.md"]);
    releaseClaim(root, "self", "docs/a.md");
    expect(selfFiles()).toEqual(["docs/b.md"]);
  });

  test("absolute arg releases a relative entry", () => {
    seedSelf(["docs/a.md", "docs/b.md"]);
    releaseClaim(root, "self", join(root, "docs/a.md"));
    expect(selfFiles()).toEqual(["docs/b.md"]);
  });

  test("no match → unchanged", () => {
    seedSelf(["docs/a.md"]);
    releaseClaim(root, "self", "docs/nope.md");
    expect(selfFiles()).toEqual(["docs/a.md"]);
  });
});

function seedPeer(id: string, sessionId: string, files: string[]): void {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(
    join(activeDir, `${id}.json`),
    JSON.stringify({
      schema_version: 1,
      instance_id: id,
      session_id: sessionId,
      files_touched: files,
      last_heartbeat: ts,
      started_at: ts,
    }),
    "utf8",
  );
}
function peerFiles(id: string): string[] {
  return JSON.parse(readFileSync(join(activeDir, `${id}.json`), "utf8")).files_touched;
}

describe("groupUnclaim path-form robustness (the post-commit release path)", () => {
  test("relative prune releases an absolute-under-coordRoot entry", () => {
    seedPeer("parent", "sess-1", [join(root, "docs/a.md"), "docs/b.md"]);
    const hits = groupUnclaim(root, "sess-1", "docs/a.md");
    expect(peerFiles("parent")).toEqual(["docs/b.md"]);
    expect(hits.map((h) => h.instance_id)).toEqual(["parent"]);
  });

  test("releases BOTH forms of the same file in one call (legacy dupes)", () => {
    seedPeer("parent", "sess-1", [join(root, "docs/a.md"), "docs/a.md", "docs/b.md"]);
    groupUnclaim(root, "sess-1", "docs/a.md");
    expect(peerFiles("parent")).toEqual(["docs/b.md"]);
  });

  test("walks the whole session group, skips other groups, reports hits", () => {
    seedPeer("parent", "sess-1", ["docs/a.md"]);
    seedPeer("sub", "sess-1", [join(root, "docs/a.md")]);
    seedPeer("stranger", "sess-2", ["docs/a.md"]);
    const hits = groupUnclaim(root, "sess-1", "docs/a.md");
    expect(peerFiles("parent")).toEqual([]);
    expect(peerFiles("sub")).toEqual([]);
    expect(peerFiles("stranger")).toEqual(["docs/a.md"]);
    expect(hits.map((h) => h.instance_id).sort()).toEqual(["parent", "sub"]);
  });

  test("no holder → no hits, heartbeats untouched", () => {
    seedPeer("parent", "sess-1", ["docs/b.md"]);
    const hits = groupUnclaim(root, "sess-1", "docs/a.md");
    expect(hits).toEqual([]);
    expect(peerFiles("parent")).toEqual(["docs/b.md"]);
  });
});
