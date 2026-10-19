import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerWorkflowCommand } from "../../src/commands/workflow.ts";
import {
  createLocalGitWorktreeProvider,
  readWorkflowRecoveryLedger,
  runWorkflow,
} from "../../src/core/workflow/index.ts";
import {
  descriptorPathsAvailable,
  git,
  gitFixture,
  quiet,
  writeScript,
} from "../workspace-test-helpers.ts";

let host: string;
let repo: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  ({ host, repo } = gitFixture("workflow-recovery-cli"));
  mkdirSync(join(repo, ".harnery"), { recursive: true });
  process.chdir(repo);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(host, { recursive: true, force: true });
});

async function command(args: string[]) {
  const values: unknown[] = [];
  const text: string[] = [];
  const program = new Command();
  registerWorkflowCommand(program, {
    text: (value: string) => text.push(value),
    data: (value: unknown) => values.push(value),
    config: () => {},
    error: (error: { code: string; message: string }) => {
      throw Object.assign(new Error(error.message), { code: error.code });
    },
  } as never);
  await program.parseAsync(args, { from: "user" });
  return { values, text: text.join("") };
}

describe("audited workflow recovery CLI", () => {
  test("unlock previews then confirms exactly one abandoned lock", async () => {
    const path = join(repo, ".harnery", "workflows", "wf-abandoned", "resume.lock");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ pid: 2_147_483_647, host: hostname(), created_at: "2000-01-01T00:00:00Z" }),
    );
    const preview = (await command(["run", "unlock", "wf-abandoned", "--json"])).values[0] as {
      lock_sha256: string;
    };
    expect(existsSync(path)).toBe(true);
    const result = await command([
      "run",
      "unlock",
      "wf-abandoned",
      "--lock-sha256",
      preview.lock_sha256,
      "--actor",
      "operator",
      "--reason",
      "Owner exited.",
      "--yes",
      "--json",
    ]);
    expect(result.values[0]).toMatchObject({
      action: "unlocked",
      run_id: "wf-abandoned",
      owner_state: "dead",
    });
    expect(existsSync(path)).toBe(false);
    expect(readWorkflowRecoveryLedger(repo, "wf-abandoned")[0]?.outcome).toBe("completed");
  });
  test("unlock reports refusal when confirmation omits the exact digest", async () => {
    await expect(command(["run", "unlock", "wf-absent", "--yes"])).rejects.toMatchObject({
      code: "workflow_resume_unlock_failed",
    });
  });
  test.skipIf(!descriptorPathsAvailable)(
    "reclaim maps exact unknown recovery authority and retains unknown liveness",
    async () => {
      const script = writeScript(repo, "export default async () => 'done';\n");
      git(repo, "add", "scripts");
      git(repo, "commit", "-qm", "workflow");
      const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
      const report = await runWorkflow(script, {
        coordRoot: repo,
        cwd: repo,
        spawners: {},
        isolation: "worktree",
        workspace: { provider, writableRoots: [host] },
        ...quiet,
      });
      const dirty = join(report.workspaceBinding!.workspace_root, "README.md");
      writeFileSync(dirty, "retained work\n");
      writeFileSync(report.transcriptPath, "corrupt\n");
      const preview = (await command(["run", "reclaim", report.runId, "--discard", "--json"]))
        .values[0] as { evidence_sha256: string };
      expect(readFileSync(dirty, "utf8")).toBe("retained work\n");
      const result = await command([
        "run",
        "reclaim",
        report.runId,
        "--discard",
        "--unknown-liveness",
        preview.evidence_sha256,
        "--actor",
        "operator",
        "--reason",
        "Terminal proof retained after evidence loss.",
        "--yes",
        "--json",
      ]);
      expect(result.values[0]).toMatchObject({
        action: "reclaimed",
        liveness: "unknown",
        cleanup: { status: "released" },
      });
      expect(readWorkflowRecoveryLedger(repo, report.runId)[0]?.outcome).toBe("completed");
    },
  );
});
