import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveBinName, workflowSubscriptionOnly } from "../core/config.ts";
import { createBuiltinHarnessRegistry } from "../core/harnesses/index.ts";
import { findCoordRoot } from "../core/hooks/resolve/coord-root.ts";
import type { PolicyIsolation } from "../core/policy/index.ts";
import { loadPolicyFile } from "../core/policy/index.ts";
import type { WorkflowApproval, WorkflowApprovalStatus } from "../core/workflow/approvals.ts";
import { WorkflowParkedError } from "../core/workflow/engine.ts";
import type { WorkspaceProvider } from "../core/workflow/index.ts";

/**
 * `workflow run <script>`: execute a workflow script — bounded, schema-gated,
 * conditionally-routed stages fanning out to headless harness-CLI subagents.
 * The script (deterministic code), not a model, decides routing between
 * stages, and the run terminates when the script returns.
 *
 * Phase 2 surface: `run` only, claude-code spawn adapter only. Design +
 * phasing: decision 0015.
 */

interface WorkflowRunOpts {
  maxAgents?: string;
  concurrency?: string;
  cwd?: string;
  harness?: string;
  resumeFrom?: string;
  subscriptionOnly?: boolean;
  allowApiBilling?: boolean;
  policy?: string;
  isolation?: PolicyIsolation;
  workspaceRoot?: string;
  approvalTo?: string;
  json?: boolean;
}

interface WorkflowProofOpts {
  json?: boolean;
}

interface WorkflowApprovalListOpts {
  status?: WorkflowApprovalStatus;
  json?: boolean;
}

interface WorkflowApprovalDecisionOpts {
  actor?: string;
  reason?: string;
  json?: boolean;
}

interface WorkflowIntegrationPrepareOpts {
  policy?: string;
  reviewer?: string;
  reason?: string;
  targetRoot?: string;
  acceptUnknown?: string[];
  approvalTo?: string;
  json?: boolean;
}

interface WorkflowConfirmedMutationOpts {
  yes?: boolean;
  json?: boolean;
}

