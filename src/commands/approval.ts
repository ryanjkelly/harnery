import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveCoordRoot } from "../core/agents/coord-client.ts";
import { resolveBinName } from "../core/config.ts";
import {
  type DocketApproval,
  docketContact,
  docketSourceLabel,
  fetchPresence,
  findRemoteApproval,
  type RemoteDocket,
  readRemoteDockets,
  readRemoteMachines,
} from "../core/presence/index.ts";
import type { WorkflowApproval, WorkflowApprovalStatus } from "../core/run/approvals.ts";

/**
 * `approval`: inspect and resolve durable run-policy approvals. Local
 * approvals resolve here. With `--remote`, `list` also shows pending
 * approvals other machines share through the docket refs (ADR 0255), and
 * `show` falls back to those copies. Remote copies are read-only: approve or
 * deny on the machine that parked the run.
 */

interface ApprovalListOpts {
  status?: WorkflowApprovalStatus;
  json?: boolean;
  remote?: boolean;
}

interface ApprovalDecisionOpts {
  actor?: string;
  reason?: string;
  json?: boolean;
}

export function registerApprovalCommand(program: Command, emit: EmitContext): void {
  const approvals = program
    .command("approval")
    .description("Inspect and resolve durable run-policy approvals.");

  approvals
    .command("list")
    .description("List durable workflow approvals.")
    .option("--status <status>", "Filter: pending | approved | denied")
    .option("--remote", "Also list pending approvals shared by other machines (read-only)")
    .option("--json", "Emit approval records as JSON")
    .action(async (opts: ApprovalListOpts) => {
      const coordRoot = coordRootOrExit(emit);
      if (opts.status && !(["pending", "approved", "denied"] as const).includes(opts.status)) {
        emit.error({
          code: "bad_approval_status",
          message: `unknown approval status ${JSON.stringify(opts.status)}`,
        });
        process.exit(1);
      }
      const { listWorkflowApprovals } = await import("../core/run/approvals.ts");
      const records = listWorkflowApprovals(coordRoot, { status: opts.status });
      const remote: RemoteApprovalRow[] = [];
      if (opts.remote && (!opts.status || opts.status === "pending")) {
        const localIds = new Set(records.map((r) => r.request.id));
        for (const source of loadRemoteDockets(coordRoot)) {
          for (const approval of source.approvals) {
            if (localIds.has(approval.id)) continue;
            if (opts.status && approval.status !== opts.status) continue;
            remote.push(remoteApprovalRow(coordRoot, approval, source));
          }
        }
      }
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data(opts.remote ? { local: records, remote } : records);
        return;
      }
      if (records.length === 0 && remote.length === 0) {
        emit.text("no workflow approvals\n");
        return;
      }
      const lines = records.map(
        ({ request, status }) =>
          `${request.id}  ${status.padEnd(8)}  ${request.run_id}  ${request.request.phase}  ${request.request.action}  -> ${request.addressed_to}`,
      );
      for (const row of remote) {
        lines.push(
          `${row.id}  ${row.status.padEnd(8)}  ${row.run_id}  ${row.phase}  ${row.action}  -> ${row.addressed_to}  [${row.remote.machine}${row.remote.stale ? ", stale" : ""}, read-only]`,
        );
      }
      if (remote.length > 0) {
        lines.push(
          "",
          "Remote approvals resolve only on their own machine; `show <id>` prints who to ping.",
        );
      }
      emit.text(`${lines.join("\n")}\n`);
    });

  approvals
    .command("show <approval-id>")
    .description("Show one durable workflow approval (falls back to shared remote copies).")
    .option("--json", "Emit the approval record as JSON")
    .action(async (approvalId: string, opts: { json?: boolean }) => {
      const coordRoot = coordRootOrExit(emit);
      const { readWorkflowApproval, renderWorkflowApproval } = await import(
        "../core/run/approvals.ts"
      );
      let approval: WorkflowApproval;
      try {
        approval = readWorkflowApproval(coordRoot, approvalId);
      } catch (err) {
        const hit = findRemoteApproval(loadRemoteDockets(coordRoot), approvalId);
        if (!hit) {
          emit.error({ code: "workflow_approval_read_failed", message: (err as Error).message });
          process.exit(1);
        }
        const row = remoteApprovalRow(coordRoot, hit.approval, hit.source);
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(row);
        } else {
          emit.text(renderRemoteApproval(row));
        }
        return;
      }
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data(approval);
      } else {
        emit.text(renderWorkflowApproval(approval));
      }
    });

  const registerDecision = (command: "approve" | "deny", verdict: "allow" | "deny") => {
    approvals
      .command(`${command} <approval-id>`)
      .description(`${command === "approve" ? "Approve" : "Deny"} a pending workflow approval.`)
      .option("--actor <name>", "Decision actor recorded in the receipt")
      .option("--reason <text>", "Bounded decision reason")
      .option("--json", "Emit the resolved approval as JSON")
      .action(async (approvalId: string, opts: ApprovalDecisionOpts) => {
        const coordRoot = coordRootOrExit(emit);
        try {
          const { resolveWorkflowApproval, renderWorkflowApproval } = await import(
            "../core/run/approvals.ts"
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
                approvalNextActionHint(resolved.approval),
            );
          }
        } catch (err) {
          const hit = findRemoteApproval(readRemoteDockets(coordRoot).dockets, approvalId);
          if (hit) {
            const row = remoteApprovalRow(coordRoot, hit.approval, hit.source);
            emit.error({
              code: "remote_approval",
              message: `approval ${approvalId} was parked on ${row.remote.machine}; it can only be resolved there. Reach it: ${row.remote.reach}`,
            });
            process.exit(1);
          }
          emit.error({
            code: "workflow_approval_resolution_failed",
            message: (err as Error).message,
          });
          process.exit(1);
        }
      });
  };
  registerDecision("approve", "allow");
  registerDecision("deny", "deny");
}

