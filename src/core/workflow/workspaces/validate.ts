import { isAbsolute, relative, resolve } from "node:path";
import { policyDigest } from "../../policy/index.ts";
import { stableDigest } from "../durable-record.ts";
import type { WorkflowRunManifest } from "../run-state.ts";
import type {
  RepositoryObservation,
  WorkspaceAllocationRequest,
  WorkspaceAttestation,
  WorkspaceBinding,
  WorkspaceBoundExecutionEvidence,
  WorkspaceCompatibilityExecutionEvidence,
  WorkspaceExecutionEvidence,
  WorkspaceOwner,
  WorkspaceProofLifecycleState,
  WorkspaceProofOutcome,
} from "./types.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const OBJECT_ID = /^[a-f0-9]{40,64}$/;

export function isWorkspaceOwner(value: unknown): value is WorkspaceOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as WorkspaceOwner;
  return owner.kind === "standalone"
    ? owner.work_item_id === null && owner.attempt === null
    : owner.kind === "work_attempt" &&
        typeof owner.work_item_id === "string" &&
        owner.work_item_id.length > 0 &&
        Number.isSafeInteger(owner.attempt) &&
        owner.attempt > 0;
}

export function isWorkspaceAllocationRequest(value: unknown): value is WorkspaceAllocationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as WorkspaceAllocationRequest;
  if (
    request.schema_version !== 1 ||
    typeof request.run_id !== "string" ||
    !isWorkspaceOwner(request.owner) ||
    !isAbsolute(request.requested_cwd) ||
    !["worktree", "sandbox", "remote"].includes(request.requested_isolation) ||
    !["enabled", "disabled", "unknown"].includes(request.network_access) ||
    !isAbsolute(request.script?.path) ||
    !DIGEST.test(request.script?.sha256) ||
    !(request.policy_sha256 === null || DIGEST.test(request.policy_sha256)) ||
    !validatedPathArray(request.allowed_paths) ||
    !validatedPathArray(request.writable_roots) ||
    request.writable_roots.length !== 1 ||
    !validValidatedPath(request.selected_writable_root) ||
    stableDigest(request.writable_roots[0]) !== stableDigest(request.selected_writable_root) ||
    typeof request.provider_id !== "string" ||
    request.provider_id.length === 0 ||
    !DIGEST.test(request.capability_digest) ||
    !DIGEST.test(request.idempotency_key)
  ) {
    return false;
  }
  const { idempotency_key: _idempotencyKey, ...authority } = request;
  return request.idempotency_key === stableDigest(authority);
}

export function isWorkspaceBinding(value: unknown, runId?: string): value is WorkspaceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as WorkspaceBinding;
  return (
    binding.schema_version === 1 &&
    typeof binding.binding_id === "string" &&
    binding.binding_id.length > 0 &&
    typeof binding.workspace_id === "string" &&
    binding.workspace_id.length > 0 &&
    typeof binding.run_id === "string" &&
    (runId === undefined || binding.run_id === runId) &&
    isWorkspaceOwner(binding.owner) &&
    binding.provider !== undefined &&
    typeof binding.provider.id === "string" &&
    typeof binding.provider.version === "string" &&
    DIGEST.test(binding.provider.capability_digest) &&
    ["worktree", "sandbox", "remote"].includes(binding.isolation) &&
    ["enabled", "disabled", "unknown"].includes(binding.network_access) &&
    isAbsolute(binding.workspace_root) &&
    resolve(binding.workspace_root) === binding.workspace_root &&
    validIdentity(binding.workspace_root_identity) &&
    isAbsolute(binding.active_root) &&
    resolve(binding.active_root) === binding.active_root &&
    containsResolvedPath(binding.workspace_root, binding.active_root) &&
    validIdentity(binding.active_root_identity) &&
    (binding.integration_root === undefined ||
      (isAbsolute(binding.integration_root) &&
        resolve(binding.integration_root) === binding.integration_root)) &&
    validValidatedPath(binding.writable_root) &&
    Number.isSafeInteger(binding.generation) &&
    binding.generation > 0 &&
    /^[a-f0-9]{64}$/.test(binding.recovery_token) &&
    DIGEST.test(binding.request_sha256) &&
    validTimestamp(binding.created_at) &&
    (binding.repository === undefined ||
      (validValidatedPath(binding.repository.source_root) &&
        validObservedIdentity(binding.repository.common_dir) &&
        OBJECT_ID.test(binding.repository.base_commit) &&
        OBJECT_ID.test(binding.repository.target_commit) &&
        typeof binding.repository.target_ref === "string" &&
        typeof binding.repository.workspace_ref === "string" &&
        typeof binding.repository.workspace_branch === "string" &&
        validObservedIdentity(binding.repository.gitdir) &&
        typeof binding.repository.branch_created_by_provider === "boolean"))
  );
}

