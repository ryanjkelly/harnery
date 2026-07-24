import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { registerWorkflowCommand } from "../../src/commands/workflow.ts";
import { resolveBinName } from "../../src/core/config.ts";
import {
  createLocalGitWorktreeProvider,
  listWorkflowWorkspaceInspections,
  readWorkflowWorkspaceStatus,
  runWorkflow,
  workflowApprovalId,
} from "../../src/core/workflow/index.ts";
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

  test("prepares, applies, and cleans up through existing durable authority", async () => {
    if (!hasGit() || process.platform !== "linux") return;
    const script = writeScript(
      repo,
      `
        export const meta = {
          acceptance: [{ id: "ready", statement: "workspace change is ready" }],
        };
        export default async ({ agent, evidence }) => {
          await agent("produce");
          evidence({
            kind: "test",
            status: "passed",
            label: "workspace verification",
            acceptanceIds: ["ready"],
          });
          return "ready";
        };
      `,
    );
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    const report = await runWorkflow(script, {
      coordRoot: repo,
      cwd: repo,
      spawners: {
        "claude-code": async (request) => {
          writeFileSync(join(request.cwd, "result.txt"), "integrated\n");
          git(request.cwd, "add", "result.txt");
          git(request.cwd, "commit", "-qm", "workspace result");
          return {
            ok: true,
            text: "done",
            durationMs: 1,
            costUsd: 0,
            sessionId: "fixture",
          };
        },
      },
      harnessEvidence: {
        "claude-code": { toolEvidence: { support: "supported" } },
      },
      isolation: "worktree",
      workspace: { provider, writableRoots: [host] },
    });
    const policyPath = join(host, "integration-policy.json");
    writeFileSync(
      policyPath,
      `${JSON.stringify({
        external_actions: "ask",
        allowed_isolation: ["worktree"],
        allowed_paths: [host],
      })}\n`,
    );
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

    const prepareArgs = [
      "workflow",
      "integration",
      "prepare",
      report.runId,
      "--policy",
      policyPath,
      "--reviewer",
      "reviewer",
      "--accept-unknown",
      "network_not_attested",
      "--approval-to",
      "operator",
    ];
    await runCommand(prepareArgs, emit);
    const parkedText = output.join("\n");
    expect(parkedText).toContain("integration preparation parked");
    expect(parkedText).toContain(`run: ${report.runId}`);
    expect(parkedText).toMatch(/plan: integration-plan-/);
    const approvalId = workflowApprovalId(report.runId, "p99999");
    expect(parkedText).toContain(`approval: ${approvalId}`);
    expect(parkedText).toContain(
      `approve: ${resolveBinName()} workflow approvals approve ${approvalId}`,
    );
    expect(emitted).toHaveLength(0);

    output.length = 0;
    await runCommand([...prepareArgs, "--json"], emit);
    expect(emitted.at(-1)).toMatchObject({
      status: "parked",
      runId: report.runId,
      approvalId,
    });
    expect((emitted.at(-1) as { planId: string }).planId).toMatch(/^integration-plan-/);

    await runCommand(
      [
        "workflow",
        "approvals",
        "approve",
        approvalId,
        "--actor",
        "operator",
        "--reason",
        "reviewed exact fast-forward",
      ],
      emit,
    );
    output.length = 0;
    await runCommand(prepareArgs, emit);
    expect(output.join("\n")).toContain("integration plan");
    expect(readWorkflowWorkspaceStatus(repo, report.runId)).toMatchObject({
      lifecycle: { integration_state: "planned" },
    });

    await expect(
      runCommand(["workflow", "integration", "apply", report.runId], emit),
    ).rejects.toThrow(/pass --yes/);
    await runCommand(["workflow", "integration", "apply", report.runId, "--yes"], emit);
    expect(existsSync(join(repo, "result.txt"))).toBe(true);
    expect(readWorkflowWorkspaceStatus(repo, report.runId)).toMatchObject({
      lifecycle: { state: "integrated", integration_state: "applied" },
    });

    await expect(runCommand(["workflow", "cleanup", report.runId], emit)).rejects.toThrow(
      /pass --yes/,
    );
    await runCommand(["workflow", "cleanup", report.runId, "--yes"], emit);
    expect(readWorkflowWorkspaceStatus(repo, report.runId)).toMatchObject({
      lifecycle: { state: "released", resource_state: "released" },
      cleanup: { state: "released" },
    });
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
