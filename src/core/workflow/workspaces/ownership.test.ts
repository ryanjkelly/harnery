import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  descriptorPathsAvailable,
  git,
  gitFixture,
  quiet,
  writeScript,
} from "../../../../tests/workspace-test-helpers.ts";
import { runWorkflow } from "../engine.ts";
import { createLocalGitWorktreeProvider } from "./local-git.ts";
import { claimOverlapsWorkspace } from "./ownership.ts";
import { readCleanupAttempts, readWorkspaceClaim, workspaceClaimPath } from "./state.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function allocated(coordRoot?: string) {
  const { host, repo } = gitFixture("workspace-reservation");
  roots.push(host);
  const script = writeScript(repo, "export default async () => 'done';\n");
  git(repo, "add", "scripts");
  git(repo, "commit", "-qm", "workflow");
  const coord = coordRoot ?? repo;
  const provider = createLocalGitWorktreeProvider({ coordRoot: coord });
  const report = await runWorkflow(script, {
    coordRoot: coord,
    cwd: repo,
    spawners: {},
    isolation: "worktree",
    workspace: { provider, writableRoots: [host] },
    ...quiet,
  });
  const binding = report.workspaceBinding!;
  const claim = readWorkspaceClaim(coord, binding.provider.id, binding.binding_id)!;
  return { host, repo, coord, provider, report, binding, claim };
}

describe.skipIf(!descriptorPathsAvailable)("workspace reclaim peer authority", () => {
  test("sibling workspaces can share a source ancestor without claiming each other's checkout", async () => {
    const outer = await allocated();
    const script = writeScript(outer.repo, "export default async () => 'second';\n");
    git(outer.repo, "add", "scripts");
    git(outer.repo, "commit", "-qm", "second workflow");
    const first = await runWorkflow(script, {
      coordRoot: outer.coord,
      cwd: outer.repo,
      spawners: {},
      isolation: "worktree",
      workspace: { provider: outer.provider, writableRoots: [outer.repo] },
      ...quiet,
    });
    const second = await runWorkflow(script, {
      coordRoot: outer.coord,
      cwd: outer.repo,
      spawners: {},
      isolation: "worktree",
      workspace: { provider: outer.provider, writableRoots: [outer.repo] },
      ...quiet,
    });
    const a = first.workspaceBinding!;
    const b = second.workspaceBinding!;
    const peer = readWorkspaceClaim(outer.coord, b.provider.id, b.binding_id)!;
    expect(claimOverlapsWorkspace(peer, a.workspace_root)).toBe(false);
    const result = await outer.provider.reclaim(a, { mode: "discard", yes: true });
    expect(result.action).toBe("reclaimed");
    expect(existsSync(b.workspace_root)).toBe(true);
  });

  test("malformed peer inventory refuses before effects and corrected retry remains usable", async () => {
    const outer = await allocated();
    const dirty = join(outer.binding.workspace_root, "README.md");
    writeFileSync(dirty, "retained dirty work\n");
    const bad = workspaceClaimPath(outer.coord, outer.claim.provider_id, "ws-malformed");
    mkdirSync(dirname(bad));
    writeFileSync(bad, "{not-json\n");
    await expect(
      outer.provider.reclaim(outer.binding, { mode: "discard", yes: true }),
    ).rejects.toMatchObject({ code: "workflow_reclaim_ownership_unproven" });
    expect(readFileSync(dirty, "utf8")).toBe("retained dirty work\n");
    const transcript = join(
      outer.coord,
      ".harnery",
      "workflows",
      outer.binding.run_id,
      "transcript.jsonl",
    );
    const original = readFileSync(transcript, "utf8");
    writeFileSync(transcript, "corrupt retained transcript\n");
    await expect(
      outer.provider.reclaim(outer.binding, { mode: "discard", yes: true, force: true }),
    ).rejects.toMatchObject({ code: "workflow_reclaim_ownership_unproven" });
    expect(readFileSync(dirty, "utf8")).toBe("retained dirty work\n");
    writeFileSync(transcript, original);
    rmSync(dirname(bad), { recursive: true });
    const result = await outer.provider.reclaim(outer.binding, { mode: "discard", yes: true });
    expect(result.action).toBe("reclaimed");
    const attempts = readCleanupAttempts(outer.coord, outer.binding.run_id);
    const again = await outer.provider.reclaim(outer.binding, { mode: "discard", yes: true });
    expect(again.action).toBe("reclaimed");
    if (again.action === "reclaimed" && result.action === "reclaimed") {
      expect(again.cleanup).toEqual(result.cleanup);
    }
    expect(readCleanupAttempts(outer.coord, outer.binding.run_id)).toEqual(attempts);
  });
});
