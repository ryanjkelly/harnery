import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { checkpointContext } from "../../src/core/context/index.ts";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import { gitFixture, hasGit } from "../git-test-helpers.ts";
import { removeDir } from "../helpers/remove-dir.ts";

const HARNERY_DIR = resolve(import.meta.dir, "../..");
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

function hook(root: string, payload: object, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [HOOK, "session-start", "--adapter", "claude-code"], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20_000,
    env: environment(root, extraEnv),
  });
}
