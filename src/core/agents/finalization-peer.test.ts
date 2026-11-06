import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { checkGitFinalization } from "./finalization.ts";
import { recordLiveClaimChangeV3 } from "./live-authority-v3.ts";
import { ensureLiveCoordinationHeartbeat } from "./state/live-coordination-writer.ts";

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || args.join(" "));
  return result.stdout.trim();
}
function init(path: string, bare = false): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "--quiet", "--initial-branch=next", ...(bare ? ["--bare"] : []));
  if (bare) return;
  git(path, "config", "user.email", "test@example.invalid");
  git(path, "config", "user.name", "Test");
  git(path, "config", "core.hooksPath", "/dev/null");
}
function commit(repo: string, path: string, value: string): void {
  writeFileSync(join(repo, path), value);
  git(repo, "add", "--", path);
  git(repo, "commit", "--quiet", "-m", value, "--", path);
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "harnery-peer-finalization-"));
  fixtures.push(base);
  const repo = join(base, "parent");
  const seed = join(base, "seed");
  const remote = join(base, "child.git");
  const parentRemote = join(base, "parent.git");
  init(remote, true);
  init(seed);
  commit(seed, "generated.txt", "first generated version\n");
  const old = git(seed, "rev-parse", "HEAD");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--quiet", "-u", "origin", "next");
  init(repo);
  git(
    repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-b",
    "next",
    remote,
    "generated",
  );
  commit(repo, "owned.txt", "worker work\n");
  git(repo, "add", "--", ".gitmodules", "generated");
  git(
    repo,
    "commit",
    "--quiet",
    "-m",
    "initial generated pointer",
    "--",
    ".gitmodules",
    "generated",
  );
  init(parentRemote, true);
  git(repo, "remote", "add", "origin", parentRemote);
  git(repo, "push", "--quiet", "-u", "origin", "next");
  commit(seed, "generated.txt", "peer generated version\n");
  commit(seed, "cache.txt", "peer cache file\n");
  const target = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "--quiet", "origin", "next");
  const child = join(repo, "generated");
  git(child, "config", "user.email", "test@example.invalid");
  git(child, "config", "user.name", "Test");
  git(child, "config", "core.hooksPath", "/dev/null");
  git(child, "fetch", "--quiet", "origin", "next");
  git(repo, "update-index", "--cacheinfo", `160000,${target},generated`);
  git(repo, "commit", "--quiet", "-m", "peer generated pointer");
  git(repo, "push", "--quiet", "origin", "next");
  return { repo, child, seed, old, target, remote };
}
const recover = { reconcilePeerSubmodules: true };

