import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readWorkItem } from "../../work/state.ts";
import { readWorkflowProof } from "../proof.ts";
import { readWorkflowRunManifest } from "../run-state.ts";
import type { WorkflowProof } from "../types.ts";
import { deriveWorkspaceLifecycle, type WorkspaceLifecycleProjection } from "./lifecycle.ts";
import {
  fileSha256,
  readCleanupAttempts,
  readIntegrationAttempts,
  readWorkflowSupplement,
  readWorkspaceEvents,
  workflowRunDir,
} from "./state.ts";
import type {
  IntegrationApplyReceipt,
  IntegrationAuthorization,
  IntegrationPlan,
  WorkspaceAttestation,
  WorkspaceCancellationReceipt,
  WorkspaceCleanupIntent,
  WorkspaceCleanupReceipt,
  WorkspaceCompatibilityExecutionEvidence,
  WorkspaceIsolation,
  WorkspaceProviderRef,
} from "./types.ts";
import { isWorkspaceBoundExecutionEvidence } from "./validate.ts";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export type WorkflowWorkspaceSelection = "shared" | "compatibility" | "isolated";
export type WorkflowWorkspaceVerification =
  | "not_applicable"
  | "pending"
  | "ok"
  | "blocked"
  | "lost";

export interface WorkflowWorkspaceStatus {
  schema_version: 1;
  run_id: string;
  run_name: string;
  work_item_id?: string;
  started_at: string;
  selection: WorkflowWorkspaceSelection;
  requested_isolation: "shared" | WorkspaceIsolation;
  effective_isolation: "shared" | WorkspaceIsolation;
  provider?: WorkspaceProviderRef;
  compatibility?: {
    reason: WorkspaceCompatibilityExecutionEvidence["selection_reason"];
    unsupported: WorkspaceCompatibilityExecutionEvidence["unsupported"];
    unknowns: WorkspaceCompatibilityExecutionEvidence["unknowns"];
  };
  allocation?: {
    binding_id: string;
    workspace_id: string;
    workspace_root: string;
    active_root: string;
    created_at: string;
  };
  lifecycle: WorkspaceLifecycleProjection;
  verification: {
    status: WorkflowWorkspaceVerification;
    workflow_status?: WorkflowProof["run"]["status"];
    attested_at?: string;
    drift: string[];
    unsupported: Array<{ code: string; message: string }>;
    unknowns: Array<{ code: string; message: string }>;
  };
  integration: {
    state: WorkspaceLifecycleProjection["integration_state"];
    changed_paths: string[];
    target_ref?: string;
    target_commit?: string;
    receipt_id?: string;
  };
  cleanup: {
    state: "not_requested" | "pending" | "released" | "preserved_dirty" | "blocked";
    attempts: number;
    reason?: string;
    receipt_id?: string;
  };
  repository: {
    dirty_paths: string[];
    conflicts: string[];
    operations_in_progress: string[];
  };
  integrity: {
    status: "verified";
    proof_sha256?: string;
    provider_event_chain_sha256: string | null;
  };
}

export type WorkflowWorkspaceInspection =
  | { ok: true; value: WorkflowWorkspaceStatus }
  | { ok: false; run_id: string; error: string };

interface WorkflowJournalProjectionEvent {
  event: string;
  ok?: boolean;
  status?: "blocked" | "lost" | "cancelled" | "unsupported" | "preserved_dirty";
  work_event_seq?: number;
  work_event_sha256?: string;
}

/**
 * Read one workflow's workspace state from validated durable authority.
 *
 * Corrupt, contradictory, or foreign records throw instead of being projected
 * as healthy. Use inspectWorkflowWorkspace when a UI needs a typed error row.
 */
