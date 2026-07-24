import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { Command } from "commander";
import { registerWorkflowCommand } from "../../src/commands/workflow.ts";
import { listWorkflowWorkspaceInspections } from "../../src/core/workflow/index.ts";
import { git, gitFixture, hasGit, writeScript } from "../workspace-test-helpers.ts";

let host: string;
let repo: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  ({ host, repo } = gitFixture("workflow-workspace-command"));
  mkdirSync(`${repo}/.harnery`, { recursive: true });
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(host, { recursive: true, force: true });
});

describe("workflow workspace commands", () => {
  test("allocates through the built-in provider and renders validated state", async () => {
    if (!hasGit() || process.platform !== "linux") return;
    const script = writeScript(repo, "export default async () => 'isolated';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const output: string[] = [];
    const emitted: unknown[] = [];
    const emit = {
      text: (value: string) => output.push(value),
      data: (value: unknown) => emitted.push(value),
      config: () => {},
      error: (error: { message: string }) => {
        throw new Error(error.message);
      },
    };

    await runCommand(
      ["workflow", "run", script, "--isolation", "worktree", "--workspace-root", host],
      emit,
    );
    const inspection = listWorkflowWorkspaceInspections(repo).find(
      (item) => item.ok && item.value.selection === "isolated",
    );
    expect(inspection?.ok).toBe(true);
    if (!inspection?.ok) throw new Error("isolated workspace inspection missing");

    await runCommand(["workflow", "workspace", inspection.value.run_id], emit);
    expect(output.join("\n")).toContain("verification: ok");
    expect(output.join("\n")).toContain("integration none");

    await runCommand(["workflow", "workspace", inspection.value.run_id, "--json"], emit);
    expect(emitted.at(-1)).toMatchObject({
      run_id: inspection.value.run_id,
      selection: "isolated",
      lifecycle: { state: "completed_unintegrated" },
    });

    await runCommand(["workflow", "workspaces"], emit);
    expect(output.join("\n")).toContain(`${inspection.value.run_id}\tisolated`);
  });
});

async function runCommand(
  args: string[],
  emit: {
    text: (value: string) => void;
    data: (value: unknown) => void;
    config: (value: unknown) => void;
    error: (value: { message: string }) => void;
  },
): Promise<void> {
  const program = new Command();
  registerWorkflowCommand(program, emit as never);
  await program.parseAsync(args, { from: "user" });
}
