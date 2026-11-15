import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import { readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import {
  liveInstanceIdV3,
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { checkGitFinalization, readSessionFinalizationScope } from "./finalization.ts";
import { recordLiveClaimChangeV3 } from "./live-authority-v3.ts";
import { evaluateClaim } from "./rules/claim-conflict.ts";
import { evaluateCommit } from "./rules/commit-conflict.ts";
import {
  finalizationPathIndexDir,
  pruneFinalizationPathIndex,
  readFinalizationPathIndex,
  removeFinalizationPathIndex,
} from "./state/finalization-path-index.ts";
import { setIdentityCache } from "./state/heartbeat-writer.ts";
import { readLiveCoordinationRow } from "./state/live-coordination-view.ts";
import { ensureLiveCoordinationHeartbeat } from "./state/live-coordination-writer.ts";

const TIMEOUT_MS = process.platform === "win32" ? 120_000 : 60_000;
setDefaultTimeout(TIMEOUT_MS);

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) removeDir(path);
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
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
  git(path, "config", "core.autocrlf", "false");
}

function commit(repo: string, message: string, ...paths: string[]): void {
  git(repo, "add", "--", ...paths);
  git(repo, "commit", "--quiet", "-m", message, "--", ...paths);
}

const ADA = "released-ada";
const BO = "released-bo";

/** A pushed coordination repository with a pushed submodule and a pushed sibling repository. */
function fixture(): { repo: string; sibling: string } {
  const created = mkdtempSync(join(tmpdir(), "harnery-released-"));
  const base = process.platform === "win32" ? realpathSync.native(created) : created;
  fixtures.push(base);
  const repo = join(base, "repo");
  const childRemote = join(base, "child.git");
  const childSeed = join(base, "child-seed");
  const sibling = join(base, "sibling");
  const siblingRemote = join(base, "sibling.git");

  init(childRemote, true);
  init(childSeed);
  writeFileSync(join(childSeed, "owned.txt"), "base\n");
  commit(childSeed, "seed child", "owned.txt");
  git(childSeed, "remote", "add", "origin", childRemote);
  git(childSeed, "push", "--quiet", "-u", "origin", "next");

  init(siblingRemote, true);
  init(sibling);
  writeFileSync(join(sibling, "owned.txt"), "base\n");
  commit(sibling, "seed sibling", "owned.txt");
  git(sibling, "remote", "add", "origin", siblingRemote);
  git(sibling, "push", "--quiet", "-u", "origin", "next");

  init(join(base, "repo.git"), true);
  init(repo);
  writeFileSync(join(repo, ".gitignore"), ".harnery/\n");
  writeFileSync(join(repo, "owned.txt"), "base\n");
  writeFileSync(join(repo, "other.txt"), "base\n");
  commit(repo, "seed", ".gitignore", "owned.txt", "other.txt");
  git(
    repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    childRemote,
    "child",
  );
  git(repo, "commit", "--quiet", "-m", "add child");
  git(join(repo, "child"), "config", "user.email", "test@example.invalid");
  git(join(repo, "child"), "config", "user.name", "Test");
  git(join(repo, "child"), "config", "core.hooksPath", "/dev/null");
  git(repo, "remote", "add", "origin", join(base, "repo.git"));
  git(repo, "push", "--quiet", "-u", "origin", "next");

  initializeEventLedgerV3({
    coordRoot: repo,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-released-claims",
  });
  mkdirSync(join(repo, ".harnery"), { recursive: true });
  writeFileSync(
    join(repo, ".harnery", "config.jsonc"),
    JSON.stringify({
      binName: "harn",
      agents: { finalizationRoots: [{ path: "../sibling", disposition: "git" }] },
    }),
  );
  const route = resolveLiveEventLedgerRouteV3(repo);
  if (route.state !== "v3") throw new Error("expected V3 fixture route");
  for (const [name, owner] of [
    ["Ada", ADA],
    ["Bo", BO],
  ] as const) {
    for (const eventName of ["session-start", "user-prompt-submit"] as const) {
      recordLiveHookSignalV3({
        coordRoot: repo,
        route,
        eventName,
        payload: { session_id: owner, raw: {}, turn_id: `${owner}-turn`, prompt: "edit" },
        adapter: "codex",
        instanceId: owner,
      });
    }
    ensureLiveCoordinationHeartbeat(repo, owner, owner, "codex", "fixture");
    setIdentityCache(repo, owner, name, `id-${name}`);
  }
  return { repo, sibling };
}