export function readWorkflowWorkspaceStatus(
  coordRoot: string,
  runId: string,
): WorkflowWorkspaceStatus {
  assertRunId(runId);
  const root = resolve(coordRoot);
  const runDir = workflowRunDir(root, runId);
  const manifest = readWorkflowRunManifest(root, runId);
  const journal = readWorkspaceJournal(runDir, runId);
  const proofPath = join(runDir, "proof.json");
  const proof = existsSync(proofPath) ? readWorkflowProof(root, runId) : undefined;
  const proofSha256 = proof ? fileSha256(proofPath) : undefined;
  const binding = manifest.execution.workspace_binding;
  const fallback = manifest.execution.workspace_fallback;

  if (!binding) {
    const lifecycle = deriveWorkspaceLifecycle({
      manifest,
      workflow_journal: journal,
      proof,
      proof_sha256: proofSha256,
      allocation_unsupported: fallback !== undefined,
    });
    return {
      schema_version: 1,
      run_id: runId,
      run_name: manifest.name,
      work_item_id: manifest.work_item_id,
      started_at: manifest.started_at,
      selection: fallback ? "compatibility" : "shared",
      requested_isolation: manifest.execution.isolation,
      effective_isolation: "shared",
      provider: fallback?.provider,
      compatibility: fallback
        ? {
            reason: fallback.selection_reason,
            unsupported: [...fallback.unsupported],
            unknowns: [...fallback.unknowns],
          }
        : undefined,
      lifecycle,
      verification: {
        status: "not_applicable",
        workflow_status: proof?.run.status,
        drift: [...(fallback?.drift ?? [])],
        unsupported: [...(fallback?.unsupported ?? [])],
        unknowns: [...(fallback?.unknowns ?? [])],
      },
      integration: { state: "none", changed_paths: [] },
      cleanup: { state: "not_requested", attempts: 0 },
      repository: { dirty_paths: [], conflicts: [], operations_in_progress: [] },
      integrity: {
        status: "verified",
        proof_sha256: proofSha256,
        provider_event_chain_sha256: null,
      },
    };
  }

  const providerEvents = readWorkspaceEvents(root, binding.provider.id, binding.binding_id);
  const integrationPlan = readWorkflowSupplement<IntegrationPlan>(
    root,
    runId,
    "integration/plan.json",
  );
  const integrationAuthorization = readWorkflowSupplement<IntegrationAuthorization>(
    root,
    runId,
    "integration/authorization.json",
  );
  const integrationAttempts = readIntegrationAttempts(root, runId);
  const integrationReceipt = readWorkflowSupplement<IntegrationApplyReceipt>(
    root,
    runId,
    "integration/receipt.json",
  );
  const cleanupIntent = readWorkflowSupplement<WorkspaceCleanupIntent>(
    root,
    runId,
    "cleanup/intent.json",
  );
  const cleanupAttempts = readCleanupAttempts(root, runId);
  const cleanupReceipt = readWorkflowSupplement<WorkspaceCleanupReceipt>(
    root,
    runId,
    "cleanup/receipt.json",
  );
  const cancellationReceipt = readWorkflowSupplement<WorkspaceCancellationReceipt>(
    root,
    runId,
    "cancellation/outcome.json",
  );
  const workEvents =
    binding.owner.kind === "work_attempt"
      ? readWorkItem(root, binding.owner.work_item_id).events
      : undefined;

  const lifecycle = deriveWorkspaceLifecycle({
    binding,
    provider_events: providerEvents,
    manifest,
    workflow_journal: journal,
    proof,
    proof_sha256: proofSha256,
    integration_plan: integrationPlan,
    integration_authorization: integrationAuthorization,
    integration_attempts: integrationAttempts,
    integration_receipt: integrationReceipt,
    cleanup_intent: cleanupIntent,
    cleanup_attempts: cleanupAttempts,
    cleanup_receipt: cleanupReceipt,
    work_events: workEvents,
    cancellation_receipt: cancellationReceipt,
  });
  const latestCleanup = cleanupAttempts.at(-1);
  const attestation = latestAttestation(proof, latestCleanup?.attestation, cleanupReceipt);

  return {
    schema_version: 1,
    run_id: runId,
    run_name: manifest.name,
    work_item_id: manifest.work_item_id,
    started_at: manifest.started_at,
    selection: "isolated",
    requested_isolation: manifest.execution.isolation,
    effective_isolation: binding.isolation,
    provider: binding.provider,
    allocation: {
      binding_id: binding.binding_id,
      workspace_id: binding.workspace_id,
      workspace_root: binding.workspace_root,
      active_root: binding.active_root,
      created_at: binding.created_at,
    },
    lifecycle,
    verification: {
      status: verificationStatus(proof, attestation),
      workflow_status: proof?.run.status,
      attested_at: attestation?.recorded_at,
      drift: [...(attestation?.provider_drift ?? [])],
      unsupported: [...(attestation?.unsupported ?? [])],
      unknowns: [...(attestation?.unknowns ?? [])],
    },
    integration: {
      state: lifecycle.integration_state,
      changed_paths: [...(integrationPlan?.provider_preview.changed_paths ?? [])],
      target_ref: integrationPlan?.provider_preview.target_ref,
      target_commit:
        integrationReceipt?.target_commit ?? integrationPlan?.provider_preview.target_commit,
      receipt_id: integrationReceipt?.receipt_id,
    },
    cleanup: {
      state: cleanupState(cleanupIntent, latestCleanup?.status, cleanupReceipt),
      attempts: cleanupAttempts.length,
      reason: latestCleanup?.reason,
      receipt_id: cleanupReceipt?.receipt_id,
    },
    repository: {
      dirty_paths: [...(attestation?.repository?.dirty_paths ?? [])],
      conflicts: [...(attestation?.repository?.conflicts ?? [])],
      operations_in_progress: [...(attestation?.repository?.operation_in_progress ?? [])],
    },
    integrity: {
      status: "verified",
      proof_sha256: proofSha256,
      provider_event_chain_sha256: lifecycle.provider_event_chain_sha256,
    },
  };
}

