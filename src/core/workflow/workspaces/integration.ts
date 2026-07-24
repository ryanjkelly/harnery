import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  evaluatePolicy,
  type NormalizedPolicy,
  normalizePolicy,
  type PolicyDecision,
  type PolicySpec,
  policyDigest,
  summarizePolicyRequest,
} from "../../policy/index.ts";
import { readWorkItem } from "../../work/state.ts";
import { createWorkflowApproval, readWorkflowApproval } from "../approvals.ts";
import { readWorkflowProof } from "../proof.ts";
import { readWorkflowRunManifest } from "../run-state.ts";
import { acquireNoClobberLease } from "./leases.ts";
import {
  appendIntegrationAttempt,
  appendWorkflowJournalEvent,
  fileSha256,
  readIntegrationAttempts,
  readWorkflowSupplement,
  stableDigest,
  workflowRunDir,
  writeWorkflowSupplement,
} from "./state.ts";
import type {
  AuthorizedIntegrationPlan,
  IntegrationApplyReceipt,
  IntegrationAuthorization,
  IntegrationPlan,
  IntegrationReviewRecord,
  ProviderIntegrationInput,
  ProviderIntegrationPreview,
  ProviderIntegrationResult,
  WorkspaceBinding,
  WorkspaceBoundExecutionEvidence,
  WorkspaceProvider,
} from "./types.ts";
import {
  isWorkspaceAllocationRequest,
  isWorkspaceAttestation,
  isWorkspaceBoundExecutionEvidence,
} from "./validate.ts";

const INTEGRATION_DECISION_ID = "p99999";
const TARGET_LEASE_STALE_MS = 5 * 60 * 1_000;

export interface PrepareIntegrationInput {
  coordRoot: string;
  runId: string;
  provider: WorkspaceProvider;
  policy: PolicySpec | NormalizedPolicy;
  targetRoot?: string;
  review?: { actor: string; reason?: string };
  acceptedUnknowns?: readonly string[];
  approvalAddressee?: string;
}

export interface ApplyIntegrationInput {
  coordRoot: string;
  runId: string;
  provider: WorkspaceProvider;
  plan?: IntegrationPlan;
}

/** Host-policy ASK still pending during integration prepare. Carries the exact
 * durable IDs an operator needs to approve and resume the same plan. */
export class IntegrationPrepareParkedError extends Error {
  readonly runId: string;
  readonly planId: string;
  readonly approvalId: string;

  constructor(runId: string, planId: string, approvalId: string) {
    super(`integration preparation parked: run ${runId}, plan ${planId}, approval ${approvalId}`);
    this.name = "IntegrationPrepareParkedError";
    this.runId = runId;
    this.planId = planId;
    this.approvalId = approvalId;
  }
}