describe("end-turn peer submodule recovery", () => {
  test.each([
    "attached",
    "detached",
    "detached published branch",
    "remote default",
    "same as parent",
  ])("reconciles a pushed peer pointer with a clean %s checkout", (mode) => {
    const { repo, child, old, target } = fixture();
    if (mode.startsWith("detached")) git(child, "checkout", "--quiet", "--detach", old);
    if (mode === "detached published branch") git(child, "branch", "-f", "next", target);
    if (mode === "remote default" || mode === "same as parent") {
      if (mode === "remote default")
        git(repo, "config", "--file", ".gitmodules", "--unset", "submodule.generated.branch");
      else git(repo, "config", "--file", ".gitmodules", "submodule.generated.branch", ".");
      git(repo, "add", "--", ".gitmodules");
      git(repo, "commit", "--quiet", "-m", "use remote branch policy", "--", ".gitmodules");
      git(repo, "push", "--quiet", "origin", "next");
    }
    expect(checkGitFinalization(repo, ["owned.txt"]).stale_submodules).toEqual(["generated"]);
    expect(checkGitFinalization(repo, ["owned.txt"], recover)).toMatchObject({
      ok: true,
      dirty_paths: [],
      unpushed_repos: [],
      stale_submodules: [],
    });
    expect(git(child, "rev-parse", "HEAD")).toBe(target);
    expect(readFileSync(join(child, "generated.txt"), "utf8")).toBe("peer generated version\n");
    expect(git(repo, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "origin/next"));
  });

  test.each([
    "dirty child",
    "untracked child",
    "ignored collision",
    "unsafe branch",
    "hidden local branch",
    "staged pointer",
    "remote advanced",
    "remote unavailable",
  ])("preserves and reports %s", (mode) => {
    const { repo, child, seed, old } = fixture();
    switch (mode) {
      case "dirty child":
        writeFileSync(join(child, "generated.txt"), "unfinished input\n");
        git(child, "add", "--", "generated.txt");
        break;
      case "untracked child":
        writeFileSync(join(child, "draft.txt"), "draft\n");
        break;
      case "ignored collision":
        writeFileSync(git(child, "rev-parse", "--git-path", "info/exclude"), "cache.txt\n");
        writeFileSync(join(child, "cache.txt"), "ignored local work\n");
        break;
      case "unsafe branch":
        git(child, "checkout", "--quiet", "-b", "other");
        break;
      case "hidden local branch":
        commit(child, "local.txt", "unpublished\n");
        git(child, "checkout", "--quiet", "--detach", old);
        break;
      case "staged pointer":
        git(repo, "update-index", "--cacheinfo", `160000,${old},generated`);
        break;
      case "remote advanced":
        commit(seed, "newer.txt", "newer peer work\n");
        git(seed, "push", "--quiet", "origin", "next");
        break;
      case "remote unavailable":
        git(child, "remote", "set-url", "origin", join(child, "absent.git"));
        break;
    }
    const before = git(child, "status", "--porcelain=v1", "--untracked-files=all");
    const parentIndex = git(repo, "ls-files", "--stage", "--", "generated");
    const result = checkGitFinalization(repo, ["owned.txt"], recover);
    expect(result.ok).toBe(false);
    expect(result.stale_submodules).toEqual(["generated"]);
    expect(git(child, "rev-parse", "HEAD")).toBe(old);
    expect(git(child, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before);
    expect(git(repo, "ls-files", "--stage", "--", "generated")).toBe(parentIndex);
    if (mode === "ignored collision")
      expect(readFileSync(join(child, "cache.txt"), "utf8")).toBe("ignored local work\n");
  });

  test("end-turn status completes in one call after a pushed peer pointer advance", () => {
    const { repo, child, target } = fixture();
    const owner = "peer-recovery-owner";
    initializeEventLedgerV3({
      coordRoot: repo,
      harneryBuild: "fixture",
      hostBuild: "fixture",
      configDigest: sha256V3("config"),
      approvalRecordId: "test-peer-recovery",
    });
    const route = resolveLiveEventLedgerRouteV3(repo);
    if (route.state !== "v3") throw new Error("expected V3 fixture route");
    for (const eventName of ["session-start", "user-prompt-submit"] as const) {
      recordLiveHookSignalV3({
        coordRoot: repo,
        route,
        eventName,
        payload: {
          session_id: owner,
          raw: {},
          turn_id: "peer-recovery-turn",
          prompt: "finish owned work",
        },
        adapter: "codex",
        instanceId: owner,
      });
    }
    ensureLiveCoordinationHeartbeat(repo, owner, owner, "codex", "fixture");
    for (const operation of ["acquired", "released"] as const) {
      recordLiveClaimChangeV3({
        coordRoot: repo,
        owner,
        nativeSessionId: owner,
        adapter: "codex",
        operation,
        path: "owned.txt",
      });
    }
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "../../cli.ts"),
        "agents",
        "status",
        "--end-turn",
        "--json",
        "--session-id",
        owner,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          HARNERY_COORD_ROOT_OVERRIDE: repo,
          HARNERY_AGENT_COORD_OWNER: owner,
          HARNERY_AGENT_COORD_BRIDGE: "",
          HARNERY_AGENT_COORD_SESSION_ID: "",
          CODEX_THREAD_ID: "",
        },
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ finalization: { ok: true } });
    expect(git(child, "rev-parse", "HEAD")).toBe(target);
  }, 15_000);

  test("rechecks owned work after a merge hook runs", () => {
    const { repo, child, target } = fixture();
    // Store hooks outside the worktree so the peer checkout remains clean.
    const hookDir = join(repo, ".git", "recovery-test-hooks");
    mkdirSync(hookDir, { recursive: true });
    const hook = join(hookDir, "post-merge");
    writeFileSync(hook, "#!/bin/sh\nprintf 'changed by hook\\n' > ../owned.txt\n");
    chmodSync(hook, 0o755);
    git(child, "config", "core.hooksPath", hookDir);
    expect(checkGitFinalization(repo, ["owned.txt"], recover)).toMatchObject({
      ok: false,
      dirty_paths: ["owned.txt"],
      stale_submodules: [],
    });
    expect(git(child, "rev-parse", "HEAD")).toBe(target);
  });

  test("keeps stale inputs from this session visible", () => {
    const { repo, child, old } = fixture();
    const result = checkGitFinalization(repo, ["generated/generated.txt"], recover);
    expect(result).toMatchObject({
      ok: false,
      dirty_paths: ["generated"],
      stale_submodules: ["generated"],
    });
    expect(git(child, "rev-parse", "HEAD")).toBe(old);
  });

  test.each([
    "dirty",
    "unpushed",
  ])("still refuses owned %s work before any peer recovery", (mode) => {
    const { repo, child, old } = fixture();
    if (mode === "dirty") writeFileSync(join(repo, "owned.txt"), "unfinished\n");
    else commit(repo, "owned.txt", "unpublished worker work\n");
    const result = checkGitFinalization(repo, ["owned.txt"], recover);
    expect(result.ok).toBe(false);
    if (mode === "dirty") expect(result.dirty_paths).toEqual(["owned.txt"]);
    else expect(result.unpushed_repos).toEqual(["."]);
    expect(git(child, "rev-parse", "HEAD")).toBe(old);
  });

  test("reports a diverged peer checkout without moving it", () => {
    const { repo, child } = fixture();
    commit(child, "local.txt", "unpublished fork\n");
    const before = git(child, "rev-parse", "HEAD");
    expect(checkGitFinalization(repo, ["owned.txt"], recover)).toMatchObject({
      ok: false,
      diverged_submodules: ["generated"],
    });
    expect(git(child, "rev-parse", "HEAD")).toBe(before);
  });
});
