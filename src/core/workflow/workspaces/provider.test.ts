import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import {
  git,
  gitFixture,
  hasGit,
  quiet,
  replaceSourceCheckout,
  tempRoot,
  writeScript,
} from "../../../../tests/workspace-test-helpers.ts";
import {
  cancelWorkItem,
  createWorkItem,
  readWorkItem,
  reopenWorkItem,
  runWorkItem,
} from "../../work/index.ts";
import { resolveWorkflowApproval } from "../approvals.ts";
import { runWorkflow, WorkflowParkedError, WorkflowRunError } from "../engine.ts";
import { readWorkflowProof } from "../proof.ts";
import type { WorkflowProof } from "../types.ts";
import { cancelWorkspace } from "./cancellation.ts";
import { cleanupWorkspace } from "./cleanup.ts";
import { acquireNoClobberLease } from "./leases.ts";
import { deriveWorkspaceLifecycle } from "./lifecycle.ts";
import { createLocalGitWorktreeProvider } from "./local-git.ts";
import { filesystemIdentity, validateConfiguredRoot } from "./paths.ts";
import {
  appendWorkspaceEvent,
  readCleanupAttempts,
  readWorkspaceEvents,
  readWorkspaceRequest,
  stableDigest,
  type WorkspaceClaim,
  type WorkspaceProviderEvent,
  workspaceBindingPath,
  workspaceClaimPath,
  workspaceLockPath,
  writeWorkspaceClaim,
} from "./state.ts";
import type {
  WorkspaceAllocationRequest,
  WorkspaceBoundExecutionEvidence,
  WorkspaceCleanupIntent,
  WorkspaceProvider,
} from "./types.ts";
import {
  assertWorkspaceManifestAuthority,
  isWorkspaceAttestation,
  isWorkspaceBoundExecutionEvidence,
} from "./validate.ts";

