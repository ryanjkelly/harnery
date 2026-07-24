import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  git,
  gitFixture,
  hasGit,
  quiet,
  tempRoot,
  writeScript,
} from "../../../../tests/workspace-test-helpers.ts";
import { runWorkflow } from "../engine.ts";
import { cleanupWorkspace } from "./cleanup.ts";
import {
  inspectWorkflowWorkspace,
  listWorkflowWorkspaceInspections,
  readWorkflowWorkspaceStatus,
  renderWorkflowWorkspaceStatus,
} from "./inspect.ts";
import { applyIntegration, prepareIntegration } from "./integration.ts";
import { createLocalGitWorktreeProvider } from "./local-git.ts";
import { workspaceEventsPath } from "./state.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow workspace inspection", () => {
  test("distinguishes shared execution from explicit compatibility fallback", async () => {
    const root = tracked(tempRoot("workspace-inspect-shared"));
    const script = writeScript(root, "export default async () => 'shared';\n");
    const shared = await runWorkflow(script, { coordRoot: root, spawners: {}, ...quiet });
    expect(readWorkflowWorkspaceStatus(root, shared.runId)).toMatchObject({
      selection: "shared",
      requested_isolation: "shared",
      effective_isolation: "shared",
      verification: { status: "not_applicable" },
      integration: { state: "none" },
      cleanup: { state: "not_requested" },
      integrity: { status: "verified" },
    });

    const compatibility = await runWorkflow(script, {
      coordRoot: root,
      spawners: {},
      isolation: "worktree",
      ...quiet,
    });
    expect(readWorkflowWorkspaceStatus(root, compatibility.runId)).toMatchObject({
      selection: "compatibility",
      requested_isolation: "worktree",
      effective_isolation: "shared",
      compatibility: { reason: "provider_not_configured" },
      verification: {
        status: "not_applicable",
        unsupported: [{ code: "provider_not_configured" }],
      },
    });
  });

  test("projects an isolated run from validated manifest, proof, and provider records", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-inspect-isolated");
    tracked(host);
    const script = writeScript(repo, "export default async () => 'isolated';\n");
    git(repo, "add", ".");
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

    const status = readWorkflowWorkspaceStatus(repo, report.runId);
    expect(status).toMatchObject({
      selection: "isolated",
      requested_isolation: "worktree",
      effective_isolation: "worktree",
      provider: { id: "local-git-worktree", version: "1" },
      lifecycle: {
        state: "completed_unintegrated",
        workflow_outcome: "completed_unintegrated",
        resource_state: "active",
        integration_state: "none",
      },
      verification: { status: "ok", workflow_status: "succeeded" },
      repository: { dirty_paths: [], conflicts: [], operations_in_progress: [] },
      integrity: { status: "verified" },
    });
    expect(status.allocation?.active_root).toBe(report.workspaceBinding?.active_root);
    expect(renderWorkflowWorkspaceStatus(status)).toContain("verification: ok");
    expect(
      listWorkflowWorkspaceInspections(repo).some(
        (inspection) => inspection.ok && inspection.value.run_id === report.runId,
      ),
    ).toBe(true);
  });

  test("returns an explicit invalid inspection for corrupt provider history", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-inspect-corrupt");
    tracked(host);
    const script = writeScript(repo, "export default async () => 'isolated';\n");
    git(repo, "add", ".");
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
    const eventsPath = workspaceEventsPath(repo, binding.provider.id, binding.binding_id);
    writeFileSync(eventsPath, `${readFileSync(eventsPath, "utf8")}{bad\n`);

    expect(inspectWorkflowWorkspace(repo, report.runId)).toMatchObject({
      ok: false,
      run_id: report.runId,
    });
  });

  test("projects planned, applied, and released authority from durable receipts", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-inspect-integration");
    tracked(host);
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
      ...quiet,
    });
    const plan = await prepareIntegration({
      coordRoot: repo,
      runId: report.runId,
      provider,
      review: { actor: "reviewer" },
      policy: {
        external_actions: "allow",
        allowed_isolation: ["worktree"],
        allowed_paths: [repo],
      },
      acceptedUnknowns: ["network_not_attested"],
    });
    expect(readWorkflowWorkspaceStatus(repo, report.runId)).toMatchObject({
      lifecycle: { state: "integration_requested", integration_state: "planned" },
      integration: { state: "planned", changed_paths: ["result.txt"] },
    });

    const receipt = await applyIntegration({
      coordRoot: repo,
      runId: report.runId,
      provider,
      plan,
    });
    expect(readWorkflowWorkspaceStatus(repo, report.runId)).toMatchObject({
      lifecycle: { state: "integrated", integration_state: "applied" },
      integration: { state: "applied", receipt_id: receipt.receipt_id },
    });

    await cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider });
    expect(readWorkflowWorkspaceStatus(repo, report.runId)).toMatchObject({
      lifecycle: { state: "released", resource_state: "released" },
      cleanup: { state: "released", attempts: 2 },
    });
  });
});

function tracked(root: string): string {
  roots.push(root);
  return root;
}
