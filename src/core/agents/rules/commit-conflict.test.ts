import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCommit } from "./commit-conflict.ts";

let root: string;
let activeDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `agent-coord-commit-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

function seedPeer(
  id: string,
  opts: { name?: string; session?: string; files?: string[]; fresh?: boolean },
): void {
  const now = new Date();
  const stale = new Date(now.getTime() - 30 * 60_000);
  const ts = ((opts.fresh ?? true) ? now : stale).toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(
    join(activeDir, `${id}.json`),
    JSON.stringify({
      schema_version: 1,
      instance_id: id,
      name: opts.name,
      session_id: opts.session ?? id,
      files_touched: opts.files ?? [],
      last_heartbeat: ts,
      started_at: ts,
    }),
    "utf8",
  );
}

describe("evaluateCommit", () => {
  test("empty staged paths → allow", () => {
    const v = evaluateCommit(root, { instance_id: "self", session_id: "self", staged_paths: [] });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("commit.pass");
  });

  test("no peers → allow", () => {
    seedPeer("self", { name: "Maya" });
    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["docs/x.md"],
    });
    expect(v.allow).toBe(true);
  });

  test("fresh peer holding staged path → block (peer holds OTHER files too, so self-attribution doesn't suppress)", () => {
    seedPeer("self", { name: "Maya" });
    // The peer must hold AT LEAST one file outside the staged set, otherwise
    // the self-attribution suppression (Fix #2) kicks in and treats this as
    // the current commit under a transient identity.
    seedPeer("peer", { name: "Adelaide", files: ["docs/shared.md", "docs/peer-only.md"] });
    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["docs/shared.md"],
    });
    expect(v.allow).toBe(false);
    expect(v.conflicts.length).toBe(1);
    expect(v.conflicts[0]!.short_name).toContain("Adelaide");
  });

  test("self-attribution suppression: peer holds only staged files → allow + suppressed", () => {
    seedPeer("self", { name: "Maya" });
    seedPeer("peer", { name: "Adelaide", files: ["docs/shared.md"] });
    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["docs/shared.md"],
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("commit.suppressed");
    expect(v.suppressed_self_attribution).toBe(true);
  });

  test("stale peer → no block", () => {
    seedPeer("self", { name: "Maya" });
    seedPeer("peer", { name: "Adelaide", files: ["docs/shared.md"], fresh: false });
    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["docs/shared.md"],
    });
    expect(v.allow).toBe(true);
  });

  test("same group (same session_id) → no block", () => {
    seedPeer("self", { name: "Maya", session: "group-a" });
    seedPeer("peer", { name: "Maya-sub", session: "group-a", files: ["docs/shared.md"] });
    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "group-a",
      staged_paths: ["docs/shared.md"],
    });
    expect(v.allow).toBe(true);
  });

  test("bypass=true converts block to warning + allow", () => {
    seedPeer("self", { name: "Maya" });
    // Two files so self-attribution doesn't fire; we want a real conflict
    // that bypass then converts to a warning.
    seedPeer("peer", { name: "Adelaide", files: ["docs/shared.md", "docs/peer-only.md"] });
    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["docs/shared.md"],
      bypass: true,
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("commit.bypass");
    expect(v.conflicts.length).toBe(1);
  });

  test("gitlink discrimination: staging bare submodule path doesn't conflict with inner-file claim", () => {
    seedPeer("self", { name: "Maya" });
    seedPeer("peer", { name: "Adelaide", files: ["submodule-a/src/foo.ts"] });
    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["submodule-a"],
      staged_gitlinks: ["submodule-a"],
    });
    // Gitlink staging is a pointer bump, not a claim on contents → allow.
    expect(v.allow).toBe(true);
  });

  test("prefix overlap: staged dir vs peer's inner file → block", () => {
    seedPeer("self", { name: "Maya" });
    // Two files so self-attribution doesn't fire. Note: docs/security must NOT
    // be a prefix of docs/security/peer-only.md if we want the second file to
    // count as outside-the-staged-set, but the suppression check considers
    // prefix equivalence too. Use a clearly unrelated path.
    seedPeer("peer", {
      name: "Adelaide",
      files: ["docs/security/auth.md", "completely-unrelated.txt"],
    });
    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      // Staged dir 'docs/security' is a prefix of peer's inner file
      staged_paths: ["docs/security"],
    });
    expect(v.allow).toBe(false);
  });
});