function claim(repo: string, owner: string, path: string, operation: "acquired" | "released") {
  recordLiveClaimChangeV3({
    coordRoot: repo,
    owner,
    nativeSessionId: owner,
    adapter: "codex",
    operation,
    path,
  });
}

/** The same scope read and check the closing status command performs. */
function finalization(repo: string, owner: string) {
  const row = readLiveCoordinationRow(repo, owner);
  if (!row) throw new Error(`no live row for ${owner}`);
  const scope = readSessionFinalizationScope(repo, row, owner);
  return {
    scope,
    result: checkGitFinalization(repo, scope.paths, {
      claimHistoryComplete: scope.complete,
      repositoryOnlyPaths: scope.repositoryOnlyPaths,
    }),
  };
}

describe("released claims stay in the closing check", () => {
  test("(a) a committed, released, unpushed path in the coordination repository", () => {
    const { repo } = fixture();
    claim(repo, ADA, "owned.txt", "acquired");
    writeFileSync(join(repo, "owned.txt"), "ada\n");
    commit(repo, "ada", "owned.txt");
    claim(repo, ADA, "owned.txt", "released");

    const before = finalization(repo, ADA);
    expect(before.scope.paths).toEqual([]);
    expect(before.scope.repositoryOnlyPaths).toEqual(["owned.txt"]);
    expect(before.result.ok).toBe(false);
    expect(before.result.unpushed_repos).toEqual(["."]);
    expect(before.result.dirty_paths).toEqual([]);

    git(repo, "push", "--quiet", "origin", "next");
    expect(finalization(repo, ADA).result.ok).toBe(true);
  });

  test("(b) a committed, released path in a submodule: child push, then the parent pointer", () => {
    const { repo } = fixture();
    const child = join(repo, "child");
    claim(repo, ADA, "child/owned.txt", "acquired");
    writeFileSync(join(child, "owned.txt"), "ada\n");
    commit(child, "ada", "owned.txt");
    claim(repo, ADA, "child/owned.txt", "released");

    const unpushed = finalization(repo, ADA).result;
    expect(unpushed.ok).toBe(false);
    expect(unpushed.unpushed_repos).toContain("child");

    git(child, "push", "--quiet", "origin", "HEAD:next");
    const pointer = finalization(repo, ADA).result;
    expect(pointer.ok).toBe(false);
    expect(pointer.unpushed_repos).toEqual([]);
    expect(pointer.dirty_paths).toEqual(["child"]);

    commit(repo, "bump child", "child");
    const parentUnpushed = finalization(repo, ADA).result;
    expect(parentUnpushed.dirty_paths).toEqual([]);
    expect(parentUnpushed.unpushed_repos).toEqual(["."]);

    git(repo, "push", "--quiet", "origin", "next");
    expect(finalization(repo, ADA).result.ok).toBe(true);
  });

  test("(c) a path released while dirty leaves the dirty-file check but keeps its commits", () => {
    const { repo } = fixture();
    claim(repo, ADA, "owned.txt", "acquired");
    writeFileSync(join(repo, "owned.txt"), "ada\n");
    claim(repo, ADA, "owned.txt", "released");
    // An explicit release gives up the uncommitted changes: only commits stay owed.
    const dirty = finalization(repo, ADA);
    expect(dirty.scope.repositoryOnlyPaths).toEqual(["owned.txt"]);
    expect(dirty.result.dirty_paths).toEqual([]);
    expect(dirty.result.ok).toBe(true);

    commit(repo, "ada", "owned.txt");
    writeFileSync(join(repo, "owned.txt"), "ada again\n");
    expect(finalization(repo, ADA).result).toMatchObject({
      ok: false,
      unpushed_repos: ["."],
      dirty_paths: [],
    });
  });

  // A claim outside the coordination root is an external_path target, which
  // the contract records without a path. The machine-local path index
  // (ADR 0267) gives the closing check those paths, held or released.
  test("(d) a committed, released, unpushed path in an extra finalization root", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    writeFileSync(join(sibling, "owned.txt"), "ada\n");
    commit(sibling, "ada", "owned.txt");
    claim(repo, ADA, "../sibling/owned.txt", "released");

    const before = finalization(repo, ADA).result;
    expect(before.ok).toBe(false);
    expect(before.unpushed_repos).toEqual(["../sibling"]);

    git(sibling, "push", "--quiet", "origin", "next");
    expect(finalization(repo, ADA).result.ok).toBe(true);
  });

  test("(d, held) a dirty, held path in an extra finalization root", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    writeFileSync(join(sibling, "owned.txt"), "ada\n");
    expect(finalization(repo, ADA).result.dirty_paths).toEqual(["../sibling/owned.txt"]);
  });

  test("a released path blocks no peer's edit or commit, and a peer's other commit blocks nobody", () => {
    const { repo } = fixture();
    claim(repo, ADA, "owned.txt", "acquired");
    writeFileSync(join(repo, "owned.txt"), "ada\n");
    commit(repo, "ada", "owned.txt");
    claim(repo, ADA, "owned.txt", "released");

    // Ada still owes the push, but Bo may edit and commit the same path.
    expect(finalization(repo, ADA).result.unpushed_repos).toEqual(["."]);
    expect(
      evaluateClaim(repo, { rule: "claim", instance_id: BO, session_id: BO, path: "owned.txt" })
        .allow,
    ).toBe(true);
    claim(repo, BO, "owned.txt", "acquired");
    writeFileSync(join(repo, "owned.txt"), "ada\nbo\n");
    git(repo, "add", "--", "owned.txt");
    expect(
      evaluateCommit(repo, { staged_paths: ["owned.txt"], instance_id: BO, session_id: BO }).allow,
    ).toBe(true);
    git(repo, "commit", "--quiet", "-m", "bo", "--", "owned.txt");
    git(repo, "push", "--quiet", "origin", "next");
    expect(finalization(repo, ADA).result.ok).toBe(true);

    // A peer's unpushed commit to a different path is not Ada's obligation.
    writeFileSync(join(repo, "other.txt"), "bo\n");
    commit(repo, "bo other", "other.txt");
    expect(finalization(repo, ADA).result.ok).toBe(true);
  });

  test("claiming a released path again makes it a held path, and the view keeps the release", () => {
    const { repo } = fixture();
    claim(repo, ADA, "owned.txt", "acquired");
    claim(repo, ADA, "owned.txt", "released");
    expect(readCoordinationViewV3(repo).instances[liveInstanceIdV3(ADA)]?.released_paths).toEqual([
      "owned.txt",
    ]);
    expect(readLiveCoordinationRow(repo, ADA)?.files_touched).toEqual([]);

    claim(repo, ADA, "owned.txt", "acquired");
    expect(
      readCoordinationViewV3(repo).instances[liveInstanceIdV3(ADA)]?.released_paths,
    ).toBeUndefined();
    expect(finalization(repo, ADA).scope).toMatchObject({
      paths: ["owned.txt"],
      repositoryOnlyPaths: [],
    });
  });
});

