import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  descriptorPathsAvailable,
  git,
  hasGit,
  quiet,
  tempRoot,
  writeScript,
} from "../../../../tests/workspace-test-helpers.ts";
import { runWorkflow } from "../engine.ts";
import { createLocalGitWorktreeProvider, probe } from "./local-git.ts";
import type { WorkspaceProbeInput, WorkspaceProbeResult } from "./types.ts";

// These fixtures build every Git checkout shape with real `git` commands and drive
// them through the provider's exported probe(). `git worktree add` — the provider's
// allocation primitive — supports all four, so the only question this suite answers is
// whether the provider's own inspection accepts each one, and refuses the shapes that
// genuinely cannot be served safely.

// Every probe here pins descriptor-path support ON: the verdict under test is about
// repository SHAPE, and the host's descriptor capability is a separate axis that would
// otherwise mask it. On a host lacking traversable descriptor paths (macOS) the
// unpinned probe fails the "supported" cases for an unrelated reason, and worse, passes
// the refusal cases for the wrong one.
function probeShape(input: WorkspaceProbeInput): Promise<WorkspaceProbeResult> {
  return probe(input, () => true);
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tracked(root: string): string {
  roots.push(root);
  return root;
}

function initRepo(dir: string, seed: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), seed);
  git(dir, "add", "README.md");
  git(dir, "commit", "-qm", "base");
}

// A superproject that embeds `subsrc` at `super/sub`, with the submodule checkout left
// on an attached branch (inspectSourceRepository refuses detached integration targets).
function submoduleFixture(label: string): {
  host: string;
  superRoot: string;
  subCheckout: string;
  subCommonDir: string;
} {
  const host = tracked(tempRoot(label));
  const subOrigin = join(host, "subsrc");
  initRepo(subOrigin, "sub\n");
  const superRoot = join(host, "super");
  initRepo(superRoot, "super\n");
  git(superRoot, "-c", "protocol.file.allow=always", "submodule", "add", subOrigin, "sub");
  git(superRoot, "commit", "-qm", "add submodule");
  const subCheckout = join(superRoot, "sub");
  git(subCheckout, "checkout", "-q", "-B", "work");
  return {
    host: resolve(host),
    superRoot: resolve(superRoot),
    subCheckout: resolve(subCheckout),
    subCommonDir: resolve(superRoot, ".git", "modules", "sub"),
  };
}

describe("local Git provider accepts every worktree and submodule checkout shape", () => {
  test("a plain checkout is supported", async () => {
    if (!hasGit()) return;
    const host = tracked(tempRoot("layout-plain"));
    const repo = join(host, "repo");
    initRepo(repo, "plain\n");
    expect(lstatSync(join(repo, ".git")).isDirectory()).toBe(true);
    const probed = await probeShape({ requested_cwd: repo, writable_roots: [host] });
    expect(probed.supported).toBe(true);
  });

  test("a submodule checkout is supported when the enclosing repo is writable", async () => {
    if (!hasGit()) return;
    const fixture = submoduleFixture("layout-submodule");
    // The submodule's Git authority lives in super/.git/modules/sub — a `.git` file,
    // not a directory — which the old directory check refused outright.
    expect(lstatSync(join(fixture.subCheckout, ".git")).isFile()).toBe(true);
    const probed = await probeShape({
      requested_cwd: fixture.subCheckout,
      writable_roots: [fixture.host],
    });
    expect(probed.supported).toBe(true);
  });

  test("a linked worktree is supported when the common dir is writable", async () => {
    if (!hasGit()) return;
    const host = tracked(tempRoot("layout-linked"));
    const superRoot = join(host, "super");
    initRepo(superRoot, "super\n");
    const linked = join(host, "linked");
    git(superRoot, "worktree", "add", "-q", "-b", "linked", linked);
    expect(lstatSync(join(linked, ".git")).isFile()).toBe(true);
    const probed = await probeShape({ requested_cwd: linked, writable_roots: [host] });
    expect(probed.supported).toBe(true);
  });

  test("a worktree of a submodule is supported when the common dir is writable", async () => {
    if (!hasGit()) return;
    const fixture = submoduleFixture("layout-submodule-worktree");
    const subWorktree = join(fixture.host, "sub-worktree");
    git(fixture.subCheckout, "worktree", "add", "-q", "-b", "subwt", subWorktree);
    // Here the Git dir (…/modules/sub/worktrees/subwt) is strictly *inside* the common
    // dir (…/modules/sub), so the git-dir ⊆ common-dir assertion is exercised on a
    // legitimate non-equal nesting rather than the trivial plain/submodule equal case.
    expect(lstatSync(join(subWorktree, ".git")).isFile()).toBe(true);
    const probed = await probeShape({ requested_cwd: subWorktree, writable_roots: [fixture.host] });
    expect(probed.supported).toBe(true);
  });
});

