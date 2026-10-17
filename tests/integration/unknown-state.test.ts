import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { processStartToken } from "../../src/core/agents/state/proc-start.ts";
import { checkpointContext } from "../../src/core/context/index.ts";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import { runWorkflow } from "../../src/core/workflow/engine.ts";
import { createLocalGitWorktreeProvider } from "../../src/core/workflow/workspaces/local-git.ts";
import { readWorkflowLiveness } from "../../src/core/workflow/workspaces/recovery.ts";
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
const HOOK = join(HARNERY_DIR, "bin", "agent-hook");
const SESSION = "unknown-state-fixture";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
        symlinkSync(HARNERY_DIR, join(repo, "harnery"));
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
          const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
          expect(realGit).not.toBe("");
          const shim = join(bin, "git");
          writeFileSync(
            shim,
            `#!/bin/sh\nif [ "$1" = "status" ]; then\n  echo 'forced status read failure' >&2\n  exit 128\nfi\nexec '${realGit.replaceAll("'", "'\\''")}' "$@"\n`,
          );
          chmodSync(shim, 0o755);
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

  for (const generation of ["different", "unknown"] as const) {
    test(`governor stop leaves a real process with ${generation} generation running`, async () => {
      const { repo } = fixture("service-generation");
      const child = spawn(
        process.execPath,
        ["-e", "process.stdin.on('data', () => process.stdout.write('alive\\n'))"],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      await once(child, "spawn");
      const exited = once(child, "exit").then(() => false);
      try {
        const pid = child.pid!;
        const token = processStartToken(pid);
        expect(token).not.toBeNull();
        const directory = join(repo, ".harnery", "governor-service");
        mkdirSync(directory, { recursive: true });
        const now = new Date().toISOString();
        writeFileSync(
          join(directory, "status.json"),
          JSON.stringify({
            schema_version: 1,
            pid,
            host: hostname(),
            nonce: "fixture-generation",
            ...(generation === "different" ? { start_token: `${token}-different` } : {}),
            running_build: "fixture",
            state: "running",
            started_at: now,
            heartbeat_at: now,
            config_created_at: now,
            sweep_count: 0,
          }),
        );
        const result = harn(repo, ["governor", "service", "stop", "--json"]);
        const answered = once(child.stdout, "data").then(([data]) => String(data) === "alive\n");
        child.stdin.write("probe\n", () => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
        });
        const stillRunning = await Promise.race([answered, exited, timedOut]);
        clearTimeout(timer);
        expect(result.status).toBe(0);
        expect(stillRunning).toBe(true);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(processStartToken(pid)).toBe(token);
        expect(JSON.parse(result.stdout)).toMatchObject({
          generation,
          signal_sent: false,
          signal_verdict: generation,
        });
        expect(existsSync(join(directory, "stop.json"))).toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin.end();
          await exited;
        }
      }
    }, 15_000);
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
  return spawnSync("bash", [HOOK, "session-start", "--adapter", "claude-code"], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20_000,
    env: environment(root, extraEnv),
  });
}
