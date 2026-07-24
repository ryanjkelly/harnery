import type { WorkEvent } from "../../work/state.ts";
import { stableDigest } from "../durable-record.ts";
import type { WorkflowRunManifest } from "../run-state.ts";
import type { WorkflowProof } from "../types.ts";
import type { WorkspaceProviderEvent } from "./state.ts";
import type {
  IntegrationApplyAttempt,
  IntegrationApplyReceipt,
  IntegrationAuthorization,
  IntegrationPlan,
  WorkspaceBinding,
  WorkspaceCancellationReceipt,
  WorkspaceCancellationResult,
  WorkspaceCleanupAttempt,
  WorkspaceCleanupIntent,
  WorkspaceCleanupReceipt,
  WorkspaceIntegrationState,
  WorkspaceLifecycleState,
  WorkspaceProofOutcome,
  WorkspaceResourceState,
} from "./types.ts";
import { isWorkspaceAttestation, isWorkspaceBoundExecutionEvidence } from "./validate.ts";

const LIFECYCLE_STATES = new Set<WorkspaceLifecycleState>([
  "shared",
  "unsupported",
  "allocation_recorded",
  "allocating",
  "bound",
  "running",
  "parked",
  "completed_unintegrated",
  "failed_retained",
  "integration_requested",
  "integrating",
  "integrated",
  "cleanup_pending",
  "released",
  "blocked",
  "lost",
  "preserved_dirty",
  "abandoned_dirty",
]);

const LEGAL_TRANSITIONS: Record<WorkspaceLifecycleState, ReadonlySet<WorkspaceLifecycleState>> = {
  shared: new Set(["shared", "completed_unintegrated", "failed_retained"]),
  unsupported: new Set(["unsupported"]),
  allocation_recorded: new Set(["allocation_recorded", "allocating", "blocked", "lost"]),
  allocating: new Set(["allocating", "bound", "blocked", "lost"]),
  bound: new Set([
    "bound",
    "running",
    "parked",
    "completed_unintegrated",
    "failed_retained",
    "blocked",
    "lost",
  ]),
  running: new Set([
    "running",
    "parked",
    "completed_unintegrated",
    "failed_retained",
    "cleanup_pending",
    "preserved_dirty",
    "blocked",
    "lost",
  ]),
  parked: new Set([
    "parked",
    "running",
    "completed_unintegrated",
    "failed_retained",
    "cleanup_pending",
    "preserved_dirty",
    "blocked",
    "lost",
  ]),
  completed_unintegrated: new Set([
    "completed_unintegrated",
    "integration_requested",
    "cleanup_pending",
    "preserved_dirty",
    "blocked",
    "lost",
  ]),
  failed_retained: new Set([
    "failed_retained",
    "cleanup_pending",
    "preserved_dirty",
    "blocked",
    "lost",
  ]),
  integration_requested: new Set([
    "integration_requested",
    "integrating",
    "cleanup_pending",
    "blocked",
    "lost",
  ]),
  integrating: new Set(["integrating", "integrated", "blocked", "lost"]),
  integrated: new Set(["integrated", "cleanup_pending", "blocked", "lost"]),
  cleanup_pending: new Set([
    "cleanup_pending",
    "released",
    "preserved_dirty",
    "abandoned_dirty",
    "blocked",
    "lost",
  ]),
  released: new Set(["released"]),
  blocked: new Set([
    "blocked",
    "allocating",
    "bound",
    "running",
    "parked",
    "completed_unintegrated",
    "failed_retained",
    "integration_requested",
    "integrating",
    "cleanup_pending",
    "released",
    "preserved_dirty",
    "abandoned_dirty",
    "lost",
  ]),
  lost: new Set(["lost", "blocked"]),
  preserved_dirty: new Set(["preserved_dirty", "cleanup_pending", "released", "blocked"]),
  abandoned_dirty: new Set(["abandoned_dirty"]),
};