export function isWorkspaceAttestation(
  value: unknown,
  binding: WorkspaceBinding,
): value is WorkspaceAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attestation = value as WorkspaceAttestation;
  const containment = attestation.containment;
  const filesystem = attestation.filesystem;
  const validContainment =
    containment !== undefined &&
    containment !== null &&
    typeof containment === "object" &&
    typeof containment.writable_root === "boolean" &&
    typeof containment.workspace_root === "boolean" &&
    typeof containment.active_root === "boolean" &&
    (typeof containment.integration_root === "boolean" || containment.integration_root === null);
  const validFilesystem =
    filesystem !== undefined &&
    filesystem !== null &&
    typeof filesystem === "object" &&
    typeof filesystem.root_identity_match === "boolean" &&
    (filesystem.workspace_identity === undefined || validIdentity(filesystem.workspace_identity)) &&
    (filesystem.active_identity === undefined || validIdentity(filesystem.active_identity));
  const repository = attestation.repository;
  const validDrift = stringArray(attestation.provider_drift);
  const validUnsupported = providerFactArray(attestation.unsupported);
  const validUnknowns = providerFactArray(attestation.unknowns);
  const validRepository =
    repository === undefined ||
    (typeof repository === "object" &&
      repository !== null &&
      validObservedSourceRoot(repository.source_root) &&
      (repository.common_dir === undefined || validObservedIdentity(repository.common_dir)) &&
      (repository.active_gitdir === undefined || validObservedIdentity(repository.active_gitdir)) &&
      typeof repository.worktree_registered === "boolean" &&
      (repository.current_ref === undefined || typeof repository.current_ref === "string") &&
      (repository.workspace_ref_oid === undefined ||
        OBJECT_ID.test(repository.workspace_ref_oid)) &&
      (repository.target_ref_oid === undefined || OBJECT_ID.test(repository.target_ref_oid)) &&
      (repository.head_commit === undefined || OBJECT_ID.test(repository.head_commit)) &&
      (typeof repository.base_is_ancestor === "boolean" || repository.base_is_ancestor === null) &&
      (typeof repository.target_is_ancestor === "boolean" ||
        repository.target_is_ancestor === null) &&
      stringArray(repository.dirty_paths) &&
      stringArray(repository.conflicts) &&
      stringArray(repository.operation_in_progress));
  const validReleasedAuthority =
    attestation.resource_state === "released" &&
    attestation.workspace_exists === false &&
    containment?.writable_root === true &&
    containment.workspace_root === false &&
    containment.active_root === false &&
    filesystem?.root_identity_match === true &&
    filesystem.workspace_identity === undefined &&
    filesystem.active_identity === undefined &&
    (binding.repository === undefined ||
      (repository !== undefined &&
        repositorySourceMatches(repository, binding) &&
        repositoryCommonDirMatches(repository, binding) &&
        repository?.active_gitdir === undefined &&
        repository.worktree_registered === false &&
        repository.current_ref === undefined &&
        repository.workspace_ref_oid === undefined &&
        repository.target_ref_oid !== undefined &&
        repository.head_commit === undefined &&
        repository.base_is_ancestor === null &&
        repository.target_is_ancestor === null &&
        repository.dirty_paths.length === 0 &&
        repository.conflicts.length === 0 &&
        repository.operation_in_progress.length === 0));
  const validActiveAuthority =
    (attestation.resource_state === "active" || attestation.resource_state === "preserved_dirty") &&
    attestation.workspace_exists === true &&
    containment?.writable_root === true &&
    containment.workspace_root === true &&
    containment.active_root === true &&
    (binding.integration_root === undefined || containment.integration_root === true) &&
    filesystem?.root_identity_match === true &&
    validIdentity(filesystem.workspace_identity) &&
    validIdentity(filesystem.active_identity) &&
    sameIdentity(filesystem.workspace_identity, binding.workspace_root_identity) &&
    sameIdentity(filesystem.active_identity, binding.active_root_identity) &&
    (binding.repository === undefined ||
      (repository !== undefined &&
        repositorySourceMatches(repository, binding) &&
        repositoryCommonDirMatches(repository, binding) &&
        repositoryGitdirMatches(repository, binding) &&
        repository.worktree_registered === true &&
        binding.repository.branch_created_by_provider === true &&
        repository.current_ref === binding.repository.workspace_ref &&
        repository.workspace_ref_oid !== undefined &&
        repository.target_ref_oid !== undefined &&
        repository.head_commit !== undefined &&
        repository.workspace_ref_oid === repository.head_commit &&
        repository.base_is_ancestor === true &&
        repository.target_is_ancestor === true));
  const validOkAuthority =
    attestation.status !== "ok" ||
    (validDrift &&
      attestation.provider_drift.length === 0 &&
      (validActiveAuthority || validReleasedAuthority));
  const validFailureEvidence =
    validDrift &&
    validUnsupported &&
    validUnknowns &&
    (attestation.status === "ok" ||
      repository !== undefined ||
      attestation.provider_drift.length > 0 ||
      attestation.unsupported.length > 0 ||
      attestation.unknowns.length > 0);
  return (
    attestation.schema_version === 1 &&
    attestation.binding_id === binding.binding_id &&
    attestation.workspace_id === binding.workspace_id &&
    attestation.run_id === binding.run_id &&
    sameOwner(attestation.owner, binding.owner) &&
    validProviderRef(attestation.provider) &&
    attestation.provider.id === binding.provider.id &&
    attestation.provider.version === binding.provider.version &&
    attestation.provider.capability_digest === binding.provider.capability_digest &&
    validTimestamp(attestation.recorded_at) &&
    validContainment &&
    validFilesystem &&
    validRepository &&
    validOkAuthority &&
    validFailureEvidence &&
    (binding.repository === undefined
      ? repository === undefined
      : attestation.status !== "ok" || repository !== undefined) &&
    typeof attestation.workspace_exists === "boolean" &&
    ["active", "preserved_dirty", "released", "blocked", "lost"].includes(
      attestation.resource_state,
    ) &&
    (attestation.status === "blocked"
      ? attestation.resource_state === "blocked"
      : attestation.status === "lost"
        ? attestation.resource_state === "lost"
        : attestation.resource_state === "active" ||
          attestation.resource_state === "preserved_dirty" ||
          attestation.resource_state === "released") &&
    ["ok", "blocked", "lost"].includes(attestation.status) &&
    validDrift &&
    validUnsupported &&
    validUnknowns
  );
}

