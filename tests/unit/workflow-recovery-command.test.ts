import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { registerWorkflowCommand } from "../../src/commands/workflow.ts";
import { createLocalGitWorktreeProvider, runWorkflow } from "../../src/core/workflow/index.ts";
import { readWorkspaceEvents } from "../../src/core/workflow/workspaces/state.ts";
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

describe("workflow reclaim --force CLI", () => {
  test.skipIf(!descriptorPathsAvailable)(
    "previews unknown liveness, then force reclaims and records one ledger line",
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
      const binding = report.workspaceBinding!;
      const dirty = join(binding.workspace_root, "README.md");
      writeFileSync(dirty, "retained work\n");
      writeFileSync(report.transcriptPath, "corrupt\n");
      const preview = await command(["run", "reclaim", report.runId, "--discard", "--force"]);
      expect(preview.text).toContain("add --force with --yes");
      expect(readFileSync(dirty, "utf8")).toBe("retained work\n");
      await expect(
        command(["run", "reclaim", report.runId, "--discard", "--yes"]),
      ).rejects.toMatchObject({ code: "workflow_reclaim_liveness_unknown" });
      const result = await command([
        "run",
        "reclaim",
        report.runId,
        "--discard",
        "--force",
        "--yes",
        "--json",
      ]);
      expect(result.values[0]).toMatchObject({
        action: "reclaimed",
        liveness: "unknown",
        cleanup: { status: "released" },
      });
      expect(
        readWorkspaceEvents(repo, binding.provider.id, binding.binding_id).filter(
          (event) => event.event === "reclaim_forced",
        ),
      ).toHaveLength(1);
    },
  );
});
