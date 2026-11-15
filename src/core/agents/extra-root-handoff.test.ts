import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import {
  checkGitFinalization,
  formatGitFinalizationFailure,
  readSessionFinalizationScope,
} from "./finalization.ts";
import { recordLiveClaimChangeV3 } from "./live-authority-v3.ts";
import {
  FinalizationPathIndexUnreadableError,
  finalizationPathIndexDir,
  recordFinalizationPathClaim,
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

const ADA = "extra-handoff-ada";
const BO = "extra-handoff-bo";
const SHARED = "../sibling/owned.txt";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
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

/** A pushed coordination repository plus a pushed sibling repository configured as an extra root. */
function fixture(): { repo: string; sibling: string } {
  const created = mkdtempSync(join(tmpdir(), "harnery-extra-handoff-"));
  const base = process.platform === "win32" ? realpathSync.native(created) : created;
  fixtures.push(base);
  const repo = join(base, "repo");
  const sibling = join(base, "sibling");
  for (const [path, remote, seed] of [
    [repo, join(base, "repo.git"), ".gitignore"],
    [sibling, join(base, "sibling.git"), "owned.txt"],
  ] as const) {
    init(remote, true);
    init(path);
    writeFileSync(join(path, seed), seed === ".gitignore" ? ".harnery/\n" : "base\n");
    git(path, "add", "--", seed);
    git(path, "commit", "--quiet", "-m", "seed", "--", seed);
    git(path, "remote", "add", "origin", remote);
    git(path, "push", "--quiet", "-u", "origin", "next");
  }
  initializeEventLedgerV3({
    coordRoot: repo,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-extra-root-handoff",
  });
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

function claim(repo: string, owner: string, path: string): void {
  recordLiveClaimChangeV3({
    coordRoot: repo,
    owner,
    nativeSessionId: owner,
    adapter: "codex",
    operation: "acquired",
    path,
  });
}

function cli(repo: string, owner: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../../cli.ts"), ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...process.env,
      HARNERY_COORD_ROOT_OVERRIDE: repo,
      HARNERY_AGENT_COORD_OWNER: owner,
      HARNERY_AGENT_COORD_BRIDGE: "",
      HARNERY_AGENT_COORD_SESSION_ID: "",
      HARNERY_BIN: "harn",
      CODEX_THREAD_ID: "",
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
      unreadablePathIndex: scope.unreadableIndex,
    }),
  };
}

function indexFor(repo: string, owner: string): unknown {
  return JSON.parse(readFileSync(join(finalizationPathIndexDir(repo), `${owner}.json`), "utf8"));
}

describe("extra finalization roots: handoff boundary and unreadable index (ADR 0267)", () => {
  test("an extra-root path cannot be offered, and nothing moves", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, SHARED);
    writeFileSync(join(sibling, "owned.txt"), "base\nada\n");
    const adaIndex = indexFor(repo, ADA);

    const offer = cli(repo, ADA, "agents", "handoff", SHARED, "--to", "Bo");
    expect(offer.status).toBe(1);
    const error = JSON.parse(offer.stderr || offer.stdout).error;
    expect(error.code).toBe("path_outside_repository");
    expect(error.message).toContain(`harn agents release-claim ${SHARED}`);

    expect(indexFor(repo, ADA)).toEqual(adaIndex);
    expect(finalization(repo, ADA).result.dirty_paths).toEqual([SHARED]);
    expect(finalization(repo, BO).scope.paths).toEqual([]);
    expect(finalization(repo, BO).result.ok).toBe(true);
    // Accepting what was never offered is refused too.
    expect(cli(repo, BO, "agents", "handoff", "accept", SHARED).status).toBe(1);
  });

  test("release then claim moves the dirty file to the receiver; the sender keeps the push", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, SHARED);
    writeFileSync(join(sibling, "owned.txt"), "base\nada\n");
    git(sibling, "commit", "--quiet", "-am", "ada");
    writeFileSync(join(sibling, "owned.txt"), "base\nada\nmore\n");

    const released = cli(repo, ADA, "agents", "release-claim", SHARED);
    expect(released.status).toBe(0);
    claim(repo, BO, SHARED);

    // The receiver owes the dirty file and the push.
    const bo = finalization(repo, BO);
    expect(bo.result.ok).toBe(false);
    expect(bo.result.dirty_paths).toEqual([SHARED]);
    expect(bo.result.unpushed_repos).toEqual(["../sibling"]);

    // The sender keeps only the repository push obligation.
    const ada = finalization(repo, ADA);
    expect(ada.result.dirty_paths).toEqual([]);
    expect(ada.result.unpushed_repos).toEqual(["../sibling"]);

    // The receiver commits and pushes: both sessions pass.
    git(sibling, "commit", "--quiet", "-am", "bo");
    git(sibling, "push", "--quiet", "origin", "next");
    expect(finalization(repo, BO).result.ok).toBe(true);
    expect(finalization(repo, ADA).result.ok).toBe(true);
  });

  test("a new claim that meets an unreadable index refuses and names the remove command", () => {
    const { repo, sibling } = fixture();
    claim(repo, ADA, SHARED);
    const file = join(finalizationPathIndexDir(repo), `${ADA}.json`);
    writeFileSync(file, "{not json");
    writeFileSync(join(sibling, "other.txt"), "new\n");

    // The claim is still recorded; the index write refuses to replace the file.
    expect(() => claim(repo, ADA, "../sibling/other.txt")).not.toThrow();
    expect(readFileSync(file, "utf8")).toBe("{not json");
    expect(() =>
      recordFinalizationPathClaim(repo, {
        instanceId: ADA,
        generationId: "gen_any",
        operation: "acquired",
        path: join(sibling, "other.txt"),
        root: "../sibling",
      }),
    ).toThrow(FinalizationPathIndexUnreadableError);

    // The closing check fails closed and names the guarded remove that clears it.
    const closing = finalization(repo, ADA);
    expect(closing.result.ok).toBe(false);
    expect(closing.result.unreadable_path_index).toBe(file);
    const message = formatGitFinalizationFailure(closing.result, "harn").replaceAll("\\", "/");
    const command = `harn rm --root ${repo.replaceAll("\\", "/")} --allow-protected .harnery/finalization-paths/${ADA}.json .harnery/finalization-paths/${ADA}.json --yes`;
    expect(message).toContain(command);

    // That command works on the live index file and nothing else in .harnery.
    const removed = cli(
      repo,
      ADA,
      "rm",
      "--root",
      repo,
      "--allow-protected",
      `.harnery/finalization-paths/${ADA}.json`,
      `.harnery/finalization-paths/${ADA}.json`,
      "--yes",
    );
    expect(removed.stderr).toBe("");
    expect(removed.status).toBe(0);
    expect(existsSync(file)).toBe(false);
    const config = cli(
      repo,
      ADA,
      "rm",
      "--root",
      repo,
      "--allow-protected",
      ".harnery/config.jsonc",
      ".harnery/config.jsonc",
      "--yes",
    );
    expect(config.status).not.toBe(0);

    // The next claim starts a new index, and the closing check sees it again.
    claim(repo, ADA, SHARED);
    writeFileSync(join(sibling, "owned.txt"), "base\nada\n");
    expect(finalization(repo, ADA).result.dirty_paths).toEqual([SHARED]);
  });
});
