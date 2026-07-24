import { join } from "node:path";
import { readWorkflowProof } from "../proof.ts";
import { readWorkflowRunManifest } from "../run-state.ts";
import { acquireNoClobberLease } from "./leases.ts";
import { containsPath } from "./paths.ts";
import {
  appendCleanupAttempt,
  appendWorkflowJournalEvent,
  readCleanupAttempts,
  readWorkflowSupplement,
  stableDigest,
  workflowRunDir,
  writeWorkflowSupplement,
} from "./state.ts";
import type {
  WorkspaceBinding,
  WorkspaceCleanupAttempt,
  WorkspaceCleanupIntent,
  WorkspaceCleanupMode,
  WorkspaceCleanupReceipt,
  WorkspaceCleanupResult,
  WorkspaceProvider,
} from "./types.ts";
import { isWorkspaceAttestation, isWorkspaceBoundExecutionEvidence } from "./validate.ts";

const CLEANUP_LEASE_STALE_MS = 5 * 60 * 1_000;

export interface CleanupWorkspaceInput {
  coordRoot: string;
  runId: string;
  provider: WorkspaceProvider;
  mode?: WorkspaceCleanupMode;
}

export async function cleanupWorkspace(
  input: CleanupWorkspaceInput,
): Promise<WorkspaceCleanupAttempt | WorkspaceCleanupReceipt> {
  const release = acquireCleanupLease(input.coordRoot, input.runId);
  try {
    return await cleanupWorkspaceUnderLease(input);
  } finally {
    release();
  }
}

async function cleanupWorkspaceUnderLease(
  input: CleanupWorkspaceInput,
): Promise<WorkspaceCleanupAttempt | WorkspaceCleanupReceipt> {
  const manifest = readWorkflowRunManifest(input.coordRoot, input.runId);
  const proof = readWorkflowProof(input.coordRoot, input.runId);
  const binding = manifest.execution.workspace_binding;
  if (
    !binding ||
    !isWorkspaceBoundExecutionEvidence(proof.execution, input.runId) ||
    stableDigest(binding) !== stableDigest(proof.execution.binding)
  ) {
    throw new Error("workspace cleanup requires matching terminal execution evidence");
  }
  assertCleanupPathAuthority(binding, manifest.execution.policy?.allowed_paths ?? []);

  const mode = input.mode ?? "normal";
  const current = await input.provider.attest(binding);
  if (!isWorkspaceAttestation(current, binding)) {
    throw new Error("workspace cleanup provider returned an invalid current attestation");
  }
  const intent = resolveCleanupIntent(input, binding, current, mode);
  for (const attempt of readCleanupAttempts(input.coordRoot, input.runId)) {
    if (
      attempt.operation_id !== intent.operation_id ||
      attempt.binding_id !== binding.binding_id ||
      attempt.binding_sha256 !== intent.binding_sha256 ||
      attempt.mode !== intent.mode ||
      (attempt.attestation !== undefined && !isWorkspaceAttestation(attempt.attestation, binding))
    ) {
      throw new Error("workspace cleanup attempt does not match the immutable intent");
    }
  }

  const receipt = readWorkflowSupplement<WorkspaceCleanupReceipt>(
    input.coordRoot,
    input.runId,
    "cleanup/receipt.json",
  );
  if (receipt) {
    validateCleanupReceipt(receipt, binding, intent);
    if (!isReleasedAttestation(current)) {
      throw new Error("existing cleanup receipt no longer reattests exact resource absence");
    }
    return receipt;
  }

  appendCleanupAttempt(input.coordRoot, input.runId, {
    schema_version: 1,
    operation_id: intent.operation_id,
    binding_id: binding.binding_id,
    binding_sha256: intent.binding_sha256,
    mode,
    status: "started",
    recorded_at: new Date().toISOString(),
  });
  const result = await input.provider.cleanup(binding, intent);
  validateCleanupResult(result, binding);
  const attempt = appendCleanupAttempt(input.coordRoot, input.runId, {
    schema_version: 1,
    operation_id: intent.operation_id,
    binding_id: binding.binding_id,
    binding_sha256: intent.binding_sha256,
    mode,
    status: result.status,
    branch_deleted: result.branch_deleted,
    attestation: result.attestation,
    reason: result.reason,
    recorded_at: result.recorded_at,
  });
  appendWorkflowJournalEvent(input.coordRoot, input.runId, "workspace.cleanup", {
    binding_id: binding.binding_id,
    provider_id: binding.provider.id,
    operation_id: intent.operation_id,
    attempt: attempt.seq,
    status: attempt.status,
  });
  if (result.status !== "released" && result.status !== "already_released") {
    return attempt;
  }
  if (!result.branch_deleted || !isReleasedAttestation(result.attestation)) {
    throw new Error("workspace cleanup cannot receipt an incomplete resource release");
  }
  const terminal: WorkspaceCleanupReceipt = {
    schema_version: 1,
    receipt_id: `cleanup-${stableDigest({
      operation: intent.operation_id,
      binding: intent.binding_sha256,
    }).slice(0, 24)}`,
    operation_id: intent.operation_id,
    binding_id: binding.binding_id,
    binding_sha256: intent.binding_sha256,
    mode,
    status: result.status,
    branch_deleted: true,
    attestation: result.attestation,
    recorded_at: result.recorded_at,
  };
  writeWorkflowSupplement(input.coordRoot, input.runId, "cleanup/receipt.json", terminal);
  return terminal;
}