export async function prepareIntegration(input: PrepareIntegrationInput): Promise<IntegrationPlan> {
  const evidence = await readAndValidateEvidence(input.coordRoot, input.runId, input.provider);
  const targetRoot = resolve(input.targetRoot ?? requiredIntegrationRoot(evidence.binding));
  const release = acquireTargetLease(input.coordRoot, targetRoot, input.runId);
  try {
    const proofSha256 = fileSha256(
      join(workflowRunDir(input.coordRoot, input.runId), "proof.json"),
    );
    const acceptedUnknowns = [...new Set(input.acceptedUnknowns ?? [])].sort();
    const unknownCodes = [
      ...evidence.proof.unknowns.map((item) => item.code),
      ...evidence.attestation.unknowns.map((item) => item.code),
    ];
    const unaccepted = unknownCodes.filter((code) => !acceptedUnknowns.includes(code));
    if (unaccepted.length > 0) {
      throw new Error(
        `integration has unaccepted unknown verification facts: ${unaccepted.join(", ")}`,
      );
    }
    const terminalAttestationSha256 = stableDigest(evidence.proof.execution!.terminal_attestation);
    const review = resolveReview(
      input,
      evidence.binding,
      proofSha256,
      terminalAttestationSha256,
      acceptedUnknowns,
    );
    const reviewSha256 = stableDigest(review);

    const preview = await input.provider.previewIntegration({
      schema_version: 1,
      run_id: input.runId,
      binding: evidence.binding,
      binding_sha256: stableDigest(evidence.binding),
      proof_sha256: proofSha256,
      terminal_attestation: evidence.proof.execution!.terminal_attestation,
      terminal_attestation_sha256: terminalAttestationSha256,
      review_sha256: reviewSha256,
      accepted_unknowns: acceptedUnknowns,
      target: { root: targetRoot },
    });
    assertVerifiedSourceCommit(evidence.proof, preview.source_commit);
    if (preview.blocked.length > 0) {
      throw new Error(
        `integration preview is blocked: ${preview.blocked.map((item) => item.message).join("; ")}`,
      );
    }
    const previewUnknowns = preview.unknowns
      .map((item) => item.code)
      .filter((code) => !acceptedUnknowns.includes(code));
    if (previewUnknowns.length > 0) {
      throw new Error(`integration preview has unaccepted unknowns: ${previewUnknowns.join(", ")}`);
    }
    const planAuthority = {
      run: input.runId,
      binding: stableDigest(evidence.binding),
      proof: proofSha256,
      terminalAttestation: stableDigest(evidence.proof.execution!.terminal_attestation),
      review: reviewSha256,
      target: preview.target_root,
      targetRef: preview.target_ref,
      targetCommit: preview.target_commit,
      sourceCommit: preview.source_commit,
      operation: preview.operation,
    };
    const proposed: IntegrationPlan = {
      schema_version: 1,
      plan_id: `integration-plan-${stableDigest(planAuthority).slice(0, 24)}`,
      run_id: input.runId,
      operation: "fast_forward",
      binding: evidence.binding,
      binding_sha256: stableDigest(evidence.binding),
      proof_sha256: proofSha256,
      terminal_attestation_sha256: terminalAttestationSha256,
      review_sha256: reviewSha256,
      accepted_unknowns: acceptedUnknowns,
      provider_preview: preview,
      target_identity_sha256: stableDigest({
        root: preview.target_root,
        ref: preview.target_ref,
        commit: preview.target_commit,
        tree: preview.target_tree,
      }),
      idempotency_sha256: stableDigest(planAuthority),
      prepared_at: new Date().toISOString(),
    };
    const prior = readWorkflowSupplement<IntegrationPlan>(
      input.coordRoot,
      input.runId,
      "integration/plan.json",
    );
    const plan = prior ?? proposed;
    if (prior && !samePlanAuthority(prior, proposed)) {
      throw new Error("existing integration plan no longer matches current evidence");
    }
    if (!prior) {
      writeWorkflowSupplement(input.coordRoot, input.runId, "integration/plan.json", plan);
      appendWorkflowJournalEvent(input.coordRoot, input.runId, "integration.plan", {
        plan_id: plan.plan_id,
        plan_sha256: stableDigest(plan),
      });
    }
    authorizePlan(input, plan);
    return plan;
  } finally {
    release();
  }
}

