import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  descriptorPathsAvailable,
  gitFixture,
  quiet,
  writeScript,
} from "../../../../tests/workspace-test-helpers.ts";
import { runWorkflow } from "../engine.ts";
import { acquireWorkflowResumeLease } from "../run-state.ts";
import { acquireNoClobberLease } from "./leases.ts";
import { createLocalGitWorktreeProvider } from "./local-git.ts";
import { prepareReclaim, salvageBranch } from "./reclaim.ts";
import { stableDigest, workspaceLockPath } from "./state.ts";

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

async function withProviderWorkspace(
  fn: (ctx: {
    repo: string;
    provider: ReturnType<typeof createLocalGitWorktreeProvider>;
    binding: NonNullable<Awaited<ReturnType<typeof runWorkflow>>["workspaceBinding"]>;
    proofPath: string;
    transcriptPath: string;
    dirtyPath: string;
  }) => Promise<void>,
): Promise<void> {
  const { host, repo } = gitFixture("provider-reclaim");
  try {
    const script = writeScript(repo, "export default async () => 'done';\n");
    run(repo, ["add", "scripts"]);
    run(repo, ["commit", "-qm", "workflow"]);
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    const report = await runWorkflow(script, {
      coordRoot: repo,
      cwd: repo,
      spawners: {},
      isolation: "worktree",
      workspace: { provider, writableRoots: [host] },
      ...quiet,
    });
    const binding = report.workspaceBinding!;
    const dirtyPath = join(binding.workspace_root, "README.md");
    writeFileSync(dirtyPath, "valuable uncommitted work\n");
    await fn({
      repo,
      provider,
      binding,
      proofPath: report.proofPath,
      transcriptPath: report.transcriptPath,
      dirtyPath,
    });
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}

describe.skipIf(!descriptorPathsAvailable)("provider reclaim gate", () => {
  test("preview reports liveness and dirty paths without changing the workspace", async () => {
    await withProviderWorkspace(async ({ provider, binding, dirtyPath }) => {
      const before = run(binding.workspace_root, ["status", "--porcelain"]);
      const preview = await provider.reclaim(binding, { mode: "discard" });
      expect(preview).toMatchObject({
        action: "preview",
        run_id: binding.run_id,
        mode: "discard",
        liveness: "inactive",
        ownership: "ok",
        lease_holder: [],
      });
      expect(preview.dirty_paths).toContain(" M README.md");
      expect(readFileSync(dirtyPath, "utf8")).toBe("valuable uncommitted work\n");
      expect(run(binding.workspace_root, ["status", "--porcelain"])).toBe(before);
    });
  });

  for (const mode of ["discard", "salvage"] as const) {
    test(`${mode} refuses an active run before reading terminal proof or changing files`, async () => {
      await withProviderWorkspace(
        async ({ provider, binding, proofPath, transcriptPath, dirtyPath }) => {
          rmSync(proofPath);
          writeFileSync(
            transcriptPath,
            `${JSON.stringify({ event: "run.start", run_id: binding.run_id })}\n`,
          );
          const head = run(binding.workspace_root, ["rev-parse", "HEAD"]);
          const status = run(binding.workspace_root, ["status", "--porcelain"]);
          await expect(provider.reclaim(binding, { mode, yes: true })).rejects.toMatchObject({
            code: "workflow_reclaim_run_live",
          });
          expect(readFileSync(dirtyPath, "utf8")).toBe("valuable uncommitted work\n");
          expect(run(binding.workspace_root, ["rev-parse", "HEAD"])).toBe(head);
          expect(run(binding.workspace_root, ["status", "--porcelain"])).toBe(status);
        },
      );
    });
  }

  test("a terminal proof cannot hide a later active transcript", async () => {
    await withProviderWorkspace(async ({ provider, binding, transcriptPath, dirtyPath }) => {
      writeFileSync(
        transcriptPath,
        `${readFileSync(transcriptPath, "utf8")}${JSON.stringify({ event: "run.resume", run_id: binding.run_id })}\n`,
      );
      await expect(provider.reclaim(binding, { mode: "discard", yes: true })).rejects.toMatchObject(
        { code: "workflow_reclaim_run_live" },
      );
      expect(readFileSync(dirtyPath, "utf8")).toBe("valuable uncommitted work\n");
    });
  });

  for (const transcript of ["missing", "corrupt"] as const) {
    test(`${transcript} transcript refuses unknown liveness despite a terminal proof`, async () => {
      await withProviderWorkspace(async ({ provider, binding, transcriptPath, dirtyPath }) => {
        if (transcript === "missing") rmSync(transcriptPath);
        else writeFileSync(transcriptPath, "not json\n");
        await expect(
          provider.reclaim(binding, { mode: "discard", yes: true }),
        ).rejects.toMatchObject({ code: "workflow_reclaim_liveness_unknown" });
        expect(readFileSync(dirtyPath, "utf8")).toBe("valuable uncommitted work\n");
      });
    });
  }

  test("unproven ownership leaves files untouched and preview paths unknown", async () => {
    await withProviderWorkspace(async ({ provider, binding, dirtyPath }) => {
      const foreign = { ...binding, recovery_token: "0".repeat(64) };
      const preview = await provider.reclaim(foreign, { mode: "discard" });
      expect(preview.ownership).toBe("unproven");
      expect(preview.dirty_paths).toBeNull();
      await expect(provider.reclaim(foreign, { mode: "discard", yes: true })).rejects.toMatchObject(
        { code: "workflow_reclaim_ownership_unproven" },
      );
      expect(readFileSync(dirtyPath, "utf8")).toBe("valuable uncommitted work\n");
    });
  });

  for (const scope of ["binding", "repository"] as const) {
    test(`${scope} lease held by another owner leaves files untouched`, async () => {
      await withProviderWorkspace(async ({ repo, provider, binding, dirtyPath }) => {
        const key = stableDigest({ common: binding.repository!.common_dir.identity });
        const path =
          scope === "binding"
            ? workspaceLockPath(repo, binding.provider.id, binding.binding_id)
            : join(
                repo,
                ".harnery",
                "workspaces",
                binding.provider.id,
                ".leases",
                `repository-${key}.lock`,
              );
        const lease = acquireNoClobberLease({
          path,
          scope,
          authoritySha256: stableDigest({
            binding_id: binding.binding_id,
            request_sha256: binding.request_sha256,
            scope,
          }),
          staleAfterMs: 300_000,
        });
        try {
          const preview = await provider.reclaim(binding, { mode: "discard" });
          expect(preview.lease_holder).toContainEqual(
            expect.objectContaining({ scope, owner_id: lease.owner.owner_id }),
          );
          await expect(
            provider.reclaim(binding, { mode: "discard", yes: true }),
          ).rejects.toMatchObject({ code: "workflow_reclaim_lease_held" });
          expect(readFileSync(dirtyPath, "utf8")).toBe("valuable uncommitted work\n");
        } finally {
          lease.release();
        }
      });
    });
  }

  test("the workflow resume lease excludes reclaim before resume writes its active marker", async () => {
    await withProviderWorkspace(async ({ repo, provider, binding, dirtyPath }) => {
      const release = acquireWorkflowResumeLease(repo, binding.run_id);
      try {
        const preview = await provider.reclaim(binding, { mode: "discard" });
        expect(preview.lease_holder).toContainEqual(
          expect.objectContaining({ scope: "resume", pid: process.pid }),
        );
        await expect(
          provider.reclaim(binding, { mode: "discard", yes: true }),
        ).rejects.toMatchObject({ code: "workflow_reclaim_lease_held" });
        expect(readFileSync(dirtyPath, "utf8")).toBe("valuable uncommitted work\n");
      } finally {
        release();
      }
    });
  });

  test("a corrupt resume lease is preserved and cannot authorize discard", async () => {
    await withProviderWorkspace(async ({ repo, provider, binding, dirtyPath }) => {
      const leasePath = join(repo, ".harnery", "workflows", binding.run_id, "resume.lock");
      writeFileSync(leasePath, "unreadable owner\n");
      await expect(provider.reclaim(binding, { mode: "discard", yes: true })).rejects.toMatchObject(
        { code: "workflow_reclaim_lease_held" },
      );
      expect(readFileSync(leasePath, "utf8")).toBe("unreadable owner\n");
      expect(readFileSync(dirtyPath, "utf8")).toBe("valuable uncommitted work\n");
    });
  });

  test("an inactive owned workspace is discarded and released with a cleanup receipt", async () => {
    await withProviderWorkspace(async ({ provider, binding }) => {
      const result = await provider.reclaim(binding, { mode: "discard", yes: true });
      expect(result.action).toBe("reclaimed");
      if (result.action !== "reclaimed") throw new Error("expected confirmed reclaim");
      expect(result.preparation.action).toBe("discarded");
      expect(result.cleanup.status).toBe("released");
      expect("receipt_id" in result.cleanup).toBe(true);
      expect(existsSync(binding.workspace_root)).toBe(false);
    });
  });

  test("salvage keeps the commit on its own ref after releasing the owned workspace", async () => {
    await withProviderWorkspace(async ({ repo, provider, binding }) => {
      const result = await provider.reclaim(binding, { mode: "salvage", yes: true });
      if (result.action !== "reclaimed") throw new Error("expected confirmed reclaim");
      expect(result.preparation.action).toBe("salvaged");
      expect(result.cleanup.status).toBe("released");
      expect(existsSync(binding.workspace_root)).toBe(false);
      expect(run(repo, ["show", `${salvageBranch(binding.run_id)}:README.md`])).toBe(
        "valuable uncommitted work\n",
      );
    });
  });
});