export function inspectWorkflowWorkspace(
  coordRoot: string,
  runId: string,
): WorkflowWorkspaceInspection {
  try {
    return { ok: true, value: readWorkflowWorkspaceStatus(coordRoot, runId) };
  } catch (error) {
    return {
      ok: false,
      run_id: runId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function listWorkflowWorkspaceInspections(coordRoot: string): WorkflowWorkspaceInspection[] {
  const workflowsRoot = join(resolve(coordRoot), ".harnery", "workflows");
  if (!existsSync(workflowsRoot)) return [];
  return readdirSync(workflowsRoot)
    .filter((runId) => RUN_ID.test(runId) && existsSync(join(workflowsRoot, runId, "run.json")))
    .sort((a, b) => b.localeCompare(a))
    .map((runId) => inspectWorkflowWorkspace(coordRoot, runId));
}

export function renderWorkflowWorkspaceStatus(status: WorkflowWorkspaceStatus): string {
  const lines = [
    `run ${status.run_id} (${status.run_name}): ${status.selection}`,
    `isolation: requested ${status.requested_isolation}; effective ${status.effective_isolation}`,
    `lifecycle: ${status.lifecycle.state}; resource ${
      status.lifecycle.resource_state ?? "not applicable"
    }; integration ${status.lifecycle.integration_state}; cancellation ${status.lifecycle.cancellation}`,
  ];
  if (status.provider) {
    lines.push(`provider: ${status.provider.id}@${status.provider.version}`);
  }
  if (status.compatibility) {
    lines.push(`compatibility: ${status.compatibility.reason}`);
  }
  if (status.allocation) {
    lines.push(
      `binding: ${status.allocation.binding_id}; workspace ${status.allocation.workspace_id}`,
      `workspace root: ${status.allocation.workspace_root}`,
      `active root: ${status.allocation.active_root}`,
    );
  }
  lines.push(
    `verification: ${status.verification.status}; workflow ${
      status.verification.workflow_status ?? "not terminal"
    }; ${status.verification.drift.length} drift; ${status.verification.unknowns.length} unknown`,
    `repository: ${status.repository.dirty_paths.length} dirty; ${
      status.repository.conflicts.length
    } conflict; ${status.repository.operations_in_progress.length} operation in progress`,
    `integration: ${status.integration.state}; ${status.integration.changed_paths.length} changed path`,
    `cleanup: ${status.cleanup.state}; ${status.cleanup.attempts} attempt`,
  );
  if (status.cleanup.reason) lines.push(`cleanup reason: ${status.cleanup.reason}`);
  return `${lines.join("\n")}\n`;
}

function readWorkspaceJournal(runDir: string, runId: string): WorkflowJournalProjectionEvent[] {
  const path = join(runDir, "journal.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new Error(
          `cannot parse workflow journal event ${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (
        typeof record.event !== "string" ||
        (record.run_id !== undefined && record.run_id !== runId)
      ) {
        throw new Error(`workflow journal event ${index + 1} is foreign or unsupported`);
      }
      return {
        event: record.event,
        ok: typeof record.ok === "boolean" ? record.ok : undefined,
        status: journalStatus(record.status),
        work_event_seq:
          typeof record.work_event_seq === "number" ? record.work_event_seq : undefined,
        work_event_sha256:
          typeof record.work_event_sha256 === "string" ? record.work_event_sha256 : undefined,
      };
    });
}

function latestAttestation(
  proof: WorkflowProof | undefined,
  cleanupAttempt: WorkspaceAttestation | undefined,
  cleanupReceipt: WorkspaceCleanupReceipt | undefined,
): WorkspaceAttestation | undefined {
  if (cleanupReceipt) return cleanupReceipt.attestation;
  if (cleanupAttempt) return cleanupAttempt;
  if (proof && isWorkspaceBoundExecutionEvidence(proof.execution, proof.run.id)) {
    return proof.execution.terminal_attestation;
  }
  return undefined;
}

function verificationStatus(
  proof: WorkflowProof | undefined,
  attestation: WorkspaceAttestation | undefined,
): WorkflowWorkspaceVerification {
  if (!proof || !attestation) return "pending";
  return attestation.status;
}

function cleanupState(
  intent: WorkspaceCleanupIntent | undefined,
  attemptStatus: string | undefined,
  receipt: WorkspaceCleanupReceipt | undefined,
): WorkflowWorkspaceStatus["cleanup"]["state"] {
  if (receipt) return "released";
  if (attemptStatus === "preserved_dirty") return "preserved_dirty";
  if (attemptStatus && ["blocked", "unsupported", "partial"].includes(attemptStatus)) {
    return "blocked";
  }
  return intent || attemptStatus ? "pending" : "not_requested";
}

function journalStatus(value: unknown): WorkflowJournalProjectionEvent["status"] {
  return typeof value === "string" &&
    ["blocked", "lost", "cancelled", "unsupported", "preserved_dirty"].includes(value)
    ? (value as WorkflowJournalProjectionEvent["status"])
    : undefined;
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error("workflow run id is invalid");
}