describe("claims in extra finalization roots use the machine-local path index", () => {
  test("a held path committed but not pushed refuses until pushed", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    writeFileSync(join(sibling, "owned.txt"), "ada\n");
    commit(sibling, "ada", "owned.txt");
    const unpushed = finalization(repo, ADA).result;
    expect(unpushed).toMatchObject({ ok: false, dirty_paths: [], unpushed_repos: ["../sibling"] });
    git(sibling, "push", "--quiet", "origin", "next");
    expect(finalization(repo, ADA).result.ok).toBe(true);
  });

  test("a released path claimed again is held: dirty work refuses again", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    claim(repo, ADA, "../sibling/owned.txt", "released");
    writeFileSync(join(sibling, "owned.txt"), "dirty after release\n");
    // Released: no dirty-file obligation, nothing committed, so nothing owed.
    expect(finalization(repo, ADA).result.ok).toBe(true);

    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    const held = finalization(repo, ADA);
    expect(held.scope.repositoryOnlyPaths).toEqual([]);
    expect(held.result.dirty_paths).toEqual(["../sibling/owned.txt"]);
  });

  test("a root without a remote still checks dirty files but owes no push", () => {
    const { repo, sibling } = fixture();
    git(sibling, "remote", "remove", "origin");
    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    writeFileSync(join(sibling, "owned.txt"), "ada\n");
    expect(finalization(repo, ADA).result.dirty_paths).toEqual(["../sibling/owned.txt"]);
    commit(sibling, "ada", "owned.txt");
    expect(finalization(repo, ADA).result.ok).toBe(true);
    claim(repo, ADA, "../sibling/owned.txt", "released");
    expect(finalization(repo, ADA).result.ok).toBe(true);
  });

  test("a path outside every configured root is not indexed", () => {
    const { repo } = fixture();
    const outside = join(repo, "..", "elsewhere", "note.txt");
    mkdirSync(join(repo, "..", "elsewhere"), { recursive: true });
    writeFileSync(outside, "x\n");
    claim(repo, ADA, outside, "acquired");
    expect(existsSync(join(finalizationPathIndexDir(repo), `${ADA}.json`))).toBe(false);
  });

  test("a released path whose root left the configuration is named, not passed", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    writeFileSync(join(sibling, "owned.txt"), "ada\n");
    commit(sibling, "ada", "owned.txt");
    claim(repo, ADA, "../sibling/owned.txt", "released");
    writeFileSync(
      join(repo, ".harnery", "config.jsonc"),
      JSON.stringify({ binName: "harn", agents: { finalizationRoots: [] } }),
    );
    const result = finalization(repo, ADA).result;
    expect(result.ok).toBe(false);
    expect(result.unsupported_paths).toEqual([
      {
        path: join(sibling, "owned.txt").replaceAll("\\", "/"),
        reason: "outside_finalization_roots",
      },
    ]);
  });

  test("a missing index changes nothing; a corrupt one fails closed", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    writeFileSync(join(sibling, "owned.txt"), "ada\n");
    expect(removeFinalizationPathIndex(repo, ADA)).toBe(true);
    expect(finalization(repo, ADA).result.ok).toBe(true);

    mkdirSync(finalizationPathIndexDir(repo), { recursive: true });
    writeFileSync(join(finalizationPathIndexDir(repo), `${ADA}.json`), "{not json");
    const corrupt = finalization(repo, ADA);
    expect(corrupt.scope.complete).toBe(false);
    expect(corrupt.result.ok).toBe(false);
    expect(corrupt.result.claim_history_complete).toBe(false);
  });

  test("the index blocks no peer, and entries from another generation are ignored", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    writeFileSync(join(sibling, "owned.txt"), "ada\n");
    commit(sibling, "ada", "owned.txt");
    claim(repo, ADA, "../sibling/owned.txt", "released");
    expect(
      evaluateClaim(repo, {
        rule: "claim",
        instance_id: BO,
        session_id: BO,
        path: "../sibling/owned.txt",
      }).allow,
    ).toBe(true);
    expect(readFinalizationPathIndex(repo, ADA, "gen_other")).toEqual({
      state: "ok",
      held: [],
      released: [],
    });
  });

  test("old index files are pruned by age", () => {
    const { repo } = fixture();
    claim(repo, ADA, "../sibling/owned.txt", "acquired");
    const file = join(finalizationPathIndexDir(repo), `${ADA}.json`);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    expect(pruneFinalizationPathIndex(repo)).toEqual([`${ADA}.json`]);
    expect(existsSync(file)).toBe(false);
  });
});
