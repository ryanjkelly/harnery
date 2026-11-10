import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { checkpointContext } from "../../src/core/context/index.ts";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import { runWorkflow } from "../../src/core/run/engine.ts";
import { createLocalGitWorktreeProvider } from "../../src/core/run/workspaces/local-git.ts";
import { readWorkflowLiveness } from "../../src/core/run/workspaces/recovery.ts";
import { removeDir } from "../helpers/remove-dir.ts";
import {
  descriptorPathsAvailable,
  git,
  gitFixture,
  hasGit,
  quiet,
  writeScript,
} from "../workspace-test-helpers.ts";

const HARNERY_DIR = resolve(import.meta.dir, "../..");
const CLI = join(HARNERY_DIR, "src", "cli.ts");
// Run the hook entry directly: the bin/agent-hook shell wrapper cannot be spawned on Windows.
const HOOK = join(HARNERY_DIR, "src", "core", "hooks", "cli.ts");
const SESSION = "unknown-state-fixture";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe.skipIf(!hasGit())("unknown state CLI conformance", () => {
  for (const dirty of [false, true]) {
    for (const failure of ["missing directory", "failed Git status"] as const) {
      test(`recovery makes no match or cleared-path claim after ${failure} (${dirty ? "dirty" : "clean"} checkpoint)`, () => {
        const { host, repo } = fixture(`recovery-${dirty}`);
        initializeEventLedgerV3({
          coordRoot: repo,
          harneryBuild: "fixture",
          hostBuild: "fixture",
          configDigest: sha256V3("config"),
          approvalRecordId: "unknown-state-fixture",
        });
        // A junction needs no symlink privilege on Windows; other platforms ignore the type.
        symlinkSync(HARNERY_DIR, join(repo, "harnery"), "junction");
        writeFileSync(join(repo, ".git", "info", "exclude"), ".harnery/\nharnery\n");
        const startup = hook(repo, { session_id: SESSION, source: "startup", cwd: repo });
        expect(startup.status).toBe(0);
        if (dirty) writeFileSync(join(repo, "README.md"), "uncommitted checkpoint work\n");
        const checkpoint = checkpointContext(repo, {
          sessionId: SESSION,
          instanceId: SESSION,
          adapter: "claude-code",
          cwd: repo,
          reason: "pre_compact",
        });
        expect(checkpoint.capsule.repo.observation).toBe("ok");
        expect(checkpoint.capsule.repo.dirty_paths).toHaveLength(dirty ? 1 : 0);

        const extraEnv: Record<string, string> = {};
        let recoveryCwd = join(host, "missing", "repository");
        if (failure === "failed Git status") {
          recoveryCwd = repo;
          const bin = join(host, "fault-bin");
          mkdirSync(bin);
          const realGit = Bun.which("git") ?? "";
          expect(realGit).not.toBe("");
          if (process.platform === "win32") {
            // Windows resolves a git.cmd on PATH; a #!/bin/sh shim cannot run there.
            writeFileSync(
              join(bin, "git.cmd"),
              `@echo off\r\nif "%~1"=="status" (\r\n  echo forced status read failure 1>&2\r\n  exit /b 128\r\n)\r\n"${realGit}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
            );
          } else {
            const shim = join(bin, "git");
            writeFileSync(
              shim,
              `#!/bin/sh\nif [ "$1" = "status" ]; then\n  echo 'forced status read failure' >&2\n  exit 128\nfi\nexec '${realGit.replaceAll("'", "'\\''")}' "$@"\n`,
            );
            chmodSync(shim, 0o755);
          }
          extraEnv.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
        }
        const recovery = hook(
          repo,
          { session_id: SESSION, source: "compact", cwd: recoveryCwd },
          extraEnv,
        );
        expect(recovery.status).toBe(0);
        const output = recovery.stdout;
        expect(output).toContain("[harnery context continuity]");
        expect(output).toMatch(/could not be verified|could not verify/i);
        expect(output).not.toMatch(/matches|paths no longer dirty|dirty_paths_cleared/i);
      }, 30_000);
    }
  }
});