export async function applyIntegration(
  input: ApplyIntegrationInput,
): Promise<IntegrationApplyReceipt> {
  const storedPlan = readWorkflowSupplement<IntegrationPlan>(
    input.coordRoot,
    input.runId,
    "integration/plan.json",
  );
  if (!storedPlan) throw new Error("integration apply requires a durable plan");
  if (input.plan && stableDigest(input.plan) !== stableDigest(storedPlan)) {
    throw new Error("integration apply caller plan does not match the durable plan");
  }
  const release = acquireTargetLease(
    input.coordRoot,
    storedPlan.provider_preview.target_root,
    input.runId,
  );
  try {
    const evidence = await readAndValidateEvidence(input.coordRoot, input.runId, input.provider);
    const proofSha256 = fileSha256(
      join(workflowRunDir(input.coordRoot, input.runId), "proof.json"),
    );
    if (
      proofSha256 !== storedPlan.proof_sha256 ||
      stableDigest(evidence.binding) !== storedPlan.binding_sha256 ||
      stableDigest(storedPlan.binding) !== storedPlan.binding_sha256 ||
      stableDigest(evidence.proof.execution!.terminal_attestation) !==
        storedPlan.terminal_attestation_sha256
    ) {
      throw new Error("integration proof or binding changed after planning");
    }
    const review = readReviewForPlan(input.coordRoot, storedPlan);
    if (stableDigest(review) !== storedPlan.review_sha256) {
      throw new Error("integration review authority changed or disappeared");
    }
    const authorization = readWorkflowSupplement<IntegrationAuthorization>(
      input.coordRoot,
      input.runId,
      "integration/authorization.json",
    );
    if (!authorization) throw new Error("integration authorization disappeared");
    const planSha256 = stableDigest(storedPlan);
    if (authorization.plan_sha256 !== planSha256 || authorization.decision.verdict !== "allow") {
      throw new Error("integration authorization does not permit the durable plan");
    }
    if (
      authorization.decision_sha256 !== stableDigest(authorization.decision) ||
      authorization.journal_anchor.event !== "integration.plan" ||
      authorization.journal_anchor.plan_sha256 !== planSha256
    ) {
      throw new Error("integration authorization digest or journal anchor is corrupt");
    }
    assertIntegrationPlanJournal(input.coordRoot, input.runId, planSha256);
    if (authorization.approval_id) {
      const approval = readWorkflowApproval(input.coordRoot, authorization.approval_id);
      if (
        approval.status !== "approved" ||
        approval.request.run_id !== input.runId ||
        approval.decision?.actor !== authorization.approval_actor ||
        authorization.approval_sha256 !== stableDigest(approval)
      ) {
        throw new Error("integration approval authority is missing or mismatched");
      }
    }

    const authorized: AuthorizedIntegrationPlan = {
      schema_version: 1,
      plan: storedPlan,
      plan_sha256: planSha256,
      authorization,
      authorization_sha256: stableDigest(authorization),
    };
    const previewInput: ProviderIntegrationInput = {
      schema_version: 1,
      run_id: input.runId,
      binding: evidence.binding,
      binding_sha256: stableDigest(evidence.binding),
      proof_sha256: proofSha256,
      terminal_attestation: evidence.proof.execution!.terminal_attestation,
      terminal_attestation_sha256: storedPlan.terminal_attestation_sha256,
      review_sha256: storedPlan.review_sha256,
      accepted_unknowns: storedPlan.accepted_unknowns,
      target: {
        root: storedPlan.provider_preview.target_root,
        ref: storedPlan.provider_preview.target_ref,
      },
    };
    const currentPreview = await input.provider.previewIntegration(previewInput);
    assertVerifiedSourceCommit(evidence.proof, currentPreview.source_commit);
    if (
      currentPreview.provider_id !== storedPlan.provider_preview.provider_id ||
      currentPreview.binding_id !== storedPlan.binding.binding_id ||
      currentPreview.target_root !== storedPlan.provider_preview.target_root ||
      currentPreview.target_ref !== storedPlan.provider_preview.target_ref ||
      currentPreview.source_commit !== storedPlan.provider_preview.source_commit ||
      currentPreview.source_tree !== storedPlan.provider_preview.source_tree
    ) {
      throw new Error("integration source, provider, or target identity drifted");
    }
    if (currentPreview.blocked.length > 0) {
      throw new Error(
        `integration preview is blocked: ${currentPreview.blocked
          .map((item) => item.message)
          .join("; ")}`,
      );
    }
    for (const attempt of readIntegrationAttempts(input.coordRoot, input.runId)) {
      if (
        attempt.run_id !== input.runId ||
        attempt.plan_sha256 !== planSha256 ||
        attempt.authorization_sha256 !== authorized.authorization_sha256 ||
        attempt.proof_sha256 !== proofSha256 ||
        attempt.binding_sha256 !== stableDigest(evidence.binding)
      ) {
        throw new Error("integration attempt does not match current durable authority");
      }
    }
    const prior = readWorkflowSupplement<IntegrationApplyReceipt>(
      input.coordRoot,
      input.runId,
      "integration/receipt.json",
    );
    if (prior) {
      if (
        prior.plan_sha256 !== planSha256 ||
        prior.authorization_sha256 !== authorized.authorization_sha256 ||
        prior.proof_sha256 !== proofSha256 ||
        prior.binding_sha256 !== stableDigest(evidence.binding) ||
        prior.target_commit !== currentPreview.target_commit ||
        prior.target_tree !== currentPreview.target_tree ||
        prior.source_commit !== storedPlan.provider_preview.source_commit
      ) {
        throw new Error("existing integration receipt does not match current target authority");
      }
      return prior;
    }
    appendIntegrationAttempt(input.coordRoot, input.runId, {
      schema_version: 1,
      run_id: input.runId,
      plan_sha256: planSha256,
      authorization_sha256: authorized.authorization_sha256,
      proof_sha256: proofSha256,
      binding_sha256: stableDigest(evidence.binding),
      status: "started",
      recorded_at: new Date().toISOString(),
    });
    const providerResult = await input.provider.applyAuthorizedIntegration({
      schema_version: 1,
      run_id: input.runId,
      binding: evidence.binding,
      binding_sha256: stableDigest(evidence.binding),
      plan_id: storedPlan.plan_id,
      plan_sha256: planSha256,
      authorization_sha256: authorized.authorization_sha256,
      proof_sha256: proofSha256,
      terminal_attestation_sha256: storedPlan.terminal_attestation_sha256,
      review_sha256: storedPlan.review_sha256,
      accepted_unknowns: storedPlan.accepted_unknowns,
      preview: storedPlan.provider_preview,
    });
    validateProviderIntegrationResult(providerResult, storedPlan, currentPreview);
    const postApplyAttestation = await input.provider.reattach(evidence.binding);
    if (
      !isWorkspaceAttestation(postApplyAttestation, evidence.binding) ||
      postApplyAttestation.status !== "ok" ||
      stableDigest(postApplyAttestation.owner) !== stableDigest(evidence.binding.owner)
    ) {
      throw new Error("integration result could not reattach the frozen workspace");
    }
    const postApplyPreview = await input.provider.previewIntegration(previewInput);
    validatePostApplyState(providerResult, storedPlan, postApplyPreview);
    appendIntegrationAttempt(input.coordRoot, input.runId, {
      schema_version: 1,
      run_id: input.runId,
      plan_sha256: planSha256,
      authorization_sha256: authorized.authorization_sha256,
      proof_sha256: proofSha256,
      binding_sha256: stableDigest(evidence.binding),
      status: providerResult.status,
      target_commit: providerResult.target_commit,
      target_tree: providerResult.target_tree,
      recorded_at: providerResult.applied_at,
    });

    const receipt: IntegrationApplyReceipt = {
      schema_version: 1,
      receipt_id: `integration-apply-${stableDigest({
        plan: planSha256,
        authorization: authorized.authorization_sha256,
        target: providerResult.target_commit,
      }).slice(0, 24)}`,
      run_id: input.runId,
      plan_id: storedPlan.plan_id,
      plan_sha256: planSha256,
      authorization_sha256: authorized.authorization_sha256,
      proof_sha256: proofSha256,
      binding_sha256: stableDigest(evidence.binding),
      binding_id: storedPlan.binding.binding_id,
      provider_id: storedPlan.binding.provider.id,
      status: providerResult.status,
      target_root: storedPlan.provider_preview.target_root,
      target_ref: storedPlan.provider_preview.target_ref,
      source_commit: storedPlan.provider_preview.source_commit,
      target_commit: providerResult.target_commit,
      target_tree: providerResult.target_tree,
      applied_at: providerResult.applied_at,
    };
    writeWorkflowSupplement(input.coordRoot, input.runId, "integration/receipt.json", receipt);
    appendWorkflowJournalEvent(input.coordRoot, input.runId, "integration.apply", {
      receipt_id: receipt.receipt_id,
      status: receipt.status,
      target_commit: receipt.target_commit,
    });
    return receipt;
  } finally {
    release();
  }
}

