import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  descriptorPathsAvailable,
  git,
  gitFixture,
  quiet,
  writeScript,
} from "../../../../tests/workspace-test-helpers.ts";
import { runWorkflow } from "../engine.ts";
import { acquireNoClobberLease } from "./leases.ts";
import { createLocalGitWorktreeProvider } from "./local-git.ts";
import { claimOverlapsWorkspace, reserveWorkspaceReclaim } from "./ownership.ts";
import {
  readCleanupAttempts,
  readWorkspaceClaim,
  stableDigest,
  workspaceClaimPath,
  writeWorkspaceClaim,
} from "./state.ts";

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

function reservationPath(ctx: Awaited<ReturnType<typeof allocated>>) {
  return join(
    ctx.coord,
    ".harnery",
    "workspaces",
    ctx.claim.provider_id,
    ".leases",
    `reclaim-${ctx.claim.binding_id}.lock`,
  );
}

describe.skipIf(!descriptorPathsAvailable)("workspace reclaim reservations", () => {
  test("independent real allocation progresses while a reclaim reservation is held", async () => {
    const outer = await allocated();
    const held = reserveWorkspaceReclaim(outer.coord, outer.claim);
    try {
      const independent = await allocated(outer.coord);
      expect(existsSync(independent.binding.workspace_root)).toBe(true);
      expect(claimOverlapsWorkspace(independent.claim, outer.binding.workspace_root)).toBe(false);
      held.assertCurrent();
    } finally {
      held.release();
    }
    expect(
      (await outer.provider.reclaim(outer.binding, { mode: "discard", yes: true })).action,
    ).toBe("reclaimed");
  });

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

  test("supported publication refuses overlapping authority without writing a claim", async () => {
    const outer = await allocated();
    // Use a real provider-generated claim; point the physical workspace alias at
    // the protected tree without changing any authority bytes in that claim.
    const peer = await allocated(outer.coord);
    const path = workspaceClaimPath(outer.coord, peer.claim.provider_id, peer.claim.binding_id);
    renameSync(path, join(peer.host, "withheld-claim.json"));
    renameSync(peer.binding.workspace_root, `${peer.binding.workspace_root}-retained`);
    symlinkSync(outer.binding.workspace_root, peer.binding.workspace_root, "dir");
    const held = reserveWorkspaceReclaim(outer.coord, outer.claim);
    try {
      expect(() => writeWorkspaceClaim(outer.coord, peer.claim)).toThrow("lease workspace-reclaim");
      expect(existsSync(path)).toBe(false);
      held.assertCurrent();
    } finally {
      held.release();
    }
    expect(writeWorkspaceClaim(outer.coord, peer.claim)).toBe(true);
    expect(readWorkspaceClaim(outer.coord, peer.claim.provider_id, peer.claim.binding_id)).toEqual(
      peer.claim,
    );
    const dirty = join(outer.binding.workspace_root, "README.md");
    writeFileSync(dirty, "retained overlapping peer work\n");
    const transcript = join(
      outer.coord,
      ".harnery",
      "workflows",
      outer.binding.run_id,
      "transcript.jsonl",
    );
    writeFileSync(transcript, "corrupt retained transcript\n");
    await expect(
      outer.provider.reclaim(outer.binding, { mode: "discard", yes: true, force: true }),
    ).rejects.toMatchObject({ code: "workflow_reclaim_ownership_unproven" });
    expect(readFileSync(dirty, "utf8")).toBe("retained overlapping peer work\n");
    expect(
      readWorkspaceClaim(outer.coord, outer.claim.provider_id, outer.claim.binding_id),
    ).toEqual(outer.claim);
    expect(readWorkspaceClaim(outer.coord, peer.claim.provider_id, peer.claim.binding_id)).toEqual(
      peer.claim,
    );
  });

  test("expired dead reservation recovery leaves claim and worktree intact and fences old release", async () => {
    const outer = await allocated();
    const path = reservationPath(outer);
    const old = acquireNoClobberLease({
      path,
      scope: "workspace-reclaim",
      authoritySha256: stableDigest(outer.claim),
      metadata: { binding_id: outer.claim.binding_id, request_sha256: outer.claim.request_sha256 },
      staleAfterMs: 5 * 60 * 1_000,
      now: () => 1_000,
      pid: 2_000_000_000,
    });
    const current = reserveWorkspaceReclaim(outer.coord, outer.claim);
    try {
      current.assertCurrent();
      expect(() => old.release()).toThrow();
      current.assertCurrent();
      expect(existsSync(outer.binding.workspace_root)).toBe(true);
      expect(
        readWorkspaceClaim(outer.coord, outer.claim.provider_id, outer.claim.binding_id),
      ).toEqual(outer.claim);
    } finally {
      current.release();
    }
    const retry = reserveWorkspaceReclaim(outer.coord, outer.claim);
    retry.assertCurrent();
    retry.release();
  });

  test("stale reservation with mismatched authority cannot be recovered", async () => {
    const outer = await allocated();
    const old = acquireNoClobberLease({
      path: reservationPath(outer),
      scope: "workspace-reclaim",
      authoritySha256: "f".repeat(64),
      metadata: { binding_id: outer.claim.binding_id, request_sha256: outer.claim.request_sha256 },
      staleAfterMs: 5 * 60 * 1_000,
      now: () => 1_000,
      pid: 2_000_000_000,
    });
    expect(() => reserveWorkspaceReclaim(outer.coord, outer.claim)).toThrow("mismatched authority");
    expect(existsSync(outer.binding.workspace_root)).toBe(true);
    old.release();
    const retry = reserveWorkspaceReclaim(outer.coord, outer.claim);
    retry.release();
  });

  test("foreign-host reservation stays blocking even after its deadline", async () => {
    const outer = await allocated();
    const old = acquireNoClobberLease({
      path: reservationPath(outer),
      scope: "workspace-reclaim",
      authoritySha256: stableDigest(outer.claim),
      metadata: { binding_id: outer.claim.binding_id, request_sha256: outer.claim.request_sha256 },
      staleAfterMs: 5 * 60 * 1_000,
      now: () => 1_000,
      pid: 2_000_000_000,
      host: "unobservable-host",
    });
    try {
      expect(() => reserveWorkspaceReclaim(outer.coord, outer.claim)).toThrow(
        "liveness is unknown",
      );
      expect(existsSync(outer.binding.workspace_root)).toBe(true);
    } finally {
      old.release();
    }
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

  test("reservation identity drift refuses without discarding dirty files", async () => {
    const outer = await allocated();
    const held = reserveWorkspaceReclaim(outer.coord, outer.claim);
    const current = join(reservationPath(outer), "current");
    const original = readFileSync(current, "utf8");
    const dirty = join(outer.binding.workspace_root, "README.md");
    writeFileSync(dirty, "preserve\n");
    try {
      writeFileSync(current, original.replace('"workspace-reclaim"', '"different-scope"'));
      expect(() => held.assertCurrent()).toThrow("owner changed");
      expect(readFileSync(dirty, "utf8")).toBe("preserve\n");
    } finally {
      writeFileSync(current, original);
      held.release();
    }
  });

  test("malformed reservation cannot be treated as an unrelated publication", async () => {
    const outer = await allocated();
    const independent = await allocated(outer.coord);
    const held = reserveWorkspaceReclaim(outer.coord, outer.claim);
    const current = join(reservationPath(outer), "current");
    const bytes = readFileSync(current, "utf8");
    try {
      writeFileSync(current, "{invalid-owner\n");
      expect(() => writeWorkspaceClaim(outer.coord, independent.claim)).toThrow(
        "cannot parse reclaim reservation",
      );
      expect(
        readWorkspaceClaim(
          outer.coord,
          independent.claim.provider_id,
          independent.claim.binding_id,
        ),
      ).toEqual(independent.claim);
    } finally {
      writeFileSync(current, bytes);
      held.release();
    }
    expect(writeWorkspaceClaim(outer.coord, independent.claim)).toBe(false);
  });

  test("publication recovers only the exact dead reservation and preserves its resources", async () => {
    const outer = await allocated();
    const peer = await allocated(outer.coord);
    const claimPath = workspaceClaimPath(
      outer.coord,
      peer.claim.provider_id,
      peer.claim.binding_id,
    );
    renameSync(claimPath, join(peer.host, "retained-claim.json"));
    renameSync(peer.binding.workspace_root, `${peer.binding.workspace_root}-retained`);
    symlinkSync(outer.binding.workspace_root, peer.binding.workspace_root, "dir");
    const old = acquireNoClobberLease({
      path: reservationPath(outer),
      scope: "workspace-reclaim",
      authoritySha256: stableDigest(outer.claim),
      metadata: { binding_id: outer.claim.binding_id, request_sha256: outer.claim.request_sha256 },
      staleAfterMs: 5 * 60 * 1_000,
      now: () => 1_000,
      pid: 2_000_000_000,
    });
    expect(writeWorkspaceClaim(outer.coord, peer.claim)).toBe(true);
    expect(() => old.release()).toThrow();
    expect(existsSync(outer.binding.workspace_root)).toBe(true);
    expect(
      readWorkspaceClaim(outer.coord, outer.claim.provider_id, outer.claim.binding_id),
    ).toEqual(outer.claim);
    expect(readWorkspaceClaim(outer.coord, peer.claim.provider_id, peer.claim.binding_id)).toEqual(
      peer.claim,
    );
  });
});