export interface WorkspaceLifecycleProjectionInput {
  allocation_unsupported?: boolean;
  binding?: WorkspaceBinding;
  provider_events?: readonly WorkspaceProviderEvent[];
  manifest?: WorkflowRunManifest;
  workflow_journal?: readonly {
    event: string;
    ok?: boolean;
    status?: "blocked" | "lost" | WorkspaceCancellationResult["status"];
    work_event_seq?: number;
    work_event_sha256?: string;
  }[];
  proof?: WorkflowProof;
  proof_sha256?: string;
  integration_plan?: IntegrationPlan;
  integration_authorization?: IntegrationAuthorization;
  integration_attempts?: readonly IntegrationApplyAttempt[];
  integration_receipt?: IntegrationApplyReceipt;
  cleanup_intent?: WorkspaceCleanupIntent;
  cleanup_attempts?: readonly WorkspaceCleanupAttempt[];
  cleanup_receipt?: WorkspaceCleanupReceipt;
  work_events?: readonly WorkEvent[];
  cancellation_outcome?: WorkspaceCancellationResult;
  cancellation_receipt?: WorkspaceCancellationReceipt;
}

export interface WorkspaceLifecycleProjection {
  state: WorkspaceLifecycleState;
  workflow_outcome: WorkspaceProofOutcome | null;
  resource_state: WorkspaceResourceState | null;
  integration_state: WorkspaceIntegrationState;
  provider_event_chain_sha256: string | null;
  cancellation: "none" | "host_requested" | "confirmed";
}

export function isWorkspaceLifecycleState(value: unknown): value is WorkspaceLifecycleState {
  return typeof value === "string" && LIFECYCLE_STATES.has(value as WorkspaceLifecycleState);
}

export function assertWorkspaceLifecycleTransition(
  from: WorkspaceLifecycleState,
  to: WorkspaceLifecycleState,
): void {
  if (!isWorkspaceLifecycleState(from) || !isWorkspaceLifecycleState(to)) {
    throw new Error("workspace lifecycle state is unsupported");
  }
  if (!LEGAL_TRANSITIONS[from].has(to)) {
    throw new Error(`illegal workspace lifecycle transition: ${from} -> ${to}`);
  }
}