function validateProviderIntegrationResult(
  result: ProviderIntegrationResult,
  plan: IntegrationPlan,
  before: ProviderIntegrationPreview,
): void {
  const expectedStatus =
    before.target_commit === plan.provider_preview.source_commit ? "already_applied" : "applied";
  if (
    result.schema_version !== 1 ||
    result.binding_id !== plan.binding.binding_id ||
    result.plan_id !== plan.plan_id ||
    result.status !== expectedStatus ||
    result.target_commit !== plan.provider_preview.source_commit ||
    result.target_tree !== plan.provider_preview.source_tree ||
    !Number.isFinite(Date.parse(result.applied_at))
  ) {
    throw new Error("workspace provider returned an invalid integration result");
  }
}

function validatePostApplyState(
  result: ProviderIntegrationResult,
  plan: IntegrationPlan,
  current: ProviderIntegrationPreview,
): void {
  const expected = plan.provider_preview;
  if (
    current.schema_version !== 1 ||
    current.provider_id !== expected.provider_id ||
    current.binding_id !== plan.binding.binding_id ||
    current.operation !== plan.operation ||
    current.target_root !== expected.target_root ||
    current.target_ref !== expected.target_ref ||
    current.source_commit !== expected.source_commit ||
    current.source_tree !== expected.source_tree ||
    current.target_commit !== result.target_commit ||
    current.target_tree !== result.target_tree ||
    current.target_commit !== expected.source_commit ||
    current.target_tree !== expected.source_tree ||
    current.blocked.length > 0
  ) {
    throw new Error("integration result does not match the reattached target state");
  }
}

