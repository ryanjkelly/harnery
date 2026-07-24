import {
  acquireWorkEventLease,
  readWorkItemIgnoringLease,
  type WorkEvent,
} from "../../work/state.ts";
import { readWorkflowRunManifest } from "../run-state.ts";
import {
  appendWorkflowJournalEvent,
  readWorkflowSupplement,
  stableDigest,
  writeWorkflowSupplement,
} from "./state.ts";
import type {
  WorkspaceBinding,
  WorkspaceCancellationReceipt,
  WorkspaceCancellationResult,
  WorkspaceProvider,
} from "./types.ts";
import { isWorkspaceAttestation } from "./validate.ts";

export interface CancelWorkspaceInput {
  coordRoot: string;
  runId: string;
  provider: WorkspaceProvider;
}

export async function cancelWorkspace(
  input: CancelWorkspaceInput,
): Promise<WorkspaceCancellationReceipt> {
  const manifest = readWorkflowRunManifest(input.coordRoot, input.runId);
  const binding = manifest.execution.workspace_binding;
  if (binding?.owner.kind !== "work_attempt") {
    throw new Error("workspace cancellation requires a work-linked isolated binding");
  }
  const release = acquireWorkEventLease(input.coordRoot, binding.owner.work_item_id);
  try {
    const cancellation = currentWorkCancellation(input.coordRoot, binding);
    const bindingSha256 = stableDigest(binding);
    const eventSha256 = stableDigest(cancellation);
    const prior = readWorkflowSupplement<WorkspaceCancellationReceipt>(
      input.coordRoot,
      input.runId,
      "cancellation/outcome.json",
    );
    if (prior) {
      validateCancellationReceipt(prior, binding, cancellation);
      return prior;
    }

    const providerBinding = await input.provider.readBinding(binding);
    if (stableDigest(providerBinding) !== bindingSha256) {
      throw new Error("workspace cancellation provider binding differs from the frozen manifest");
    }
    const result = await input.provider.cancel(binding);
    validateCancellationResult(result, binding);
    const receipt: WorkspaceCancellationReceipt = {
      schema_version: 1,
      receipt_id: `cancellation-${stableDigest({
        binding: bindingSha256,
        event: eventSha256,
        result,
      }).slice(0, 24)}`,
      run_id: input.runId,
      binding_id: binding.binding_id,
      binding_sha256: bindingSha256,
      work_item_id: binding.owner.work_item_id,
      work_event_seq: cancellation.seq,
      work_event_sha256: eventSha256,
      status: result.status,
      recorded_at: result.recorded_at,
      attestation: result.attestation,
      reason: result.reason,
    };
    writeWorkflowSupplement(input.coordRoot, input.runId, "cancellation/outcome.json", receipt);
    appendWorkflowJournalEvent(input.coordRoot, input.runId, "workspace.cancel", {
      binding_id: binding.binding_id,
      provider_id: binding.provider.id,
      receipt_id: receipt.receipt_id,
      work_event_seq: cancellation.seq,
      work_event_sha256: eventSha256,
      status: receipt.status,
    });
    return receipt;
  } finally {
    release();
  }
}

function currentWorkCancellation(coordRoot: string, binding: WorkspaceBinding): WorkEvent {
  if (binding.owner.kind !== "work_attempt") {
    throw new Error("workspace cancellation requires a work attempt owner");
  }
  const work = readWorkItemIgnoringLease(coordRoot, binding.owner.work_item_id);
  const governance = [...work.events]
    .reverse()
    .find((event) => ["work.accepted", "work.cancelled", "work.reopened"].includes(event.event));
  if (work.projection.state !== "cancelled" || governance?.event !== "work.cancelled") {
    throw new Error("workspace cancellation requires the current host work cancellation");
  }
  return governance;
}

function validateCancellationResult(
  result: WorkspaceCancellationResult,
  binding: WorkspaceBinding,
): void {
  if (
    result.schema_version !== 1 ||
    result.binding_id !== binding.binding_id ||
    !["cancelled", "unsupported", "preserved_dirty", "blocked"].includes(result.status) ||
    !Number.isFinite(Date.parse(result.recorded_at)) ||
    !isWorkspaceAttestation(result.attestation, binding)
  ) {
    throw new Error("workspace cancellation provider returned an invalid result");
  }
}

function validateCancellationReceipt(
  receipt: WorkspaceCancellationReceipt,
  binding: WorkspaceBinding,
  cancellation: WorkEvent,
): void {
  if (
    receipt.schema_version !== 1 ||
    receipt.run_id !== binding.run_id ||
    receipt.binding_id !== binding.binding_id ||
    receipt.binding_sha256 !== stableDigest(binding) ||
    receipt.work_item_id !== binding.owner.work_item_id ||
    receipt.work_event_seq !== cancellation.seq ||
    receipt.work_event_sha256 !== stableDigest(cancellation) ||
    !["cancelled", "unsupported", "preserved_dirty", "blocked"].includes(receipt.status) ||
    !Number.isFinite(Date.parse(receipt.recorded_at)) ||
    !isWorkspaceAttestation(receipt.attestation, binding)
  ) {
    throw new Error("workspace cancellation outcome does not match current host authority");
  }
}