export function deriveWorkspaceLifecycle(
  input: WorkspaceLifecycleProjectionInput,
): WorkspaceLifecycleProjection {
  const events = [...(input.provider_events ?? [])];
  validateProviderEventChain(events, input.binding);
  const projectedResourceState = resourceState(input);
  const projectedIntegrationState = integrationState(input);
  const sharedCompatibility =
    input.manifest?.execution.isolation === "shared" ||
    input.manifest?.execution.workspace_fallback !== undefined;
  let state: WorkspaceLifecycleState = sharedCompatibility
    ? "shared"
    : input.allocation_unsupported || (!input.binding && events.length === 0)
      ? "unsupported"
      : "allocation_recorded";

  const firstBound = events.findIndex(
    (event) => event.event === "bound" || event.event === "reattached",
  );
  const allocationEvents = firstBound < 0 ? events : events.slice(0, firstBound + 1);
  for (const event of allocationEvents) {
    const next = providerState(event.event);
    if (!next) continue;
    transition(next);
  }

  const journal = input.workflow_journal ?? [];
  for (const event of journal) {
    if (input.binding && (event.event === "run.start" || event.event === "run.resume")) {
      transition("running");
    }
    if (event.event === "run.parked") transition("parked");
  }
  const failedReattachment = [...journal]
    .reverse()
    .find((event) => event.event === "workspace.reattach.failed");
  if (failedReattachment) transition(failedReattachment.status === "blocked" ? "blocked" : "lost");
  let workflowOutcome = proofOutcome(input.proof, input.binding);
  const terminalJournal = [...journal].reverse().find((event) => event.event === "run.end");
  if (input.proof && !failedReattachment) transition(workflowOutcome!);
  if (terminalJournal && !input.proof && !failedReattachment) {
    workflowOutcome = terminalJournal.ok === false ? "failed_retained" : null;
    transition("blocked");
  }
  if (projectedIntegrationState !== "none") transition("integration_requested");
  if (projectedIntegrationState === "applying" || projectedIntegrationState === "applied") {
    transition("integrating");
  }
  if (projectedIntegrationState === "applied") transition("integrated");
  const postBindingEvents = firstBound < 0 ? [] : events.slice(firstBound + 1);
  if (
    input.cleanup_intent ||
    (input.cleanup_attempts?.length ?? 0) > 0 ||
    postBindingEvents.some((event) => event.event === "cleanup_pending")
  ) {
    transition("cleanup_pending");
  }
  const cleanupResult = input.cleanup_attempts?.at(-1);
  if (cleanupResult?.status === "preserved_dirty") transition("preserved_dirty");
  if (
    cleanupResult?.status === "blocked" ||
    cleanupResult?.status === "partial" ||
    cleanupResult?.status === "unsupported"
  ) {
    transition("blocked");
  }
  for (const event of postBindingEvents) {
    if (
      event.event === "blocked" ||
      event.event === "lost" ||
      event.event === "preserved_dirty" ||
      event.event === "abandoned_dirty"
    ) {
      transition(providerState(event.event)!);
    }
  }
  if (input.cleanup_receipt) transition("released");

  const latestGovernance = [...(input.work_events ?? [])]
    .reverse()
    .find((event) => ["work.accepted", "work.cancelled", "work.reopened"].includes(event.event));
  const hostCancelled = latestGovernance?.event === "work.cancelled";
  const workEventSha256 = latestGovernance ? stableDigest(latestGovernance) : undefined;
  const providerCancelled =
    hostCancelled &&
    ((input.cancellation_receipt?.status === "cancelled" &&
      input.cancellation_receipt.work_event_seq === latestGovernance.seq &&
      input.cancellation_receipt.work_event_sha256 === workEventSha256) ||
      journal.some(
        (event) =>
          event.event === "workspace.cancel" &&
          event.status === "cancelled" &&
          event.work_event_seq === latestGovernance.seq &&
          event.work_event_sha256 === workEventSha256,
      ));
  return {
    state,
    workflow_outcome: workflowOutcome,
    resource_state: projectedResourceState,
    integration_state: projectedIntegrationState,
    provider_event_chain_sha256: events.at(-1)?.record_sha256 ?? null,
    cancellation: hostCancelled ? (providerCancelled ? "confirmed" : "host_requested") : "none",
  };

  function transition(next: WorkspaceLifecycleState): void {
    if (state === "unsupported" && input.binding) state = "allocation_recorded";
    assertWorkspaceLifecycleTransition(state, next);
    state = next;
  }
}

function proofOutcome(
  proof: WorkflowProof | undefined,
  binding: WorkspaceBinding | undefined,
): WorkspaceProofOutcome | null {
  if (!proof) return null;
  if (!["succeeded", "failed"].includes(proof.run?.status)) {
    throw new Error("workspace proof has an unsupported workflow outcome");
  }
  const execution = proof?.execution;
  if (binding) {
    if (
      !isWorkspaceBoundExecutionEvidence(execution, binding.run_id, proof.run.status) ||
      stableDigest(execution.binding) !== stableDigest(binding)
    ) {
      throw new Error("workspace proof does not match the immutable binding");
    }
    return execution.terminal_lifecycle_state;
  }
  if (execution && "binding" in execution) {
    throw new Error("workspace proof has bound execution evidence without a binding");
  }
  if (
    execution &&
    "binding" in execution &&
    ["completed_unintegrated", "failed_retained", "blocked", "lost"].includes(
      execution.terminal_lifecycle_state,
    )
  ) {
    return execution.terminal_lifecycle_state as WorkspaceProofOutcome;
  }
  return proof
    ? proof.run.status === "succeeded"
      ? "completed_unintegrated"
      : "failed_retained"
    : null;
}

