import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  git,
  gitFixture,
  hasGit,
  quiet,
  replaceSourceCheckout,
  writeScript,
} from "../../../../tests/workspace-test-helpers.ts";
import { acceptWorkItem, createWorkItem, reopenWorkItem, runWorkItem } from "../../work/index.ts";
import { resolveWorkflowApproval, workflowApprovalId } from "../approvals.ts";
import { runWorkflow } from "../engine.ts";
import { readWorkflowProof } from "../proof.ts";
import {
  applyIntegration,
  IntegrationPrepareParkedError,
  prepareIntegration,
} from "./integration.ts";
import { acquireNoClobberLease } from "./leases.ts";
import { deriveWorkspaceLifecycle } from "./lifecycle.ts";
import { createLocalGitWorktreeProvider } from "./local-git.ts";
import {
  fileSha256,
  readIntegrationAttempts,
  readWorkflowSupplement,
  readWorkspaceEvents,
  stableDigest,
} from "./state.ts";
import type { IntegrationAuthorization, IntegrationPlan } from "./types.ts";

const roots: string[] = [];
const TARGET_LEASE_STALE_MS = 5 * 60 * 1_000;
const DEAD_PID = 2_000_000_000;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verification-gated fast-forward integration", () => {
  for (const recoveryState of ["current", "abandoned recovery"] as const) {
    test(`recovers a stale ${recoveryState} lease left by another run`, async () => {
      if (!hasGit()) return;
      const { host, repo } = gitFixture(`workspace-integration-stale-${recoveryState[0]}`);
      roots.push(host);
      const script = writeScript(
        repo,
        "export default async ({ agent }) => { await agent('produce'); return 'ready'; };\n",
      );
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "workflow");
      const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
      const report = await runWorkflow(script, {
        coordRoot: repo,
        cwd: repo,
        spawners: {
          "claude-code": async (request) => {
            writeFileSync(join(request.cwd, "result.txt"), "lease recovery\n");
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
      const targetRoot = resolve(repo);
      const leasePath = join(
        repo,
        ".harnery",
        "workspaces",
        ".integration-leases",
        `${stableDigest(targetRoot)}.lease`,
      );
      const staleStartedAt = Date.now() - 20 * 60 * 1_000;
      const staleRunId = "wf-prior-integration";
      const staleAuthority = stableDigest({
        run_id: staleRunId,
        target_root: targetRoot,
        operation: "integration",
      });
      acquireNoClobberLease({
        path: leasePath,
        scope: "integration",
        authoritySha256: staleAuthority,
        staleAfterMs: TARGET_LEASE_STALE_MS,
        metadata: { run_id: staleRunId, target_root: targetRoot },
        now: () => staleStartedAt,
        pid: DEAD_PID,
      });

      if (recoveryState === "abandoned recovery") {
        const crashedRunId = "wf-crashed-integration-recovery";
        const crashedAuthority = stableDigest({
          run_id: crashedRunId,
          target_root: targetRoot,
          operation: "integration",
        });
        expect(() =>
          acquireNoClobberLease({
            path: leasePath,
            scope: "integration",
            authoritySha256: crashedAuthority,
            staleAfterMs: TARGET_LEASE_STALE_MS,
            metadata: { run_id: crashedRunId, target_root: targetRoot },
            now: () => staleStartedAt + TARGET_LEASE_STALE_MS + 1,
            pid: DEAD_PID - 1,
            validateStaleOwner: (owner) =>
              owner.authority_sha256 === staleAuthority &&
              owner.metadata?.run_id === staleRunId &&
              owner.metadata?.target_root === targetRoot,
            onRecoveryStep: (step) => {
              if (step === "new_current_linked") {
                throw new Error("simulated integration recovery crash");
              }
            },
          }),
        ).toThrow("simulated integration recovery crash");
        expect(existsSync(join(leasePath, "recovery"))).toBe(true);
      }

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
      expect(plan.run_id).toBe(report.runId);
      expect(existsSync(join(leasePath, "current"))).toBe(false);
      expect(existsSync(join(leasePath, "recovery"))).toBe(false);
      expect(readdirSync(leasePath).filter((entry) => entry.startsWith("owner-"))).toEqual([]);
    });
  }

  test("requires review and policy, applies once, and returns the exact replay receipt", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-integration");
    roots.push(host);
    const script = writeScript(
      repo,
      `
        export const meta = { acceptance: [{ id: "tests", statement: "tests pass" }] };
        export default async ({ agent, evidence }) => {
          await agent("produce");
          evidence({ kind: "test", status: "passed", label: "unit", acceptanceIds: ["tests"] });
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
          return { ok: true, text: "done", durationMs: 1, costUsd: 0, sessionId: "fixture" };
        },
      },
      harnessEvidence: {
        "claude-code": { toolEvidence: { support: "supported" } },
      },
      isolation: "worktree",
      workspace: { provider, writableRoots: [host] },
      ...quiet,
    });
    await expect(
      prepareIntegration({
        coordRoot: repo,
        runId: report.runId,
        provider,
        policy: {
          external_actions: "allow",
          allowed_isolation: ["worktree"],
          allowed_paths: [repo],
        },
        acceptedUnknowns: ["network_not_attested"],
      }),
    ).rejects.toThrow(/review/);
    await expect(
      prepareIntegration({
        coordRoot: repo,
        runId: report.runId,
        provider,
        review: { actor: "reviewer" },
        policy: {
          external_actions: "deny",
          allowed_isolation: ["worktree"],
          allowed_paths: [repo],
        },
        acceptedUnknowns: ["network_not_attested"],
      }),
    ).rejects.toThrow(/policy denied/);

    const targetAtParkBoundary = git(repo, "rev-parse", "HEAD");
    let parked: IntegrationPrepareParkedError | undefined;
    try {
      await prepareIntegration({
        coordRoot: repo,
        runId: report.runId,
        provider,
        review: { actor: "reviewer" },
        policy: {
          external_actions: "ask",
          allowed_isolation: ["worktree"],
          allowed_paths: [repo],
        },
        acceptedUnknowns: ["network_not_attested"],
      });
    } catch (error) {
      parked = error as IntegrationPrepareParkedError;
    }
    expect(parked).toBeInstanceOf(IntegrationPrepareParkedError);
    expect(parked!.runId).toBe(report.runId);
    expect(parked!.planId).toMatch(/^integration-plan-/);
    expect(parked!.approvalId).toBe(workflowApprovalId(report.runId, "p99999"));
    expect(git(repo, "rev-parse", "HEAD")).toBe(targetAtParkBoundary);
    const parkedPlan = readWorkflowSupplement<IntegrationPlan>(
      repo,
      report.runId,
      "integration/plan.json",
    );
    expect(parkedPlan?.plan_id).toBe(parked!.planId);
    expect(parkedPlan?.provider_preview.target_commit).toBe(targetAtParkBoundary);
    resolveWorkflowApproval({
      coordRoot: repo,
      approvalId: parked!.approvalId,
      verdict: "allow",
      actor: "operator",
      reason: "reviewed exact fast-forward",
    });
    const plan = await prepareIntegration({
      coordRoot: repo,
      runId: report.runId,
      provider,
      review: { actor: "reviewer" },
      policy: { external_actions: "ask", allowed_isolation: ["worktree"], allowed_paths: [repo] },
      acceptedUnknowns: ["network_not_attested"],
    });
    expect(plan.plan_id).toBe(parked!.planId);
    expect(git(repo, "rev-parse", "HEAD")).toBe(targetAtParkBoundary);
    expect(plan.provider_preview.target_commit).toBe(targetAtParkBoundary);
    const invalidIdentity = {
      ...provider,
      applyAuthorizedIntegration: async () => ({
        schema_version: 1 as const,
        binding_id: "foreign-binding",
        plan_id: "foreign-plan",
        status: "applied" as const,
        target_commit: plan.provider_preview.source_commit,
        target_tree: plan.provider_preview.source_tree,
        applied_at: new Date().toISOString(),
      }),
    };
    await expect(
      applyIntegration({
        coordRoot: repo,
        runId: report.runId,
        provider: invalidIdentity,
        plan,
      }),
    ).rejects.toThrow(/invalid integration result/);
    const noOpProvider = {
      ...provider,
      applyAuthorizedIntegration: async () => ({
        schema_version: 1 as const,
        binding_id: plan.binding.binding_id,
        plan_id: plan.plan_id,
        status: "applied" as const,
        target_commit: plan.provider_preview.source_commit,
        target_tree: plan.provider_preview.source_tree,
        applied_at: new Date().toISOString(),
      }),
    };
    await expect(
      applyIntegration({
        coordRoot: repo,
        runId: report.runId,
        provider: noOpProvider,
        plan,
      }),
    ).rejects.toThrow(/reattached target state/);
    expect(
      existsSync(join(repo, ".harnery", "workflows", report.runId, "integration", "receipt.json")),
    ).toBe(false);
    const first = await applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan });
    expect(first.status).toBe("applied");
    const runDir = join(repo, ".harnery", "workflows", report.runId);
    expect(
      deriveWorkspaceLifecycle({
        binding: plan.binding,
        provider_events: readWorkspaceEvents(
          repo,
          plan.binding.provider.id,
          plan.binding.binding_id,
        ),
        proof: readWorkflowProof(repo, report.runId),
        proof_sha256: fileSha256(join(runDir, "proof.json")),
        integration_plan: plan,
        integration_authorization: readWorkflowSupplement<IntegrationAuthorization>(
          repo,
          report.runId,
          "integration/authorization.json",
        ),
        integration_attempts: readIntegrationAttempts(repo, report.runId),
        integration_receipt: first,
      }),
    ).toMatchObject({
      state: "integrated",
      integration_state: "applied",
    });
    expect(readFileSync(join(repo, "result.txt"), "utf8")).toBe("integrated\n");
    const dirtyPath = join(repo, "dirty-after-apply.txt");
    writeFileSync(dirtyPath, "dirty\n");
    await expect(
      applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
    ).rejects.toThrow(/blocked|clean/);
    rmSync(dirtyPath);
    const replay = await applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan });
    expect(replay).toEqual(first);
    const attemptsPath = join(
      repo,
      ".harnery",
      "workflows",
      report.runId,
      "integration",
      "attempts.jsonl",
    );
    const attemptsBody = readFileSync(attemptsPath, "utf8");
    writeFileSync(attemptsPath, `${attemptsBody}{corrupt\n`);
    await expect(
      applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
    ).rejects.toThrow(/cannot parse integration attempt/);
    writeFileSync(attemptsPath, attemptsBody);
    const planPath = join(repo, ".harnery", "workflows", report.runId, "integration", "plan.json");
    const planBody = readFileSync(planPath, "utf8");
    writeFileSync(planPath, "{corrupt\n");
    await expect(
      applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
    ).rejects.toThrow(/cannot parse/);
    writeFileSync(planPath, planBody);

    const authorizationPath = join(
      repo,
      ".harnery",
      "workflows",
      report.runId,
      "integration",
      "authorization.json",
    );
    const authorizationBody = readFileSync(authorizationPath, "utf8");
    writeFileSync(authorizationPath, "{corrupt\n");
    await expect(
      applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
    ).rejects.toThrow(/cannot parse/);
    writeFileSync(authorizationPath, authorizationBody);

    const journalPath = join(repo, ".harnery", "workflows", report.runId, "journal.jsonl");
    const journalBody = readFileSync(journalPath, "utf8");
    writeFileSync(journalPath, `${journalBody}{corrupt\n`);
    await expect(
      applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
    ).rejects.toThrow(/workflow journal is corrupt/);
    writeFileSync(journalPath, journalBody);

    const receiptPath = join(
      repo,
      ".harnery",
      "workflows",
      report.runId,
      "integration",
      "receipt.json",
    );
    expect(readFileSync(receiptPath, "utf8")).toContain(first.receipt_id);
    writeFileSync(receiptPath, "{corrupt\n");
    await expect(
      applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
    ).rejects.toThrow(/cannot parse/);
  });

  test("reconciles a crash after Git mutation without applying a second fast-forward", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-integration-crash-after-apply");
    roots.push(host);
    const script = writeScript(
      repo,
      "export default async ({ agent }) => { await agent('produce'); return 'ready'; };\n",
    );
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    const report = await runWorkflow(script, {
      coordRoot: repo,
      cwd: repo,
      spawners: {
        "claude-code": async (request) => {
          writeFileSync(join(request.cwd, "result.txt"), "reconciled\n");
          git(request.cwd, "add", "result.txt");
          git(request.cwd, "commit", "-qm", "workspace result");
          return { ok: true, text: "done", durationMs: 1, costUsd: 0, sessionId: "fixture" };
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
      policy: { external_actions: "allow", allowed_isolation: ["worktree"], allowed_paths: [repo] },
      acceptedUnknowns: ["network_not_attested"],
    });
    let providerMutations = 0;
    const interrupted = {
      ...provider,
      applyAuthorizedIntegration: async (
        input: Parameters<typeof provider.applyAuthorizedIntegration>[0],
      ) => {
        providerMutations++;
        await provider.applyAuthorizedIntegration(input);
        throw new Error("simulated crash after Git mutation");
      },
    };
    await expect(
      applyIntegration({ coordRoot: repo, runId: report.runId, provider: interrupted, plan }),
    ).rejects.toThrow(/simulated crash/);
    expect(providerMutations).toBe(1);
    expect(git(repo, "rev-parse", "HEAD")).toBe(plan.provider_preview.source_commit);
    expect(
      existsSync(join(repo, ".harnery", "workflows", report.runId, "integration", "receipt.json")),
    ).toBe(false);

    const reconciled = await applyIntegration({
      coordRoot: repo,
      runId: report.runId,
      provider,
      plan,
    });
    expect(reconciled.status).toBe("already_applied");
    expect(reconciled.target_commit).toBe(plan.provider_preview.source_commit);
    const attempts = readFileSync(
      join(repo, ".harnery", "workflows", report.runId, "integration", "attempts.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).status);
    expect(attempts).toEqual(["started", "started", "already_applied"]);
    expect(
      await applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
    ).toEqual(reconciled);
  });

  test("blocks divergent target state before returning a prior receipt", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-integration-drift");
    roots.push(host);
    const script = writeScript(
      repo,
      "export default async ({ agent }) => { await agent('produce'); return 'ready'; };\n",
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
          return { ok: true, text: "done", durationMs: 1, costUsd: 0, sessionId: "fixture" };
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
      policy: { external_actions: "allow", allowed_isolation: ["worktree"], allowed_paths: [repo] },
      acceptedUnknowns: ["network_not_attested"],
    });
    await applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan });
    writeFileSync(join(repo, "after.txt"), "moved\n");
    git(repo, "add", "after.txt");
    git(repo, "commit", "-qm", "target moved");
    await expect(
      applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
    ).rejects.toThrow(/current target authority|no longer authorized|drifted|preview is blocked/);
  });

  test("rejects workspace commits created after terminal verification", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-integration-stale-proof");
    roots.push(host);
    const script = writeScript(repo, "export default async () => 'ready';\n");
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
    writeFileSync(join(report.workspaceBinding!.active_root, "unverified.txt"), "late\n");
    git(report.workspaceBinding!.active_root, "add", "unverified.txt");
    git(report.workspaceBinding!.active_root, "commit", "-qm", "unverified result");
    await expect(
      prepareIntegration({
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
      }),
    ).rejects.toThrow(/terminal proof|unverified/);
  });

  test("fails closed when work-linked review history is malformed", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-integration-work-history");
    roots.push(host);
    const script = writeScript(
      repo,
      `
        export const meta = { acceptance: [{ id: "tests", statement: "tests pass" }] };
        export default async ({ agent, evidence }) => {
          await agent("produce");
          evidence({ kind: "test", status: "passed", label: "unit", acceptanceIds: ["tests"] });
          return "ready";
        };
      `,
    );
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    createWorkItem({
      coordRoot: repo,
      id: "reviewed-work",
      title: "Reviewed work",
      objective: "Produce verified source",
      workflowPath: script,
    });
    const report = await runWorkItem({
      coordRoot: repo,
      workId: "reviewed-work",
      actor: "runner",
      engine: {
        cwd: repo,
        isolation: "worktree",
        workspace: { provider, writableRoots: [host] },
        spawners: {
          "claude-code": async (request) => {
            writeFileSync(join(request.cwd, "result.txt"), "integrated\n");
            git(request.cwd, "add", "result.txt");
            git(request.cwd, "commit", "-qm", "workspace result");
            return { ok: true, text: "done", durationMs: 1, costUsd: 0, sessionId: "fixture" };
          },
        },
        harnessEvidence: {
          "claude-code": { toolEvidence: { support: "supported" } },
        },
        ...quiet,
      },
    });
    acceptWorkItem(repo, "reviewed-work", { actor: "reviewer" });
    appendFileSync(join(repo, ".harnery", "work", "reviewed-work", "events.jsonl"), "{bad\n");
    await expect(
      prepareIntegration({
        coordRoot: repo,
        runId: report.runId,
        provider,
        policy: {
          external_actions: "allow",
          allowed_isolation: ["worktree"],
          allowed_paths: [repo],
        },
        acceptedUnknowns: ["network_not_attested"],
      }),
    ).rejects.toThrow(/cannot parse|invalid JSON/);
  });

  test("rejects a work acceptance superseded after integration planning", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-integration-reopened");
    roots.push(host);
    const script = writeScript(
      repo,
      `
        export const meta = { acceptance: [{ id: "tests", statement: "tests pass" }] };
        export default async ({ agent, evidence }) => {
          await agent("produce");
          evidence({ kind: "test", status: "passed", label: "unit", acceptanceIds: ["tests"] });
          return "ready";
        };
      `,
    );
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    createWorkItem({
      coordRoot: repo,
      id: "reopened-work",
      title: "Reopened work",
      objective: "Produce verified source",
      workflowPath: script,
    });
    const report = await runWorkItem({
      coordRoot: repo,
      workId: "reopened-work",
      actor: "runner",
      engine: {
        cwd: repo,
        isolation: "worktree",
        workspace: { provider, writableRoots: [host] },
        spawners: {
          "claude-code": async (request) => {
            writeFileSync(join(request.cwd, "result.txt"), "integrated\n");
            git(request.cwd, "add", "result.txt");
            git(request.cwd, "commit", "-qm", "workspace result");
            return { ok: true, text: "done", durationMs: 1, costUsd: 0, sessionId: "fixture" };
          },
        },
        harnessEvidence: {
          "claude-code": { toolEvidence: { support: "supported" } },
        },
        ...quiet,
      },
    });
    const accepted = acceptWorkItem(repo, "reopened-work", {
      actor: "reviewer",
      acceptedUnknowns: ["network_not_attested"],
    });
    const acceptance = [...accepted.events]
      .reverse()
      .find((event) => event.event === "work.accepted");
    const terminalProof = JSON.parse(readFileSync(report.proofPath, "utf8"));
    expect(accepted.projection.attempts_used).toBe(1);
    expect(acceptance).toMatchObject({
      run_id: report.runId,
      attempt: 1,
      workspace_binding_id: report.workspaceBinding?.binding_id,
      proof_sha256: fileSha256(report.proofPath),
      terminal_attestation_sha256: stableDigest(terminalProof.execution.terminal_attestation),
      accepted_unknowns: ["network_not_attested"],
    });
    expect(existsSync(join(repo, ".harnery", "work", "reopened-work", "lease.json"))).toBe(false);
    expect(existsSync(join(repo, ".harnery", "work", "reopened-work", "events.lease.json"))).toBe(
      false,
    );
    const plan = await prepareIntegration({
      coordRoot: repo,
      runId: report.runId,
      provider,
      policy: {
        external_actions: "allow",
        allowed_isolation: ["worktree"],
        allowed_paths: [repo],
      },
      acceptedUnknowns: ["network_not_attested"],
    });

    reopenWorkItem(repo, "reopened-work", { actor: "reviewer", reason: "review superseded" });
    await expect(
      applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
    ).rejects.toThrow(/acceptance disappeared/);
    expect(existsSync(join(repo, "result.txt"))).toBe(false);
  });

  test("rejects source-root authority loss before prepare, apply, and receipt replay", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-integration-source-replacement");
    roots.push(host);
    const script = writeScript(
      repo,
      `
        export const meta = { acceptance: [{ id: "tests", statement: "tests pass" }] };
        export default async ({ agent, evidence }) => {
          await agent("produce");
          evidence({ kind: "test", status: "passed", label: "unit", acceptanceIds: ["tests"] });
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
      isolation: "worktree",
      workspace: { provider, writableRoots: [host] },
      spawners: {
        "claude-code": async (request) => {
          writeFileSync(join(request.cwd, "result.txt"), "integrated\n");
          git(request.cwd, "add", "result.txt");
          git(request.cwd, "commit", "-qm", "workspace result");
          return { ok: true, text: "done", durationMs: 1, costUsd: 0, sessionId: "fixture" };
        },
      },
      harnessEvidence: {
        "claude-code": { toolEvidence: { support: "supported" } },
      },
      ...quiet,
    });
    const prepare = () =>
      prepareIntegration({
        coordRoot: repo,
        runId: report.runId,
        provider,
        review: { actor: "reviewer" },
        policy: {
          external_actions: "allow",
          allowed_isolation: ["worktree"] as const,
          allowed_paths: [repo],
        },
        acceptedUnknowns: ["network_not_attested"],
      });

    let restore = replaceSourceCheckout(repo);
    try {
      await expect(prepare()).rejects.toThrow(/source repository identity/);
      expect(existsSync(join(repo, "result.txt"))).toBe(false);
    } finally {
      restore();
    }

    const plan = await prepare();
    restore = replaceSourceCheckout(repo);
    try {
      await expect(
        applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
      ).rejects.toThrow(/source repository identity/);
      expect(
        existsSync(
          join(repo, ".harnery", "workflows", report.runId, "integration", "receipt.json"),
        ),
      ).toBe(false);
    } finally {
      restore();
    }

    const first = await applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan });
    const targetCommit = git(repo, "rev-parse", "HEAD");
    const receiptPath = join(
      repo,
      ".harnery",
      "workflows",
      report.runId,
      "integration",
      "receipt.json",
    );
    const receiptBytes = readFileSync(receiptPath, "utf8");
    restore = replaceSourceCheckout(repo);
    try {
      await expect(
        applyIntegration({ coordRoot: repo, runId: report.runId, provider, plan }),
      ).rejects.toThrow(/source repository identity/);
      expect(readFileSync(receiptPath, "utf8")).toBe(receiptBytes);
    } finally {
      restore();
    }
    expect(git(repo, "rev-parse", "HEAD")).toBe(targetCommit);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(first);
  });
});
