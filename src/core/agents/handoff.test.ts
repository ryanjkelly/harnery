import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import { readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { checkGitFinalization, readSessionFinalizationScope } from "./finalization.ts";
import {
  describeDirtyPathPeers,
  findLivePeerByName,
  formatDirtyPathPeers,
  handoffGitState,
} from "./handoff.ts";
import { recordLiveClaimChangeV3, recordLiveTaskChangeV3 } from "./live-authority-v3.ts";
import { claimConflictReason } from "./rules/claim-conflict.ts";
import { evaluateCommit } from "./rules/commit-conflict.ts";
import { setIdentityCache } from "./state/heartbeat-writer.ts";
import {
  readLiveCoordinationRow,
  readLiveCoordinationRows,
} from "./state/live-coordination-view.ts";
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

/** Commit exactly this content for one path, leaving the working tree alone. */
function commitContent(repo: string, path: string, content: string, message: string): void {
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    input: content,
    encoding: "utf8",
    windowsHide: true,
  }).stdout.trim();
  git(repo, "update-index", "--cacheinfo", `100644,${blob},${path}`);
  // No pathspec: a pathspec commit takes the working-tree file, peers' lines included.
  git(repo, "commit", "--quiet", "-m", message);
}

const SESSIONS = { ada: "handoff-ada", bo: "handoff-bo", cy: "handoff-cy" } as const;

function fixture(): string {
  const base = mkdtempSync(join(tmpdir(), "harnery-handoff-"));
  fixtures.push(base);
  const repo = join(base, "repo");
  const remote = join(base, "repo.git");
  init(remote, true);
  init(repo);
  // Keep the coordination state out of the repository's status.
  writeFileSync(join(repo, ".gitignore"), ".harnery/\n");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  writeFileSync(join(repo, "clean.txt"), "clean\n");
  git(repo, "add", "--", ".gitignore", "shared.txt", "clean.txt");
  git(repo, "commit", "--quiet", "-m", "seed");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "--quiet", "-u", "origin", "next");
  initializeEventLedgerV3({
    coordRoot: repo,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-handoff",
  });
  const route = resolveLiveEventLedgerRouteV3(repo);
  if (route.state !== "v3") throw new Error("expected V3 fixture route");
  for (const [name, owner] of Object.entries(SESSIONS)) {
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
    setIdentityCache(repo, owner, name.charAt(0).toUpperCase() + name.slice(1), `id-${name}`);
  }
  return repo;
}