export function isWorkspaceExecutionEvidence(
  value: unknown,
  runId: string,
  workflowStatus?: "succeeded" | "failed",
): value is WorkspaceExecutionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const execution = value as WorkspaceExecutionEvidence;
  if (isWorkspaceCompatibilityExecutionEvidence(execution, runId)) return true;
  return isWorkspaceBoundExecutionEvidence(execution, runId, workflowStatus);
}

export function isWorkspaceBoundExecutionEvidence(
  value: unknown,
  runId?: string,
  workflowStatus?: "succeeded" | "failed",
): value is WorkspaceBoundExecutionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const execution = value as WorkspaceBoundExecutionEvidence;
  return (
    execution.schema_version === 1 &&
    isWorkspaceBinding(execution.binding, runId) &&
    isWorkspaceAttestation(execution.terminal_attestation, execution.binding) &&
    validWorkspaceProofOutcome(
      execution.terminal_lifecycle_state,
      execution.terminal_attestation,
      workflowStatus,
    ) &&
    stableDigest(execution.drift) === stableDigest(execution.terminal_attestation.provider_drift) &&
    stableDigest(execution.unsupported) ===
      stableDigest(execution.terminal_attestation.unsupported) &&
    stableDigest(execution.unknowns) === stableDigest(execution.terminal_attestation.unknowns) &&
    validBoundReceiptLocations(execution.receipts)
  );
}

export function workspaceProofLifecycle(
  workflowStatus: "succeeded" | "failed",
  attestation: WorkspaceAttestation,
): WorkspaceProofOutcome {
  if (attestation.status === "lost") return "lost";
  if (attestation.status === "blocked") return "blocked";
  return workflowStatus === "succeeded" ? "completed_unintegrated" : "failed_retained";
}

