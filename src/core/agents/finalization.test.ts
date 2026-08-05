import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkGitFinalization } from "./finalization.ts";

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
  temp = mkdtempSync(join("/tmp", "harnery-finalization-"));
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
});
