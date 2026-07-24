import type { PolicyDecision, PolicyIsolation, PolicyNetworkAccess } from "../../policy/index.ts";

export const WORKSPACE_BINDING_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_RECEIPT_SCHEMA_VERSION = 1 as const;

export type WorkspaceIsolation = Exclude<PolicyIsolation, "shared">;

export type WorkspaceOwner =
  | { kind: "work_attempt"; work_item_id: string; attempt: number }
  | { kind: "standalone"; work_item_id: null; attempt: null };

export interface FilesystemIdentity {
  platform: NodeJS.Platform;
  device: string;
  inode: string;
}

export interface ValidatedFilesystemPath {
  configured: string;
  realpath: string;
  identity: FilesystemIdentity;
}

/** @deprecated Use ValidatedFilesystemPath. */
export type ValidatedFilesystemRoot = ValidatedFilesystemPath;

export interface WorkspaceProviderRef {
  id: string;
  version: string;
  capability_digest: string;
}

export interface ProviderUnsupportedReason {
  code: string;
  message: string;
}

export interface ProviderUnknown {
  code: string;
  message: string;
}

export interface WorkspaceProviderCapabilities {
  schema_version: 1;
  provider_id: string;
  provider_version: string;
  isolation: readonly ("worktree" | "sandbox" | "remote")[];
  reattach: "supported" | "unsupported";
  cancellation: "supported" | "partial" | "unsupported";
  cleanup: "ownership_gated" | "unsupported";
  integration: readonly "fast_forward"[];
  network_attestation: "supported" | "unknown" | "unsupported";
  filesystem_identity: "supported" | "unsupported";
  capability_digest: string;
}

export interface WorkspaceProbeResult {
  schema_version: 1;
  supported: boolean;
  capabilities: WorkspaceProviderCapabilities;
  unsupported: readonly ProviderUnsupportedReason[];
  unknowns: readonly ProviderUnknown[];
}

export interface WorkspaceProbeInput {
  requested_cwd: string;
  writable_roots: readonly string[];
}

export interface WorkspaceAllocationRequest {
  schema_version: 1;
  run_id: string;
  owner: WorkspaceOwner;
  requested_cwd: string;
  requested_isolation: WorkspaceIsolation;
  network_access: PolicyNetworkAccess;
  script: { path: string; sha256: string };
  policy_sha256: string | null;
  allowed_paths: readonly ValidatedFilesystemPath[];
  writable_roots: readonly ValidatedFilesystemPath[];
  selected_writable_root: ValidatedFilesystemPath;
  provider_id: string;
  capability_digest: string;
  idempotency_key: string;
}

export interface GitRepositoryBinding {
  source_root: {
    configured: string;
    realpath: string;
    identity: FilesystemIdentity;
  };
  common_dir: {
    realpath: string;
    identity: FilesystemIdentity;
  };
  base_commit: string;
  target_commit: string;
  target_ref: string;
  workspace_ref: string;
  workspace_branch: string;
  gitdir: {
    realpath: string;
    identity: FilesystemIdentity;
  };
  branch_created_by_provider: boolean;
}

export type RepositoryBinding = GitRepositoryBinding;

export interface WorkspaceBinding {
  schema_version: 1;
  binding_id: string;
  workspace_id: string;
  run_id: string;
  owner: WorkspaceOwner;
  provider: WorkspaceProviderRef;
  isolation: WorkspaceIsolation;
  network_access: PolicyNetworkAccess;
  workspace_root: string;
  workspace_root_identity: FilesystemIdentity;
  active_root: string;
  active_root_identity: FilesystemIdentity;
  integration_root?: string;
  writable_root: ValidatedFilesystemPath;
  repository?: GitRepositoryBinding;
  generation: number;
  recovery_token: string;
  request_sha256: string;
  created_at: string;
}

export interface RepositoryObservation {
  source_root: {
    configured: string;
    realpath?: string;
    identity?: FilesystemIdentity;
  };
  common_dir?: {
    realpath: string;
    identity: FilesystemIdentity;
  };
  active_gitdir?: {
    realpath: string;
    identity: FilesystemIdentity;
  };
  worktree_registered: boolean;
  current_ref?: string;
  workspace_ref_oid?: string;
  target_ref_oid?: string;
  head_commit?: string;
  base_is_ancestor: boolean | null;
  target_is_ancestor: boolean | null;
  dirty_paths: string[];
  conflicts: string[];
  operation_in_progress: string[];
}

export type WorkspaceObservation = RepositoryObservation;

export type WorkspaceLifecycleState =
  | "shared"
  | "allocation_recorded"
  | "allocating"
  | "bound"
  | "running"
  | "parked"
  | "completed_unintegrated"
  | "failed_retained"
  | "integration_requested"
  | "integrating"
  | "integrated"
  | "cleanup_pending"
  | "released"
  | "unsupported"
  | "preserved_dirty"
  | "blocked"
  | "lost"
  | "abandoned_dirty";