const roots: string[] = [];
type ContradictableExecution = Omit<WorkspaceBoundExecutionEvidence, "terminal_lifecycle_state"> & {
  terminal_lifecycle_state: string;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared and explicit-provider compatibility", () => {
  test("shared execution creates no provider records", async () => {
    const root = tracked(tempRoot("workspace-shared"));
    const script = writeScript(root, "export default async () => 'shared';\n");
    const report = await runWorkflow(script, { coordRoot: root, spawners: {}, ...quiet });
    const proof = JSON.parse(readFileSync(report.proofPath, "utf8")) as WorkflowProof;
    expect(report.workspaceBinding).toBeUndefined();
    expect(proof.execution).toBeUndefined();
    expect(existsSync(join(root, ".harnery", "workspaces"))).toBe(false);
    expect(
      existsSync(join(root, ".harnery", "workflows", report.runId, "workspace-request.json")),
    ).toBe(false);

    proof.execution = {
      schema_version: 1,
      run_id: report.runId,
      requested_isolation: "worktree",
      effective_isolation: "shared",
      selection_reason: "provider_not_configured",
      terminal_lifecycle_state: "shared",
      drift: [],
      unsupported: [
        { code: "provider_not_configured", message: "no workspace provider is configured" },
      ],
      unknowns: [],
      receipts: {},
    };
    writeFileSync(report.proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    expect(() => readWorkflowProof(root, report.runId)).toThrow(
      /does not match the frozen execution manifest/,
    );
  });

  test("provider-absent non-shared execution records explicit shared compatibility", async () => {
    const root = tracked(tempRoot("workspace-declaration"));
    const script = writeScript(root, "export default async ({ agent }) => agent('cwd');\n");
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: {
        "claude-code": async (request) => ({
          ok: true,
          text: request.cwd,
          durationMs: 1,
        }),
      },
      isolation: "worktree",
      ...quiet,
    });
    expect(report.result).toBe(root);
    expect(report.workspaceBinding).toBeUndefined();
    expect(existsSync(join(root, ".harnery", "workspaces"))).toBe(false);
    expect(
      existsSync(join(root, ".harnery", "workflows", report.runId, "workspace-request.json")),
    ).toBe(false);
    const proof = readWorkflowProof(root, report.runId);
    expect(proof.execution).toEqual({
      schema_version: 1,
      run_id: report.runId,
      requested_isolation: "worktree",
      effective_isolation: "shared",
      selection_reason: "provider_not_configured",
      terminal_lifecycle_state: "shared",
      drift: [],
      unsupported: [
        {
          code: "provider_not_configured",
          message: "no workspace provider is configured; shared execution was selected",
        },
      ],
      unknowns: [],
      receipts: {},
    });
    const manifest = JSON.parse(
      readFileSync(join(root, ".harnery", "workflows", report.runId, "run.json"), "utf8"),
    );
    expect(manifest.execution.workspace_fallback).toEqual(proof.execution);
    expect(readFileSync(report.journalPath, "utf8")).toContain('"event":"workspace.compatibility"');
  });

  test("unsupported providers fall back only when frozen policy allows shared execution", async () => {
    const root = tracked(tempRoot("workspace-fallback"));
    const script = writeScript(
      root,
      `
        export default async ({ agent, authorize }) => {
          const cwd = await agent("cwd");
          await authorize({ action: "write fallback marker", path: "fallback.txt" });
          return cwd;
        };
      `,
    );
    let probes = 0;
    let allocations = 0;
    const provider: WorkspaceProvider = {
      probe: async () => {
        probes++;
        return {
          schema_version: 1,
          supported: false,
          capabilities: {
            schema_version: 1,
            provider_id: "unsupported-test",
            provider_version: "1",
            isolation: ["worktree"],
            reattach: "unsupported",
            cancellation: "unsupported",
            cleanup: "unsupported",
            integration: [],
            network_attestation: "unsupported",
            filesystem_identity: "unsupported",
            capability_digest: "a".repeat(64),
          },
          unsupported: [{ code: "unavailable", message: "provider unavailable" }],
          unknowns: [{ code: "probe_incomplete", message: "probe could not inspect the host" }],
        };
      },
      allocate: async () => {
        allocations++;
        throw new Error("allocation must not run");
      },
      readBinding: async () => {
        throw new Error("readBinding must not run");
      },
      reattach: async () => {
        throw new Error("reattach must not run");
      },
      attest: async () => {
        throw new Error("attest must not run");
      },
      cancel: async () => {
        throw new Error("cancel must not run");
      },
      previewIntegration: async () => {
        throw new Error("previewIntegration must not run");
      },
      applyAuthorizedIntegration: async () => {
        throw new Error("applyAuthorizedIntegration must not run");
      },
      cleanup: async () => {
        throw new Error("cleanup must not run");
      },
    };
    const spawners = {
      "claude-code": async (request: { cwd: string }) => ({
        ok: true as const,
        text: request.cwd,
        durationMs: 1,
      }),
    };
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners,
      isolation: "worktree",
      policy: {
        allowed_isolation: ["shared"],
        allowed_paths: [root],
        network: "allow",
        external_actions: "allow",
      },
      workspace: { provider, writableRoots: [root] },
      ...quiet,
    });
    expect(report.result).toBe(root);
    expect(report.workspaceBinding).toBeUndefined();
    expect(probes).toBe(1);
    expect(allocations).toBe(0);
    expect(
      existsSync(join(root, ".harnery", "workflows", report.runId, "workspace-request.json")),
    ).toBe(false);
    expect(readFileSync(report.journalPath, "utf8")).toContain('"event":"workspace.fallback"');
    const proof = JSON.parse(readFileSync(report.proofPath, "utf8")) as WorkflowProof;
    expect(proof.execution).toEqual({
      schema_version: 1,
      run_id: report.runId,
      requested_isolation: "worktree",
      effective_isolation: "shared",
      selection_reason: "provider_unsupported",
      provider: {
        id: "unsupported-test",
        version: "1",
        capability_digest: "a".repeat(64),
      },
      terminal_lifecycle_state: "shared",
      drift: [],
      unsupported: [{ code: "unavailable", message: "provider unavailable" }],
      unknowns: [{ code: "probe_incomplete", message: "probe could not inspect the host" }],
      receipts: {},
    });
    expect(proof.policy?.isolation).toBe("shared");
    expect(proof.policy?.decisions.map((decision) => decision.phase)).toEqual([
      "dispatch",
      "external_mutation",
    ]);
    expect(
      proof.policy?.decisions.every((decision) => decision.request.isolation === "shared"),
    ).toBe(true);
    expect(
      (
        JSON.parse(
          readFileSync(join(root, ".harnery", "workflows", report.runId, "run.json"), "utf8"),
        ) as {
          execution: {
            isolation: string;
            workspace_fallback: unknown;
          };
        }
      ).execution.isolation,
    ).toBe("worktree");
    expect(
      (
        JSON.parse(
          readFileSync(join(root, ".harnery", "workflows", report.runId, "run.json"), "utf8"),
        ) as { execution: { workspace_fallback: unknown } }
      ).execution.workspace_fallback,
    ).toEqual(proof.execution);
    expect(readWorkflowProof(root, report.runId).execution).toEqual(proof.execution);

    await expect(
      runWorkflow(script, {
        coordRoot: root,
        runId: "wf-fallback-denied",
        spawners,
        isolation: "worktree",
        policy: { allowed_isolation: ["worktree"], network: "allow" },
        workspace: { provider, writableRoots: [root] },
        ...quiet,
      }),
    ).rejects.toThrow(/does not support worktree/);
    expect(allocations).toBe(0);
  });

  test("records terminal evidence for module import and metadata failures before cleanup", async () => {
    if (!hasGit()) return;
    for (const [suffix, body, message] of [
      ["import", "export default async () => {\n", /Unexpected|expected/i],
      [
        "metadata",
        "export const meta = { acceptance: 'invalid' }; export default async () => 'no';\n",
        /acceptance must be an array/,
      ],
    ] as const) {
      const { host, repo } = gitFixture(`workspace-initialization-${suffix}`);
      tracked(host);
      const script = writeScript(repo, body);
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "workflow");
      const runId = `wf-initialization-${suffix}`;
      const local = createLocalGitWorktreeProvider({ coordRoot: repo });
      let reattachCalls = 0;
      const provider: WorkspaceProvider = {
        ...local,
        reattach: async (binding) => {
          reattachCalls++;
          if (reattachCalls === 2) {
            expect(existsSync(join(repo, ".harnery", "workflows", runId, "run.json"))).toBe(true);
          }
          return local.reattach(binding);
        },
      };
      let failure: unknown;
      try {
        await runWorkflow(script, {
          coordRoot: repo,
          runId,
          cwd: repo,
          spawners: {},
          isolation: "worktree",
          workspace: { provider, writableRoots: [host] },
          ...quiet,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(WorkflowRunError);
      expect((failure as Error).message).toMatch(message);
      expect(reattachCalls).toBe(2);
      expect(existsSync(join(repo, ".harnery", "workflows", runId, "run.json"))).toBe(true);
      const journal = readFileSync(
        join(repo, ".harnery", "workflows", runId, "journal.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(journal.some((event) => event.event === "workspace.reattach.module_initialized")).toBe(
        true,
      );
      const proof = JSON.parse(
        readFileSync(join(repo, ".harnery", "workflows", runId, "proof.json"), "utf8"),
      ) as WorkflowProof;
      expect(proof.run.status).toBe("failed");
      expect(boundExecution(proof).binding.run_id).toBe(runId);
      expect(proof.execution?.terminal_lifecycle_state).toBe("failed_retained");
      expect((await cleanupWorkspace({ coordRoot: repo, runId, provider })).status).toBe(
        "released",
      );
    }
  });

  test("preserves the blocked terminal attestation that fails a run", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-terminal-attestation");
    tracked(host);
    const script = writeScript(repo, "export default async () => 'isolated';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const runId = "wf-terminal-attestation";
    const local = createLocalGitWorktreeProvider({ coordRoot: repo });
    let attestCalls = 0;
    const provider: WorkspaceProvider = {
      ...local,
      attest: async (binding) => {
        attestCalls++;
        const attestation = await local.attest(binding);
        return attestCalls === 1
          ? {
              ...attestation,
              status: "blocked",
              resource_state: "blocked",
              provider_drift: ["terminal workspace authority could not be proved"],
            }
          : attestation;
      },
    };

    await expect(
      runWorkflow(script, {
        coordRoot: repo,
        runId,
        cwd: repo,
        spawners: {},
        isolation: "worktree",
        workspace: { provider, writableRoots: [host] },
        ...quiet,
      }),
    ).rejects.toBeInstanceOf(WorkflowRunError);

    const proof = readWorkflowProof(repo, runId);
    const attestation = boundExecution(proof).terminal_attestation;
    expect(attestCalls).toBe(1);
    expect(proof.run.status).toBe("failed");
    expect(attestation.status).toBe("blocked");
    expect(attestation.provider_drift).toEqual([
      "terminal workspace authority could not be proved",
    ]);
    expect(proof.execution?.terminal_lifecycle_state).toBe("blocked");
  });

  test("post-import reattachment failure still writes a fallback manifest and proof", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-post-import-failure");
    tracked(host);
    const script = writeScript(repo, "export default async ({ agent }) => agent('never');\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const runId = "wf-post-import-reattach-failure";
    const local = createLocalGitWorktreeProvider({ coordRoot: repo });
    let reattachCalls = 0;
    let spawnCalls = 0;
    let restoreSource: (() => void) | undefined;
    const provider: WorkspaceProvider = {
      ...local,
      reattach: async (binding) => {
        reattachCalls++;
        if (reattachCalls === 2) restoreSource = replaceSourceCheckout(repo);
        return local.reattach(binding);
      },
    };
    try {
      await expect(
        runWorkflow(script, {
          coordRoot: repo,
          runId,
          cwd: repo,
          spawners: {
            "claude-code": async () => {
              spawnCalls++;
              return { ok: true, text: "unexpected", durationMs: 1 };
            },
          },
          isolation: "worktree",
          workspace: { provider, writableRoots: [host] },
          ...quiet,
        }),
      ).rejects.toBeInstanceOf(WorkflowRunError);
      expect(spawnCalls).toBe(0);
      expect(existsSync(join(repo, ".harnery", "workflows", runId, "run.json"))).toBe(true);
      const proof = JSON.parse(
        readFileSync(join(repo, ".harnery", "workflows", runId, "proof.json"), "utf8"),
      ) as WorkflowProof;
      const attestation = boundExecution(proof).terminal_attestation;
      expect(proof.run.status).toBe("failed");
      expect(attestation.status).toBe("blocked");
      expect(attestation.workspace_exists).toBe(true);
      expect(attestation.repository?.source_root.realpath).toBe(repo);
      expect(attestation.repository?.source_root.identity).not.toEqual(
        boundExecution(proof).binding.repository?.source_root.identity,
      );
      expect(attestation.repository?.current_ref).toBeUndefined();
      expect(attestation.provider_drift).toContain("source repository identity mismatch");
      expect(proof.execution?.terminal_lifecycle_state).toBe("blocked");
      expect(
        readFileSync(join(repo, ".harnery", "workflows", runId, "journal.jsonl"), "utf8"),
      ).toContain('"event":"workspace.reattach.module_initialization_failed"');
    } finally {
      restoreSource?.();
    }
  });

  test("rejects provider paths outside the sole explicit writable root", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-authority");
    tracked(host);
    const allowed = join(host, "allowed");
    mkdirSync(allowed);
    const script = writeScript(repo, "export default async () => 'isolated';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const local = createLocalGitWorktreeProvider({ coordRoot: repo });
    const provider: WorkspaceProvider = {
      ...local,
      allocate: async (request) => ({
        ...(await local.allocate(request)),
        workspace_root: repo,
        active_root: repo,
      }),
    };
    await expect(
      runWorkflow(script, {
        coordRoot: repo,
        cwd: repo,
        spawners: {},
        isolation: "worktree",
        workspace: { provider, writableRoots: [allowed] },
        ...quiet,
      }),
    ).rejects.toThrow(
      /writable-root authority|inside the writable root|escapes|immutable provider binding/,
    );
  });

  test("rejects workspace allocation outside frozen policy path authority", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-policy-authority");
    tracked(host);
    const script = writeScript(repo, "export default async () => 'isolated';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });

    await expect(
      runWorkflow(script, {
        coordRoot: repo,
        cwd: repo,
        spawners: {},
        isolation: "worktree",
        policy: { allowed_paths: [repo], allowed_isolation: ["worktree"] },
        workspace: { provider, writableRoots: [host] },
        ...quiet,
      }),
    ).rejects.toThrow(/writable root.*outside frozen path authority/);
    expect(existsSync(join(host, "harnery-workspaces"))).toBe(false);
  });

  test("revalidates frozen policy path authority before workspace cleanup", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-cleanup-policy-authority");
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
      policy: { allowed_paths: [host], allowed_isolation: ["worktree"] },
      workspace: { provider, writableRoots: [host] },
      ...quiet,
    });
    const manifestPath = join(repo, ".harnery", "workflows", report.runId, "run.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.execution.policy.allowed_paths = [repo];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    let providerCalled = false;
    const observing: WorkspaceProvider = {
      ...provider,
      attest: async (binding) => {
        providerCalled = true;
        return provider.attest(binding);
      },
    };

    await expect(
      cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider: observing }),
    ).rejects.toThrow(/manifest, workspace request, and provider binding disagree/);
    expect(providerCalled).toBe(false);
    expect(existsSync(report.workspaceBinding!.workspace_root)).toBe(true);
  });

  test("historical declaration-only non-shared resume retains its frozen cwd", async () => {
    const root = tracked(tempRoot("workspace-historical"));
    const script = writeScript(root, "export default async ({ agent }) => agent('resume');\n");
    let parked: WorkflowParkedError | undefined;
    try {
      await runWorkflow(script, {
        coordRoot: root,
        spawners: { "claude-code": async () => ({ ok: true, text: "done", durationMs: 1 }) },
        policy: { network: "ask" },
        networkAccess: "enabled",
        approvalMode: "park",
        ...quiet,
      });
    } catch (error) {
      parked = error as WorkflowParkedError;
    }
    expect(parked).toBeInstanceOf(WorkflowParkedError);
    const manifestPath = join(root, ".harnery", "workflows", parked!.runId, "run.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.execution.isolation = "worktree";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const approvalPath = join(root, ".harnery", "approvals", parked!.approvalId, "request.json");
    const approval = JSON.parse(readFileSync(approvalPath, "utf8"));
    approval.request.isolation = "worktree";
    approval.request_sha256 = createHash("sha256")
      .update(
        JSON.stringify({
          policy_sha256: approval.policy.sha256,
          request: approval.request,
          evaluation: approval.evaluation,
        }),
      )
      .digest("hex");
    writeFileSync(approvalPath, `${JSON.stringify(approval, null, 2)}\n`);
    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: parked!.approvalId,
      verdict: "allow",
      actor: "operator",
    });
    const report = await runWorkflow(script, {
      coordRoot: root,
      resumeRunId: parked!.runId,
      spawners: {
        "claude-code": async (request) => ({ ok: true, text: request.cwd, durationMs: 1 }),
      },
      ...quiet,
    });
    expect(report.result).toBe(root);
    expect(report.workspaceBinding).toBeUndefined();
    expect(existsSync(join(root, ".harnery", "workspaces"))).toBe(false);
  });

  test("bound resume without its provider fails before import or spawn and retains binding", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-resume-provider-required");
    tracked(host);
    const importMarker = join(repo, "imports.log");
    const script = writeScript(
      repo,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(importMarker)}, "imported\\n");