function claim(repo: string, owner: string, path: string, operation = "acquired" as const): void {
  recordLiveClaimChangeV3({
    coordRoot: repo,
    owner,
    nativeSessionId: owner,
    adapter: "codex",
    operation,
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

describe("named claim handoff", () => {
  test("three sessions sharing one file all finalize without any bypass", () => {
    const repo = fixture();
    // Each session adds its own line to the same file and holds a claim on it.
    claim(repo, SESSIONS.ada, "shared.txt");
    writeFileSync(join(repo, "shared.txt"), "base\nada\n");
    claim(repo, SESSIONS.bo, "shared.txt");
    writeFileSync(join(repo, "shared.txt"), "base\nada\nbo\n");
    claim(repo, SESSIONS.cy, "shared.txt");
    writeFileSync(join(repo, "shared.txt"), "base\nada\nbo\ncy\n");

    // Ada commits and pushes only her own line; the peers' lines stay dirty.
    commitContent(repo, "shared.txt", "base\nada\n", "add ada line");
    git(repo, "push", "--quiet", "origin", "next");

    const before = finalization(repo, SESSIONS.ada).result;
    expect(before.ok).toBe(false);
    expect(before.dirty_paths).toEqual(["shared.txt"]);
    const notes = formatDirtyPathPeers(
      describeDirtyPathPeers(
        repo,
        SESSIONS.ada,
        before.dirty_paths,
        readLiveCoordinationRows(repo),
      ),
      "harn",
    );
    expect(notes[0]).toContain("shared.txt is dirty only from changes this session did not write");
    expect(notes[0]).toContain("agent-Bo, agent-Cy");
    expect(notes[1]).toContain("`harn agents handoff shared.txt --to Bo`");

    // The guards name the handoff that resolves the conflict.
    const blocked = evaluateCommit(repo, {
      staged_paths: ["shared.txt"],
      instance_id: SESSIONS.cy,
      session_id: SESSIONS.cy,
    });
    expect(blocked.allow).toBe(false);
    expect(blocked.handoff_commands?.join("\n")).toContain(
      "harn agents handoff shared.txt --to Cy",
    );
    expect(
      claimConflictReason(
        repo,
        "shared.txt",
        { name: "Ada", instance_id: SESSIONS.ada },
        {
          name: "Cy",
          instance_id: SESSIONS.cy,
        },
      ),
    ).toContain("agents handoff accept shared.txt");

    // Ada and Bo offer the file to Cy, the integrator.
    const adaOffer = cli(repo, SESSIONS.ada, "agents", "handoff", "shared.txt", "--to", "agent-Cy");
    expect(adaOffer.stderr).toBe("");
    expect(adaOffer.status).toBe(0);
    expect(JSON.parse(adaOffer.stdout)).toMatchObject({ receiver: "agent-Cy" });
    const boOffer = cli(repo, SESSIONS.bo, "agents", "handoff", "shared.txt", "--to", "Cy");
    expect(boOffer.status).toBe(0);
    // Offering again is idempotent.
    const repeat = cli(repo, SESSIONS.bo, "agents", "handoff", "shared.txt", "--to", "Cy");
    expect(JSON.parse(repeat.stdout).offered[0].recorded).toBe(false);

    // Until Cy accepts, nothing moves.
    expect(finalization(repo, SESSIONS.ada).result.dirty_paths).toEqual(["shared.txt"]);
    expect(readLiveCoordinationRow(repo, SESSIONS.bo)?.files_touched).toEqual(["shared.txt"]);

    const accepted = cli(repo, SESSIONS.cy, "agents", "handoff", "accept", "shared.txt");
    expect(accepted.stderr).toBe("");
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout).accepted).toHaveLength(2);

    // Ada and Bo no longer own the dirty file; Ada keeps her repository check.
    const ada = finalization(repo, SESSIONS.ada);
    expect(ada.scope.paths).toEqual([]);
    expect(ada.scope.repositoryOnlyPaths).toEqual(["shared.txt"]);
    expect(ada.result.repos_checked).toEqual(["."]);
    expect(ada.result.ok).toBe(true);
    expect(finalization(repo, SESSIONS.bo).result.ok).toBe(true);
    expect(readLiveCoordinationRow(repo, SESSIONS.ada)?.files_touched).toEqual([]);

    // The guards treat Cy as the owner at once: her commit passes unbypassed.
    const commitVerdict = evaluateCommit(repo, {
      staged_paths: ["shared.txt"],
      instance_id: SESSIONS.cy,
      session_id: SESSIONS.cy,
    });
    expect(commitVerdict.rule).toBe("commit.pass");
    expect(finalization(repo, SESSIONS.cy).result.dirty_paths).toEqual(["shared.txt"]);
    git(repo, "add", "--", "shared.txt");
    git(repo, "commit", "--quiet", "-m", "add peer lines", "--", "shared.txt");
    git(repo, "push", "--quiet", "origin", "next");
    expect(finalization(repo, SESSIONS.cy).result.ok).toBe(true);

    // Editing the file again makes it the sender's own obligation again.
    claim(repo, SESSIONS.ada, "shared.txt");
    expect(finalization(repo, SESSIONS.ada).scope).toMatchObject({
      paths: ["shared.txt"],
      repositoryOnlyPaths: [],
    });

    // The ledger records sender, receiver, path, and the Git state.
    const handoffs = Object.values(readCoordinationViewV3(repo).handoffs ?? {});
    expect(handoffs.map((h) => h.state)).toEqual(["accepted", "accepted"]);
    expect(handoffs.every((h) => h.target_display === "shared.txt")).toBe(true);
  });

  test("an unaccepted handoff changes nothing and an unoffered accept is refused", () => {
    const repo = fixture();
    claim(repo, SESSIONS.ada, "shared.txt");
    writeFileSync(join(repo, "shared.txt"), "base\nada\n");
    const refused = cli(repo, SESSIONS.cy, "agents", "handoff", "accept", "shared.txt");
    expect(refused.status).toBe(1);
    expect(refused.stderr + refused.stdout).toContain("no live peer has offered you shared.txt");
    expect(cli(repo, SESSIONS.ada, "agents", "handoff", "shared.txt", "--to", "Cy").status).toBe(0);
    // The receiver's status box names the waiting offer and the accept command.
    const status = cli(repo, SESSIONS.cy, "agents", "status");
    expect(status.stdout).toContain("offered by agent-Ada");
    expect(status.stdout).toContain("harn agents handoff accept");
    // Bo was not offered the file, so Bo cannot take it.
    expect(cli(repo, SESSIONS.bo, "agents", "handoff", "accept", "shared.txt").status).toBe(1);
    expect(finalization(repo, SESSIONS.ada).result.dirty_paths).toEqual(["shared.txt"]);
    expect(readLiveCoordinationRow(repo, SESSIONS.ada)?.files_touched).toEqual(["shared.txt"]);
    expect(readLiveCoordinationRow(repo, SESSIONS.cy)?.files_touched).toEqual([]);
    // A clean path or an unclaimed path is not offered.
    claim(repo, SESSIONS.ada, "clean.txt");
    const clean = cli(repo, SESSIONS.ada, "agents", "handoff", "clean.txt", "--to", "Cy");
    expect(clean.stderr + clean.stdout).toContain("release-claim clean.txt");
    const unclaimed = cli(repo, SESSIONS.bo, "agents", "handoff", "shared.txt", "--to", "Cy");
    expect(unclaimed.stderr + unclaimed.stdout).toContain("holds no claim on shared.txt");
  });

  test("a handoff to a session that is not live is refused", () => {
    const repo = fixture();
    claim(repo, SESSIONS.ada, "shared.txt");
    writeFileSync(join(repo, "shared.txt"), "base\nada\n");
    const result = cli(repo, SESSIONS.ada, "agents", "handoff", "shared.txt", "--to", "Nobody");
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("no live session is named Nobody");
    expect(readCoordinationViewV3(repo).handoffs).toEqual({});
    const self = cli(repo, SESSIONS.ada, "agents", "handoff", "shared.txt", "--to", "Ada");
    expect(self.status).toBe(1);
    const rows = [{ instance_id: "a", name: "Ada", last_heartbeat: new Date(0).toISOString() }];
    expect(findLivePeerByName(rows, "Ada", "b", 600)).toEqual({ state: "not_live" });
  });

  test("finishing the task releases clean claims and keeps dirty ones with the reason", () => {
    const repo = fixture();
    recordLiveTaskChangeV3({
      coordRoot: repo,
      owner: SESSIONS.ada,
      nativeSessionId: SESSIONS.ada,
      adapter: "codex",
      task: "finish edits",
    });
    claim(repo, SESSIONS.ada, "clean.txt");
    claim(repo, SESSIONS.ada, "shared.txt");
    writeFileSync(join(repo, "shared.txt"), "base\nada\n");

    const refused = cli(repo, SESSIONS.ada, "agents", "lifecycle", "done");
    expect(refused.status).toBe(1);
    const message = refused.stderr + refused.stdout;
    expect(message).toContain("Released claims on clean paths: clean.txt.");
    expect(message).toContain("Each dirty path keeps its claim because it has uncommitted changes");
    expect(message).toContain("shared.txt");
    expect(readLiveCoordinationRow(repo, SESSIONS.ada)?.files_touched).toEqual(["shared.txt"]);

    git(repo, "add", "--", "shared.txt");
    git(repo, "commit", "--quiet", "-m", "ada line", "--", "shared.txt");
    git(repo, "push", "--quiet", "origin", "next");
    expect(handoffGitState(repo, "shared.txt").worktree).toBe("clean");
    const done = cli(repo, SESSIONS.ada, "agents", "lifecycle", "done");
    expect(done.stderr).toBe("");
    expect(done.status).toBe(0);
    expect(readLiveCoordinationRow(repo, SESSIONS.ada)?.files_touched).toEqual([]);
  });

  test("summarizes a path's Git state without its contents", () => {
    const repo = fixture();
    expect(handoffGitState(repo, "shared.txt")).toMatchObject({ worktree: "clean" });
    writeFileSync(join(repo, "shared.txt"), "base\nchanged\n");
    expect(handoffGitState(repo, "shared.txt").worktree).toBe("unstaged");
    git(repo, "add", "--", "shared.txt");
    expect(handoffGitState(repo, "shared.txt").worktree).toBe("staged");
    writeFileSync(join(repo, "shared.txt"), "base\nchanged again\n");
    expect(handoffGitState(repo, "shared.txt").worktree).toBe("staged_and_unstaged");
    writeFileSync(join(repo, "new.txt"), "new\n");
    expect(handoffGitState(repo, "new.txt").worktree).toBe("untracked");
    expect(handoffGitState(repo, "gone.txt").worktree).toBe("missing");
    expect(handoffGitState(repo, "shared.txt").head).toMatch(/^[0-9a-f]{40}$/);
  });
});