export function assertWorkspaceManifestAuthority(
  manifest: WorkflowRunManifest,
  request: WorkspaceAllocationRequest | undefined,
): void {
  const binding = manifest.execution.workspace_binding;
  const fallback = manifest.execution.workspace_fallback;
  if (binding) {
    if (fallback) {
      throw new Error("workflow manifest cannot bind a workspace and a fallback");
    }
    const expectedOwner: WorkspaceOwner =
      manifest.work_item_id && manifest.attempt_context
        ? {
            kind: "work_attempt",
            work_item_id: manifest.work_item_id,
            attempt: manifest.attempt_context.number,
          }
        : { kind: "standalone", work_item_id: null, attempt: null };
    const expectedPolicyDigest = manifest.execution.policy
      ? policyDigest(manifest.execution.policy)
      : null;
    if (
      !isWorkspaceAllocationRequest(request) ||
      request.run_id !== manifest.run_id ||
      binding.run_id !== manifest.run_id ||
      stableDigest(request.owner) !== stableDigest(expectedOwner) ||
      stableDigest(binding.owner) !== stableDigest(expectedOwner) ||
      request.requested_isolation !== manifest.execution.isolation ||
      binding.isolation !== manifest.execution.isolation ||
      request.network_access !== manifest.execution.network_access ||
      binding.network_access !== manifest.execution.network_access ||
      manifest.execution.cwd !== binding.active_root ||
      request.provider_id !== binding.provider.id ||
      request.capability_digest !== binding.provider.capability_digest ||
      stableDigest(request.selected_writable_root) !== stableDigest(binding.writable_root) ||
      request.writable_roots.length !== 1 ||
      stableDigest(request.writable_roots[0]) !== stableDigest(request.selected_writable_root) ||
      stableDigest(request.script) !== stableDigest(manifest.script) ||
      request.policy_sha256 !== expectedPolicyDigest ||
      stableDigest(request.allowed_paths.map((path) => path.configured)) !==
        stableDigest(manifest.execution.policy?.allowed_paths ?? []) ||
      binding.request_sha256 !== stableDigest(request) ||
      (binding.repository !== undefined &&
        (!workspaceCwdMatchesBinding(request, binding) ||
          binding.integration_root !== binding.repository.source_root.realpath))
    ) {
      throw new Error("workflow manifest, workspace request, and provider binding disagree");
    }
    return;
  }
  if (request) {
    throw new Error("workflow manifest has an unbound workspace request");
  }
  if (
    fallback &&
    (fallback.run_id !== manifest.run_id ||
      fallback.requested_isolation !== manifest.execution.isolation ||
      fallback.effective_isolation !== "shared")
  ) {
    throw new Error("workflow manifest and workspace fallback disagree");
  }
}

function workspaceCwdMatchesBinding(
  request: WorkspaceAllocationRequest,
  binding: WorkspaceBinding,
): boolean {
  if (!binding.repository) return true;
  const relativeCwd = relative(binding.repository.source_root.configured, request.requested_cwd);
  return (
    (relativeCwd === "" ||
      (!relativeCwd.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        relativeCwd !== ".." &&
        !isAbsolute(relativeCwd))) &&
    binding.active_root === resolve(binding.workspace_root, relativeCwd)
  );
}

function validWorkspaceProofOutcome(
  outcome: WorkspaceProofLifecycleState,
  attestation: WorkspaceAttestation,
  workflowStatus?: "succeeded" | "failed",
): boolean {
  if (workflowStatus !== undefined) {
    return outcome === workspaceProofLifecycle(workflowStatus, attestation);
  }
  if (attestation.status === "lost") return outcome === "lost";
  if (attestation.status === "blocked") return outcome === "blocked";
  return outcome === "completed_unintegrated" || outcome === "failed_retained";
}

export function isWorkspaceCompatibilityExecutionEvidence(
  value: unknown,
  runId?: string,
): value is WorkspaceCompatibilityExecutionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const execution = value as WorkspaceCompatibilityExecutionEvidence;
  const providerNotConfigured =
    execution.selection_reason === "provider_not_configured" &&
    execution.provider === undefined &&
    execution.unsupported.some((fact) => fact.code === "provider_not_configured");
  const providerUnsupported =
    execution.selection_reason === "provider_unsupported" && validProviderRef(execution.provider);
  return (
    execution.schema_version === 1 &&
    typeof execution.run_id === "string" &&
    (runId === undefined || execution.run_id === runId) &&
    ["worktree", "sandbox", "remote"].includes(execution.requested_isolation) &&
    execution.effective_isolation === "shared" &&
    (providerNotConfigured || providerUnsupported) &&
    execution.terminal_lifecycle_state === "shared" &&
    Array.isArray(execution.drift) &&
    execution.drift.length === 0 &&
    providerFactArray(execution.unsupported) &&
    execution.unsupported.length > 0 &&
    providerFactArray(execution.unknowns) &&
    execution.receipts !== null &&
    typeof execution.receipts === "object" &&
    !Array.isArray(execution.receipts) &&
    Object.keys(execution.receipts).length === 0
  );
}