interface RemoteApprovalRow extends DocketApproval {
  remote: {
    machine: string;
    published_at: string;
    age_secs: number;
    stale: boolean;
    read_only: true;
    reach: string;
  };
}

function remoteApprovalRow(
  coordRoot: string,
  approval: DocketApproval,
  source: RemoteDocket,
): RemoteApprovalRow {
  const agents =
    readRemoteMachines(coordRoot, { includeStale: true }).find(
      (m) => m.machine === source.ref || m.machine === source.machine,
    )?.agents ?? [];
  const contact = docketContact(undefined, agents);
  const machine = docketSourceLabel(source);
  return {
    ...approval,
    remote: {
      machine,
      published_at: source.published_at,
      age_secs: source.age_secs,
      stale: source.stale,
      read_only: true,
      reach: contact
        ? `${resolveBinName(coordRoot)} agents ping ${contact} "<message>"`
        : `no agent known on ${machine}; ask its owner directly`,
    },
  };
}

function renderRemoteApproval(row: RemoteApprovalRow): string {
  return [
    `approval: ${row.id}`,
    `status: ${row.status} (shared copy from ${row.remote.machine}${row.remote.stale ? ", stale" : ""}, read-only)`,
    `run: ${row.run_id}`,
    `requested: ${row.requested_at}`,
    `addressed to: ${row.addressed_to}`,
    `request: ${row.phase} ${row.action}`,
    ...(row.reason ? [`reason: ${row.reason}`] : []),
    `resolve on its own machine; reach it: ${row.remote.reach}`,
    "",
  ].join("\n");
}

/** Other machines' shared dockets, after a throttled fetch that fails open. */
function loadRemoteDockets(coordRoot: string): RemoteDocket[] {
  try {
    fetchPresence(coordRoot, { sync: true });
  } catch {
    /* fail open */
  }
  return readRemoteDockets(coordRoot).dockets;
}

function approvalNextActionHint(approval: WorkflowApproval): string {
  return `resume: ${resolveBinName()} run resume ${approval.request.run_id}\n`;
}

function coordRootOrExit(emit: EmitContext): string {
  const coordRoot = resolveCoordRoot();
  if (!coordRoot) {
    emit.error({ code: "no_coord_root", message: "no .harnery/ coordination root found" });
    process.exit(1);
  }
  return coordRoot;
}