function integrationState(input: WorkspaceLifecycleProjectionInput): WorkspaceIntegrationState {
  const plan = input.integration_plan;
  const authorization = input.integration_authorization;
  const attempts = [...(input.integration_attempts ?? [])];
  const receipt = input.integration_receipt;
  if (!plan && !authorization && attempts.length === 0 && !receipt) return "none";

  const binding = input.binding;
  const proof = input.proof;
  const proofSha256 = input.proof_sha256;
  if (
    !binding ||
    !proof ||
    !isWorkspaceBoundExecutionEvidence(proof.execution, binding.run_id, proof.run.status) ||
    stableDigest(proof.execution.binding) !== stableDigest(binding) ||
    !digest(proofSha256)
  ) {
    throw new Error("integration evidence requires the exact bound proof authority");
  }
  if (!plan) throw new Error("integration evidence is missing its durable plan");
  validateIntegrationPlan(plan, binding, proof, proofSha256);
  const planSha256 = stableDigest(plan);

  if (!authorization && (attempts.length > 0 || receipt)) {
    throw new Error("integration apply evidence is missing authorization");
  }
  const authorizationSha256 = authorization
    ? validateIntegrationAuthorization(authorization, plan, planSha256)
    : undefined;
  validateIntegrationAttempts(
    attempts,
    binding,
    plan,
    planSha256,
    authorizationSha256,
    proofSha256,
  );
  if (receipt) {
    if (!authorizationSha256) {
      throw new Error("integration receipt is missing authorization authority");
    }
    validateIntegrationReceipt(
      receipt,
      attempts,
      binding,
      plan,
      planSha256,
      authorizationSha256,
      proofSha256,
    );
    return "applied";
  }
  return attempts.some((attempt) => attempt.status === "started") ? "applying" : "planned";
}

function validateIntegrationPlan(
  plan: IntegrationPlan,
  binding: WorkspaceBinding,
  proof: WorkflowProof,
  proofSha256: string,
): void {
  const execution = proof.execution!;
  if (!("binding" in execution)) throw new Error("integration plan requires bound proof evidence");
  const bindingSha256 = stableDigest(binding);
  const terminalAttestationSha256 = stableDigest(execution.terminal_attestation);
  const preview = plan.provider_preview;
  const authority = {
    run: binding.run_id,
    binding: bindingSha256,
    proof: proofSha256,
    terminalAttestation: terminalAttestationSha256,
    review: plan.review_sha256,
    target: preview?.target_root,
    targetRef: preview?.target_ref,
    targetCommit: preview?.target_commit,
    sourceCommit: preview?.source_commit,
    operation: preview?.operation,
  };
  if (
    plan.schema_version !== 1 ||
    plan.run_id !== binding.run_id ||
    plan.operation !== "fast_forward" ||
    plan.binding_sha256 !== bindingSha256 ||
    stableDigest(plan.binding) !== bindingSha256 ||
    plan.proof_sha256 !== proofSha256 ||
    plan.terminal_attestation_sha256 !== terminalAttestationSha256 ||
    !digest(plan.review_sha256) ||
    !Array.isArray(plan.accepted_unknowns) ||
    preview?.schema_version !== 1 ||
    preview.provider_id !== binding.provider.id ||
    preview.binding_id !== binding.binding_id ||
    preview.operation !== plan.operation ||
    typeof preview.target_root !== "string" ||
    typeof preview.target_ref !== "string" ||
    typeof preview.target_commit !== "string" ||
    typeof preview.target_tree !== "string" ||
    typeof preview.source_commit !== "string" ||
    typeof preview.source_tree !== "string" ||
    !Array.isArray(preview.changed_paths) ||
    !Array.isArray(preview.blocked) ||
    preview.blocked.length > 0 ||
    !Array.isArray(preview.unknowns) ||
    !validTimestamp(preview.prepared_at) ||
    plan.target_identity_sha256 !==
      stableDigest({
        root: preview.target_root,
        ref: preview.target_ref,
        commit: preview.target_commit,
        tree: preview.target_tree,
      }) ||
    plan.idempotency_sha256 !== stableDigest(authority) ||
    plan.plan_id !== `integration-plan-${stableDigest(authority).slice(0, 24)}` ||
    !validTimestamp(plan.prepared_at)
  ) {
    throw new Error("integration plan is corrupt or foreign");
  }
}

function validateIntegrationAuthorization(
  authorization: IntegrationAuthorization,
  plan: IntegrationPlan,
  planSha256: string,
): string {
  if (
    authorization.schema_version !== 1 ||
    authorization.run_id !== plan.run_id ||
    authorization.plan_sha256 !== planSha256 ||
    !digest(authorization.policy_sha256) ||
    authorization.decision?.verdict !== "allow" ||
    authorization.decision_sha256 !== stableDigest(authorization.decision) ||
    authorization.journal_anchor?.event !== "integration.plan" ||
    authorization.journal_anchor.plan_sha256 !== planSha256 ||
    !validTimestamp(authorization.authorized_at) ||
    (authorization.approval_id !== undefined &&
      (typeof authorization.approval_actor !== "string" || !digest(authorization.approval_sha256)))
  ) {
    throw new Error("integration authorization is corrupt or foreign");
  }
  return stableDigest(authorization);
}