async function readAndValidateEvidence(
  coordRoot: string,
  runId: string,
  provider: WorkspaceProvider,
): Promise<{
  proof: ReturnType<typeof readWorkflowProof> & {
    execution: WorkspaceBoundExecutionEvidence;
  };
  binding: WorkspaceBinding;
  attestation: Awaited<ReturnType<WorkspaceProvider["reattach"]>>;
}> {
  const manifest = readWorkflowRunManifest(coordRoot, runId);
  const proof = readWorkflowProof(coordRoot, runId);
  if (proof.run.status !== "succeeded") throw new Error("integration requires succeeded proof");
  if (proof.acceptance.summary.unsatisfied > 0 || proof.acceptance.summary.unknown > 0) {
    throw new Error("integration requires fully satisfied acceptance");
  }
  const binding = manifest.execution.workspace_binding;
  if (!binding || !isWorkspaceBoundExecutionEvidence(proof.execution, runId))
    throw new Error("integration requires isolated execution evidence");
  const boundProof = proof as ReturnType<typeof readWorkflowProof> & {
    execution: WorkspaceBoundExecutionEvidence;
  };
  if (boundProof.execution.terminal_lifecycle_state !== "completed_unintegrated") {
    throw new Error("integration requires a successful completed workspace proof");
  }
  if (
    stableDigest(binding) !== stableDigest(boundProof.execution.binding) ||
    stableDigest(binding.owner) !== stableDigest(boundProof.execution.terminal_attestation.owner)
  ) {
    throw new Error("manifest, proof, binding, and terminal attestation do not agree");
  }
  const attestation = await provider.reattach(binding);
  if (
    !isWorkspaceAttestation(attestation, binding) ||
    attestation.status !== "ok" ||
    stableDigest(attestation.owner) !== stableDigest(binding.owner)
  ) {
    throw new Error("workspace provider reattachment did not attest the frozen binding");
  }
  const request = readWorkflowSupplement<Record<string, unknown>>(
    coordRoot,
    runId,
    "workspace-request.json",
  );
  if (
    !request ||
    !isWorkspaceAllocationRequest(request) ||
    stableDigest(request) !== binding.request_sha256
  ) {
    throw new Error("workspace request is missing or does not match the binding");
  }
  const capabilities = await provider.probe({
    requested_cwd: request.requested_cwd,
    writable_roots: request.writable_roots.map((root) => root.configured),
  });
  if (
    capabilities.capabilities.provider_id !== binding.provider.id ||
    capabilities.capabilities.provider_version !== binding.provider.version ||
    capabilities.capabilities.capability_digest !== binding.provider.capability_digest
  ) {
    throw new Error("workspace provider identity or capabilities drifted");
  }
  return { proof: boundProof, binding, attestation };
}