export type WorkspaceProofOutcome =
  | "completed_unintegrated"
  | "failed_retained"
  | "blocked"
  | "lost";

/** @deprecated Use WorkspaceProofOutcome. */
export type WorkspaceProofLifecycleState = WorkspaceProofOutcome;

export type WorkspaceResourceState = "active" | "preserved_dirty" | "released" | "blocked" | "lost";

export type WorkspaceIntegrationState = "none" | "planned" | "applying" | "applied";

export interface WorkspaceAttestation {
  schema_version: 1;
  binding_id: string;
  workspace_id: string;
  run_id: string;
  owner: WorkspaceOwner;
  provider: WorkspaceBinding["provider"];
  recorded_at: string;
  containment: {
    writable_root: boolean;
    workspace_root: boolean;
    active_root: boolean;
    integration_root: boolean | null;
  };
  filesystem: {
    root_identity_match: boolean;
    workspace_identity?: FilesystemIdentity;
    active_identity?: FilesystemIdentity;
  };
  provider_drift: string[];
  workspace_exists: boolean;
  repository?: RepositoryObservation;
  resource_state: WorkspaceResourceState;
  unsupported: ProviderUnsupportedReason[];
  unknowns: ProviderUnknown[];
  status: "ok" | "blocked" | "lost";
}

export interface WorkspaceCancellationResult {
  schema_version: 1;
  binding_id: string;
  status: "cancelled" | "unsupported" | "preserved_dirty" | "blocked";
  recorded_at: string;
  attestation: WorkspaceAttestation;
  reason?: string;
}

export interface WorkspaceCancellationReceipt {
  schema_version: 1;
  receipt_id: string;
  run_id: string;
  binding_id: string;
  binding_sha256: string;
  work_item_id: string;
  work_event_seq: number;
  work_event_sha256: string;
  status: WorkspaceCancellationResult["status"];
  recorded_at: string;
  attestation: WorkspaceAttestation;
  reason?: string;
}

export type WorkspaceCleanupMode = "normal";

export interface WorkspaceCleanupResult {
  schema_version: 1;
  binding_id: string;
  status:
    | "released"
    | "already_released"
    | "preserved_dirty"
    | "blocked"
    | "unsupported"
    | "partial";
  recorded_at: string;
  branch_deleted: boolean;
  attestation: WorkspaceAttestation;
  reason?: string;
}

export interface WorkspaceCleanupIntent {
  schema_version: 1;
  run_id: string;
  operation_id: string;
  binding_id: string;
  binding_sha256: string;
  mode: WorkspaceCleanupMode;
  expected: {
    worktree_path: string;
    gitdir: GitRepositoryBinding["gitdir"];
    workspace_ref: string;
    workspace_ref_oid: string;
    target_ref: string;
    target_ref_oid: string;
  };
  created_at: string;
}

export interface WorkspaceCleanupAttempt {
  schema_version: 1;
  seq: number;
  previous_sha256: string | null;
  record_sha256: string;
  operation_id: string;
  binding_id: string;
  binding_sha256: string;
  mode: WorkspaceCleanupMode;
  status: "started" | WorkspaceCleanupResult["status"];
  branch_deleted?: boolean;
  attestation?: WorkspaceAttestation;
  reason?: string;
  recorded_at: string;
}

export interface WorkspaceCleanupReceipt {
  schema_version: 1;
  receipt_id: string;
  operation_id: string;
  binding_id: string;
  binding_sha256: string;
  mode: WorkspaceCleanupMode;
  status: "released" | "already_released";
  branch_deleted: true;
  attestation: WorkspaceAttestation;
  recorded_at: string;
}

export interface IntegrationTarget {
  root: string;
  ref?: string;
}

export interface ProviderIntegrationPreview {
  schema_version: 1;
  provider_id: string;
  binding_id: string;
  operation: "fast_forward";
  target_root: string;
  target_ref: string;
  target_commit: string;
  target_tree: string;
  source_commit: string;
  source_tree: string;
  changed_paths: string[];
  blocked: ProviderUnsupportedReason[];
  unknowns: ProviderUnknown[];
  prepared_at: string;
}

export interface IntegrationReviewRecord {
  schema_version: 1;
  run_id: string;
  owner: WorkspaceOwner;
  proof_sha256: string;
  binding_id: string;
  terminal_attestation_sha256: string;
  accepted_unknowns: string[];
  actor: string;
  reason?: string;
  reviewed_at: string;
}

export interface IntegrationAuthorization {
  schema_version: 1;
  run_id: string;
  plan_sha256: string;
  policy_sha256: string;
  decision: PolicyDecision;
  decision_sha256: string;
  approval_id?: string;
  approval_actor?: string;
  approval_sha256?: string;
  journal_anchor: {
    event: "integration.plan";
    plan_sha256: string;
  };
  authorized_at: string;
}