function validateIntegrationAttempts(
  attempts: readonly IntegrationApplyAttempt[],
  binding: WorkspaceBinding,
  plan: IntegrationPlan,
  planSha256: string,
  authorizationSha256: string | undefined,
  proofSha256: string,
): void {
  if (attempts.length > 0 && !authorizationSha256) {
    throw new Error("integration attempts are missing authorization authority");
  }
  let prior: IntegrationApplyAttempt | undefined;
  for (const [index, attempt] of attempts.entries()) {
    const { record_sha256: recordSha256, ...basis } = attempt;
    const terminal = attempt.status === "applied" || attempt.status === "already_applied";
    if (
      attempt.schema_version !== 1 ||
      attempt.seq !== index + 1 ||
      attempt.previous_sha256 !== (prior?.record_sha256 ?? null) ||
      recordSha256 !== stableDigest(basis) ||
      attempt.run_id !== binding.run_id ||
      attempt.plan_sha256 !== planSha256 ||
      attempt.authorization_sha256 !== authorizationSha256 ||
      attempt.proof_sha256 !== proofSha256 ||
      attempt.binding_sha256 !== stableDigest(binding) ||
      !["started", "applied", "already_applied"].includes(attempt.status) ||
      (terminal &&
        (attempt.target_commit !== plan.provider_preview.source_commit ||
          attempt.target_tree !== plan.provider_preview.source_tree)) ||
      (!terminal && (attempt.target_commit !== undefined || attempt.target_tree !== undefined)) ||
      !validTimestamp(attempt.recorded_at)
    ) {
      throw new Error(`integration attempt ${index + 1} is corrupt or foreign`);
    }
    prior = attempt;
  }
}