function assertCleanupPathAuthority(
  binding: WorkspaceBinding,
  allowedPaths: readonly string[],
): void {
  if (
    allowedPaths.length > 0 &&
    (!allowedPaths.some((root) => containsPath(root, binding.workspace_root)) ||
      !allowedPaths.some((root) => containsPath(root, binding.active_root)) ||
      (binding.repository !== undefined &&
        (!allowedPaths.some((root) =>
          containsPath(root, binding.repository!.source_root.realpath),
        ) ||
          !allowedPaths.some((root) =>
            containsPath(root, binding.repository!.common_dir.realpath),
          ))))
  ) {
    throw new Error("workspace cleanup path is outside frozen policy path authority");
  }
  if (
    !containsPath(binding.writable_root.realpath, binding.workspace_root) ||
    !containsPath(binding.writable_root.realpath, binding.active_root)
  ) {
    throw new Error("workspace cleanup path is outside frozen writable-root authority");
  }
}

function acquireCleanupLease(coordRoot: string, runId: string): () => void {
  const authoritySha256 = stableDigest({ run_id: runId, operation: "cleanup" });
  const lease = acquireNoClobberLease({
    path: join(workflowRunDir(coordRoot, runId), "cleanup", "operation.lease"),
    scope: "cleanup",
    authoritySha256,
    staleAfterMs: CLEANUP_LEASE_STALE_MS,
    metadata: { run_id: runId },
    validateStaleOwner: (owner) =>
      owner.authority_sha256 === authoritySha256 && owner.metadata?.run_id === runId,
  });
  return () => lease.release();
}