export interface IntegrationPlan {
  schema_version: 1;
  plan_id: string;
  run_id: string;
  operation: "fast_forward";
  binding: WorkspaceBinding;
  binding_sha256: string;
  proof_sha256: string;
  terminal_attestation_sha256: string;
  review_sha256: string;
  accepted_unknowns: string[];
  provider_preview: ProviderIntegrationPreview;
  target_identity_sha256: string;
  idempotency_sha256: string;
  prepared_at: string;
}

export interface AuthorizedIntegrationPlan {
  schema_version: 1;
  plan: IntegrationPlan;
  plan_sha256: string;
  authorization: IntegrationAuthorization;
  authorization_sha256: string;
}

export interface ProviderIntegrationInput {
  schema_version: 1;
  run_id: string;
  binding: WorkspaceBinding;
  binding_sha256: string;
  proof_sha256: string;
  terminal_attestation: WorkspaceAttestation;
  terminal_attestation_sha256: string;
  review_sha256: string;
  accepted_unknowns: readonly string[];
  target: IntegrationTarget;
}

export interface AuthorizedProviderIntegrationInput {
  schema_version: 1;
  run_id: string;
  binding: WorkspaceBinding;
  binding_sha256: string;
  plan_id: string;
  plan_sha256: string;
  authorization_sha256: string;
  proof_sha256: string;
  terminal_attestation_sha256: string;
  review_sha256: string;
  accepted_unknowns: readonly string[];
  preview: ProviderIntegrationPreview;
}

export interface ProviderIntegrationResult {
  schema_version: 1;
  binding_id: string;
  plan_id: string;
  status: "applied" | "already_applied";
  target_commit: string;
  target_tree: string;
  applied_at: string;
}

export interface IntegrationApplyReceipt {
  schema_version: 1;
  receipt_id: string;
  run_id: string;
  plan_id: string;
  plan_sha256: string;
  authorization_sha256: string;
  proof_sha256: string;
  binding_sha256: string;
  binding_id: string;
  provider_id: string;
  status: "applied" | "already_applied";
  target_root: string;
  target_ref: string;
  source_commit: string;
  target_commit: string;
  target_tree: string;
  applied_at: string;
}

export interface IntegrationApplyAttempt {
  schema_version: 1;
  seq: number;
  previous_sha256: string | null;
  record_sha256: string;
  run_id: string;
  plan_sha256: string;
  authorization_sha256: string;
  proof_sha256: string;
  binding_sha256: string;
  status: "started" | ProviderIntegrationResult["status"];
  target_commit?: string;
  target_tree?: string;
  recorded_at: string;
}

export interface WorkspaceBoundExecutionEvidence {
  schema_version: 1;
  binding: WorkspaceBinding;
  terminal_attestation: WorkspaceAttestation;
  terminal_lifecycle_state: WorkspaceProofOutcome;
  drift: string[];
  unsupported: ProviderUnsupportedReason[];
  unknowns: ProviderUnknown[];
  receipts: {
    request: "workspace-request.json";
    cancellation_outcome?: "cancellation/outcome.json";
    integration_plan?: "integration/plan.json";
    integration_authorization?: "integration/authorization.json";
    integration_apply?: "integration/receipt.json";
    cleanup_intent?: "cleanup/intent.json";
    cleanup_receipt?: "cleanup/receipt.json";
  };
}

export interface WorkspaceCompatibilityExecutionEvidence {
  schema_version: 1;
  run_id: string;
  requested_isolation: WorkspaceIsolation;
  effective_isolation: "shared";
  selection_reason: "provider_not_configured" | "provider_unsupported";
  provider?: WorkspaceProviderRef;
  terminal_lifecycle_state: "shared";
  drift: string[];
  unsupported: ProviderUnsupportedReason[];
  unknowns: ProviderUnknown[];
  receipts: Record<string, never>;
}

/** @deprecated Use WorkspaceCompatibilityExecutionEvidence. */
export type WorkspaceUnsupportedExecutionEvidence = WorkspaceCompatibilityExecutionEvidence;

export type WorkspaceExecutionEvidence =
  | WorkspaceBoundExecutionEvidence
  | WorkspaceCompatibilityExecutionEvidence;

export interface WorkspaceProvider {
  probe(input: WorkspaceProbeInput): Promise<WorkspaceProbeResult>;
  allocate(request: WorkspaceAllocationRequest): Promise<WorkspaceBinding>;
  readBinding(binding: WorkspaceBinding): Promise<WorkspaceBinding>;
  reattach(binding: WorkspaceBinding): Promise<WorkspaceAttestation>;
  attest(binding: WorkspaceBinding): Promise<WorkspaceAttestation>;
  cancel(binding: WorkspaceBinding): Promise<WorkspaceCancellationResult>;
  previewIntegration(input: ProviderIntegrationInput): Promise<ProviderIntegrationPreview>;
  applyAuthorizedIntegration(
    input: AuthorizedProviderIntegrationInput,
  ): Promise<ProviderIntegrationResult>;
  cleanup(
    binding: WorkspaceBinding,
    intent: WorkspaceCleanupIntent,
  ): Promise<WorkspaceCleanupResult>;
}