describe.skipIf(!hasGit() || !descriptorPathsAvailable)("live reclaim CLI conformance", () => {
  test("preview is read-only and discard refuses an active transcript before changing its dirty provider worktree", async () => {
    const { host, repo } = fixture("reclaim-live");
    const script = writeScript(repo, "export default async () => 'fixture';\n");
    git(repo, "add", "scripts");
    git(repo, "commit", "-qm", "Add fixture workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    const report = await runWorkflow(script, {
      coordRoot: repo,
      cwd: repo,
      spawners: {},
      isolation: "worktree",
      workspace: { provider, writableRoots: [host] },
      ...quiet,
    });
    const workspace = report.workspaceBinding!.active_root;
    const dirtyPath = join(workspace, "README.md");
    const content = "valuable work still owned by an active run\n";
    writeFileSync(dirtyPath, content);
    rmSync(report.proofPath);
    const started = readFileSync(report.transcriptPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.event === "run.start");
    expect(started).toBeDefined();
    writeFileSync(report.transcriptPath, `${JSON.stringify(started)}\n`);
    expect(readWorkflowLiveness(repo, report.runId)).toBe("active");
    const beforeStatus = git(workspace, "status", "--porcelain=v1");
    const beforeHead = git(workspace, "rev-parse", "HEAD");

    for (const mode of ["discard", "salvage"]) {
      for (const json of [false, true]) {
        const preview = harn(repo, [
          "run",
          "reclaim",
          report.runId,
          ...(mode === "discard" ? ["--discard"] : []),
          ...(json ? ["--json"] : []),
        ]);
        expect(preview.status).toBe(0);
        if (json) {
          expect(JSON.parse(preview.stdout)).toMatchObject({
            action: "preview",
            run_id: report.runId,
            mode,
            liveness: "active",
            ownership: "ok",
            dirty_paths: [expect.stringMatching(/README\.md$/)],
            lease_holder: [],
          });
        } else {
          expect(preview.stdout).toContain(`reclaim preview: ${report.runId}`);
          expect(preview.stdout).toContain(`mode: ${mode}`);
          expect(preview.stdout).toContain("liveness: active");
          expect(preview.stdout).toContain("lease holder: none observed");
          expect(preview.stdout).toMatch(/dirty paths: [^\n]*README\.md\n/);
          expect(preview.stdout).toContain("Pass --yes");
        }
        expect(readFileSync(dirtyPath, "utf8")).toBe(content);
        expect(git(workspace, "status", "--porcelain=v1")).toBe(beforeStatus);
        expect(git(workspace, "rev-parse", "HEAD")).toBe(beforeHead);
      }
    }

    const result = harn(repo, ["run", "reclaim", report.runId, "--discard", "--yes"]);

    expect(existsSync(dirtyPath)).toBe(true);
    expect(readFileSync(dirtyPath, "utf8")).toBe(content);
    expect(git(workspace, "status", "--porcelain=v1")).toBe(beforeStatus);
    expect(git(workspace, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("workflow_reclaim_run_live");
  }, 30_000);
});

function fixture(label: string) {
  const result = gitFixture(`harn-unknown-${label}`);
  roots.push(result.host);
  mkdirSync(join(result.repo, ".harnery"), { recursive: true });
  return result;
}

function environment(root: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HARNERY_COORD_ROOT_OVERRIDE: root,
    HARNERY_AGENT_COORD_OWNER: SESSION,
    CLAUDE_CODE_SESSION_ID: SESSION,
    CODEX_THREAD_ID: "",
    CODEX_SESSION_ID: "",
    HARNERY_AGENT_COORD_BRIDGE: "",
    HARNERY_AGENT_COORD_SESSION_ID: "",
    ...extra,
  };
}

function harn(root: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: environment(root),
  });
}

function hook(root: string, payload: object, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [HOOK, "session-start", "--adapter", "claude-code"], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20_000,
    env: environment(root, extraEnv),
  });
}