/** @deprecated Use isWorkspaceCompatibilityExecutionEvidence. */
export const isWorkspaceUnsupportedExecutionEvidence = isWorkspaceCompatibilityExecutionEvidence;

function sameOwner(left: WorkspaceOwner, right: WorkspaceOwner): boolean {
  return (
    left.kind === right.kind &&
    left.work_item_id === right.work_item_id &&
    left.attempt === right.attempt
  );
}

function repositorySourceMatches(
  observation: RepositoryObservation | undefined,
  binding: WorkspaceBinding,
): boolean {
  const expected = binding.repository?.source_root;
  return Boolean(
    observation &&
      expected &&
      observation.source_root &&
      observation.source_root.configured === expected.configured &&
      observation.source_root.realpath === expected.realpath &&
      sameIdentity(observation.source_root.identity, expected.identity),
  );
}

function repositoryCommonDirMatches(
  observation: RepositoryObservation | undefined,
  binding: WorkspaceBinding,
): boolean {
  const expected = binding.repository?.common_dir;
  return Boolean(
    observation &&
      expected &&
      observation.common_dir?.realpath === expected.realpath &&
      sameIdentity(observation.common_dir?.identity, expected.identity),
  );
}

function repositoryGitdirMatches(
  observation: RepositoryObservation | undefined,
  binding: WorkspaceBinding,
): boolean {
  const expected = binding.repository?.gitdir;
  return Boolean(
    observation &&
      expected &&
      observation.active_gitdir?.realpath === expected.realpath &&
      sameIdentity(observation.active_gitdir?.identity, expected.identity),
  );
}

function validObservedSourceRoot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  return (
    typeof root.configured === "string" &&
    isAbsolute(root.configured) &&
    resolve(root.configured) === root.configured &&
    ((root.realpath === undefined && root.identity === undefined) ||
      (typeof root.realpath === "string" &&
        isAbsolute(root.realpath) &&
        resolve(root.realpath) === root.realpath &&
        validIdentity(root.identity)))
  );
}

function validObservedIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  return (
    typeof root.realpath === "string" &&
    isAbsolute(root.realpath) &&
    resolve(root.realpath) === root.realpath &&
    validIdentity(root.identity)
  );
}

function sameIdentity(left: unknown, right: unknown): boolean {
  if (!validIdentity(left) || !validIdentity(right)) return false;
  return stableDigest(left) === stableDigest(right);
}

function validBoundReceiptLocations(
  value: WorkspaceBoundExecutionEvidence["receipts"] | undefined,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected: Record<string, string> = {
    request: "workspace-request.json",
    cancellation_outcome: "cancellation/outcome.json",
    integration_plan: "integration/plan.json",
    integration_authorization: "integration/authorization.json",
    integration_apply: "integration/receipt.json",
    cleanup_intent: "cleanup/intent.json",
    cleanup_receipt: "cleanup/receipt.json",
  };
  return (
    value.request === expected.request &&
    Object.entries(value).every(([key, location]) => expected[key] === location)
  );
}

function validIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.platform === "string" &&
    typeof identity.device === "string" &&
    typeof identity.inode === "string"
  );
}

function validProviderRef(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provider = value as Record<string, unknown>;
  return (
    typeof provider.id === "string" &&
    provider.id.length > 0 &&
    typeof provider.version === "string" &&
    provider.version.length > 0 &&
    typeof provider.capability_digest === "string" &&
    DIGEST.test(provider.capability_digest)
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validValidatedPath(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const path = value as Record<string, unknown>;
  return (
    typeof path.configured === "string" &&
    isAbsolute(path.configured) &&
    resolve(path.configured) === path.configured &&
    typeof path.realpath === "string" &&
    isAbsolute(path.realpath) &&
    resolve(path.realpath) === path.realpath &&
    validIdentity(path.identity)
  );
}

function validatedPathArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(validValidatedPath);
}

function containsResolvedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel))
  );
}

function providerFactArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof item.code === "string" &&
        item.code.length > 0 &&
        typeof item.message === "string" &&
        item.message.length > 0,
    )
  );
}