function resolveCleanupIntent(
  input: CleanupWorkspaceInput,
  binding: WorkspaceBinding,
  attestation: WorkspaceCleanupResult["attestation"],
  mode: WorkspaceCleanupMode,
): WorkspaceCleanupIntent {
  if (!binding.repository) throw new Error("workspace cleanup requires repository identity");
  const bindingSha256 = stableDigest(binding);
  const operationId = `cleanup-${stableDigest({ binding: bindingSha256, mode }).slice(0, 24)}`;
  const prior = readWorkflowSupplement<WorkspaceCleanupIntent>(
    input.coordRoot,
    input.runId,
    "cleanup/intent.json",
  );
  if (prior) {
    if (
      prior.schema_version !== 1 ||
      prior.run_id !== input.runId ||
      prior.binding_id !== binding.binding_id ||
      prior.binding_sha256 !== bindingSha256 ||
      prior.mode !== mode ||
      prior.operation_id !== operationId
    ) {
      throw new Error("existing cleanup intent does not match current workspace authority");
    }
    validateCleanupIntentExpected(prior, binding);
    return prior;
  }
  const workspaceRefOid = attestation.repository?.workspace_ref_oid;
  const targetRefOid = attestation.repository?.target_ref_oid;
  if (!workspaceRefOid || !targetRefOid) {
    throw new Error("workspace cleanup cannot freeze exact source and target ref identities");
  }
  const proposed: WorkspaceCleanupIntent = {
    schema_version: 1,
    run_id: input.runId,
    operation_id: operationId,
    binding_id: binding.binding_id,
    binding_sha256: bindingSha256,
    mode,
    expected: {
      worktree_path: binding.workspace_root,
      gitdir: binding.repository.gitdir,
      workspace_ref: binding.repository.workspace_ref,
      workspace_ref_oid: workspaceRefOid,
      target_ref: binding.repository.target_ref,
      target_ref_oid: targetRefOid,
    },
    created_at: new Date().toISOString(),
  };
  writeWorkflowSupplement(input.coordRoot, input.runId, "cleanup/intent.json", proposed);
  return proposed;
}

function validateCleanupIntentExpected(
  intent: WorkspaceCleanupIntent,
  binding: WorkspaceBinding,
): void {
  const repository = binding.repository;
  if (
    !repository ||
    intent.expected.worktree_path !== binding.workspace_root ||
    stableDigest(intent.expected.gitdir) !== stableDigest(repository.gitdir) ||
    intent.expected.workspace_ref !== repository.workspace_ref ||
    intent.expected.target_ref !== repository.target_ref ||
    !/^[0-9a-f]{40,64}$/.test(intent.expected.workspace_ref_oid) ||
    !/^[0-9a-f]{40,64}$/.test(intent.expected.target_ref_oid)
  ) {
    throw new Error("cleanup intent expected identities do not match the workspace binding");
  }
}

function validateCleanupResult(result: WorkspaceCleanupResult, binding: WorkspaceBinding): void {
  if (
    result.schema_version !== 1 ||
    result.binding_id !== binding.binding_id ||
    ![
      "released",
      "already_released",
      "preserved_dirty",
      "blocked",
      "unsupported",
      "partial",
    ].includes(result.status) ||
    !Number.isFinite(Date.parse(result.recorded_at)) ||
    typeof result.branch_deleted !== "boolean" ||
    !isWorkspaceAttestation(result.attestation, binding) ||
    ((result.status === "released" || result.status === "already_released") &&
      !isReleasedAttestation(result.attestation))
  ) {
    throw new Error("workspace cleanup provider returned an invalid result");
  }
}

function validateCleanupReceipt(
  receipt: WorkspaceCleanupReceipt,
  binding: WorkspaceBinding,
  intent: WorkspaceCleanupIntent,
): void {
  if (
    receipt.schema_version !== 1 ||
    receipt.operation_id !== intent.operation_id ||
    receipt.binding_id !== binding.binding_id ||
    receipt.binding_sha256 !== intent.binding_sha256 ||
    receipt.mode !== intent.mode ||
    (receipt.status !== "released" && receipt.status !== "already_released") ||
    receipt.branch_deleted !== true ||
    !isWorkspaceAttestation(receipt.attestation, binding) ||
    !isReleasedAttestation(receipt.attestation)
  ) {
    throw new Error("workspace cleanup receipt is invalid or mismatched");
  }
}

function isReleasedAttestation(attestation: WorkspaceCleanupResult["attestation"]): boolean {
  return (
    attestation.status === "ok" &&
    attestation.provider_drift.length === 0 &&
    attestation.resource_state === "released" &&
    !attestation.workspace_exists
  );
}