function resolveReview(
  input: PrepareIntegrationInput,
  binding: WorkspaceBinding,
  proofSha256: string,
  terminalAttestationSha256: string,
  acceptedUnknowns: string[],
): IntegrationReviewRecord {
  if (binding.owner.kind === "work_attempt") {
    const record = readWorkAcceptance(
      input.coordRoot,
      binding,
      proofSha256,
      terminalAttestationSha256,
      acceptedUnknowns,
    );
    if (!record) throw new Error("work-linked integration requires exact durable work acceptance");
    return record;
  }
  if (!input.review?.actor) throw new Error("standalone integration requires explicit review");
  const review: IntegrationReviewRecord = {
    schema_version: 1,
    run_id: input.runId,
    owner: binding.owner,
    proof_sha256: proofSha256,
    binding_id: binding.binding_id,
    terminal_attestation_sha256: terminalAttestationSha256,
    accepted_unknowns: acceptedUnknowns,
    actor: input.review.actor,
    reason: input.review.reason,
    reviewed_at: new Date().toISOString(),
  };
  const prior = readWorkflowSupplement<IntegrationReviewRecord>(
    input.coordRoot,
    input.runId,
    "integration/review.json",
  );
  if (prior) {
    if (
      prior.run_id !== review.run_id ||
      prior.proof_sha256 !== review.proof_sha256 ||
      prior.binding_id !== review.binding_id ||
      prior.terminal_attestation_sha256 !== review.terminal_attestation_sha256 ||
      stableDigest(prior.accepted_unknowns) !== stableDigest(review.accepted_unknowns) ||
      prior.actor !== review.actor ||
      prior.reason !== review.reason
    ) {
      throw new Error("existing integration review does not match current evidence");
    }
    return prior;
  }
  writeWorkflowSupplement(input.coordRoot, input.runId, "integration/review.json", review);
  return review;
}

function readReviewForPlan(coordRoot: string, plan: IntegrationPlan): IntegrationReviewRecord {
  if (plan.binding.owner.kind === "work_attempt") {
    const review = readWorkAcceptance(
      coordRoot,
      plan.binding,
      plan.proof_sha256,
      plan.terminal_attestation_sha256,
      plan.accepted_unknowns,
    );
    if (!review) throw new Error("durable work acceptance disappeared");
    return review;
  }
  const review = readWorkflowSupplement<IntegrationReviewRecord>(
    coordRoot,
    plan.run_id,
    "integration/review.json",
  );
  if (!review) throw new Error("standalone integration review disappeared");
  return review;
}

function readWorkAcceptance(
  coordRoot: string,
  binding: WorkspaceBinding,
  proofSha256: string,
  terminalAttestationSha256: string,
  acceptedUnknowns: readonly string[],
): IntegrationReviewRecord | undefined {
  if (binding.owner.kind !== "work_attempt") return undefined;
  const work = readWorkItem(coordRoot, binding.owner.work_item_id);
  const accepted = [...work.events]
    .reverse()
    .find((event) => ["work.accepted", "work.cancelled", "work.reopened"].includes(event.event));
  if (
    work.projection.state !== "succeeded" ||
    !accepted ||
    accepted.event !== "work.accepted" ||
    accepted.run_id !== binding.run_id ||
    accepted.attempt !== binding.owner.attempt ||
    accepted.proof_sha256 !== proofSha256 ||
    accepted.workspace_binding_id !== binding.binding_id ||
    accepted.terminal_attestation_sha256 !== terminalAttestationSha256 ||
    stableDigest(accepted.accepted_unknowns ?? []) !== stableDigest(acceptedUnknowns) ||
    typeof accepted.actor !== "string" ||
    typeof accepted.ts !== "string"
  ) {
    return undefined;
  }
  return {
    schema_version: 1,
    run_id: binding.run_id,
    owner: binding.owner,
    proof_sha256: proofSha256,
    binding_id: binding.binding_id,
    terminal_attestation_sha256: terminalAttestationSha256,
    accepted_unknowns: [...acceptedUnknowns],
    actor: accepted.actor,
    reason: typeof accepted.reason === "string" ? accepted.reason : undefined,
    reviewed_at: accepted.ts,
  };
}