describe("local Git provider refuses shapes it cannot serve safely", () => {
  test("a symlink .git is refused so a pinned pointer cannot be moved underneath", async () => {
    if (!hasGit()) return;
    const host = tracked(tempRoot("layout-symlink"));
    const repo = join(host, "repo");
    initRepo(repo, "plain\n");
    renameSync(join(repo, ".git"), join(repo, ".gitdir"));
    symlinkSync(".gitdir", join(repo, ".git"));
    const probed = await probeShape({ requested_cwd: repo, writable_roots: [host] });
    expect(probed.supported).toBe(false);
    const message = probed.unsupported.find(
      (item) => item.code === "repository_unsupported",
    )?.message;
    expect(message).toContain("symlink Git directories are unsupported");
  });

  test("a submodule declared with only itself writable names the authority it cannot cover", async () => {
    if (!hasGit()) return;
    const fixture = submoduleFixture("layout-submodule-narrow");
    // The caller believes the layout is supported and declares only the inner checkout.
    // The refusal must name the common directory in the superproject and say why it is
    // outside — a generic containment message would leave the caller nothing to fix.
    const probed = await probeShape({
      requested_cwd: fixture.subCheckout,
      writable_roots: [fixture.subCheckout],
    });
    expect(probed.supported).toBe(false);
    const reason = probed.unsupported.find(
      (item) => item.code === "repository_authority_outside_writable_root",
    );
    expect(reason).toBeDefined();
    expect(reason?.message).toContain(fixture.subCommonDir);
    expect(reason?.message).toContain(fixture.subCheckout);
  });
});

describe("the gitdir cross-check is a consistency assertion, not spoof detection", () => {
  // Pins the limit of the `resolveGitDirPointer` / `rev-parse --git-dir` equality, so
  // nobody later mistakes it for an authority boundary. Git honours a `gitdir:` pointer
  // wherever it aims, so a pointer at an unrelated repository AGREES with `rev-parse`
  // and is accepted. It cannot be otherwise: a doctored pointer and a submodule's
  // pointer are the same construct. Containment and `allowed_paths` on the resolved
  // common directory are what actually bound the write, which is why this checkout is
  // accepted only while the repository it points at is inside the writable root.
  test("a pointer aimed at an unrelated repository is accepted, not refused", async () => {
    if (!hasGit()) return;
    const host = tracked(tempRoot("layout-pointer-elsewhere"));
    const decoy = join(host, "decoy");
    initRepo(decoy, "decoy\n");
    const repo = join(host, "repo");
    initRepo(repo, "repo\n");
    renameSync(join(repo, ".git"), join(repo, ".gitdir-real"));
    writeFileSync(join(repo, ".git"), `gitdir: ${join(decoy, ".git")}\n`);

    expect(git(repo, "rev-parse", "--git-dir")).toContain(join(decoy, ".git"));

    const probed = await probeShape({ requested_cwd: repo, writable_roots: [host] });
    expect(probed.supported).toBe(true);

    // And the real boundary still bites: narrow the writable root to the checkout and
    // the decoy's authority is outside it, so the same layout is refused by name.
    const narrowed = await probeShape({ requested_cwd: repo, writable_roots: [repo] });
    expect(narrowed.supported).toBe(false);
    expect(
      narrowed.unsupported.find(
        (item) => item.code === "repository_authority_outside_writable_root",
      )?.message,
    ).toContain(join(decoy, ".git"));
  });
});

describe("local Git provider allocates an isolated worktree from a submodule source", () => {
  test("a submodule source with the enclosing repo writable completes an isolated run", async () => {
    if (!hasGit()) return;
    if (!descriptorPathsAvailable) return;
    const fixture = submoduleFixture("layout-submodule-allocate");
    // Keep .harnery out of the submodule's status so nothing muddies the checkout.
    writeFileSync(join(fixture.subCommonDir, "info", "exclude"), ".harnery/\n");
    const script = writeScript(fixture.subCheckout, "export default async () => 'isolated';\n");
    const provider = createLocalGitWorktreeProvider({ coordRoot: fixture.subCheckout });
    const report = await runWorkflow(script, {
      coordRoot: fixture.subCheckout,
      cwd: fixture.subCheckout,
      spawners: {},
      isolation: "worktree",
      workspace: { provider, writableRoots: [fixture.host] },
      ...quiet,
    });
    const binding = report.workspaceBinding;
    expect(binding).toBeDefined();
    // The worktree's admin area lives in the submodule's common dir, inside the host.
    expect(binding?.repository?.common_dir.realpath).toBe(fixture.subCommonDir);
    expect(binding?.workspace_root.startsWith(fixture.host)).toBe(true);
    const attestation = await provider.attest(binding!);
    expect(attestation.status).toBe("ok");
  });
});
