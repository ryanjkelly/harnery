import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCommit } from "./commit-conflict.ts";

/** Init a throwaway repo with identity + hooks off, and return its path. */
function gitInit(dir: string): string {
  spawnSync("git", ["init", "--quiet"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  spawnSync("git", ["config", "core.hooksPath", "/dev/null"], { cwd: dir });
  return dir;
}

function gitCommitAll(dir: string, message: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "--quiet", "--no-verify", "-m", message], { cwd: dir });
}

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

  test("self-attribution: a held-but-unstaged path inside a submodule counts as clean", () => {
    // The shape that defeated Fix #2 in practice. A session commits inside a
    // submodule while its own heartbeat also still holds a path in that
    // submodule that it edited and reverted. That path is committed and clean,
    // so Gate A should accept it, but the check used to ask the SUPERPROJECT
    // whether it was tracked. Superprojects do not track submodule contents, so
    // the answer was always "no", Gate A always failed, and every submodule
    // commit demanded HARNERY_AGENT_COORD_BYPASS=1.
    const outer = gitInit(root);
    writeFileSync(join(root, "outer.md"), "outer\n", "utf8");
    gitCommitAll(outer, "outer");

    const subDir = join(root, "sub");
    mkdirSync(subDir, { recursive: true });
    gitInit(subDir);
    writeFileSync(join(subDir, "inner.md"), "inner\n", "utf8");
    gitCommitAll(subDir, "inner");

    seedPeer("self", { name: "Maya" });
    seedPeer("peer", { name: "Maya-transient", files: ["outer.md", "sub/inner.md"] });

    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["outer.md"],
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("commit.suppressed");
  });

  test("self-attribution still refuses a submodule path with uncommitted changes", () => {
    // The guard rail on the fix above: clean-in-its-own-HEAD is the thing that
    // makes a held path safe to ignore. A dirty one is real work someone could
    // lose, so it must keep blocking.
    const outer = gitInit(root);
    writeFileSync(join(root, "outer.md"), "outer\n", "utf8");
    gitCommitAll(outer, "outer");

    const subDir = join(root, "sub");
    mkdirSync(subDir, { recursive: true });
    gitInit(subDir);
    writeFileSync(join(subDir, "inner.md"), "inner\n", "utf8");
    gitCommitAll(subDir, "inner");
    writeFileSync(join(subDir, "inner.md"), "inner edited\n", "utf8");

    seedPeer("self", { name: "Maya" });
    seedPeer("peer", { name: "Adelaide", files: ["outer.md", "sub/inner.md"] });

    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["outer.md"],
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("commit.conflict");
  });

  test("self-attribution: a held git-ignored journal path does not defeat suppression", () => {
    // Agents write journal files into an ignored directory constantly, and every
    // one of those became a permanent claim git could not vouch for: not staged,
    // not tracked, so Gate A failed for the rest of the session and every commit
    // wanted a bypass. An ignored path cannot appear in anybody's commit, so it
    // cannot be work this commit might clobber.
    const outer = gitInit(root);
    writeFileSync(join(root, ".gitignore"), "journal/\n", "utf8");
    writeFileSync(join(root, "outer.md"), "outer\n", "utf8");
    gitCommitAll(outer, "outer");

    mkdirSync(join(root, "journal"), { recursive: true });
    writeFileSync(join(root, "journal", "notes.txt"), "journal\n", "utf8");

    seedPeer("self", { name: "Maya" });
    seedPeer("peer", { name: "Maya-transient", files: ["outer.md", "journal/notes.txt"] });

    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["outer.md"],
    });
    expect(v.allow).toBe(true);
    expect(v.rule).toBe("commit.suppressed");
  });

  test("self-attribution still refuses an untracked path git does not ignore", () => {
    // The line between the two: an ignored file can never be committed, but a
    // plain untracked one can be added by anyone, so it stays a real unknown.
    const outer = gitInit(root);
    writeFileSync(join(root, "outer.md"), "outer\n", "utf8");
    gitCommitAll(outer, "outer");
    writeFileSync(join(root, "newfile.md"), "new\n", "utf8");

    seedPeer("self", { name: "Maya" });
    seedPeer("peer", { name: "Adelaide", files: ["outer.md", "newfile.md"] });

    const v = evaluateCommit(root, {
      instance_id: "self",
      session_id: "self",
      staged_paths: ["outer.md"],
    });
    expect(v.allow).toBe(false);
    expect(v.rule).toBe("commit.conflict");
  });

  test("self-attribution survives the GIT_DIR a git hook exports", () => {
    // The reason the two fixes above were not enough on their own. A hook runs
    // with GIT_DIR already pointing at the repository being committed, children
    // inherit it, and it outranks cwd. Every probe therefore questioned the
    // hook's repository instead of the one owning the path, and the gates read
    // "unverifiable". This test pins the scrubbing by polluting the environment
    // the way git does.
    const outer = gitInit(root);
    writeFileSync(join(root, ".gitignore"), "journal/\n", "utf8");
    writeFileSync(join(root, "outer.md"), "outer\n", "utf8");
    writeFileSync(join(root, "held.md"), "held\n", "utf8");
    gitCommitAll(outer, "outer");
    mkdirSync(join(root, "journal"), { recursive: true });
    writeFileSync(join(root, "journal", "notes.txt"), "journal\n", "utf8");

    const otherRepo = join(root, "elsewhere");
    mkdirSync(otherRepo, { recursive: true });
    gitInit(otherRepo);
    writeFileSync(join(otherRepo, "unrelated.md"), "x\n", "utf8");
    gitCommitAll(otherRepo, "unrelated");

    seedPeer("self", { name: "Maya" });
    seedPeer("peer", {
      name: "Maya-transient",
      files: ["outer.md", "held.md", "journal/notes.txt"],
    });

    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(otherRepo, ".git");
    process.env.GIT_WORK_TREE = otherRepo;
    try {
      const v = evaluateCommit(root, {
        instance_id: "self",
        session_id: "self",
        staged_paths: ["outer.md"],
      });
      expect(v.allow).toBe(true);
      expect(v.rule).toBe("commit.suppressed");
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.tree;
    }
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