export function registerWorkflowCommand(program: Command, emit: EmitContext): void {
  const registry = createBuiltinHarnessRegistry();
  const harnesses = registry.ids();
  const workflow = program
    .command("workflow")
    .description("Run bounded, schema-gated multi-subagent workflow scripts.");

  workflow
    .command("run <script>")
    .description(
      "Execute a workflow script (plain JS: `export default async ({agent, parallel, stage, log, evidence, authorize}) => …`). " +
        "Subagents spawn as headless harness-CLI subprocesses, coordination-registered.",
    )
    .option("--max-agents <n>", "Total-agent ceiling for the run (default 50)")
    .option("--concurrency <n>", "Concurrent-subagent cap (default 4)")
    .option("--cwd <dir>", "Working directory children spawn in (default: coord root)")
    .option(
      "--harness <name>",
      `Default harness for agent() calls: ${harnesses.join(" | ")} (default claude-code); scripts can override per agent via opts.harness`,
    )
    .option(
      "--resume-from <run-id>",
      "Reuse completed agent results from a prior run's journal; only changed/failed calls re-run",
    )
    .option(
      "--subscription-only",
      "Guarantee subscription billing: scrub API-key vars from child envs; fail loud when a " +
        "harness has no stored login (repo default via config.jsonc workflow.subscriptionOnly)",
    )
    .option(
      "--allow-api-billing",
      "Permit an exported API key to override a stored subscription login (per-token billing); " +
        "without this the engine refuses that silent-override state",
    )
    .option(
      "--policy <file>",
      "Host policy JSON/JSONC applied before dispatch and external mutation",
    )
    .option(
      "--isolation <mode>",
      "Host-created execution boundary: shared | worktree | sandbox | remote (default shared)",
    )
    .option(
      "--workspace-root <dir>",
      "Explicit writable parent for the built-in local Git worktree provider (requires --isolation worktree)",
    )
    .option("--approval-to <address>", "Address durable ASK requests (default: operator)")
    .option("--json", "Emit the full RunReport as JSON")
    .action(async (script: string, opts: WorkflowRunOpts) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({
          code: "no_coord_root",
          message: "no .harnery/ coordination root found; run `init` first",
        });
        process.exit(1);
      }
      if (opts.harness && !registry.get(opts.harness)) {
        emit.error({
          code: "bad_harness",
          message: `unknown harness "${opts.harness}" (expected: ${harnesses.join(" | ")})`,
        });
        process.exit(1);
      }
      if (
        opts.isolation &&
        !(["shared", "worktree", "sandbox", "remote"] as const).includes(opts.isolation)
      ) {
        emit.error({
          code: "bad_isolation",
          message: `unknown isolation ${JSON.stringify(opts.isolation)} (expected: shared | worktree | sandbox | remote)`,
        });
        process.exit(1);
      }
      if (opts.workspaceRoot && opts.isolation !== "worktree") {
        emit.error({
          code: "bad_workspace_root",
          message: "--workspace-root requires --isolation worktree",
        });
        process.exit(1);
      }
      // Flag beats config; the two flags contradict each other by design.
      const subscriptionOnly = opts.subscriptionOnly || workflowSubscriptionOnly(coordRoot);
      if (subscriptionOnly && opts.allowApiBilling) {
        emit.error({
          code: "billing_flags_conflict",
          message:
            "--allow-api-billing contradicts subscription-only mode " +
            "(flag or config.jsonc workflow.subscriptionOnly); pick one",
        });
        process.exit(1);
      }
      try {
        const { createLocalGitWorktreeProvider, runWorkflow } = await import(
          "../core/workflow/index.ts"
        );
        const workspace = opts.workspaceRoot
          ? {
              provider: createLocalGitWorktreeProvider({ coordRoot }),
              writableRoots: [resolve(opts.workspaceRoot)],
            }
          : undefined;
        const report = await runWorkflow(script, {
          coordRoot,
          spawners: registry.spawners(),
          defaultHarness: opts.harness,
          resumeFrom: opts.resumeFrom,
          subscriptionOnly,
          allowApiBilling: opts.allowApiBilling,
          maxAgents: opts.maxAgents ? Number.parseInt(opts.maxAgents, 10) : undefined,
          concurrency: opts.concurrency ? Number.parseInt(opts.concurrency, 10) : undefined,
          cwd: opts.cwd,
          harnessEvidence: Object.fromEntries(
            registry
              .list()
              .map((adapter) => [
                adapter.profile.id,
                { toolEvidence: adapter.profile.capabilities.toolEvidence },
              ]),
          ),
          policy: opts.policy ? loadPolicyFile(opts.policy) : undefined,
          approvalMode: "park",
          approvalAddressee: opts.approvalTo,
          isolation: opts.isolation,
          workspace,
          // CLI harness subprocesses inherit the host network. A policy that
          // forbids network must therefore deny dispatch unless a future host
          // adapter creates and declares a network-disabled boundary.
          networkAccess: "enabled",
        });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(report);
          return;
        }
        const cachedPart = report.agentsCached > 0 ? ` (+${report.agentsCached} cached)` : "";
        const billingPart = report.billing.length
          ? `billing: ${report.billing.map((b) => `${b.harness}=${b.mode}`).join(", ")}\n`
          : "";
        emit.text(
          `run ${report.runId} (${report.name}) finished: ${report.agentsSpawned} agent(s)${cachedPart}, ` +
            `$${report.costUsd.toFixed(4)}, ${Math.round(report.durationMs / 1000)}s\n${billingPart}` +
            `acceptance: ${report.acceptance.satisfied} satisfied, ${report.acceptance.unsatisfied} unsatisfied, ` +
            `${report.acceptance.unknown} unknown\n` +
            `journal: ${report.journalPath}\n` +
            `proof: ${report.proofPath}\n` +
            `result: ${typeof report.result === "string" ? report.result : JSON.stringify(report.result, null, 2)}\n`,
        );
      } catch (err) {
        if (err instanceof WorkflowParkedError) {
          if (opts.json) {
            emit.config({ format: "json" });
            emit.data({
              status: "parked",
              runId: err.runId,
              approvalId: err.approvalId,
              journalPath: err.journalPath,
            });
          } else {
            emit.text(
              `run ${err.runId} parked\napproval: ${err.approvalId}\n` +
                `journal: ${err.journalPath}\n` +
                `resume after resolution: ${resolveBinName()} workflow resume ${err.runId}\n`,
            );
          }
          return;
        }
        const proofPath =
          typeof err === "object" && err !== null && "proofPath" in err
            ? String(err.proofPath)
            : undefined;
        emit.error({
          code: "workflow_failed",
          message: `${(err as Error).message}${proofPath ? `\nproof: ${proofPath}` : ""}`,
        });
        process.exit(1);
      }
    });

  workflow
    .command("resume <run-id>")
    .description("Resume a parked workflow after its durable approval has been resolved.")
    .option("--json", "Emit the full RunReport or parked result as JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({
          code: "no_coord_root",
          message: "no .harnery/ coordination root found; run `init` first",
        });
        process.exit(1);
      }
      try {
        const { assertWorkflowRunResumable, createLocalGitWorktreeProvider, runWorkflow } =
          await import("../core/workflow/index.ts");
        const { manifest } = assertWorkflowRunResumable(coordRoot, runId);
        const binding = manifest.execution.workspace_binding;
        if (binding && binding.provider.id !== "local-git-worktree") {
          throw new Error(
            `workflow run ${runId} requires unavailable workspace provider ${binding.provider.id}`,
          );
        }
        const report = await runWorkflow(manifest.script.path, {
          coordRoot,
          spawners: registry.spawners(),
          resumeRunId: runId,
          workspace: binding
            ? {
                provider: createLocalGitWorktreeProvider({ coordRoot }),
                writableRoots: [binding.writable_root.configured],
              }
            : undefined,
          harnessEvidence: Object.fromEntries(
            registry
              .list()
              .map((adapter) => [
                adapter.profile.id,
                { toolEvidence: adapter.profile.capabilities.toolEvidence },
              ]),
          ),
        });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(report);
          return;
        }
        const cachedPart = report.agentsCached > 0 ? ` (+${report.agentsCached} cached)` : "";
        emit.text(
          `run ${report.runId} (${report.name}) finished: ${report.agentsSpawned} agent(s)${cachedPart}, ` +
            `$${report.costUsd.toFixed(4)}, ${Math.round(report.durationMs / 1000)}s\n` +
            `acceptance: ${report.acceptance.satisfied} satisfied, ${report.acceptance.unsatisfied} unsatisfied, ` +
            `${report.acceptance.unknown} unknown\n` +
            `journal: ${report.journalPath}\nproof: ${report.proofPath}\n` +
            `result: ${typeof report.result === "string" ? report.result : JSON.stringify(report.result, null, 2)}\n`,
        );
      } catch (err) {
        if (err instanceof WorkflowParkedError) {
          if (opts.json) {
            emit.config({ format: "json" });
            emit.data({
              status: "parked",
              runId: err.runId,
              approvalId: err.approvalId,
              journalPath: err.journalPath,
            });
          } else {
            emit.text(
              `run ${err.runId} parked again\napproval: ${err.approvalId}\n` +
                `journal: ${err.journalPath}\n`,
            );
          }
          return;
        }
        const proofPath =
          typeof err === "object" && err !== null && "proofPath" in err
            ? String(err.proofPath)
            : undefined;
        emit.error({
          code: "workflow_resume_failed",
          message: `${(err as Error).message}${proofPath ? `\nproof: ${proofPath}` : ""}`,
        });
        process.exit(1);
      }
    });

  workflow
    .command("workspace <run-id>")
    .description("Show validated allocation, verification, integration, and cleanup state.")
    .option("--json", "Emit the validated workspace status as JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({
          code: "no_coord_root",
          message: "no .harnery/ coordination root found; run `init` first",
        });
        process.exit(1);
      }
      const { inspectWorkflowWorkspace, renderWorkflowWorkspaceStatus } = await import(
        "../core/workflow/index.ts"
      );
      const inspection = inspectWorkflowWorkspace(coordRoot, runId);
      if (!inspection.ok) {
        emit.error({ code: "workflow_workspace_invalid", message: inspection.error });
        process.exit(1);
      }
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data(inspection.value);
        return;
      }
      emit.text(renderWorkflowWorkspaceStatus(inspection.value));
    });

  workflow
    .command("workspaces")
    .description("List validated isolated and shared-compatibility workspace decisions.")
    .option("--json", "Emit workspace inspections as JSON")
    .action(async (opts: { json?: boolean }) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({
          code: "no_coord_root",
          message: "no .harnery/ coordination root found; run `init` first",
        });
        process.exit(1);
      }
      const { listWorkflowWorkspaceInspections } = await import("../core/workflow/index.ts");
      const inspections = listWorkflowWorkspaceInspections(coordRoot).filter(
        (inspection) => !inspection.ok || inspection.value.selection !== "shared",
      );
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data(inspections);
        return;
      }
      if (inspections.length === 0) {
        emit.text("no isolated or shared-compatibility workspace runs\n");
        return;
      }
      emit.text(
        `${inspections
          .map((inspection) =>
            inspection.ok
              ? [
                  inspection.value.run_id,
                  inspection.value.selection,
                  inspection.value.lifecycle.state,
                  `verify=${inspection.value.verification.status}`,
                  `integration=${inspection.value.integration.state}`,
                  `cleanup=${inspection.value.cleanup.state}`,
                ].join("\t")
              : `${inspection.run_id}\tinvalid\t${inspection.error}`,
          )
          .join("\n")}\n`,
      );
    });

  const integration = workflow
    .command("integration")
    .description("Prepare and apply proof-gated isolated-workspace integration.");

  integration
    .command("prepare <run-id>")
    .description("Preview integration and write exact review and policy authority.")
    .option("--policy <file>", "Current host policy JSON/JSONC for the Git mutation")
    .option("--reviewer <name>", "Explicit reviewer for a standalone workflow")
    .option("--reason <text>", "Reason recorded with the standalone review")
    .option("--target-root <dir>", "Explicit target checkout (default: frozen source checkout)")
    .option(
      "--accept-unknown <code>",
      "Accept one verification unknown by code (repeatable)",
      collectOption,
      [],
    )
    .option("--approval-to <address>", "Address a durable policy ASK request")
    .option("--json", "Emit the durable integration plan as JSON")
    .action(async (runId: string, opts: WorkflowIntegrationPrepareOpts) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({
          code: "no_coord_root",
          message: "no .harnery/ coordination root found; run `init` first",
        });
        process.exit(1);
      }
      if (!opts.policy) {
        emit.error({
          code: "integration_policy_required",
          message: "integration prepare requires --policy <file>",
        });
        process.exit(1);
      }
      if (opts.reason && !opts.reviewer) {
        emit.error({
          code: "integration_reviewer_required",
          message: "--reason requires --reviewer <name>",
        });
        process.exit(1);
      }
      try {
        const provider = await builtInProviderForRun(coordRoot, runId);
        const { IntegrationPrepareParkedError, prepareIntegration } = await import(
          "../core/workflow/index.ts"
        );
        try {
          const plan = await prepareIntegration({
            coordRoot,
            runId,
            provider,
            policy: loadPolicyFile(opts.policy),
            targetRoot: opts.targetRoot,
            review: opts.reviewer ? { actor: opts.reviewer, reason: opts.reason } : undefined,
            acceptedUnknowns: opts.acceptUnknown,
            approvalAddressee: opts.approvalTo,
          });
          if (opts.json) {
            emit.config({ format: "json" });
            emit.data(plan);
            return;
          }
          emit.text(
            `integration plan ${plan.plan_id} authorized\n` +
              `source: ${plan.provider_preview.source_commit}\n` +
              `target: ${plan.provider_preview.target_ref} at ${plan.provider_preview.target_commit}\n` +
              `changes: ${plan.provider_preview.changed_paths.length}\n` +
              `apply: ${resolveBinName()} workflow integration apply ${runId} --yes\n`,
          );
        } catch (error) {
          if (error instanceof IntegrationPrepareParkedError) {
            if (opts.json) {
              emit.config({ format: "json" });
              emit.data({
                status: "parked",
                runId: error.runId,
                planId: error.planId,
                approvalId: error.approvalId,
              });
            } else {
              emit.text(
                `integration preparation parked\n` +
                  `run: ${error.runId}\n` +
                  `plan: ${error.planId}\n` +
                  `approval: ${error.approvalId}\n` +
                  `approve: ${resolveBinName()} workflow approvals approve ${error.approvalId}\n`,
              );
            }
            return;
          }
          throw error;
        }
      } catch (error) {
        emit.error({
          code: "workflow_integration_prepare_failed",
          message: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    });

  integration
    .command("apply <run-id>")
    .description("Apply an authorized durable integration plan.")
    .option("--yes", "Confirm the target-branch mutation")
    .option("--json", "Emit the durable integration receipt as JSON")
    .action(async (runId: string, opts: WorkflowConfirmedMutationOpts) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({
          code: "no_coord_root",
          message: "no .harnery/ coordination root found; run `init` first",
        });
        process.exit(1);
      }
      if (!opts.yes) {
        emit.error({
          code: "integration_confirmation_required",
          message: "integration apply changes the target branch; pass --yes to confirm",
        });
        process.exit(1);
      }
      try {
        const provider = await builtInProviderForRun(coordRoot, runId);
        const { applyIntegration } = await import("../core/workflow/index.ts");
        const receipt = await applyIntegration({ coordRoot, runId, provider });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(receipt);
          return;
        }
        emit.text(
          `integration ${receipt.status}: ${receipt.target_ref} at ${receipt.target_commit}\n` +
            `receipt: ${receipt.receipt_id}\n` +
            `cleanup: ${resolveBinName()} workflow cleanup ${runId} --yes\n`,
        );
      } catch (error) {
        emit.error({
          code: "workflow_integration_apply_failed",
          message: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    });

  workflow
    .command("cleanup <run-id>")
    .description("Conservatively release a provider-owned isolated workspace.")
    .option("--yes", "Confirm the worktree and provider-branch removal attempt")
    .option("--json", "Emit the cleanup attempt or receipt as JSON")
    .action(async (runId: string, opts: WorkflowConfirmedMutationOpts) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({
          code: "no_coord_root",
          message: "no .harnery/ coordination root found; run `init` first",
        });
        process.exit(1);
      }
      if (!opts.yes) {
        emit.error({
          code: "cleanup_confirmation_required",
          message: "workspace cleanup may remove a worktree and branch; pass --yes to confirm",
        });
        process.exit(1);
      }
      try {
        const provider = await builtInProviderForRun(coordRoot, runId);
        const { cleanupWorkspace } = await import("../core/workflow/index.ts");
        const result = await cleanupWorkspace({ coordRoot, runId, provider });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
          return;
        }
        const receipt =
          "receipt_id" in result && typeof result.receipt_id === "string"
            ? `\nreceipt: ${result.receipt_id}`
            : "";
        const reason =
          "reason" in result && typeof result.reason === "string"
            ? `\nreason: ${result.reason}`
            : "";
        emit.text(`workspace cleanup ${result.status}: ${result.binding_id}${receipt}${reason}\n`);
      } catch (error) {
        emit.error({
          code: "workflow_cleanup_failed",
          message: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    });

  const approvals = workflow
    .command("approvals")
    .description("Inspect and resolve durable workflow policy approvals.");

  approvals
    .command("list")
    .description("List durable workflow approvals.")
    .option("--status <status>", "Filter: pending | approved | denied")
    .option("--json", "Emit approval records as JSON")
    .action(async (opts: WorkflowApprovalListOpts) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({ code: "no_coord_root", message: "no .harnery/ coordination root found" });
        process.exit(1);
      }
      if (opts.status && !(["pending", "approved", "denied"] as const).includes(opts.status)) {
        emit.error({
          code: "bad_approval_status",
          message: `unknown approval status ${JSON.stringify(opts.status)}`,
        });
        process.exit(1);
      }
      const { listWorkflowApprovals } = await import("../core/workflow/approvals.ts");
      const records = listWorkflowApprovals(coordRoot, { status: opts.status });
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data(records);
        return;
      }
      if (records.length === 0) {
        emit.text("no workflow approvals\n");
        return;
      }
      emit.text(
        `${records
          .map(
            ({ request, status }) =>
              `${request.id}  ${status.padEnd(8)}  ${request.run_id}  ${request.request.phase}  ${request.request.action}  -> ${request.addressed_to}`,
          )
          .join("\n")}\n`,
      );
    });

  approvals
    .command("show <approval-id>")
    .description("Show one durable workflow approval.")
    .option("--json", "Emit the approval record as JSON")
    .action(async (approvalId: string, opts: { json?: boolean }) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({ code: "no_coord_root", message: "no .harnery/ coordination root found" });
        process.exit(1);
      }
      try {
        const { readWorkflowApproval, renderWorkflowApproval } = await import(
          "../core/workflow/approvals.ts"
        );
        const approval = readWorkflowApproval(coordRoot, approvalId);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(approval);
        } else {
          emit.text(renderWorkflowApproval(approval));
        }
      } catch (err) {
        emit.error({ code: "workflow_approval_read_failed", message: (err as Error).message });
        process.exit(1);
      }
    });

  const registerApprovalDecision = (command: "approve" | "deny", verdict: "allow" | "deny") => {
    approvals
      .command(`${command} <approval-id>`)
      .description(`${command === "approve" ? "Approve" : "Deny"} a pending workflow approval.`)
      .option("--actor <name>", "Decision actor recorded in the receipt")
      .option("--reason <text>", "Bounded decision reason")
      .option("--json", "Emit the resolved approval as JSON")
      .action(async (approvalId: string, opts: WorkflowApprovalDecisionOpts) => {
        const coordRoot = findCoordRoot();
        if (!coordRoot) {
          emit.error({ code: "no_coord_root", message: "no .harnery/ coordination root found" });
          process.exit(1);
        }
        try {
          const { resolveWorkflowApproval, renderWorkflowApproval } = await import(
            "../core/workflow/approvals.ts"
          );
          const resolved = resolveWorkflowApproval({
            coordRoot,
            approvalId,
            verdict,
            actor: opts.actor ?? process.env.USER ?? process.env.USERNAME ?? "operator",
            reason: opts.reason,
          });
          if (opts.json) {
            emit.config({ format: "json" });
            emit.data(resolved);
          } else {
            emit.text(
              `${renderWorkflowApproval(resolved.approval)}` +
                `${resolved.applied ? "decision recorded" : "decision already recorded"}\n` +
                approvalNextActionHint(coordRoot, resolved.approval),
            );
          }
        } catch (err) {
          emit.error({
            code: "workflow_approval_resolution_failed",
            message: (err as Error).message,
          });
          process.exit(1);
        }
      });
  };
  registerApprovalDecision("approve", "allow");
  registerApprovalDecision("deny", "deny");

  workflow
    .command("proof <run-id>")
    .description("Show the bounded proof packet for a completed workflow run.")
    .option("--json", "Emit the stored proof packet as JSON")
    .action(async (runId: string, opts: WorkflowProofOpts) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({
          code: "no_coord_root",
          message: "no .harnery/ coordination root found; run `init` first",
        });
        process.exit(1);
      }
      try {
        const { readWorkflowProof, renderWorkflowProof } = await import(
          "../core/workflow/proof.ts"
        );
        const proof = readWorkflowProof(coordRoot, runId);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(proof);
          return;
        }
        emit.text(renderWorkflowProof(proof));
      } catch (err) {
        emit.error({ code: "workflow_proof_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

async function builtInProviderForRun(coordRoot: string, runId: string): Promise<WorkspaceProvider> {
  const { createLocalGitWorktreeProvider, readWorkflowRunManifest } = await import(
    "../core/workflow/index.ts"
  );
  const manifest = readWorkflowRunManifest(coordRoot, runId);
  const binding = manifest.execution.workspace_binding;
  if (!binding) {
    throw new Error(`workflow run ${runId} has no isolated workspace binding`);
  }
  if (binding.provider.id !== "local-git-worktree") {
    throw new Error(
      `workflow run ${runId} requires unavailable workspace provider ${binding.provider.id}`,
    );
  }
  return createLocalGitWorktreeProvider({ coordRoot });
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Next operator command after resolving an approval. Mid-run parks resume the
 * workflow; integration prepare parks after the run is already terminal, so
 * the durable plan is authorized by re-running prepare (resume would fail). */
function approvalNextActionHint(coordRoot: string, approval: WorkflowApproval): string {
  const bin = resolveBinName();
  const runId = approval.request.run_id;
  const integrationPlanPath = join(
    coordRoot,
    ".harnery",
    "workflows",
    runId,
    "integration",
    "plan.json",
  );
  if (existsSync(integrationPlanPath)) {
    return `prepare: ${bin} workflow integration prepare ${runId}\n`;
  }
  return `resume: ${bin} workflow resume ${runId}\n`;
}