export default async ({ authorize, agent }) => {
  await authorize({ action: "resume-provider", path: ".", network: true });
  return agent("resume");
};
`,
    );
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    let parked: WorkflowParkedError | undefined;
    try {
      await runWorkflow(script, {
        coordRoot: repo,
        cwd: repo,
        isolation: "worktree",
        networkAccess: "enabled",
        approvalMode: "park",
        policy: { external_actions: "ask", network: "allow", allowed_paths: [host] },
        workspace: { provider, writableRoots: [host] },
        spawners: {
          "claude-code": async () => ({ ok: true, text: "unexpected", durationMs: 1 }),
        },
        ...quiet,
      });
    } catch (error) {
      parked = error as WorkflowParkedError;
    }
    expect(parked).toBeInstanceOf(WorkflowParkedError);
    const manifest = JSON.parse(
      readFileSync(join(repo, ".harnery", "workflows", parked!.runId, "run.json"), "utf8"),
    );
    const frozenBinding = manifest.execution.workspace_binding;
    resolveWorkflowApproval({
      coordRoot: repo,
      approvalId: parked!.approvalId,
      verdict: "allow",
      actor: "operator",
    });
    let spawns = 0;
    await expect(
      runWorkflow(script, {
        coordRoot: repo,
        resumeRunId: parked!.runId,
        spawners: {
          "claude-code": async () => {
            spawns++;
            return { ok: true, text: "unexpected", durationMs: 1 };
          },
        },
        ...quiet,
      }),
    ).rejects.toThrow(/requires the frozen workspace provider/);
    expect(spawns).toBe(0);
    expect(readFileSync(importMarker, "utf8").trim().split("\n")).toHaveLength(1);
    const proof = JSON.parse(
      readFileSync(join(repo, ".harnery", "workflows", parked!.runId, "proof.json"), "utf8"),
    ) as WorkflowProof;
    expect(proof.run.status).toBe("failed");
    expect(boundExecution(proof).binding).toEqual(frozenBinding);
    expect(["blocked", "lost"]).toContain(boundExecution(proof).terminal_lifecycle_state);
  });

  test("records terminal evidence when isolated parked resume cannot reattach", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-resume-reattach-failure");
    tracked(host);
    const script = writeScript(repo, "export default async ({ agent }) => agent('resume');\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    createWorkItem({
      coordRoot: repo,
      id: "reattach-work",
      title: "Reattach work",
      objective: "Resume in the frozen workspace",
      workflowPath: script,
      maxAttempts: 2,
    });
    let parked: WorkflowParkedError | undefined;
    try {
      await runWorkItem({
        coordRoot: repo,
        workId: "reattach-work",
        engine: {
          cwd: repo,
          isolation: "worktree",
          workspace: { provider, writableRoots: [host] },
          policy: { network: "ask", allowed_paths: [host] },
          networkAccess: "enabled",
          approvalMode: "park",
          spawners: {
            "claude-code": async () => ({ ok: true, text: "done", durationMs: 1 }),
          },
          ...quiet,
        },
      });
    } catch (error) {
      parked = error as WorkflowParkedError;
    }
    expect(parked).toBeInstanceOf(WorkflowParkedError);
    resolveWorkflowApproval({
      coordRoot: repo,
      approvalId: parked!.approvalId,
      verdict: "allow",
      actor: "operator",
    });

    await expect(
      runWorkItem({
        coordRoot: repo,
        workId: "reattach-work",
        engine: {
          cwd: repo,
          isolation: "worktree",
          workspace: { provider, writableRoots: [] },
          spawners: {
            "claude-code": async () => ({ ok: true, text: "done", durationMs: 1 }),
          },
          ...quiet,
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowRunError);
    const journal = readFileSync(
      join(repo, ".harnery", "workflows", parked!.runId, "journal.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(journal.some((event) => event.event === "run.resume")).toBe(true);
    expect(journal.some((event) => event.event === "workspace.reattach.failed")).toBe(true);
    expect(journal.at(-1)?.event).toBe("run.end");
    const proof = JSON.parse(
      readFileSync(join(repo, ".harnery", "workflows", parked!.runId, "proof.json"), "utf8"),
    ) as WorkflowProof;
    expect(proof.run.status).toBe("failed");
    const attestation = boundExecution(proof).terminal_attestation;
    expect(attestation.status).toBe("blocked");
    expect(attestation.workspace_exists).toBe(true);
    expect(attestation.repository?.source_root.identity).toEqual(
      boundExecution(proof).binding.repository?.source_root.identity,
    );
    expect(attestation.repository?.current_ref).toBe(
      boundExecution(proof).binding.repository?.workspace_ref,
    );
    expect(attestation.provider_drift).toContain(
      "isolated workflow resume requires explicit writable roots",
    );
    expect(proof.execution?.terminal_lifecycle_state).toBe("blocked");
    expect(readWorkItem(repo, "reattach-work").projection).toMatchObject({
      state: "blocked",
      next_action: "retry",
    });
  });

  test("blocks parked resume after source-root replacement without spawning or a new attempt", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-resume-source-replacement");
    tracked(host);
    const script = writeScript(repo, "export default async ({ agent }) => agent('resume');\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    createWorkItem({
      coordRoot: repo,
      id: "source-replacement-work",
      title: "Source replacement work",
      objective: "Resume only with frozen repository authority",
      workflowPath: script,
      maxAttempts: 2,
    });
    let parked: WorkflowParkedError | undefined;
    try {
      await runWorkItem({
        coordRoot: repo,
        workId: "source-replacement-work",
        engine: {
          cwd: repo,
          isolation: "worktree",
          workspace: { provider, writableRoots: [host] },
          policy: { network: "ask", allowed_paths: [host] },
          networkAccess: "enabled",
          approvalMode: "park",
          spawners: {
            "claude-code": async () => ({ ok: true, text: "done", durationMs: 1 }),
          },
          ...quiet,
        },
      });
    } catch (error) {
      parked = error as WorkflowParkedError;
    }
    expect(parked).toBeInstanceOf(WorkflowParkedError);
    resolveWorkflowApproval({
      coordRoot: repo,
      approvalId: parked!.approvalId,
      verdict: "allow",
      actor: "operator",
    });
    const attemptsBefore = readWorkItem(repo, "source-replacement-work").events.filter(
      (event) => event.event === "attempt.started",
    ).length;
    let spawns = 0;
    const restore = replaceSourceCheckout(repo);
    try {
      await expect(
        runWorkItem({
          coordRoot: repo,
          workId: "source-replacement-work",
          engine: {
            cwd: repo,
            isolation: "worktree",
            workspace: { provider, writableRoots: [host] },
            spawners: {
              "claude-code": async () => {
                spawns++;
                return { ok: true, text: "done", durationMs: 1 };
              },
            },
            ...quiet,
          },
        }),
      ).rejects.toBeInstanceOf(WorkflowRunError);
      expect(spawns).toBe(0);
      expect(
        readWorkItem(repo, "source-replacement-work").events.filter(
          (event) => event.event === "attempt.started",
        ).length,
      ).toBe(attemptsBefore);
      const proof = readWorkflowProof(repo, parked!.runId);
      const attestation = boundExecution(proof).terminal_attestation;
      expect(attestation.status).toBe("blocked");
      expect(attestation.workspace_exists).toBe(true);
      expect(attestation.repository?.source_root.realpath).toBe(repo);
      expect(attestation.repository?.source_root.identity).not.toEqual(
        boundExecution(proof).binding.repository?.source_root.identity,
      );
      expect(attestation.repository?.common_dir).toEqual(
        boundExecution(proof).binding.repository?.common_dir,
      );
      expect(attestation.repository?.current_ref).toBeUndefined();
      expect(attestation.provider_drift.join(" ")).toMatch(/source repository identity/);
      expect(proof.execution?.terminal_lifecycle_state).toBe("blocked");
    } finally {
      restore();
    }
  });

  test("durably binds provider cancellation to current host cancellation", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-cancellation");
    tracked(host);
    const script = writeScript(repo, "export default async () => 'done';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    createWorkItem({
      coordRoot: repo,
      id: "cancelled-work",
      title: "Cancelled work",
      objective: "Exercise durable cancellation",
      workflowPath: script,
    });
    const report = await runWorkItem({
      coordRoot: repo,
      workId: "cancelled-work",
      engine: {
        cwd: repo,
        isolation: "worktree",
        workspace: { provider, writableRoots: [host] },
        spawners: {},
        ...quiet,
      },
    });
    cancelWorkItem(repo, "cancelled-work", { actor: "operator" });
    const receipt = await cancelWorkspace({
      coordRoot: repo,
      runId: report.runId,
      provider,
    });
    expect(receipt.status).toBe("cancelled");
    expect(
      existsSync(join(repo, ".harnery", "workflows", report.runId, "cancellation", "outcome.json")),
    ).toBe(true);
    expect(await cancelWorkspace({ coordRoot: repo, runId: report.runId, provider })).toEqual(
      receipt,
    );

    const binding = report.workspaceBinding!;
    const providerEvents = readWorkspaceEvents(repo, binding.provider.id, binding.binding_id);
    expect(
      deriveWorkspaceLifecycle({
        binding,
        provider_events: providerEvents,
        work_events: readWorkItem(repo, "cancelled-work").events,
        cancellation_receipt: receipt,
      }).cancellation,
    ).toBe("confirmed");

    reopenWorkItem(repo, "cancelled-work", { actor: "operator" });
    expect(
      deriveWorkspaceLifecycle({
        binding,
        provider_events: providerEvents,
        work_events: readWorkItem(repo, "cancelled-work").events,
        cancellation_receipt: receipt,
      }).cancellation,
    ).toBe("none");
    await expect(
      cancelWorkspace({ coordRoot: repo, runId: report.runId, provider }),
    ).rejects.toThrow(/current host work cancellation/);
  });

  test("records an explicit unsupported result for a running isolated attempt", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-running-cancellation");
    tracked(host);
    const script = writeScript(
      repo,
      "export default async ({ agent }) => agent('hold execution');\n",
    );
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    createWorkItem({
      coordRoot: repo,
      id: "running-cancellation",
      title: "Running cancellation",
      objective: "Record unsupported cooperative cancellation",
      workflowPath: script,
    });
    let entered!: () => void;
    const spawnerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let continueRun!: () => void;
    const providerMayFinish = new Promise<void>((resolve) => {
      continueRun = resolve;
    });
    const running = runWorkItem({
      coordRoot: repo,
      workId: "running-cancellation",
      engine: {
        cwd: repo,
        isolation: "worktree",
        workspace: { provider, writableRoots: [host] },
        spawners: {
          "claude-code": async () => {
            entered();
            await providerMayFinish;
            return { ok: true, text: "done", durationMs: 1 };
          },
        },
        ...quiet,
      },
    });

    try {
      await spawnerEntered;
      expect(readWorkItem(repo, "running-cancellation").projection.state).toBe("running");
      const cancelled = cancelWorkItem(repo, "running-cancellation", {
        actor: "operator",
        reason: "stop requested",
      });
      expect(cancelled.projection.state).toBe("cancelled");
      const receipt = await cancelWorkspace({
        coordRoot: repo,
        runId: cancelled.projection.latest_run_id!,
        provider,
      });
      expect(receipt.status).toBe("unsupported");
      expect(receipt.reason).toMatch(/no proven cooperative cancellation/);
    } finally {
      continueRun();
    }

    await running;
    const final = readWorkItem(repo, "running-cancellation");
    expect(final.projection.state).toBe("cancelled");
    expect(final.projection.attempts_used).toBe(1);
    expect(final.events.filter((event) => event.event === "work.cancelled")).toHaveLength(1);
  });

  test("does not cancel or clean up a resumed run without terminal proof", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-resumed-liveness");
    tracked(host);
    const script = writeScript(repo, "export default async () => 'isolated';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    const report = await runWorkflow(script, {
      coordRoot: repo,
      runId: "wf-resumed-liveness",
      cwd: repo,
      spawners: {},
      isolation: "worktree",
      workspace: { provider, writableRoots: [host] },
      ...quiet,
    });
    const binding = report.workspaceBinding!;
    rmSync(report.proofPath);
    writeFileSync(
      report.journalPath,
      [
        { event: "run.start", run_id: report.runId },
        { event: "run.parked", run_id: report.runId },
        { event: "run.resume", run_id: report.runId },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")
        .concat("\n"),
    );

    const cancellation = await provider.cancel(binding);
    expect(cancellation.status).toBe("unsupported");
    expect(cancellation.reason).toMatch(/active execution/);

    const current = await provider.attest(binding);
    const bindingSha256 = stableDigest(binding);
    const intent: WorkspaceCleanupIntent = {
      schema_version: 1,
      run_id: report.runId,
      operation_id: `cleanup-${stableDigest({
        binding: bindingSha256,
        mode: "normal",
      }).slice(0, 24)}`,
      binding_id: binding.binding_id,
      binding_sha256: bindingSha256,
      mode: "normal",
      expected: {
        worktree_path: binding.workspace_root,
        gitdir: binding.repository!.gitdir,
        workspace_ref: binding.repository!.workspace_ref,
        workspace_ref_oid: current.repository!.workspace_ref_oid!,
        target_ref: binding.repository!.target_ref,
        target_ref_oid: current.repository!.target_ref_oid!,
      },
      created_at: new Date().toISOString(),
    };
    const cleanup = await provider.cleanup(binding, intent);
    expect(cleanup.status).toBe("blocked");
    expect(cleanup.reason).toMatch(/live execution/);
    expect(existsSync(binding.workspace_root)).toBe(true);
  });

  test("cooperatively cancels a parked isolated attempt", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-parked-cancellation");
    tracked(host);
    const script = writeScript(repo, "export default async ({ agent }) => agent('park');\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    createWorkItem({
      coordRoot: repo,
      id: "parked-cancellation",
      title: "Parked cancellation",
      objective: "Cancel the isolated attempt while it is parked",
      workflowPath: script,
    });
    let parked: WorkflowParkedError | undefined;
    try {
      await runWorkItem({
        coordRoot: repo,
        workId: "parked-cancellation",
        engine: {
          cwd: repo,
          isolation: "worktree",
          workspace: { provider, writableRoots: [host] },
          policy: { network: "ask", allowed_paths: [host] },
          networkAccess: "enabled",
          approvalMode: "park",
          spawners: {
            "claude-code": async () => ({ ok: true, text: "unused", durationMs: 1 }),
          },
          ...quiet,
        },
      });
    } catch (error) {
      parked = error as WorkflowParkedError;
    }
    expect(parked).toBeInstanceOf(WorkflowParkedError);
    expect(readWorkItem(repo, "parked-cancellation").projection.state).toBe("awaiting_approval");

    const cancelled = cancelWorkItem(repo, "parked-cancellation", { actor: "operator" });
    const receipt = await cancelWorkspace({
      coordRoot: repo,
      runId: parked!.runId,
      provider,
    });
    expect(cancelled.projection.state).toBe("cancelled");
    expect(cancelled.projection.attempts_used).toBe(1);
    expect(receipt.status).toBe("cancelled");
    expect(await cancelWorkspace({ coordRoot: repo, runId: parked!.runId, provider })).toEqual(
      receipt,
    );
  });
});

describe("local Git worktree allocation and recovery", () => {
  test("rejects manifest substitution and proof contradictions across authority fields", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-authority-matrices");
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
    const runDir = join(repo, ".harnery", "workflows", report.runId);
    const manifest = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    const request = readWorkspaceRequest(repo, report.runId)!;
    const manifestSubstitutions: Array<[string, (candidate: typeof manifest) => void]> = [
      ["run", (candidate) => (candidate.run_id = "wf-foreign")],
      [
        "work item",
        (candidate) =>
          (candidate.execution.workspace_binding.owner = {
            kind: "work_attempt",
            work_item_id: "foreign-work",
            attempt: 1,
          }),
      ],
      [
        "attempt",
        (candidate) =>
          (candidate.execution.workspace_binding.owner = {
            kind: "work_attempt",
            work_item_id: "work",
            attempt: 2,
          }),
      ],
      ["isolation", (candidate) => (candidate.execution.isolation = "sandbox")],
      ["network", (candidate) => (candidate.execution.network_access = "disabled")],
      ["cwd", (candidate) => (candidate.execution.cwd = repo)],
      [
        "active root",
        (candidate) => (candidate.execution.workspace_binding.active_root = join(host, "foreign")),
      ],
      [
        "provider",
        (candidate) => (candidate.execution.workspace_binding.provider.id = "foreign-provider"),
      ],
      [
        "fallback",
        (candidate) =>
          (candidate.execution.workspace_fallback = {
            schema_version: 1,
            run_id: candidate.run_id,
            requested_isolation: "worktree",
            effective_isolation: "shared",
            selection_reason: "provider_unsupported",
            provider: candidate.execution.workspace_binding.provider,
            terminal_lifecycle_state: "shared",
            drift: [],
            unsupported: [{ code: "foreign", message: "foreign fallback" }],
            unknowns: [],
            receipts: {},
          }),
      ],
    ];
    for (const [field, mutate] of manifestSubstitutions) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      expect(() => assertWorkspaceManifestAuthority(candidate, request), field).toThrow();
    }

    const proof = JSON.parse(readFileSync(report.proofPath, "utf8")) as WorkflowProof;
    const execution = boundExecution(proof);
    const proofContradictions: Array<[string, (candidate: ContradictableExecution) => void]> = [
      ["false lifecycle", (candidate) => (candidate.terminal_lifecycle_state = "integrated")],
      ["invented drift", (candidate) => candidate.drift.push("invented")],
      ["missing repository", (candidate) => delete candidate.terminal_attestation.repository],
      [
        "changed unsupported",
        (candidate) =>
          candidate.unsupported.push({ code: "invented", message: "invented unsupported fact" }),
      ],
      [
        "changed unknowns",
        (candidate) =>
          candidate.unknowns.push({ code: "invented", message: "invented unknown fact" }),
      ],
      [
        "invalid released combination",
        (candidate) => {
          candidate.terminal_attestation.resource_state = "released";
          candidate.terminal_attestation.workspace_exists = false;
          candidate.terminal_lifecycle_state = "released";
        },
      ],
    ];
    for (const [field, mutate] of proofContradictions) {
      const candidate = structuredClone(execution) as ContradictableExecution;
      mutate(candidate);
      expect(isWorkspaceBoundExecutionEvidence(candidate, report.runId), field).toBe(false);
    }

    const proofWithoutExecution = structuredClone(proof);
    delete proofWithoutExecution.execution;
    writeFileSync(report.proofPath, `${JSON.stringify(proofWithoutExecution, null, 2)}\n`);
    expect(() => readWorkflowProof(repo, report.runId)).toThrow(
      /does not match the frozen execution manifest/,
    );
  });

  test("probes unsupported without Git and without explicit roots", async () => {
    const root = tracked(tempRoot("workspace-no-git"));
    const oldPath = process.env.PATH;
    process.env.PATH = join(root, "empty");
    try {
      const provider = createLocalGitWorktreeProvider({ coordRoot: root });
      const capabilities = await provider.probe({ requested_cwd: root, writable_roots: [] });
      expect(capabilities.supported).toBe(false);
      expect(capabilities.capabilities.isolation).toEqual(["worktree"]);
      expect(capabilities.unsupported.map((item) => item.code)).toContain("git_unavailable");
      expect(capabilities.unsupported.map((item) => item.code)).toContain(
        "writable_roots_required",
      );
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("reports old Git and unavailable descriptor-backed paths as unsupported", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-capability-probe");
    tracked(host);
    const wrapperDir = join(host, "git-version-wrapper");
    mkdirSync(wrapperDir);
    const wrapper = join(wrapperDir, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'git version 2.30.9'
  exit 0
fi
exec "$HARNERY_REAL_GIT" "$@"
`,
    );
    chmodSync(wrapper, 0o700);
    const oldPath = process.env.PATH;
    process.env.HARNERY_REAL_GIT = findGitBinary();
    process.env.PATH = `${wrapperDir}${delimiter}${oldPath}`;
    try {
      const provider = createLocalGitWorktreeProvider({
        coordRoot: repo,
        descriptorPathsSupported: () => false,
      });
      const capabilities = await provider.probe({
        requested_cwd: repo,
        writable_roots: [host],
      });
      expect(capabilities.supported).toBe(false);
      expect(capabilities.unsupported.map((item) => item.code)).toContain(
        "git_version_unsupported",
      );
      expect(capabilities.unsupported.map((item) => item.code)).toContain(
        "descriptor_paths_unavailable",
      );
    } finally {
      process.env.PATH = oldPath;
      delete process.env.HARNERY_REAL_GIT;
    }
  });

  test("rejects bare, detached, and linked-worktree source repositories", async () => {
    if (!hasGit()) return;
    const fixture = gitFixture("workspace-repository-shapes");
    tracked(fixture.host);
    const provider = createLocalGitWorktreeProvider({ coordRoot: fixture.repo });

    const bare = join(fixture.host, "bare.git");
    git(fixture.host, "init", "--bare", bare);
    const bareProbe = await provider.probe({
      requested_cwd: bare,
      writable_roots: [fixture.host],
    });
    expect(bareProbe.supported).toBe(false);
    expect(bareProbe.unsupported.map((item) => item.code)).toContain("repository_unsupported");

    const sourceBranch = git(fixture.repo, "branch", "--show-current");
    git(fixture.repo, "checkout", "--detach");
    const detachedProbe = await provider.probe({
      requested_cwd: fixture.repo,
      writable_roots: [fixture.host],
    });
    expect(detachedProbe.supported).toBe(false);
    expect(detachedProbe.unsupported.map((item) => item.code)).toContain("repository_unsupported");
    git(fixture.repo, "checkout", sourceBranch);

    const linked = join(fixture.host, "linked-source");
    git(fixture.repo, "worktree", "add", "-b", "linked-source", linked);
    const linkedProbe = await provider.probe({
      requested_cwd: linked,
      writable_roots: [fixture.host],
    });
    expect(linkedProbe.supported).toBe(false);
    expect(linkedProbe.unsupported.map((item) => item.code)).toContain("repository_unsupported");
  });

  test("ignores inherited Git repository authority overrides", async () => {
    if (!hasGit()) return;
    const requested = gitFixture("workspace-requested-authority");
    const foreign = gitFixture("workspace-foreign-authority");
    tracked(requested.host);
    tracked(foreign.host);
    const script = writeScript(requested.repo, "export default async () => 'isolated';\n");
    git(requested.repo, "add", ".");
    git(requested.repo, "commit", "-qm", "workflow");
    const expectedHead = git(requested.repo, "rev-parse", "HEAD");
    const oldGitDir = process.env.GIT_DIR;
    const oldGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(foreign.repo, ".git");
    process.env.GIT_WORK_TREE = requested.repo;
    try {
      const provider = createLocalGitWorktreeProvider({ coordRoot: requested.repo });
      const report = await runWorkflow(script, {
        coordRoot: requested.repo,
        runId: "wf-inherited-git-authority",
        cwd: requested.repo,
        spawners: {},
        isolation: "worktree",
        workspace: { provider, writableRoots: [requested.host] },
        ...quiet,
      });
      expect(report.workspaceBinding?.repository?.source_root.realpath).toBe(requested.repo);
      expect(report.workspaceBinding?.repository?.common_dir.realpath).toBe(
        realpathSync(join(requested.repo, ".git")),
      );
      expect(report.workspaceBinding?.repository?.base_commit).toBe(expectedHead);
    } finally {
      restoreEnvironment("GIT_DIR", oldGitDir);
      restoreEnvironment("GIT_WORK_TREE", oldGitWorkTree);
    }
  });

  test("rejects a Git executable that reports foreign repository authority", async () => {
    if (!hasGit()) return;
    const requested = gitFixture("workspace-requested-checkout");
    const foreign = gitFixture("workspace-foreign-checkout");
    tracked(requested.host);
    tracked(foreign.host);
    const wrapperDir = join(requested.host, "git-authority-wrapper");
    mkdirSync(wrapperDir);
    const wrapper = join(wrapperDir, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh
GIT_DIR="$HARNERY_TEST_GIT_DIR" GIT_WORK_TREE="$HARNERY_TEST_WORK_TREE" exec "$HARNERY_REAL_GIT" "$@"
`,
    );
    chmodSync(wrapper, 0o700);
    const oldPath = process.env.PATH;
    process.env.HARNERY_REAL_GIT = findGitBinary();
    process.env.HARNERY_TEST_GIT_DIR = join(foreign.repo, ".git");
    process.env.HARNERY_TEST_WORK_TREE = requested.repo;
    process.env.PATH = `${wrapperDir}${delimiter}${oldPath}`;
    try {
      const provider = createLocalGitWorktreeProvider({ coordRoot: requested.repo });
      const capabilities = await provider.probe({
        requested_cwd: requested.repo,
        writable_roots: [requested.host],
      });
      expect(capabilities.supported).toBe(false);
      expect(capabilities.unsupported).toContainEqual({
        code: "repository_unsupported",
        message: "resolved Git authority does not match the requested checkout",
      });
    } finally {
      process.env.PATH = oldPath;
      delete process.env.HARNERY_REAL_GIT;
      delete process.env.HARNERY_TEST_GIT_DIR;
      delete process.env.HARNERY_TEST_WORK_TREE;
    }
  });

  test("returns byte-identical duplicate bindings and safely cleans a completed workspace", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-provider");
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
    const request = readWorkspaceRequest(repo, report.runId)!;
    const { idempotency_key: idempotencyKey, ...requestWithoutKey } = request;
    expect(idempotencyKey).toBe(stableDigest(requestWithoutKey));
    const manifest = JSON.parse(
      readFileSync(join(repo, ".harnery", "workflows", report.runId, "run.json"), "utf8"),
    );
    const proof = JSON.parse(readFileSync(report.proofPath, "utf8")) as WorkflowProof;
    expect(binding.owner).toEqual({ kind: "standalone", work_item_id: null, attempt: null });
    expect(manifest.execution.workspace_binding).toEqual(binding);
    expect(boundExecution(proof).binding).toEqual(binding);
    expect(boundExecution(proof).schema_version).toBe(1);
    expect(boundExecution(proof).terminal_attestation.status).toBe("ok");
    expect(proof.execution?.terminal_lifecycle_state).toBe("completed_unintegrated");
    expect(boundExecution(proof).receipts).toEqual({
      request: "workspace-request.json",
      cancellation_outcome: "cancellation/outcome.json",
      integration_plan: "integration/plan.json",
      integration_authorization: "integration/authorization.json",
      integration_apply: "integration/receipt.json",
      cleanup_intent: "cleanup/intent.json",
      cleanup_receipt: "cleanup/receipt.json",
    });
    expect(
      isWorkspaceAttestation(
        { ...boundExecution(proof).terminal_attestation, containment: undefined },
        binding,
      ),
    ).toBe(false);
    expect(
      isWorkspaceAttestation(
        { ...boundExecution(proof).terminal_attestation, repository: undefined },
        binding,
      ),
    ).toBe(false);
    const successfulRepository = boundExecution(proof).terminal_attestation.repository!;
    const invalidRepositoryFields: Array<[string, unknown]> = [
      ["source_root", undefined],
      ["common_dir", undefined],
      ["active_gitdir", undefined],
      ["worktree_registered", false],
      ["current_ref", undefined],
      ["workspace_ref_oid", undefined],
      ["target_ref_oid", undefined],
      ["head_commit", undefined],
      ["base_is_ancestor", false],
      ["target_is_ancestor", false],
      ["dirty_paths", undefined],
      ["conflicts", undefined],
      ["operation_in_progress", undefined],
    ];
    for (const [field, replacement] of invalidRepositoryFields) {
      const candidate = structuredClone(boundExecution(proof).terminal_attestation);
      Object.assign(candidate.repository!, { [field]: replacement });
      expect(isWorkspaceAttestation(candidate, binding)).toBe(false);
    }
    for (const field of Object.keys(successfulRepository)) {
      const candidate = structuredClone(boundExecution(proof).terminal_attestation);
      delete (candidate.repository as unknown as Record<string, unknown>)[field];
      expect(isWorkspaceAttestation(candidate, binding)).toBe(false);
    }
    expect(
      isWorkspaceAttestation(boundExecution(proof).terminal_attestation, {
        ...binding,
        repository: undefined,
      }),
    ).toBe(false);
    expect(
      isWorkspaceAttestation(
        {
          ...boundExecution(proof).terminal_attestation,
          filesystem: { root_identity_match: true },
        },
        binding,
      ),
    ).toBe(false);
    expect(proof.execution?.unknowns.map((item) => item.code)).toContain("network_not_attested");
    expect(existsSync(workspaceClaimPath(repo, binding.provider.id, binding.binding_id))).toBe(
      true,
    );
    expect(existsSync(workspaceBindingPath(repo, binding.provider.id, binding.binding_id))).toBe(
      true,
    );
    const duplicate = await provider.allocate(request);
    expect(JSON.stringify(duplicate)).toBe(JSON.stringify(binding));
    await expect(
      provider.allocate({ ...request, idempotency_key: "b".repeat(64) }),
    ).rejects.toThrow(/request is invalid/);
    const attestation = await provider.reattach(binding);
    expect(attestation.status).toBe("ok");
    writeFileSync(join(binding.active_root, "committed.txt"), "advanced\n");
    git(binding.active_root, "add", "committed.txt");
    git(binding.active_root, "commit", "-qm", "advance workspace");
    expect(JSON.stringify(await provider.allocate(request))).toBe(JSON.stringify(binding));
    git(repo, "merge", "--ff-only", binding.repository!.workspace_branch);

    const lock = workspaceLockPath(repo, binding.provider.id, binding.binding_id);
    const leaseAuthority = stableDigest({
      binding_id: binding.binding_id,
      request_sha256: binding.request_sha256,
      scope: "binding",
    });
    const liveLease = acquireNoClobberLease({
      path: lock,
      scope: "binding",
      authoritySha256: leaseAuthority,
      staleAfterMs: 5 * 60 * 1_000,
      metadata: {
        request_sha256: binding.request_sha256,
        binding_id: binding.binding_id,
      },
    });
    await expect(provider.allocate(request)).rejects.toThrow(/live or unexpired/);
    await expect(provider.reattach(binding)).rejects.toThrow(/live or unexpired/);
    liveLease.release();
    acquireNoClobberLease({
      path: lock,
      scope: "binding",
      authoritySha256: leaseAuthority,
      staleAfterMs: 5 * 60 * 1_000,
      now: () => Date.parse("2020-01-01T00:00:00.000Z"),
      pid: 2_147_483_647,
      metadata: {
        request_sha256: binding.request_sha256,
        binding_id: binding.binding_id,
      },
    });
    expect(JSON.stringify(await provider.allocate(request))).toBe(JSON.stringify(binding));
    expect(
      readWorkspaceEvents(repo, binding.provider.id, binding.binding_id).some(
        (event) => event.event === "stale_lock_recovered",
      ),
    ).toBe(true);

    const invalidReleaseProvider: WorkspaceProvider = {
      ...provider,
      cleanup: async (candidate) => {
        const current = await provider.attest(candidate);
        return {
          schema_version: 1,
          binding_id: candidate.binding_id,
          status: "released",
          recorded_at: new Date().toISOString(),
          branch_deleted: true,
          attestation: {
            ...current,
            containment: {
              ...current.containment,
              workspace_root: false,
              active_root: false,
            },
            filesystem: { root_identity_match: true },
            repository: current.repository
              ? {
                  ...current.repository,
                  common_dir: undefined,
                  active_gitdir: undefined,
                  worktree_registered: false,
                }
              : undefined,
            provider_drift: ["simulated release drift"],
            workspace_exists: false,
            resource_state: "released",
            status: "lost",
          },
        };
      },
    };
    await expect(
      cleanupWorkspace({
        coordRoot: repo,
        runId: report.runId,
        provider: invalidReleaseProvider,
      }),
    ).rejects.toThrow(/invalid result/);
    expect(
      existsSync(join(repo, ".harnery", "workflows", report.runId, "cleanup", "receipt.json")),
    ).toBe(false);

    const cleanup = await cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider });
    if (!("receipt_id" in cleanup)) throw new Error("expected terminal cleanup receipt");
    expect(cleanup.status).toBe("released");
    expect(cleanup.branch_deleted).toBe(true);
    expect(cleanup.attestation.status).toBe("ok");
    expect(cleanup.attestation.resource_state).toBe("released");
    expect(cleanup.attestation.workspace_exists).toBe(false);
    expect(cleanup.attestation.provider_drift).toEqual([]);
    expect(cleanup.attestation.repository).toMatchObject({
      source_root: binding.repository!.source_root,
      common_dir: binding.repository!.common_dir,
      worktree_registered: false,
    });
    expect(cleanup.attestation.repository?.active_gitdir).toBeUndefined();
    expect(
      isWorkspaceAttestation(
        {
          ...cleanup.attestation,
          repository: {
            ...cleanup.attestation.repository!,
            source_root: {
              ...cleanup.attestation.repository!.source_root,
              identity: { platform: process.platform, device: "foreign", inode: "foreign" },
            },
          },
        },
        binding,
      ),
    ).toBe(false);
    expect(
      isWorkspaceAttestation(
        {
          ...cleanup.attestation,
          repository: {
            ...cleanup.attestation.repository!,
            common_dir: {
              ...cleanup.attestation.repository!.common_dir!,
              identity: { platform: process.platform, device: "foreign", inode: "foreign" },
            },
          },
        },
        binding,
      ),
    ).toBe(false);
    expect(existsSync(binding.workspace_root)).toBe(false);
    expect(
      existsSync(join(repo, ".harnery", "workflows", report.runId, "cleanup", "receipt.json")),
    ).toBe(true);
    const reattestedAbsence = await provider.attest(binding);
    expect(reattestedAbsence.status).toBe("ok");
    expect(reattestedAbsence.resource_state).toBe("released");
    expect(reattestedAbsence.provider_drift).toEqual([]);
    expect(await cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider })).toEqual(
      cleanup,
    );
  });

  test("maps a requested repository subdirectory into the isolated worktree", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-subdirectory-cwd");
    tracked(host);
    const requestedCwd = join(repo, "packages", "app");
    mkdirSync(requestedCwd, { recursive: true });
    writeFileSync(join(requestedCwd, "package.json"), '{"name":"fixture-app"}\n');
    const script = writeScript(repo, "export default async ({ agent }) => agent('cwd');\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    const report = await runWorkflow(script, {
      coordRoot: repo,
      runId: "wf-subdirectory-cwd",
      cwd: requestedCwd,
      spawners: {
        "claude-code": async (request) => ({
          ok: true,
          text: request.cwd,
          durationMs: 1,
        }),
      },
      isolation: "worktree",
      workspace: { provider, writableRoots: [host] },
      ...quiet,
    });

    const binding = report.workspaceBinding!;
    const expectedActiveRoot = join(binding.workspace_root, "packages", "app");
    expect(report.result).toBe(expectedActiveRoot);
    expect(binding.active_root).toBe(expectedActiveRoot);
    expect(binding.repository?.source_root.configured).toBe(repo);
    expect(readWorkspaceRequest(repo, report.runId)?.requested_cwd).toBe(requestedCwd);
    expect(existsSync(join(repo, ".harnery", "workflows", report.runId, "run.json"))).toBe(true);
    expect(boundExecution(readWorkflowProof(repo, report.runId)).terminal_attestation.status).toBe(
      "ok",
    );

    const cleanup = await cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider });
    expect(cleanup.status).toBe("released");
    expect(existsSync(binding.workspace_root)).toBe(false);
  });

  test("rejects a replaced source checkout even when the Git common dir is preserved", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-source-root-replacement");
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
    const frozenCommonIdentity = binding.repository!.common_dir.identity;
    const restore = replaceSourceCheckout(repo);
    try {
      expect(filesystemIdentity(binding.repository!.common_dir.realpath)).toEqual(
        frozenCommonIdentity,
      );
      const attestation = await provider.attest(binding);
      expect(attestation.status).toBe("blocked");
      expect(attestation.repository?.source_root.realpath).toBe(
        binding.repository!.source_root.realpath,
      );
      expect(attestation.repository?.source_root.identity).not.toEqual(
        binding.repository!.source_root.identity,
      );
      expect(attestation.repository?.common_dir).toEqual(binding.repository!.common_dir);
      expect(attestation.repository?.active_gitdir).toBeUndefined();
      expect(attestation.provider_drift).toContain("source repository identity mismatch");
      await expect(provider.reattach(binding)).rejects.toThrow(/source repository identity/);
      await expect(
        cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider }),
      ).rejects.toThrow(/freeze exact source and target ref identities/);
      expect(existsSync(binding.workspace_root)).toBe(true);
      expect(
        existsSync(join(repo, ".harnery", "workflows", report.runId, "cleanup", "receipt.json")),
      ).toBe(false);
    } finally {
      restore();
    }
    const cleanup = await cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider });
    if (!("receipt_id" in cleanup)) throw new Error("expected cleanup receipt");
    const receiptPath = join(
      repo,
      ".harnery",
      "workflows",
      report.runId,
      "cleanup",
      "receipt.json",
    );
    const receiptBytes = readFileSync(receiptPath, "utf8");
    const restoreAfterReceipt = replaceSourceCheckout(repo);
    try {
      await expect(
        cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider }),
      ).rejects.toThrow(/no longer reattests exact resource absence/);
      expect(readFileSync(receiptPath, "utf8")).toBe(receiptBytes);
      expect(existsSync(binding.workspace_root)).toBe(false);
    } finally {
      restoreAfterReceipt();
    }
  });

  test("freezes the isolated manifest and child cwd before the first spawn", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-manifest-before-child");
    tracked(host);
    const script = writeScript(repo, "export default async ({ agent }) => agent('inspect');\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const runId = "wf-manifest-before-child";
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    let observedBindingId: string | undefined;
    const report = await runWorkflow(script, {
      coordRoot: repo,
      runId,
      cwd: repo,
      spawners: {
        "claude-code": async (request) => {
          const manifest = JSON.parse(
            readFileSync(join(repo, ".harnery", "workflows", runId, "run.json"), "utf8"),
          );
          observedBindingId = manifest.execution.workspace_binding.binding_id;
          expect(
            existsSync(join(repo, ".harnery", "workflows", runId, "workspace-request.json")),
          ).toBe(true);
          expect(request.cwd).toBe(manifest.execution.workspace_binding.active_root);
          return { ok: true, text: request.cwd, durationMs: 1 };
        },
      },
      isolation: "worktree",
      workspace: { provider, writableRoots: [host] },
      ...quiet,
    });
    expect(observedBindingId).toBe(report.workspaceBinding?.binding_id);
    expect(report.result).toBe(report.workspaceBinding?.active_root);
    await cleanupWorkspace({ coordRoot: repo, runId, provider });
  });

  test("fails reattachment on token drift and preserves dirty cleanup", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-provider-drift");
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
    await expect(provider.reattach({ ...binding, recovery_token: "0".repeat(64) })).rejects.toThrow(
      /immutable provider binding/,
    );
    await expect(
      provider.reattach({
        ...binding,
        provider: { ...binding.provider, version: "foreign" },
      }),
    ).rejects.toThrow(/immutable provider binding/);
    await expect(
      provider.reattach({
        ...binding,
        owner: { kind: "standalone", work_item_id: null, attempt: null },
        run_id: "wf-foreign",
      }),
    ).rejects.toThrow(/immutable provider binding/);
    writeFileSync(join(binding.active_root, "dirty.txt"), "preserve\n");
    const cleanup = await cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider });
    expect(cleanup.status).toBe("preserved_dirty");
    expect(existsSync(binding.active_root)).toBe(true);
  });

  test("retries dirty and transiently blocked cleanup until one terminal receipt", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-cleanup-retry");
    tracked(host);
    const script = writeScript(repo, "export default async () => 'isolated';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const local = createLocalGitWorktreeProvider({ coordRoot: repo });
    const report = await runWorkflow(script, {
      coordRoot: repo,
      cwd: repo,
      spawners: {},
      isolation: "worktree",
      workspace: { provider: local, writableRoots: [host] },
      ...quiet,
    });
    const binding = report.workspaceBinding!;
    writeFileSync(join(binding.workspace_root, "dirty.txt"), "preserve\n");

    const dirty = await cleanupWorkspace({
      coordRoot: repo,
      runId: report.runId,
      provider: local,
    });
    expect(dirty.status).toBe("preserved_dirty");
    expect(
      existsSync(join(repo, ".harnery", "workflows", report.runId, "cleanup", "receipt.json")),
    ).toBe(false);
    rmSync(join(binding.workspace_root, "dirty.txt"));

    let blockedOnce = false;
    const transient: WorkspaceProvider = {
      ...local,
      cleanup: async (candidate, intent) => {
        if (!blockedOnce) {
          blockedOnce = true;
          return {
            schema_version: 1,
            binding_id: candidate.binding_id,
            status: "blocked",
            recorded_at: new Date().toISOString(),
            branch_deleted: false,
            attestation: await local.attest(candidate),
            reason: "transient liveness check",
          };
        }
        return local.cleanup(candidate, intent);
      },
    };
    const blocked = await cleanupWorkspace({
      coordRoot: repo,
      runId: report.runId,
      provider: transient,
    });
    expect(blocked.status).toBe("blocked");

    const released = await cleanupWorkspace({
      coordRoot: repo,
      runId: report.runId,
      provider: transient,
    });
    expect(released.status).toBe("released");
    expect(released.branch_deleted).toBe(true);
    expect(readCleanupAttempts(repo, report.runId).map((item) => item.status)).toEqual([
      "started",
      "preserved_dirty",
      "started",
      "blocked",
      "started",
      "released",
    ]);
    expect(
      await cleanupWorkspace({
        coordRoot: repo,
        runId: report.runId,
        provider: transient,
      }),
    ).toEqual(released);
  });

  test("resumes cleanup after the target advances beyond the frozen intent", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-cleanup-crash");
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
    const repository = binding.repository!;
    writeFileSync(join(binding.workspace_root, "integrated.txt"), "reachable\n");
    git(binding.workspace_root, "add", "integrated.txt");
    git(binding.workspace_root, "commit", "-qm", "workspace result");
    const workspaceCommit = git(binding.workspace_root, "rev-parse", "HEAD");
    let frozeIntent = false;
    const interrupted: WorkspaceProvider = {
      ...provider,
      cleanup: async (candidate) => {
        frozeIntent = true;
        return {
          schema_version: 1,
          binding_id: candidate.binding_id,
          status: "partial",
          recorded_at: new Date().toISOString(),
          branch_deleted: false,
          attestation: await provider.attest(candidate),
          reason: "simulated interruption before provider mutation",
        };
      },
    };
    expect(
      (
        await cleanupWorkspace({
          coordRoot: repo,
          runId: report.runId,
          provider: interrupted,
        })
      ).status,
    ).toBe("partial");
    expect(frozeIntent).toBe(true);

    git(repo, "merge", "--ff-only", repository.workspace_branch);
    expect(git(repo, "rev-parse", "HEAD")).toBe(workspaceCommit);
    git(repo, "worktree", "remove", binding.workspace_root);
    expect(existsSync(binding.workspace_root)).toBe(false);
    const released = await cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider });
    expect(released.status).toBe("released");
    expect(existsSync(join(repo, ".git", repository.workspace_ref))).toBe(false);
    expect(readCleanupAttempts(repo, report.runId).map((attempt) => attempt.status)).toEqual([
      "started",
      "partial",
      "started",
      "released",
    ]);
  });

  test("keeps the frozen workspace ref as the cleanup deletion CAS", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-cleanup-ref-cas");
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
    const repository = binding.repository!;
    const interrupted: WorkspaceProvider = {
      ...provider,
      cleanup: async (candidate) => ({
        schema_version: 1,
        binding_id: candidate.binding_id,
        status: "partial",
        recorded_at: new Date().toISOString(),
        branch_deleted: false,
        attestation: await provider.attest(candidate),
        reason: "simulated interruption before provider mutation",
      }),
    };
    await cleanupWorkspace({
      coordRoot: repo,
      runId: report.runId,
      provider: interrupted,
    });
    writeFileSync(join(repo, "foreign.txt"), "foreign\n");
    git(repo, "add", "foreign.txt");
    git(repo, "commit", "-qm", "foreign target");
    const foreign = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "remove", binding.workspace_root);
    git(repo, "update-ref", repository.workspace_ref, foreign, repository.base_commit);

    const blocked = await cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider });
    expect(blocked.status).toBe("blocked");
    expect("reason" in blocked ? blocked.reason : undefined).toMatch(/workspace ref changed/);
    expect(git(repo, "rev-parse", "--verify", repository.workspace_ref)).toBe(foreign);
  });

  test("holds the durable cleanup lease through core receipt persistence", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-cleanup-process-lease");
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
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let continueCleanup!: () => void;
    const providerContinue = new Promise<void>((resolve) => {
      continueCleanup = resolve;
    });
    const holding: WorkspaceProvider = {
      ...provider,
      cleanup: async (binding, intent) => {
        entered();
        await providerContinue;
        return provider.cleanup(binding, intent);
      },
    };
    const first = cleanupWorkspace({
      coordRoot: repo,
      runId: report.runId,
      provider: holding,
    });
    await providerEntered;
    const cleanupModule = new URL("./cleanup.ts", import.meta.url).href;
    const providerModule = new URL("./local-git.ts", import.meta.url).href;
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `
          import { cleanupWorkspace } from ${JSON.stringify(cleanupModule)};
          import { createLocalGitWorktreeProvider } from ${JSON.stringify(providerModule)};
          const coordRoot = process.env.HARNERY_TEST_COORD_ROOT;
          const runId = process.env.HARNERY_TEST_RUN_ID;
          const provider = createLocalGitWorktreeProvider({ coordRoot });
          await cleanupWorkspace({ coordRoot, runId, provider });
        `,
      ],
      env: {
        ...process.env,
        HARNERY_TEST_COORD_ROOT: repo,
        HARNERY_TEST_RUN_ID: report.runId,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const childError = await new Response(child.stderr).text();
    const childExit = await child.exited;
    continueCleanup();
    const firstResult = await first;
    expect(childExit).not.toBe(0);
    expect(childError).toContain("live or unexpired owner");
    expect(firstResult.status).toBe("released");
    expect(readCleanupAttempts(repo, report.runId)).toHaveLength(2);
  });

  test("rejects exact binding substitution across every repository identity field", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-binding-substitution");
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
    const repository = binding.repository!;
    const candidates = [
      { ...binding, workspace_root: repo },
      {
        ...binding,
        repository: {
          ...repository,
          gitdir: { ...repository.gitdir, realpath: repository.common_dir.realpath },
        },
      },
      {
        ...binding,
        repository: {
          ...repository,
          common_dir: { ...repository.common_dir, realpath: repository.source_root.realpath },
        },
      },
      {
        ...binding,
        repository: {
          ...repository,
          source_root: { ...repository.source_root, realpath: host },
        },
      },
      {
        ...binding,
        repository: {
          ...repository,
          workspace_branch: `${repository.workspace_branch}-foreign`,
        },
      },
    ];
    for (const candidate of candidates) {
      await expect(provider.reattach(candidate)).rejects.toThrow(/immutable provider binding/);
    }
  });

  test("blocks replacement of workspace, active-root, common-dir, and gitdir identities", async () => {
    if (!hasGit()) return;
    for (const target of ["workspace", "active", "common", "gitdir"] as const) {
      const { host, repo } = gitFixture(`workspace-replaced-${target}`);
      tracked(host);
      mkdirSync(join(repo, "nested"));
      writeFileSync(join(repo, "nested", "tracked.txt"), "tracked\n");
      const script = writeScript(repo, "export default async () => 'isolated';\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "workflow");
      const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
      const requestedCwd = target === "active" ? join(repo, "nested") : repo;
      const report = await runWorkflow(script, {
        coordRoot: repo,
        cwd: requestedCwd,
        spawners: {},
        isolation: "worktree",
        workspace: { provider, writableRoots: [host] },
        ...quiet,
      });
      const binding = report.workspaceBinding!;
      const path =
        target === "workspace"
          ? binding.workspace_root
          : target === "active"
            ? binding.active_root
            : target === "common"
              ? binding.repository!.common_dir.realpath
              : binding.repository!.gitdir.realpath;
      const backup = `${path}.frozen-backup`;
      renameSync(path, backup);
      mkdirSync(path);
      try {
        await expect(provider.reattach(binding)).rejects.toThrow(
          /identity|registration|authority|cannot reattach/,
        );
      } finally {
        rmSync(path, { recursive: true, force: true });
        renameSync(backup, path);
      }
      expect((await provider.reattach(binding)).status).toBe("ok");
    }
  });

  test("rolls back registration and ref when the workspace parent is replaced during add", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-parent-replacement");
    tracked(host);
    const script = writeScript(repo, "export default async () => 'isolated';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "workflow");
    const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
    const wrapperDir = join(host, "git-wrapper");
    const foreign = join(host, "foreign");
    const marker = join(host, "parent-replaced");
    mkdirSync(wrapperDir);
    mkdirSync(foreign);
    const wrapper = join(wrapperDir, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "add" ] && [ ! -e "$HARNERY_TEST_MARKER" ]; then
  touch "$HARNERY_TEST_MARKER"
  mv "$HARNERY_TEST_PARENT" "$HARNERY_TEST_PARENT-moved"
  ln -s "$HARNERY_TEST_FOREIGN" "$HARNERY_TEST_PARENT"
fi
exec "$HARNERY_REAL_GIT" "$@"
`,
    );
    chmodSync(wrapper, 0o700);
    const oldPath = process.env.PATH;
    process.env.HARNERY_REAL_GIT = findGitBinary();
    process.env.HARNERY_TEST_MARKER = marker;
    process.env.HARNERY_TEST_PARENT = join(host, "harnery-workspaces");
    process.env.HARNERY_TEST_FOREIGN = foreign;
    process.env.PATH = `${wrapperDir}${delimiter}${oldPath}`;
    try {
      await expect(
        runWorkflow(script, {
          coordRoot: repo,
          runId: "wf-parent-replacement",
          cwd: repo,
          spawners: {},
          isolation: "worktree",
          workspace: { provider, writableRoots: [host] },
          ...quiet,
        }),
      ).rejects.toThrow(/workspace parent|symlink|identity changed/);
    } finally {
      process.env.PATH = oldPath;
      delete process.env.HARNERY_REAL_GIT;
      delete process.env.HARNERY_TEST_MARKER;
      delete process.env.HARNERY_TEST_PARENT;
      delete process.env.HARNERY_TEST_FOREIGN;
    }
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/harnery/workspace")).toBe(
      "",
    );
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("harnery/workspace");
  });

  test("fails closed on corrupt claim, binding, event chain, and cleanup attempts", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-corrupt-records");
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
    const bindingPath = workspaceBindingPath(repo, binding.provider.id, binding.binding_id);
    const claimPath = workspaceClaimPath(repo, binding.provider.id, binding.binding_id);
    const eventsPath = join(
      repo,
      ".harnery",
      "workspaces",
      binding.provider.id,
      binding.binding_id,
      "events.jsonl",
    );

    const bindingBody = readFileSync(bindingPath, "utf8");
    writeFileSync(bindingPath, "{bad\n");
    await expect(provider.attest(binding)).rejects.toThrow(/cannot parse/);
    writeFileSync(bindingPath, bindingBody);

    const eventsBody = readFileSync(eventsPath, "utf8");
    writeFileSync(eventsPath, `${eventsBody}{bad\n`);
    await expect(provider.reattach(binding)).rejects.toThrow(/cannot parse/);
    writeFileSync(eventsPath, eventsBody);

    const claimBody = readFileSync(claimPath, "utf8");
    writeFileSync(claimPath, "{bad\n");
    await expect(provider.attest(binding)).rejects.toThrow(/cannot parse/);
    writeFileSync(claimPath, claimBody);

    writeFileSync(join(binding.workspace_root, "dirty.txt"), "preserve\n");
    expect(
      (
        await cleanupWorkspace({
          coordRoot: repo,
          runId: report.runId,
          provider,
        })
      ).status,
    ).toBe("preserved_dirty");
    const attemptsPath = join(
      repo,
      ".harnery",
      "workflows",
      report.runId,
      "cleanup",
      "attempts.jsonl",
    );
    writeFileSync(attemptsPath, `${readFileSync(attemptsPath, "utf8")}{bad\n`);
    rmSync(join(binding.workspace_root, "dirty.txt"));
    await expect(
      cleanupWorkspace({ coordRoot: repo, runId: report.runId, provider }),
    ).rejects.toThrow(/cannot parse workspace cleanup attempt/);
  });

  test("rejects a claim whose request no longer matches its immutable digest", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-corrupt-claim-request");
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
    const claimPath = workspaceClaimPath(repo, binding.provider.id, binding.binding_id);
    const claim = JSON.parse(readFileSync(claimPath, "utf8")) as WorkspaceClaim;
    claim.request.script.path = join(repo, "foreign-workflow.ts");
    writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`);

    await expect(provider.reattach(binding)).rejects.toThrow(
      /workspace ownership claim does not match the binding/,
    );
  });

  test("rejects digest-consistent event journals with foreign claim authority", async () => {
    if (!hasGit()) return;
    const { host, repo } = gitFixture("workspace-foreign-event-authority");
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
    const eventsPath = join(
      repo,
      ".harnery",
      "workspaces",
      binding.provider.id,
      binding.binding_id,
      "events.jsonl",
    );
    const eventsBody = readFileSync(eventsPath, "utf8");

    for (const rewrite of [
      { workspace_id: "foreign-workspace" },
      { request_sha256: "f".repeat(64) },
    ]) {
      rewriteEventJournal(eventsPath, rewrite);
      await expect(provider.reattach(binding)).rejects.toThrow(/workspace event 1 is corrupt/);
      writeFileSync(eventsPath, eventsBody);
    }
  });

  test("recovers every supported pre-binding allocation crash boundary", async () => {
    if (!hasGit()) return;
    for (const state of [
      "claim_only",
      "branch_created",
      "worktree_registered",
      "worktree_event_recorded",
      "stale_registration",
    ] as const) {
      const fixture = await allocationCrashFixture(state);
      const binding = await fixture.provider.allocate(fixture.request);
      expect(binding.recovery_token).toBe(fixture.claim.recovery_token);
      expect((await fixture.provider.reattach(binding)).status).toBe("ok");
      expect(
        readWorkspaceEvents(fixture.repo, binding.provider.id, binding.binding_id).some(
          (event) => event.event === "bound",
        ),
      ).toBe(true);
    }
  });
});

function boundExecution(proof: WorkflowProof): WorkspaceBoundExecutionEvidence {
  if (!isWorkspaceBoundExecutionEvidence(proof.execution, proof.run.id)) {
    throw new Error("expected bound workspace execution evidence");
  }
  return proof.execution;
}

function tracked(root: string): string {
  roots.push(root);
  return root;
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function rewriteEventJournal(
  path: string,
  rewrite: Partial<Pick<WorkspaceProviderEvent, "request_sha256" | "workspace_id">>,
): void {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkspaceProviderEvent);
  let previousSha256: string | null = null;
  const rewritten = records.map((record) => {
    const { record_sha256: _recordSha256, ...existingBasis } = record;
    const basis = {
      ...existingBasis,
      ...rewrite,
      previous_sha256: previousSha256,
    };
    const rewrittenRecord = { ...basis, record_sha256: stableDigest(basis) };
    previousSha256 = rewrittenRecord.record_sha256;
    return rewrittenRecord;
  });
  writeFileSync(path, `${rewritten.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function findGitBinary(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "git");
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error("Git binary is unavailable");
}

async function allocationCrashFixture(
  state:
    | "claim_only"
    | "branch_created"
    | "worktree_registered"
    | "worktree_event_recorded"
    | "stale_registration",
): Promise<{
  repo: string;
  provider: ReturnType<typeof createLocalGitWorktreeProvider>;
  request: WorkspaceAllocationRequest;
  claim: WorkspaceClaim;
}> {
  const { host, repo } = gitFixture(`workspace-crash-${state}`);
  tracked(host);
  const script = writeScript(repo, "export default async () => 'recovered';\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "workflow");
  const provider = createLocalGitWorktreeProvider({ coordRoot: repo });
  const capabilities = await provider.probe({
    requested_cwd: repo,
    writable_roots: [host],
  });
  const writableRoot = validateConfiguredRoot(host);
  const requestWithoutKey: Omit<WorkspaceAllocationRequest, "idempotency_key"> = {
    schema_version: 1,
    run_id: `wf-${state}`,
    owner: { kind: "standalone", work_item_id: null, attempt: null },
    requested_cwd: repo,
    requested_isolation: "worktree",
    network_access: "disabled",
    script: {
      path: script,
      sha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
    },
    policy_sha256: null,
    allowed_paths: [],
    writable_roots: [writableRoot],
    selected_writable_root: writableRoot,
    provider_id: capabilities.capabilities.provider_id,
    capability_digest: capabilities.capabilities.capability_digest,
  };
  const request: WorkspaceAllocationRequest = {
    ...requestWithoutKey,
    idempotency_key: stableDigest(requestWithoutKey),
  };
  const requestSha256 = stableDigest(request);
  const bindingId = `ws-${stableDigest(request.idempotency_key).slice(0, 24)}`;
  const workspaceId = `local-${stableDigest({ bindingId, requestSha256 }).slice(0, 24)}`;
  const workspaceRoot = join(host, "harnery-workspaces", bindingId);
  const commonDir = resolve(repo, git(repo, "rev-parse", "--git-common-dir"));
  const branch = git(repo, "branch", "--show-current");
  const head = git(repo, "rev-parse", "HEAD");
  const claim: WorkspaceClaim = {
    schema_version: 1,
    provider_id: capabilities.capabilities.provider_id,
    provider_version: capabilities.capabilities.provider_version,
    binding_id: bindingId,
    workspace_id: workspaceId,
    request,
    request_sha256: requestSha256,
    recovery_token: "a".repeat(64),
    created_at: "2026-07-23T00:00:00.000Z",
    workspace_root: workspaceRoot,
    active_root: workspaceRoot,
    writable_root: validateConfiguredRoot(host),
    repository: {
      source_root: {
        configured: repo,
        realpath: repo,
        identity: filesystemIdentity(repo),
      },
      common_dir: {
        realpath: commonDir,
        identity: filesystemIdentity(commonDir),
      },
      base_commit: head,
      target_commit: head,
      target_ref: `refs/heads/${branch}`,
      workspace_ref: `refs/heads/harnery/workspace/${bindingId}`,
      workspace_branch: `harnery/workspace/${bindingId}`,
    },
  };
  writeWorkspaceClaim(repo, claim);
  if (state !== "claim_only") {
    appendWorkspaceEvent(repo, claim, "allocation_recorded");
    appendWorkspaceEvent(repo, claim, "branch_creation_started", {
      ref: claim.repository.workspace_ref,
      commit: head,
    });
    git(repo, "branch", claim.repository.workspace_branch, head);
  }
  if (
    state === "worktree_registered" ||
    state === "worktree_event_recorded" ||
    state === "stale_registration"
  ) {
    mkdirSync(join(host, "harnery-workspaces"));
    git(repo, "worktree", "add", workspaceRoot, claim.repository.workspace_branch);
  }
  if (state === "worktree_event_recorded") {
    appendWorkspaceEvent(repo, claim, "worktree_created", {
      path: workspaceRoot,
      ref: claim.repository.workspace_ref,
    });
  }
  if (state === "stale_registration") {
    rmSync(workspaceRoot, { recursive: true });
  }
  return { repo, provider, request, claim };
}
