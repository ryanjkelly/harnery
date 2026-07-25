import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareReclaim, salvageBranch } from "./reclaim.ts";

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A source repo plus a linked worktree on its own branch: the exact topology a
 * preserved workspace has. */
async function withWorktree(
  fn: (ctx: { worktree: string; source: string; branch: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harnery-reclaim-test-"));
  const source = join(root, "src");
  const worktree = join(root, "wt");
  const branch = "harnery/workspace/ws-test";
  try {
    run(root, ["init", "-q", source]);
    run(source, ["config", "user.email", "t@example.com"]);
    run(source, ["config", "user.name", "t"]);
    writeFileSync(join(source, "tracked.txt"), "base\n");
    run(source, ["add", "-A"]);
    run(source, ["commit", "-qm", "init"]);
    run(source, ["worktree", "add", "-q", worktree, "-b", branch]);
    await fn({ worktree, source, branch });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const input = (worktree: string, _branch: string, mode: "salvage" | "discard") => ({
  worktreePath: worktree,
  mode,
  runId: "wf-test-000000",
});

describe("prepareReclaim", () => {
  test("salvage commits the work so it outlives the worktree directory", async () => {
    await withWorktree(async ({ worktree, source, branch }) => {
      writeFileSync(join(worktree, "tracked.txt"), "agent edit\n");
      writeFileSync(join(worktree, "new.txt"), "untracked agent file\n");

      const workspaceTipBefore = run(worktree, ["rev-parse", branch]).trim();

      const result = prepareReclaim(input(worktree, branch, "salvage"));
      expect(result.action).toBe("salvaged");
      expect(run(worktree, ["status", "--porcelain"]).trim()).toBe("");

      // The workspace ref must NOT move: cleanup pins its OID in a frozen intent
      // and refuses when it changes, and cleanup deletes that branch anyway.
      expect(run(worktree, ["rev-parse", branch]).trim()).toBe(workspaceTipBefore);
      const salvaged = salvageBranch("wf-test-000000");
      expect(run(source, ["rev-parse", salvaged]).trim()).not.toBe(workspaceTipBefore);

      // The point of salvage: remove the worktree AND the workspace branch the
      // way cleanup does, and the work is still reachable.
      run(source, ["worktree", "remove", "--force", worktree]);
      run(source, ["branch", "-D", branch]);
      expect(existsSync(worktree)).toBe(false);
      const files = run(source, ["show", "--name-only", "--format=", salvaged]).trim().split("\n");
      expect(files.sort()).toEqual(["new.txt", "tracked.txt"]);
      expect(run(source, ["show", `${salvaged}:new.txt`])).toBe("untracked agent file\n");
    });
  });

  test("salvage picks up untracked files, not just modifications", async () => {
    await withWorktree(async ({ worktree, branch }) => {
      writeFileSync(join(worktree, "only-untracked.txt"), "x\n");
      const result = prepareReclaim(input(worktree, branch, "salvage"));
      expect(result.action).toBe("salvaged");
      expect(run(worktree, ["status", "--porcelain"]).trim()).toBe("");
    });
  });

  test("salvage survives a repository hook that would reject the commit", async () => {
    // An abandoned workspace must be archivable even in a repo whose hooks
    // refuse work in progress; otherwise preservation becomes impossible.
    await withWorktree(async ({ worktree, source, branch }) => {
      const hooks = run(source, ["rev-parse", "--git-common-dir"]).trim();
      const hookPath = join(hooks.startsWith("/") ? hooks : join(source, hooks), "hooks");
      writeFileSync(join(hookPath, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      writeFileSync(join(worktree, "tracked.txt"), "agent edit\n");
      expect(prepareReclaim(input(worktree, branch, "salvage")).action).toBe("salvaged");
    });
  });

  test("discard restores the tree and removes untracked files", async () => {
    await withWorktree(async ({ worktree, branch }) => {
      writeFileSync(join(worktree, "tracked.txt"), "agent edit\n");
      writeFileSync(join(worktree, "new.txt"), "junk\n");

      const result = prepareReclaim(input(worktree, branch, "discard"));
      expect(result.action).toBe("discarded");
      expect(run(worktree, ["status", "--porcelain"]).trim()).toBe("");
      expect(existsSync(join(worktree, "new.txt"))).toBe(false);
    });
  });

  test("discard clears a staged deletion, which clean alone would miss", async () => {
    await withWorktree(async ({ worktree, branch }) => {
      run(worktree, ["rm", "-q", "tracked.txt"]);
      expect(prepareReclaim(input(worktree, branch, "discard")).action).toBe("discarded");
      expect(existsSync(join(worktree, "tracked.txt"))).toBe(true);
    });
  });

  test("a clean worktree needs no preparation and creates no empty commit", async () => {
    await withWorktree(async ({ worktree, branch }) => {
      const before = run(worktree, ["rev-parse", "HEAD"]).trim();
      expect(prepareReclaim(input(worktree, branch, "salvage")).action).toBe("already_clean");
      expect(run(worktree, ["rev-parse", "HEAD"]).trim()).toBe(before);
    });
  });

  test("a missing worktree reports already_gone rather than throwing", async () => {
    // The idempotence rule: a workspace nothing can advance must not keep
    // incrementing an attempt counter forever.
    const result = prepareReclaim(input("/nonexistent/harnery/ws", "b", "salvage"));
    expect(result.action).toBe("already_gone");
  });
});
