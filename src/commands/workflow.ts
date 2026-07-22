import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { workflowSubscriptionOnly } from "../core/config.ts";
import { createBuiltinHarnessRegistry } from "../core/harnesses/index.ts";
import { findCoordRoot } from "../core/hooks/resolve/coord-root.ts";
import type { PolicyIsolation } from "../core/policy/index.ts";
import { loadPolicyFile } from "../core/policy/index.ts";
import type { WorkflowApprovalStatus } from "../core/workflow/approvals.ts";
import { WorkflowParkedError } from "../core/workflow/engine.ts";

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
        const { runWorkflow } = await import("../core/workflow/engine.ts");
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
                `resume after resolution: harn workflow resume ${err.runId}\n`,
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
        const { assertWorkflowRunResumable, runWorkflow } = await import(
          "../core/workflow/index.ts"
        );
        const { manifest } = assertWorkflowRunResumable(coordRoot, runId);
        const report = await runWorkflow(manifest.script.path, {
          coordRoot,
          spawners: registry.spawners(),
          resumeRunId: runId,
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
                `resume: harn workflow resume ${resolved.approval.request.run_id}\n`,
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