function validateIntegrationReceipt(
  receipt: IntegrationApplyReceipt,
  attempts: readonly IntegrationApplyAttempt[],
  binding: WorkspaceBinding,
  plan: IntegrationPlan,
  planSha256: string,
  authorizationSha256: string,
  proofSha256: string,
): void {
  const terminal = attempts.at(-1);
  const expectedReceiptId = `integration-apply-${stableDigest({
    plan: planSha256,
    authorization: authorizationSha256,
    target: receipt.target_commit,
  }).slice(0, 24)}`;
  if (
    !terminal ||
    (terminal.status !== "applied" && terminal.status !== "already_applied") ||
    receipt.schema_version !== 1 ||
    receipt.receipt_id !== expectedReceiptId ||
    receipt.run_id !== binding.run_id ||
    receipt.plan_id !== plan.plan_id ||
    receipt.plan_sha256 !== planSha256 ||
    receipt.authorization_sha256 !== authorizationSha256 ||
    receipt.proof_sha256 !== proofSha256 ||
    receipt.binding_sha256 !== stableDigest(binding) ||
    receipt.binding_id !== binding.binding_id ||
    receipt.provider_id !== binding.provider.id ||
    receipt.status !== terminal.status ||
    receipt.target_root !== plan.provider_preview.target_root ||
    receipt.target_ref !== plan.provider_preview.target_ref ||
    receipt.source_commit !== plan.provider_preview.source_commit ||
    receipt.target_commit !== plan.provider_preview.source_commit ||
    receipt.target_tree !== plan.provider_preview.source_tree ||
    receipt.target_commit !== terminal.target_commit ||
    receipt.target_tree !== terminal.target_tree ||
    !validTimestamp(receipt.applied_at)
  ) {
    throw new Error("integration receipt is corrupt or foreign");
  }
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function resourceState(input: WorkspaceLifecycleProjectionInput): WorkspaceResourceState | null {
  const binding = input.binding;
  const receiptState = validateCleanupReceiptEvidence(
    input.cleanup_receipt,
    binding,
    input.cleanup_intent,
  );
  const cleanupState = validateCleanupAttemptEvidence(input.cleanup_attempts ?? [], binding);
  const provider = latestPostBindingTerminalEvent(input.provider_events ?? []);
  const providerState = providerResourceState(provider);
  const proofState = terminalProofResourceState(input.proof, binding);

  if (receiptState) {
    if (cleanupState && cleanupState !== "released") {
      throw new Error("workspace cleanup receipt contradicts the latest cleanup attempt");
    }
    if (providerState && providerState !== "released") {
      throw new Error("workspace cleanup receipt contradicts the terminal provider event");
    }
    const receiptAttestation = input.cleanup_receipt!.attestation;
    const providerAttestationSha256 = provider?.data.attestation_sha256;
    if (
      providerAttestationSha256 !== undefined &&
      providerAttestationSha256 !== stableDigest(receiptAttestation)
    ) {
      throw new Error("workspace cleanup receipt contradicts provider attestation authority");
    }
    return receiptState;
  }
  if (cleanupState) {
    if (providerState === "released" && cleanupState !== "released") {
      throw new Error("latest cleanup attempt regresses a released provider resource");
    }
    if (cleanupState === "released" && providerState && providerState !== "released") {
      throw new Error("released cleanup attempt contradicts the terminal provider event");
    }
    return cleanupState;
  }
  if (providerState) return providerState;
  if (proofState) return proofState;
  return binding ? "active" : null;
}

function validateCleanupReceiptEvidence(
  receipt: WorkspaceCleanupReceipt | undefined,
  binding: WorkspaceBinding | undefined,
  intent: WorkspaceCleanupIntent | undefined,
): "released" | null {
  if (!receipt) return null;
  if (!binding) throw new Error("workspace cleanup receipt has no binding authority");
  const bindingSha256 = stableDigest(binding);
  const operationId = `cleanup-${stableDigest({
    binding: bindingSha256,
    mode: receipt.mode,
  }).slice(0, 24)}`;
  if (
    receipt.schema_version !== 1 ||
    receipt.operation_id !== operationId ||
    receipt.binding_id !== binding.binding_id ||
    receipt.binding_sha256 !== bindingSha256 ||
    receipt.mode !== "normal" ||
    (receipt.status !== "released" && receipt.status !== "already_released") ||
    receipt.branch_deleted !== true ||
    !Number.isFinite(Date.parse(receipt.recorded_at)) ||
    !isWorkspaceAttestation(receipt.attestation, binding) ||
    receipt.attestation.status !== "ok" ||
    receipt.attestation.resource_state !== "released" ||
    receipt.attestation.workspace_exists ||
    (intent !== undefined &&
      (intent.operation_id !== receipt.operation_id ||
        intent.binding_id !== receipt.binding_id ||
        intent.binding_sha256 !== receipt.binding_sha256 ||
        intent.mode !== receipt.mode))
  ) {
    throw new Error("workspace cleanup receipt is invalid or mismatched");
  }
  return "released";
}

function validateCleanupAttemptEvidence(
  attempts: readonly WorkspaceCleanupAttempt[],
  binding: WorkspaceBinding | undefined,
): WorkspaceResourceState | null {
  if (attempts.length === 0) return null;
  if (!binding) throw new Error("workspace cleanup attempts have no binding authority");
  const bindingSha256 = stableDigest(binding);
  const operationId = `cleanup-${stableDigest({ binding: bindingSha256, mode: "normal" }).slice(
    0,
    24,
  )}`;
  for (const [index, attempt] of attempts.entries()) {
    const { record_sha256, ...basis } = attempt;
    const terminal = attempt.status !== "started";
    if (
      attempt.schema_version !== 1 ||
      attempt.seq !== index + 1 ||
      attempt.previous_sha256 !== (attempts[index - 1]?.record_sha256 ?? null) ||
      record_sha256 !== stableDigest(basis) ||
      attempt.operation_id !== operationId ||
      attempt.binding_id !== binding.binding_id ||
      attempt.binding_sha256 !== bindingSha256 ||
      attempt.mode !== "normal" ||
      !Number.isFinite(Date.parse(attempt.recorded_at)) ||
      ![
        "started",
        "released",
        "already_released",
        "preserved_dirty",
        "blocked",
        "unsupported",
        "partial",
      ].includes(attempt.status) ||
      (terminal &&
        (typeof attempt.branch_deleted !== "boolean" ||
          !isWorkspaceAttestation(attempt.attestation, binding))) ||
      (!terminal && (attempt.branch_deleted !== undefined || attempt.attestation !== undefined))
    ) {
      throw new Error(`workspace cleanup attempt ${index + 1} is corrupt or mismatched`);
    }
  }
  const latest = attempts.at(-1)!;
  if (latest.status === "started") return null;
  if (latest.status === "released" || latest.status === "already_released") {
    if (
      latest.branch_deleted !== true ||
      latest.attestation?.status !== "ok" ||
      latest.attestation.resource_state !== "released" ||
      latest.attestation.workspace_exists
    ) {
      throw new Error("released cleanup attempt lacks exact resource-absence evidence");
    }
    return "released";
  }
  if (latest.status === "preserved_dirty") {
    if (latest.attestation?.resource_state !== "preserved_dirty") {
      throw new Error("dirty cleanup attempt lacks preserved resource evidence");
    }
    return "preserved_dirty";
  }
  return "blocked";
}

function latestPostBindingTerminalEvent(
  events: readonly WorkspaceProviderEvent[],
): WorkspaceProviderEvent | undefined {
  const firstBound = events.findIndex(
    (event) => event.event === "bound" || event.event === "reattached",
  );
  if (firstBound < 0) return undefined;
  return events
    .slice(firstBound + 1)
    .reverse()
    .find((event) => ["released", "preserved_dirty", "blocked", "lost"].includes(event.event));
}

function providerResourceState(
  event: WorkspaceProviderEvent | undefined,
): WorkspaceResourceState | null {
  if (!event) return null;
  if (event.event === "released") return "released";
  if (event.event === "preserved_dirty") return "preserved_dirty";
  if (event.event === "blocked") return "blocked";
  if (event.event === "lost") return "lost";
  return null;
}

function terminalProofResourceState(
  proof: WorkflowProof | undefined,
  binding: WorkspaceBinding | undefined,
): WorkspaceResourceState | null {
  if (!proof?.execution || !("binding" in proof.execution)) return null;
  if (
    !binding ||
    !isWorkspaceBoundExecutionEvidence(proof.execution, binding.run_id) ||
    stableDigest(proof.execution.binding) !== stableDigest(binding)
  ) {
    throw new Error("terminal workflow proof does not match workspace binding authority");
  }
  return proof.execution.terminal_attestation.resource_state;
}

export function validateProviderEventChain(
  events: readonly WorkspaceProviderEvent[],
  binding?: WorkspaceBinding,
): void {
  for (const [index, record] of events.entries()) {
    const { record_sha256, ...basis } = record;
    const prior = events[index - 1];
    if (
      record.schema_version !== 1 ||
      record.seq !== index + 1 ||
      record.previous_sha256 !== (prior?.record_sha256 ?? null) ||
      record.record_sha256 !== stableDigest(basis) ||
      (binding !== undefined &&
        (record.binding_id !== binding.binding_id ||
          record.workspace_id !== binding.workspace_id ||
          record.request_sha256 !== binding.request_sha256))
    ) {
      throw new Error(`workspace provider event ${index + 1} is corrupt or mismatched`);
    }
  }
}

function providerState(event: string): WorkspaceLifecycleState | undefined {
  switch (event) {
    case "allocation_recorded":
      return "allocation_recorded";
    case "allocating":
    case "branch_creation_started":
    case "worktree_creation_started":
    case "worktree_created":
    case "allocation_rolled_back":
      return "allocating";
    case "bound":
    case "reattached":
      return "bound";
    case "cleanup_pending":
      return "cleanup_pending";
    case "released":
      return "released";
    case "blocked":
      return "blocked";
    case "lost":
      return "lost";
    case "preserved_dirty":
      return "preserved_dirty";
    case "abandoned_dirty":
      return "abandoned_dirty";
    default:
      return undefined;
  }
}
