import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  checkGitFinalization,
  classifyWriteClaimFinalization,
  formatGitFinalizationFailure,
} from "./finalization.ts";

let temp: string;
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function initRepo(path: string, bare = false): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", ...(bare ? ["--bare"] : ["--quiet"]));
  if (!bare) {
    git(path, "config", "user.email", "test@example.invalid");
    git(path, "config", "user.name", "Test");
    git(path, "config", "core.hooksPath", "/dev/null");
  }
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "--no-verify", "-m", message);
}

beforeEach(() => {
  const base = process.platform === "win32" ? join("/tmp") : tmpdir();
  mkdirSync(base, { recursive: true });
  temp = mkdtempSync(join(base, "harnery-finalization-"));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe("checkGitFinalization", () => {
  test("passes when held files are clean and the branch is pushed", () => {
    const remote = join(temp, "remote.git");
    const repo = join(temp, "repo");
    initRepo(remote, true);
    initRepo(repo);
    writeFileSync(join(repo, "owned.txt"), "done\n");
    commitAll(repo, "initial");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "HEAD:master");

    expect(checkGitFinalization(repo, ["owned.txt"])).toMatchObject({
      ok: true,
      dirty_paths: [],
      unpushed_repos: [],
    });
  });

  test("maps a Windows WSL UNC claim to the Linux coordination root", () => {
    const repo = join(temp, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "owned.txt"), "done\n");
    commitAll(repo, "initial");
    const uncPath = `\\\\wsl.localhost\\Ubuntu-22.04${repo.replaceAll("/", "\\")}\\owned.txt`;

    expect(checkGitFinalization(repo, [uncPath])).toMatchObject({
      ok: true,
      dirty_paths: [],
      unverifiable_paths: [],
      repos_checked: ["."],
    });
  });

  test("blocks a dirty held file but ignores a dirty foreign file", () => {
    const repo = join(temp, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "owned.txt"), "base\n");
    writeFileSync(join(repo, "foreign.txt"), "base\n");
    commitAll(repo, "initial");
    writeFileSync(join(repo, "owned.txt"), "mine\n");
    writeFileSync(join(repo, "foreign.txt"), "theirs\n");

    const result = checkGitFinalization(repo, ["owned.txt"]);
    expect(result.ok).toBe(false);
    expect(result.dirty_paths).toEqual(["owned.txt"]);
  });

  test("blocks a clean local commit that has not been pushed", () => {
    const remote = join(temp, "remote.git");
    const repo = join(temp, "repo");
    initRepo(remote, true);
    initRepo(repo);
    writeFileSync(join(repo, "owned.txt"), "base\n");
    commitAll(repo, "initial");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "HEAD:master");
    writeFileSync(join(repo, "owned.txt"), "done\n");
    commitAll(repo, "done");

    const result = checkGitFinalization(repo, ["owned.txt"]);
    expect(result.ok).toBe(false);
    expect(result.dirty_paths).toEqual([]);
    expect(result.unpushed_repos).toEqual(["."]);
  });

  test("checks a held submodule file and the superproject pointer", () => {
    const childRemote = join(temp, "child-remote.git");
    const childSeed = join(temp, "child-seed");
    const parent = join(temp, "parent");
    initRepo(childRemote, true);
    initRepo(childSeed);
    writeFileSync(join(childSeed, "owned.txt"), "base\n");
    commitAll(childSeed, "initial");
    git(childSeed, "remote", "add", "origin", childRemote);
    git(childSeed, "push", "-u", "origin", "HEAD:master");

    initRepo(parent);
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", childRemote, "child");
    commitAll(parent, "add child");
    git(join(parent, "child"), "config", "user.email", "test@example.invalid");
    git(join(parent, "child"), "config", "user.name", "Test");
    writeFileSync(join(parent, "child", "owned.txt"), "done\n");
    commitAll(join(parent, "child"), "done");
    git(join(parent, "child"), "push", "origin", "HEAD:master");

    const result = checkGitFinalization(parent, ["child/owned.txt"]);
    expect(result.ok).toBe(false);
    expect(result.dirty_paths).toEqual(["child"]);
    expect(result.repos_checked).toEqual([".", "child"]);
  });

  test("passes detached submodule HEAD when a remote ref contains it", () => {
    const childRemote = join(temp, "child-remote.git");
    const childSeed = join(temp, "child-seed");
    const parent = join(temp, "parent");
    initRepo(childRemote, true);
    initRepo(childSeed);
    writeFileSync(join(childSeed, "owned.txt"), "base\n");
    commitAll(childSeed, "initial");
    git(childSeed, "remote", "add", "origin", childRemote);
    git(childSeed, "push", "-u", "origin", "HEAD:master");
    initRepo(parent);
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", childRemote, "child");
    commitAll(parent, "add child");

    expect(checkGitFinalization(parent, ["child/owned.txt"]).ok).toBe(true);
  });

  test("ignores foreign dirty contents after the parent gitlink is committed", () => {
    const childRemote = join(temp, "child-remote.git");
    const childSeed = join(temp, "child-seed");
    const parent = join(temp, "parent");
    initRepo(childRemote, true);
    initRepo(childSeed);
    writeFileSync(join(childSeed, "owned.txt"), "base\n");
    commitAll(childSeed, "initial");
    git(childSeed, "remote", "add", "origin", childRemote);
    git(childSeed, "push", "-u", "origin", "HEAD:master");
    initRepo(parent);
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", childRemote, "child");
    commitAll(parent, "add child");
    writeFileSync(join(parent, "child", "foreign-untracked.txt"), "peer work\n");

    const result = checkGitFinalization(parent, ["child/owned.txt"]);
    expect(result.ok).toBe(true);
    expect(result.dirty_paths).toEqual([]);
  });

  test("blocks a clean submodule checkout that is behind the parent gitlink", () => {
    const childRemote = join(temp, "child-remote.git");
    const childSeed = join(temp, "child-seed");
    const parent = join(temp, "parent");
    initRepo(childRemote, true);
    initRepo(childSeed);
    writeFileSync(join(childSeed, "owned.txt"), "one\n");
    commitAll(childSeed, "one");
    const oldChild = git(childSeed, "rev-parse", "HEAD");
    git(childSeed, "remote", "add", "origin", childRemote);
    git(childSeed, "push", "-u", "origin", "HEAD:master");
    initRepo(parent);
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", childRemote, "child");
    commitAll(parent, "add child");

    writeFileSync(join(childSeed, "owned.txt"), "two\n");
    commitAll(childSeed, "two");
    const newChild = git(childSeed, "rev-parse", "HEAD");
    git(childSeed, "push", "origin", "HEAD:master");
    git(join(parent, "child"), "fetch", "origin", "master");
    git(join(parent, "child"), "checkout", "--detach", newChild);
    commitAll(parent, "bump child");
    git(join(parent, "child"), "checkout", "--detach", oldChild);

    const result = checkGitFinalization(parent, []);
    expect(result.ok).toBe(false);
    expect(result.stale_submodules).toEqual(["child"]);
    expect(formatGitFinalizationFailure(result, "harn")).toContain(
      "Submodule checkouts behind their parent gitlinks",
    );
  });

  test("does not globally block an unrelated turn on a submodule checkout ahead of its gitlink", () => {
    const childRemote = join(temp, "child-remote.git");
    const childSeed = join(temp, "child-seed");
    const parent = join(temp, "parent");
    initRepo(childRemote, true);
    initRepo(childSeed);
    writeFileSync(join(childSeed, "owned.txt"), "one\n");
    commitAll(childSeed, "one");
    git(childSeed, "remote", "add", "origin", childRemote);
    git(childSeed, "push", "-u", "origin", "HEAD:master");
    initRepo(parent);
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", childRemote, "child");
    commitAll(parent, "add child");

    git(join(parent, "child"), "config", "user.email", "test@example.invalid");
    git(join(parent, "child"), "config", "user.name", "Test");
    writeFileSync(join(parent, "child", "owned.txt"), "local work\n");
    commitAll(join(parent, "child"), "local work");

    const result = checkGitFinalization(parent, []);
    expect(result.ok).toBe(true);
    expect(result.stale_submodules).toEqual([]);
    expect(result.diverged_submodules).toEqual([]);
  });

  test("blocks when the coordination repository is behind its fetched upstream", () => {
    const remote = join(temp, "remote.git");
    const repo = join(temp, "repo");
    const peer = join(temp, "peer");
    initRepo(remote, true);
    initRepo(repo);
    writeFileSync(join(repo, "owned.txt"), "one\n");
    commitAll(repo, "one");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "HEAD:master");
    git(temp, "clone", "--quiet", remote, peer);
    git(peer, "config", "user.email", "test@example.invalid");
    git(peer, "config", "user.name", "Test");
    writeFileSync(join(peer, "owned.txt"), "two\n");
    commitAll(peer, "two");
    git(peer, "push", "origin", "HEAD:master");
    git(repo, "fetch", "origin", "master");

    const result = checkGitFinalization(repo, []);
    expect(result.ok).toBe(false);
    expect(result.behind_repos).toEqual(["."]);
  });

  test("checks an authorized sibling Git repository through dirty, local, unpushed, and pushed states", () => {
    const coord = join(temp, "coord");
    const sibling = join(temp, "sibling");
    const remote = join(temp, "sibling-remote.git");
    initRepo(coord);
    writeFileSync(join(coord, "seed.txt"), "coord\n");
    commitAll(coord, "coord");
    initRepo(sibling);
    writeFileSync(join(sibling, "owned.txt"), "base\n");
    commitAll(sibling, "initial");
    configureFinalizationRoots(coord, [{ path: relative(coord, sibling), disposition: "git" }]);

    expect(checkGitFinalization(coord, ["../sibling/owned.txt"])).toMatchObject({
      ok: true,
      repos_checked: ["../sibling"],
    });

    writeFileSync(join(sibling, "owned.txt"), "dirty\n");
    expect(checkGitFinalization(coord, ["../sibling/owned.txt"])).toMatchObject({
      ok: false,
      dirty_paths: ["../sibling/owned.txt"],
    });

    writeFileSync(join(sibling, "owned.txt"), "base\n");
    initRepo(remote, true);
    git(sibling, "remote", "add", "origin", remote);
    git(sibling, "push", "-u", "origin", "HEAD:master");
    writeFileSync(join(sibling, "owned.txt"), "committed\n");
    commitAll(sibling, "local");
    expect(checkGitFinalization(coord, ["../sibling/owned.txt"])).toMatchObject({
      ok: false,
      dirty_paths: [],
      unpushed_repos: ["../sibling"],
    });

    git(sibling, "push", "origin", "HEAD:master");
    expect(checkGitFinalization(coord, ["../sibling/owned.txt"]).ok).toBe(true);
  });

  test("accepts an explicit sibling output root and rejects a non-Git root declared as Git", () => {
    const coord = join(temp, "coord");
    const output = join(temp, "output");
    initRepo(coord);
    writeFileSync(join(coord, "seed.txt"), "coord\n");
    commitAll(coord, "coord");
    mkdirSync(output);
    writeFileSync(join(output, "artifact.txt"), "done\n");
    configureFinalizationRoots(coord, [{ path: relative(coord, output), disposition: "output" }]);

    expect(checkGitFinalization(coord, ["../output/artifact.txt"])).toMatchObject({
      ok: true,
      host_output_paths: ["../output/artifact.txt"],
      repos_checked: [],
    });

    configureFinalizationRoots(coord, [{ path: relative(coord, output), disposition: "git" }]);
    expect(classifyWriteClaimFinalization(coord, "../output/artifact.txt")).toMatchObject({
      allow: false,
      reason: "invalid_finalization_root",
    });

    initRepo(output);
    commitAll(output, "track output");
    configureFinalizationRoots(coord, [{ path: relative(coord, output), disposition: "output" }]);
    expect(classifyWriteClaimFinalization(coord, "../output/artifact.txt")).toMatchObject({
      allow: false,
      reason: "invalid_finalization_root",
    });
  });

  test("rejects an arbitrary external repository without granting Git discovery", () => {
    const coord = join(temp, "coord");
    const arbitrary = join(temp, "arbitrary");
    initRepo(coord);
    writeFileSync(join(coord, "seed.txt"), "coord\n");
    commitAll(coord, "coord");
    initRepo(arbitrary);
    writeFileSync(join(arbitrary, "owned.txt"), "base\n");
    commitAll(arbitrary, "initial");
    writeFileSync(join(arbitrary, "owned.txt"), "dirty\n");

    const result = checkGitFinalization(coord, ["../arbitrary/owned.txt"]);
    expect(result).toMatchObject({
      ok: false,
      dirty_paths: [],
      unpushed_repos: [],
      repos_checked: [],
      unsupported_paths: [{ path: "../arbitrary/owned.txt", reason: "outside_finalization_roots" }],
    });
    const message = formatGitFinalizationFailure(result, "harn");
    expect(message).toContain("agents.finalizationRoots");
    expect(message).not.toContain("Commit and push the owned Git work");
  });

  test("normalizes relative and WSL UNC forms of one authorized sibling claim", () => {
    if (process.platform === "win32") return;
    const coord = join(temp, "coord");
    const sibling = join(temp, "sibling");
    initRepo(coord);
    writeFileSync(join(coord, "seed.txt"), "coord\n");
    commitAll(coord, "coord");
    initRepo(sibling);
    writeFileSync(join(sibling, "owned.txt"), "base\n");
    commitAll(sibling, "initial");
    configureFinalizationRoots(coord, [{ path: relative(coord, sibling), disposition: "git" }]);
    const uncPath = `\\\\wsl.localhost\\Ubuntu-22.04${join(sibling, "owned.txt").replaceAll("/", "\\")}`;

    expect(classifyWriteClaimFinalization(coord, "../sibling/owned.txt")).toMatchObject({
      allow: true,
      path: "../sibling/owned.txt",
      descriptor: { disposition: "git" },
    });
    expect(classifyWriteClaimFinalization(coord, uncPath)).toMatchObject({
      allow: true,
      path: "../sibling/owned.txt",
      descriptor: { disposition: "git" },
    });
  });
});

function configureFinalizationRoots(
  coord: string,
  roots: Array<{ path: string; disposition: "git" | "output" }>,
): void {
  mkdirSync(join(coord, ".harnery"), { recursive: true });
  writeFileSync(
    join(coord, ".harnery", "config.jsonc"),
    JSON.stringify({
      binName: "harn",
      agents: { requireGitFinalization: true, finalizationRoots: roots },
    }),
  );
}