function assertVerifiedSourceCommit(
  proof: ReturnType<typeof readWorkflowProof> & {
    execution: WorkspaceBoundExecutionEvidence;
  },
  sourceCommit: string,
): void {
  const verifiedCommit = proof.execution.terminal_attestation.repository?.head_commit;
  if (!verifiedCommit || verifiedCommit !== sourceCommit) {
    throw new Error("integration source commit does not match the terminal proof");
  }
}

function authorizePlan(input: PrepareIntegrationInput, plan: IntegrationPlan): void {
  const policy = normalizePolicy(input.policy, {
    baseDir: plan.provider_preview.target_root,
  });
  const request = summarizePolicyRequest({
    phase: "external_mutation",
    action: `fast-forward ${plan.provider_preview.target_ref}`,
    path: plan.provider_preview.target_root,
    isolation: plan.binding.isolation,
    network_access: "disabled",
  });
  const evaluation = evaluatePolicy(policy, request);
  if (evaluation.verdict === "deny") {
    throw new Error(`integration policy denied: ${evaluation.reason}`);
  }
  let decision: PolicyDecision;
  let approvalId: string | undefined;
  let approvalActor: string | undefined;
  let approvalSha256: string | undefined;
  if (evaluation.verdict === "ask") {
    const created = createWorkflowApproval({
      coordRoot: input.coordRoot,
      runId: input.runId,
      decisionId: INTEGRATION_DECISION_ID,
      addressedTo: input.approvalAddressee,
      policy: { name: policy.name, sha256: policyDigest(policy) },
      request,
      evaluation,
    });
    approvalId = created.approval.request.id;
    if (created.approval.status === "pending") {
      throw new IntegrationPrepareParkedError(input.runId, plan.plan_id, approvalId);
    }
    if (created.approval.status !== "approved" || !created.approval.decision) {
      throw new Error(`integration approval ${approvalId} was denied`);
    }
    approvalActor = created.approval.decision.actor;
    approvalSha256 = stableDigest(created.approval);
    decision = {
      id: INTEGRATION_DECISION_ID,
      checked_at: created.approval.decision.decided_at,
      policy: policy.name,
      phase: "external_mutation",
      initial_verdict: "ask",
      verdict: "allow",
      resolved_by: "approval",
      reason: created.approval.decision.reason ?? evaluation.reason,
      rule_codes: evaluation.rules.map((rule) => rule.code),
      request,
    };
  } else {
    decision = {
      id: INTEGRATION_DECISION_ID,
      checked_at: new Date().toISOString(),
      policy: policy.name,
      phase: "external_mutation",
      initial_verdict: "allow",
      verdict: "allow",
      resolved_by: "policy",
      reason: evaluation.reason,
      rule_codes: evaluation.rules.map((rule) => rule.code),
      request,
    };
  }
  const authorization: IntegrationAuthorization = {
    schema_version: 1,
    run_id: input.runId,
    plan_sha256: stableDigest(plan),
    policy_sha256: policyDigest(policy),
    decision,
    decision_sha256: stableDigest(decision),
    approval_id: approvalId,
    approval_actor: approvalActor,
    approval_sha256: approvalSha256,
    journal_anchor: {
      event: "integration.plan",
      plan_sha256: stableDigest(plan),
    },
    authorized_at: new Date().toISOString(),
  };
  const prior = readWorkflowSupplement<IntegrationAuthorization>(
    input.coordRoot,
    input.runId,
    "integration/authorization.json",
  );
  if (prior) {
    if (
      prior.plan_sha256 !== authorization.plan_sha256 ||
      prior.policy_sha256 !== authorization.policy_sha256 ||
      prior.decision.verdict !== "allow" ||
      prior.decision_sha256 !== stableDigest(prior.decision) ||
      prior.approval_id !== authorization.approval_id ||
      prior.approval_sha256 !== authorization.approval_sha256 ||
      stableDigest(prior.journal_anchor) !== stableDigest(authorization.journal_anchor)
    ) {
      throw new Error("existing integration authorization does not match the exact plan");
    }
    return;
  }
  writeWorkflowSupplement(
    input.coordRoot,
    input.runId,
    "integration/authorization.json",
    authorization,
  );
  appendWorkflowJournalEvent(input.coordRoot, input.runId, "integration.authorized", {
    plan_id: plan.plan_id,
    authorization_sha256: stableDigest(authorization),
    policy_sha256: authorization.policy_sha256,
    approval_id: authorization.approval_id ?? null,
  });
}

function samePlanAuthority(left: IntegrationPlan, right: IntegrationPlan): boolean {
  return (
    left.plan_id === right.plan_id &&
    left.operation === right.operation &&
    left.binding_sha256 === right.binding_sha256 &&
    left.proof_sha256 === right.proof_sha256 &&
    left.terminal_attestation_sha256 === right.terminal_attestation_sha256 &&
    left.review_sha256 === right.review_sha256 &&
    stableDigest(left.binding) === stableDigest(right.binding) &&
    left.provider_preview.provider_id === right.provider_preview.provider_id &&
    left.provider_preview.target_root === right.provider_preview.target_root &&
    left.provider_preview.target_ref === right.provider_preview.target_ref &&
    left.provider_preview.target_commit === right.provider_preview.target_commit &&
    left.provider_preview.target_tree === right.provider_preview.target_tree &&
    left.provider_preview.source_commit === right.provider_preview.source_commit &&
    left.provider_preview.source_tree === right.provider_preview.source_tree &&
    left.target_identity_sha256 === right.target_identity_sha256 &&
    left.idempotency_sha256 === right.idempotency_sha256 &&
    stableDigest(left.accepted_unknowns) === stableDigest(right.accepted_unknowns)
  );
}

function requiredIntegrationRoot(binding: WorkspaceBinding): string {
  if (!binding.integration_root) throw new Error("workspace binding has no integration root");
  return binding.integration_root;
}

function assertIntegrationPlanJournal(coordRoot: string, runId: string, planSha256: string): void {
  const path = join(workflowRunDir(coordRoot, runId), "journal.jsonl");
  let records: Array<Record<string, unknown>>;
  try {
    records = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    throw new Error(`workflow journal is corrupt: ${(error as Error).message}`);
  }
  if (
    records.some((record) => record.run_id !== runId || typeof record.event !== "string") ||
    !records.some(
      (record) => record.event === "integration.plan" && record.plan_sha256 === planSha256,
    )
  ) {
    throw new Error("integration plan journal anchor is missing or mismatched");
  }
}

function acquireTargetLease(coordRoot: string, targetRoot: string, runId: string): () => void {
  const resolvedTarget = resolve(targetRoot);
  const authoritySha256 = stableDigest({
    run_id: runId,
    target_root: resolvedTarget,
    operation: "integration",
  });
  const lease = acquireNoClobberLease({
    path: join(
      resolve(coordRoot),
      ".harnery",
      "workspaces",
      ".integration-leases",
      `${stableDigest(resolvedTarget)}.lease`,
    ),
    scope: "integration",
    authoritySha256,
    staleAfterMs: TARGET_LEASE_STALE_MS,
    metadata: { run_id: runId, target_root: resolvedTarget },
    validateStaleOwner: (owner) => {
      const ownerRunId = owner.metadata?.run_id;
      return (
        ownerRunId !== undefined &&
        owner.metadata?.target_root === resolvedTarget &&
        owner.authority_sha256 ===
          stableDigest({
            run_id: ownerRunId,
            target_root: resolvedTarget,
            operation: "integration",
          })
      );
    },
  });
  return () => lease.release();
}
