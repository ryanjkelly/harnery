import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { WorkspaceAttestationError } from "./attestation-error.ts";
import {
  git,
  gitMaybe,
  gitMaybeWithDirectoryDescriptor,
  gitOperations,
  isAncestor,
  nulEntries,
  overwriteRiskPaths,
  parseWorktreeInventory,
  worktreeInventory,
} from "./git.ts";
import { acquireNoClobberLease } from "./leases.ts";
import {
  assertContainedExisting,
  assertPathIdentity,
  candidateUnderRoot,
  containsPath,
  createContainedDirectories,
  descriptorBackedPathsSupported,
  descriptorPath,
  filesystemIdentity,
  openContainedDirectory,
  sameFilesystemIdentity,
  type ValidatedRoot,
  validateConfiguredRoot,
} from "./paths.ts";
import { readWorkflowLiveness } from "./recovery.ts";
import {
  appendWorkspaceEvent,
  fileSha256,
  readWorkflowSupplement,
  readWorkspaceBinding,
  readWorkspaceClaim,
  readWorkspaceEvents,
  stableDigest,
  type WorkspaceClaim,
  workspaceClaimPath,
  workspaceLockPath,
  writeWorkspaceBinding,
  writeWorkspaceClaim,
} from "./state.ts";
import type {
  AuthorizedProviderIntegrationInput,
  FilesystemIdentity,
  GitRepositoryBinding,
  IntegrationAuthorization,
  IntegrationPlan,
  ProviderIntegrationInput,
  ProviderIntegrationPreview,
  ProviderIntegrationResult,
  ProviderUnsupportedReason,
  WorkspaceAllocationRequest,
  WorkspaceAttestation,
  WorkspaceBinding,
  WorkspaceCancellationResult,
  WorkspaceCleanupIntent,
  WorkspaceCleanupResult,
  WorkspaceProbeInput,
  WorkspaceProbeResult,
  WorkspaceProvider,
  WorkspaceProviderCapabilities,
} from "./types.ts";
import { isWorkspaceAttestation } from "./validate.ts";

const PROVIDER_ID = "local-git-worktree";
const PROVIDER_VERSION = "1";
const LOCK_STALE_MS = 5 * 60 * 1_000;
const OBJECT_FORMAT = /^[a-f0-9]{40,64}$/;
const REF_FORMAT = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;

export interface LocalGitWorktreeProviderOptions {
  coordRoot: string;
  descriptorPathsSupported?: () => boolean;
}

export function createLocalGitWorktreeProvider(
  options: LocalGitWorktreeProviderOptions,
): WorkspaceProvider {
  const coordRoot = resolve(options.coordRoot);
  return {
    probe: (input) => probe(input, options.descriptorPathsSupported),
    allocate: (request) => allocate(coordRoot, request),
    readBinding: async (binding) => {
      requiredClaim(coordRoot, binding);
      return readWorkspaceBinding(coordRoot, binding.provider.id, binding.binding_id)!;
    },
    reattach: (binding) => reattach(coordRoot, binding),
    attest: (binding) => attest(coordRoot, binding),
    cancel: (binding) => cancel(coordRoot, binding),
    previewIntegration: (input) => previewIntegration(coordRoot, input),
    applyAuthorizedIntegration: (input) => applyAuthorizedIntegration(coordRoot, input),
    cleanup: (binding, intent) => cleanup(coordRoot, binding, intent),
  };
}

export async function probe(
  input: WorkspaceProbeInput,
  descriptorPathsSupported: () => boolean = descriptorBackedPathsSupported,
): Promise<WorkspaceProbeResult> {
  const unsupported: ProviderUnsupportedReason[] = [];
  const version = gitMaybe(input.requested_cwd, ["--version"]);
  if (!version.ok) unsupported.push(reason("git_unavailable", "git is not available"));
  if (version.ok && !supportedGitVersion(version.out)) {
    unsupported.push(
      reason(
        "git_version_unsupported",
        "Git 2.31 or newer is required for safe worktree operations",
      ),
    );
  }
  if (!descriptorPathsSupported()) {
    unsupported.push(
      reason(
        "descriptor_paths_unavailable",
        "the host does not expose inherited descriptor-backed paths",
      ),
    );
  }
  if (input.writable_roots.length === 0) {
    unsupported.push(reason("writable_roots_required", "explicit writable roots are required"));
  }
  for (const root of input.writable_roots) {
    try {
      validateConfiguredRoot(root);
    } catch (error) {
      unsupported.push(reason("writable_root_invalid", (error as Error).message));
    }
  }
  if (version.ok) {
    try {
      inspectSourceRepository(input.requested_cwd);
    } catch (error) {
      unsupported.push(reason("repository_unsupported", (error as Error).message));
    }
  }
  const capabilities: WorkspaceProviderCapabilities = {
    schema_version: 1 as const,
    provider_id: PROVIDER_ID,
    provider_version: PROVIDER_VERSION,
    isolation: ["worktree"] as const,
    reattach: "supported" as const,
    cancellation: "partial" as const,
    cleanup: "ownership_gated" as const,
    integration: ["fast_forward"] as const,
    network_attestation: "unknown" as const,
    filesystem_identity: "supported" as const,
    capability_digest: "",
  };
  const capabilityDigest = stableDigest({
    ...capabilities,
    capability_digest: undefined,
  });
  return {
    schema_version: 1,
    capabilities: { ...capabilities, capability_digest: capabilityDigest },
    supported: unsupported.length === 0,
    unsupported,
    unknowns: [
      {
        code: "network_not_attested",
        message: "the local Git provider does not attest network enforcement",
      },
    ],
  };
}

async function allocate(
  coordRoot: string,
  request: WorkspaceAllocationRequest,
): Promise<WorkspaceBinding> {
  validateRequest(request);
  const capabilities = await probe({
    requested_cwd: request.requested_cwd,
    writable_roots: request.writable_roots.map((root) => root.configured),
  });
  if (
    !capabilities.supported ||
    !capabilities.capabilities.isolation.includes(request.requested_isolation)
  ) {
    throw new Error(
      `workspace provider unsupported: ${capabilities.unsupported.map((item) => item.message).join("; ")}`,
    );
  }
  if (
    request.provider_id !== PROVIDER_ID ||
    request.capability_digest !== capabilities.capabilities.capability_digest
  ) {
    throw new Error("workspace request provider identity or capability digest drifted");
  }

  const requestSha256 = stableDigest(request);
  const bindingId = `ws-${stableDigest(request.idempotency_key).slice(0, 24)}`;
  const workspaceId = `local-${stableDigest({ bindingId, requestSha256 }).slice(0, 24)}`;
  const root = validateConfiguredRoot(request.selected_writable_root.configured);
  if (
    root.realpath !== request.selected_writable_root.realpath ||
    !sameFilesystemIdentity(root.identity, request.selected_writable_root.identity)
  ) {
    throw new Error("selected writable root identity changed before allocation");
  }
  const repo = inspectSourceRepository(request.requested_cwd);
  assertAllowedPathAuthority(request.allowed_paths, repo.sourceRoot.realpath, "source repository");
  assertAllowedPathAuthority(
    request.allowed_paths,
    repo.commonDir.realpath,
    "Git common directory",
  );
  if (
    !containsPath(root.realpath, repo.sourceRoot.realpath) ||
    !containsPath(root.realpath, repo.commonDir.realpath)
  ) {
    throw new Error("source repository and Git common dir must be inside the writable root");
  }
  const workspaceRoot = candidateUnderRoot(root, ["harnery-workspaces", bindingId]);
  const activeRoot = resolve(workspaceRoot, repo.requestedRelativePath);
  if (!containsPath(workspaceRoot, activeRoot)) {
    throw new Error("requested working directory escapes the isolated workspace");
  }
  assertAllowedPathAuthority(request.allowed_paths, workspaceRoot, "workspace allocation path");
  assertAllowedPathAuthority(request.allowed_paths, activeRoot, "active workspace path");
  const workspaceBranch = `harnery/workspace/${bindingId}`;
  const workspaceRef = `refs/heads/${workspaceBranch}`;
  const proposed: WorkspaceClaim = {
    schema_version: 1,
    provider_id: PROVIDER_ID,
    provider_version: PROVIDER_VERSION,
    binding_id: bindingId,
    workspace_id: workspaceId,
    request,
    request_sha256: requestSha256,
    recovery_token: randomBytes(32).toString("hex"),
    created_at: new Date().toISOString(),
    workspace_root: workspaceRoot,
    active_root: activeRoot,
    writable_root: root,
    repository: {
      source_root: repo.sourceRoot,
      common_dir: repo.commonDir,
      base_commit: repo.head,
      target_commit: repo.head,
      target_ref: repo.targetRef,
      workspace_ref: workspaceRef,
      workspace_branch: workspaceBranch,
    },
  };
  writeWorkspaceClaim(coordRoot, proposed);
  const claim = readWorkspaceClaim(coordRoot, PROVIDER_ID, bindingId);
  if (!claim || stableDigest(claim.request) !== requestSha256) {
    throw new Error(`workspace claim ${bindingId} belongs to a different request`);
  }
  const persistedBinding = readWorkspaceBinding(coordRoot, PROVIDER_ID, bindingId);
  if (persistedBinding) {
    requiredClaim(coordRoot, persistedBinding);
    if (persistedBinding.request_sha256 !== requestSha256) {
      throw new Error(`workspace binding ${bindingId} belongs to a different request`);
    }
  } else if (!sameDeterministicClaim(claim, proposed)) {
    throw new Error(`workspace claim ${bindingId} does not match current provider inventory`);
  }

  const releaseAllocation = acquireLease(
    coordRoot,
    workspaceLockPath(coordRoot, PROVIDER_ID, bindingId),
    claim,
    "binding",
  );
  try {
    ensureInitialEvent(coordRoot, claim);
    const releaseRepository = acquireRepositoryLease(coordRoot, claim);
    try {
      return reconcileAllocation(coordRoot, claim, root);
    } finally {
      releaseRepository();
    }
  } finally {
    releaseAllocation();
  }
}

function reconcileAllocation(
  coordRoot: string,
  claim: WorkspaceClaim,
  root: ValidatedRoot,
): WorkspaceBinding {
  const events = readWorkspaceEvents(coordRoot, PROVIDER_ID, claim.binding_id);
  if (!events.some((item) => item.event === "allocating")) {
    appendWorkspaceEvent(coordRoot, claim, "allocating");
  }
  revalidateClaimResources(claim, root);

  const branchEvent = readWorkspaceEvents(coordRoot, PROVIDER_ID, claim.binding_id).some(
    (item) => item.event === "branch_creation_started",
  );
  const branchCommit = gitMaybe(claim.repository.source_root.realpath, [
    "rev-parse",
    "--verify",
    claim.repository.workspace_ref,
  ]);
  const wasBound = events.some((item) => item.event === "bound");
  if (branchCommit.ok && !branchEvent) {
    appendWorkspaceEvent(coordRoot, claim, "blocked", { reason: "foreign branch collision" });
    throw new Error(`workspace branch already exists without ownership proof`);
  }
  if (!branchEvent) {
    appendWorkspaceEvent(coordRoot, claim, "branch_creation_started", {
      ref: claim.repository.workspace_ref,
      commit: claim.repository.base_commit,
    });
  }
  if (!branchCommit.ok) {
    git(claim.repository.source_root.realpath, [
      "update-ref",
      claim.repository.workspace_ref,
      claim.repository.base_commit,
      "0".repeat(claim.repository.base_commit.length),
    ]);
  } else if (!wasBound && branchCommit.out !== claim.repository.base_commit) {
    throw new Error("provider-owned workspace branch no longer matches its frozen base");
  }

  const workspaceParent = createContainedDirectories(root, ["harnery-workspaces"]);
  const workspaceParentIdentity = filesystemIdentity(workspaceParent);
  const registered = worktreeInventory(claim.repository.source_root.realpath);
  const exact = registered.find((item) => resolve(item.path) === claim.workspace_root);
  const sameRef = registered.find((item) => item.ref === claim.repository.workspace_ref);
  if (wasBound && !exact && !existsSync(claim.workspace_root)) {
    appendWorkspaceEvent(coordRoot, claim, "lost", { reason: "bound worktree disappeared" });
    throw new Error("immutable bound workspace resource is lost");
  }
  if (sameRef && resolve(sameRef.path) !== claim.workspace_root) {
    throw new Error("provider workspace ref is registered at a foreign path");
  }
  if (exact && exact.ref !== claim.repository.workspace_ref) {
    throw new Error("provider workspace path is registered to a foreign ref");
  }
  if (exact && !existsSync(claim.workspace_root)) {
    const removed = gitMaybe(claim.repository.source_root.realpath, [
      "worktree",
      "remove",
      claim.workspace_root,
    ]);
    if (!removed.ok) {
      throw new Error("stale worktree metadata could not be removed without a broad prune");
    }
    appendWorkspaceEvent(coordRoot, claim, "stale_registration_recovered");
  } else if (
    !exact &&
    existsSync(claim.workspace_root) &&
    !readWorkspaceEvents(coordRoot, PROVIDER_ID, claim.binding_id).some(
      (item) => item.event === "worktree_creation_started",
    )
  ) {
    throw new Error("workspace directory exists without exact Git registration");
  }

  if (
    !worktreeInventory(claim.repository.source_root.realpath).some(
      (item) =>
        resolve(item.path) === claim.workspace_root && item.ref === claim.repository.workspace_ref,
    )
  ) {
    revalidateClaimResources(claim, root);
    assertPathIdentity(workspaceParent, workspaceParentIdentity, "workspace parent");
    const parentRealpath = assertContainedExisting(root, workspaceParent, "workspace parent");
    if (parentRealpath !== dirname(claim.workspace_root)) {
      throw new Error("workspace parent identity does not match the claimed workspace path");
    }
    if (
      !readWorkspaceEvents(coordRoot, PROVIDER_ID, claim.binding_id).some(
        (item) => item.event === "worktree_creation_started",
      )
    ) {
      appendWorkspaceEvent(coordRoot, claim, "worktree_creation_started", {
        parent: workspaceParent,
        parent_identity: workspaceParentIdentity,
      });
    }
    const openedWorkspace = openContainedDirectory(root, ["harnery-workspaces", claim.binding_id]);
    if (openedWorkspace.path !== claim.workspace_root) {
      openedWorkspace.close();
      throw new Error("descriptor-backed workspace directory differs from the claim");
    }
    try {
      const added = gitMaybeWithDirectoryDescriptor(
        claim.repository.source_root.realpath,
        ["worktree", "add", openedWorkspace.descriptor_path, claim.repository.workspace_branch],
        openedWorkspace.fd,
      );
      if (!added.ok) throw new Error(added.err);
      revalidateClaimResources(claim, root);
      assertPathIdentity(workspaceParent, workspaceParentIdentity, "workspace parent");
      assertContainedExisting(root, claim.workspace_root, "created workspace");
      const registeredAfter = worktreeInventory(claim.repository.source_root.realpath);
      if (
        !registeredAfter.some(
          (item) =>
            resolve(item.path) === claim.workspace_root &&
            item.ref === claim.repository.workspace_ref,
        )
      ) {
        throw new Error("Git did not canonically register the descriptor-backed workspace");
      }
    } catch (error) {
      rollbackAllocationThroughDescriptor(coordRoot, claim, openedWorkspace.fd);
      throw error;
    } finally {
      openedWorkspace.close();
    }
    appendWorkspaceEvent(coordRoot, claim, "worktree_created", {
      path: claim.workspace_root,
      ref: claim.repository.workspace_ref,
    });
  }

  revalidateClaimResources(claim, root);
  const binding = bindingFromClaim(claim);
  const storedBinding = readWorkspaceBinding(coordRoot, binding.provider.id, binding.binding_id);
  if (storedBinding && stableDigest(storedBinding) !== stableDigest(binding)) {
    throw new Error("immutable workspace binding does not match recovered provider state");
  }
  if (!storedBinding) writeWorkspaceBinding(coordRoot, binding);
  const attestation = attestSync(coordRoot, binding);
  if (attestation.status !== "ok") {
    throw new Error(
      `allocated workspace failed attestation: ${attestation.provider_drift.join("; ")}`,
    );
  }
  if (
    !readWorkspaceEvents(coordRoot, PROVIDER_ID, claim.binding_id).some(
      (item) => item.event === "bound",
    )
  ) {
    appendWorkspaceEvent(coordRoot, claim, "bound", {
      binding_sha256: stableDigest(binding),
      gitdir: binding.repository?.gitdir.realpath,
    });
  }
  return binding;
}

async function reattach(
  coordRoot: string,
  binding: WorkspaceBinding,
): Promise<WorkspaceAttestation> {
  const claim = requiredClaim(coordRoot, binding);
  const release = acquireLease(
    coordRoot,
    workspaceLockPath(coordRoot, PROVIDER_ID, binding.binding_id),
    claim,
    "binding",
  );
  try {
    return reattachUnderLease(coordRoot, binding, claim);
  } finally {
    release();
  }
}

function reattachUnderLease(
  coordRoot: string,
  binding: WorkspaceBinding,
  claim: WorkspaceClaim,
): WorkspaceAttestation {
  const result = attestSync(coordRoot, binding);
  if (result.status !== "ok") {
    throw new WorkspaceAttestationError(
      `workspace binding ${binding.binding_id} cannot reattach: ${
        [...result.provider_drift, ...result.unsupported.map((item) => item.message)].join("; ") ||
        result.status
      }`,
      result,
    );
  }
  appendWorkspaceEvent(coordRoot, claim, "reattached", {
    attestation_sha256: stableDigest(result),
  });
  return result;
}

async function attest(coordRoot: string, binding: WorkspaceBinding): Promise<WorkspaceAttestation> {
  requiredClaim(coordRoot, binding);
  return attestSync(coordRoot, binding);
}

function attestSync(coordRoot: string, binding: WorkspaceBinding): WorkspaceAttestation {
  const frozenClaim = requiredClaim(coordRoot, binding);
  const drift: string[] = [];
  const unsupported: ProviderUnsupportedReason[] = [];
  const unknowns = [
    {
      code: "network_not_attested",
      message: "the local Git provider does not attest network enforcement",
    },
  ];
  let releaseExpected = false;
  let claim: WorkspaceClaim | undefined;
  try {
    claim = readWorkspaceClaim(coordRoot, binding.provider.id, binding.binding_id);
  } catch (error) {
    drift.push(`claim unreadable: ${(error as Error).message}`);
  }
  if (!claim) drift.push("ownership claim is missing");
  if (claim) {
    if (claim.recovery_token !== binding.recovery_token) drift.push("recovery token mismatch");
    if (claim.request_sha256 !== binding.request_sha256) drift.push("request digest mismatch");
    if (claim.provider_version !== binding.provider.version)
      drift.push("provider version mismatch");
    if (
      claim.request.capability_digest !== binding.provider.capability_digest ||
      claim.request.capability_digest !== capabilityDigestForClaim(claim)
    ) {
      drift.push("capability digest mismatch");
    }
    if (claim.request.run_id !== binding.run_id) drift.push("run identity mismatch");
    if (stableDigest(claim.request.owner) !== stableDigest(binding.owner)) {
      drift.push("work or attempt owner mismatch");
    }
    try {
      releaseExpected = readWorkspaceEvents(
        coordRoot,
        binding.provider.id,
        binding.binding_id,
      ).some((event) => event.event === "cleanup_pending" || event.event === "released");
    } catch (error) {
      drift.push(`provider events unreadable: ${(error as Error).message}`);
    }
  }

  const workspaceExists = existsSync(binding.workspace_root);
  let rootMatch = false;
  let workspaceIdentity: FilesystemIdentity | undefined;
  let activeIdentity: FilesystemIdentity | undefined;
  let workspaceContained = false;
  let activeContained = false;
  try {
    const root = validateConfiguredRoot(binding.writable_root.configured);
    rootMatch =
      root.realpath === binding.writable_root.realpath &&
      sameFilesystemIdentity(root.identity, binding.writable_root.identity);
    if (workspaceExists) {
      const workspaceReal = assertContainedExisting(root, binding.workspace_root, "workspace root");
      workspaceContained = workspaceReal === binding.workspace_root;
      workspaceIdentity = filesystemIdentity(workspaceReal);
      if (!sameFilesystemIdentity(workspaceIdentity, binding.workspace_root_identity)) {
        drift.push("workspace root identity mismatch");
      }
    }
    if (existsSync(binding.active_root)) {
      const activeReal = assertContainedExisting(root, binding.active_root, "active root");
      activeContained = activeReal === binding.active_root;
      activeIdentity = filesystemIdentity(activeReal);
      if (!sameFilesystemIdentity(activeIdentity, binding.active_root_identity)) {
        drift.push("active workspace root identity mismatch");
      }
    }
  } catch (error) {
    drift.push((error as Error).message);
  }
  if (!rootMatch) drift.push("writable root identity mismatch");

  let repository: WorkspaceAttestation["repository"];
  const repositoryBinding = binding.repository;
  if (repositoryBinding) {
    const inspected = inspectBoundRepository(
      binding,
      frozenClaim,
      workspaceExists,
      releaseExpected,
    );
    repository = inspected.repository;
    drift.push(...inspected.drift);
  }

  const released =
    releaseExpected &&
    !workspaceExists &&
    (!repository ||
      (repositoryBinding !== undefined &&
        repository.source_root.realpath === repositoryBinding.source_root.realpath &&
        repository.source_root.identity !== undefined &&
        sameFilesystemIdentity(
          repository.source_root.identity,
          repositoryBinding.source_root.identity,
        ) &&
        repository.common_dir?.realpath === repositoryBinding.common_dir.realpath &&
        sameFilesystemIdentity(
          repository.common_dir.identity,
          repositoryBinding.common_dir.identity,
        ) &&
        repository.active_gitdir === undefined &&
        !repository.worktree_registered &&
        repository.current_ref === undefined &&
        repository.workspace_ref_oid === undefined));
  if (repository && !released) {
    if (
      repositoryBinding === undefined ||
      repository.source_root.realpath !== repositoryBinding.source_root.realpath ||
      repository.source_root.identity === undefined ||
      !sameFilesystemIdentity(
        repository.source_root.identity,
        repositoryBinding.source_root.identity,
      )
    ) {
      drift.push("source repository identity mismatch");
    }
    if (
      repositoryBinding === undefined ||
      repository.common_dir?.realpath !== repositoryBinding.common_dir.realpath ||
      repository.common_dir === undefined ||
      !sameFilesystemIdentity(repository.common_dir.identity, repositoryBinding.common_dir.identity)
    ) {
      drift.push("Git common-dir identity mismatch");
    }
    if (
      repositoryBinding === undefined ||
      repository.active_gitdir?.realpath !== repositoryBinding.gitdir.realpath ||
      repository.active_gitdir === undefined ||
      !sameFilesystemIdentity(repository.active_gitdir.identity, repositoryBinding.gitdir.identity)
    ) {
      drift.push("Git worktree gitdir identity mismatch");
    }
    if (!repository.worktree_registered) drift.push("Git worktree registration mismatch");
    if (
      !repositoryBinding?.branch_created_by_provider ||
      repository.workspace_ref_oid === undefined
    ) {
      drift.push("workspace branch ownership mismatch");
    }
  }
  const status = drift.length === 0 ? "ok" : workspaceExists ? "blocked" : "lost";
  const resourceState =
    status === "blocked"
      ? "blocked"
      : status === "lost"
        ? "lost"
        : released
          ? "released"
          : "active";
  return {
    schema_version: 1,
    binding_id: binding.binding_id,
    workspace_id: binding.workspace_id,
    run_id: binding.run_id,
    owner: binding.owner,
    provider: binding.provider,
    recorded_at: new Date().toISOString(),
    containment: {
      writable_root: rootMatch,
      workspace_root: workspaceContained,
      active_root: activeContained,
      integration_root: binding.integration_root
        ? isAbsolute(binding.integration_root) &&
          repositoryBinding !== undefined &&
          binding.integration_root === repositoryBinding.source_root.realpath &&
          repository?.source_root.realpath === repositoryBinding.source_root.realpath &&
          repository.source_root.identity !== undefined &&
          sameFilesystemIdentity(
            repository.source_root.identity,
            repositoryBinding.source_root.identity,
          )
        : null,
    },
    filesystem: {
      root_identity_match: rootMatch,
      workspace_identity: workspaceIdentity,
      active_identity: activeIdentity,
    },
    provider_drift: drift,
    workspace_exists: workspaceExists,
    repository,
    resource_state: resourceState,
    unsupported,
    unknowns,
    status,
  };
}

async function cancel(
  coordRoot: string,
  binding: WorkspaceBinding,
): Promise<WorkspaceCancellationResult> {
  const claim = requiredClaim(coordRoot, binding);
  const release = acquireLease(
    coordRoot,
    workspaceLockPath(coordRoot, PROVIDER_ID, binding.binding_id),
    claim,
    "binding",
  );
  try {
    return cancelUnderLease(coordRoot, binding, claim);
  } finally {
    release();
  }
}

function cancelUnderLease(
  coordRoot: string,
  binding: WorkspaceBinding,
  claim: WorkspaceClaim,
): WorkspaceCancellationResult {
  const attestation = attestSync(coordRoot, binding);
  const base = {
    schema_version: 1 as const,
    binding_id: binding.binding_id,
    recorded_at: new Date().toISOString(),
    attestation,
  };
  if (attestation.status !== "ok")
    return { ...base, status: "blocked", reason: "reattachment failed" };
  if ((attestation.repository?.dirty_paths.length ?? 0) > 0) {
    appendWorkspaceEvent(coordRoot, claim, "preserved_dirty");
    return {
      ...base,
      status: "preserved_dirty",
      attestation: { ...attestation, resource_state: "preserved_dirty" },
      reason: "dirty workspace was preserved",
    };
  }
  const liveness = readWorkflowLiveness(coordRoot, binding.run_id);
  if (liveness !== "inactive") {
    return {
      ...base,
      status: "unsupported",
      reason:
        liveness === "active"
          ? "active execution has no proven cooperative cancellation"
          : "workflow liveness cannot be proved",
    };
  }
  appendWorkspaceEvent(coordRoot, claim, "cancellation_outcome", { status: "cancelled" });
  return { ...base, status: "cancelled" };
}

async function cleanup(
  coordRoot: string,
  binding: WorkspaceBinding,
  intent: WorkspaceCleanupIntent,
): Promise<WorkspaceCleanupResult> {
  if (intent.mode !== "normal") throw new Error("unsupported workspace cleanup mode");
  const claim = requiredClaim(coordRoot, binding);
  const releaseBinding = acquireLease(
    coordRoot,
    workspaceLockPath(coordRoot, PROVIDER_ID, binding.binding_id),
    claim,
    "binding",
  );
  try {
    const releaseRepository = acquireRepositoryLease(coordRoot, claim);
    try {
      return cleanupUnderLease(coordRoot, binding, claim, intent);
    } finally {
      releaseRepository();
    }
  } finally {
    releaseBinding();
  }
}

function cleanupUnderLease(
  coordRoot: string,
  binding: WorkspaceBinding,
  claim: WorkspaceClaim,
  intent: WorkspaceCleanupIntent,
): WorkspaceCleanupResult {
  const repository = binding.repository;
  if (
    !repository ||
    intent.schema_version !== 1 ||
    intent.run_id !== binding.run_id ||
    intent.operation_id !==
      `cleanup-${stableDigest({ binding: stableDigest(binding), mode: intent.mode }).slice(0, 24)}` ||
    intent.binding_id !== binding.binding_id ||
    intent.binding_sha256 !== stableDigest(binding) ||
    intent.expected.worktree_path !== binding.workspace_root ||
    stableDigest(intent.expected.gitdir) !== stableDigest(repository.gitdir) ||
    intent.expected.workspace_ref !== repository.workspace_ref ||
    intent.expected.target_ref !== repository.target_ref
  ) {
    throw new Error("workspace cleanup intent does not match the immutable binding");
  }
  const before = attestSync(coordRoot, binding);
  const base = {
    schema_version: 1 as const,
    binding_id: binding.binding_id,
    recorded_at: new Date().toISOString(),
    branch_deleted: false,
    attestation: before,
  };
  if (before.resource_state === "released") {
    if (
      !readWorkspaceEvents(coordRoot, PROVIDER_ID, binding.binding_id).some(
        (event) => event.event === "released",
      )
    ) {
      appendWorkspaceEvent(coordRoot, claim, "released", {
        branch_deleted: true,
        attestation_sha256: stableDigest(before),
      });
    }
    return {
      ...base,
      status: "already_released",
      branch_deleted: true,
      attestation: before,
    };
  }
  const liveness = readWorkflowLiveness(coordRoot, binding.run_id);
  if (liveness !== "inactive") {
    return {
      ...base,
      status: "blocked",
      reason:
        liveness === "active"
          ? "live execution prevents cleanup"
          : "workflow liveness evidence is missing, corrupt, or ambiguous",
    };
  }
  if (before.workspace_exists && before.status !== "ok") {
    return { ...base, status: "blocked", reason: "ownership attestation failed" };
  }
  if (
    (before.repository?.dirty_paths.length ?? 0) > 0 ||
    (before.repository?.conflicts.length ?? 0) > 0 ||
    (before.repository?.operation_in_progress.length ?? 0) > 0
  ) {
    appendWorkspaceEvent(coordRoot, claim, "preserved_dirty");
    return {
      ...base,
      status: "preserved_dirty",
      attestation: { ...before, resource_state: "preserved_dirty" },
      reason: "dirty workspace was preserved",
    };
  }
  const root = validateConfiguredRoot(binding.writable_root.configured);
  assertPathIdentity(root.realpath, binding.writable_root.identity, "writable root");
  assertAllowedPathAuthority(
    claim.request.allowed_paths,
    binding.workspace_root,
    "workspace cleanup path",
  );
  assertAllowedPathAuthority(
    claim.request.allowed_paths,
    binding.active_root,
    "active workspace cleanup path",
  );
  assertAllowedPathAuthority(
    claim.request.allowed_paths,
    repository.source_root.realpath,
    "cleanup repository path",
  );
  assertAllowedPathAuthority(
    claim.request.allowed_paths,
    repository.common_dir.realpath,
    "cleanup Git common directory",
  );
  const sourceRef = gitMaybe(repository.source_root.realpath, [
    "rev-parse",
    "--verify",
    repository.workspace_ref,
  ]);
  if (!sourceRef.ok) {
    return { ...base, status: "blocked", reason: "provider workspace ref cannot be resolved" };
  }
  const targetRef = gitMaybe(repository.source_root.realpath, [
    "rev-parse",
    "--verify",
    repository.target_ref,
  ]);
  if (!targetRef.ok) {
    return { ...base, status: "blocked", reason: "cleanup target ref cannot be resolved" };
  }
  if (sourceRef.out !== intent.expected.workspace_ref_oid) {
    return { ...base, status: "blocked", reason: "workspace ref changed from the frozen intent" };
  }
  if (
    sourceRef.out !== repository.base_commit &&
    !isAncestor(repository.source_root.realpath, sourceRef.out, targetRef.out)
  ) {
    return {
      ...base,
      status: "preserved_dirty",
      attestation: { ...before, resource_state: "preserved_dirty" },
      reason: "workspace branch is neither unchanged nor reachable from the current target",
    };
  }

  const inventoryBefore = worktreeInventory(repository.source_root.realpath);
  const registered = inventoryBefore.find((item) => resolve(item.path) === binding.workspace_root);
  if (registered && registered.ref !== repository.workspace_ref) {
    return { ...base, status: "blocked", reason: "workspace path registration changed" };
  }
  if (!before.workspace_exists && registered) {
    return {
      ...base,
      status: "blocked",
      reason: "missing worktree still has ambiguous Git registration",
    };
  }

  appendWorkspaceEvent(coordRoot, claim, "cleanup_pending", {
    worktree_path: binding.workspace_root,
    gitdir: repository.gitdir,
    workspace_ref: repository.workspace_ref,
    workspace_ref_oid: intent.expected.workspace_ref_oid,
    target_ref: repository.target_ref,
    target_ref_oid: targetRef.out,
  });
  if (before.workspace_exists) {
    revalidateClaimResources(claim, root);
    assertContainedExisting(root, binding.workspace_root, "workspace cleanup path");
    git(repository.source_root.realpath, ["worktree", "remove", binding.workspace_root]);
  }
  const inventoryAfter = worktreeInventory(repository.source_root.realpath);
  if (
    existsSync(binding.workspace_root) ||
    inventoryAfter.some(
      (item) =>
        resolve(item.path) === binding.workspace_root || item.ref === repository.workspace_ref,
    )
  ) {
    return { ...base, status: "partial", reason: "exact worktree removal is incomplete" };
  }

  const currentSourceRef = gitMaybe(repository.source_root.realpath, [
    "rev-parse",
    "--verify",
    repository.workspace_ref,
  ]);
  if (currentSourceRef.ok) {
    if (currentSourceRef.out !== intent.expected.workspace_ref_oid) {
      return { ...base, status: "blocked", reason: "workspace ref changed during cleanup" };
    }
    revalidateClaimResources(claim, root);
    const deleted = gitMaybe(repository.source_root.realpath, [
      "update-ref",
      "-d",
      repository.workspace_ref,
      intent.expected.workspace_ref_oid,
    ]);
    if (!deleted.ok) {
      return { ...base, status: "partial", reason: "workspace ref deletion must be retried" };
    }
  }
  if (
    gitMaybe(repository.source_root.realpath, ["rev-parse", "--verify", repository.workspace_ref])
      .ok
  ) {
    return { ...base, status: "partial", reason: "provider workspace ref remains after cleanup" };
  }
  const after = attestSync(coordRoot, binding);
  if (
    after.status !== "ok" ||
    after.provider_drift.length > 0 ||
    after.resource_state !== "released" ||
    after.workspace_exists
  ) {
    return {
      ...base,
      status: "partial",
      reason: "resource absence could not be reattested",
      attestation: after,
    };
  }
  appendWorkspaceEvent(coordRoot, claim, "released", {
    branch_deleted: true,
    attestation_sha256: stableDigest(after),
  });
  return {
    ...base,
    status: "released",
    branch_deleted: true,
    attestation: after,
  };
}

async function previewIntegration(
  coordRoot: string,
  input: ProviderIntegrationInput,
): Promise<ProviderIntegrationPreview> {
  if (
    input.schema_version !== 1 ||
    input.run_id !== input.binding.run_id ||
    input.binding_sha256 !== stableDigest(input.binding) ||
    input.terminal_attestation_sha256 !== stableDigest(input.terminal_attestation) ||
    !isWorkspaceAttestation(input.terminal_attestation, input.binding)
  ) {
    throw new Error("provider integration input is corrupt or mismatched");
  }
  const sourceAttestation = await reattach(coordRoot, input.binding);
  return previewIntegrationWithAttestation(input, sourceAttestation);
}

function previewIntegrationWithAttestation(
  input: ProviderIntegrationInput,
  sourceAttestation: WorkspaceAttestation,
): ProviderIntegrationPreview {
  const binding = input.binding;
  const blocked: ProviderUnsupportedReason[] = [];
  if ((sourceAttestation.repository?.dirty_paths.length ?? 0) > 0) {
    blocked.push(reason("source_dirty", "workspace source has uncommitted changes"));
  }
  if ((sourceAttestation.repository?.operation_in_progress.length ?? 0) > 0) {
    blocked.push(
      reason("source_operation_in_progress", "workspace source has a Git operation in progress"),
    );
  }
  const targetRoot = realpathSync(resolve(input.target.root));
  const targetRepo = inspectIntegrationTarget(targetRoot, binding);
  const targetRef = input.target.ref ?? targetRepo.targetRef;
  if (targetRef !== targetRepo.targetRef) {
    blocked.push(reason("target_ref_mismatch", "integration target ref is not checked out"));
  }
  const sourceCommit = git(binding.active_root, ["rev-parse", "HEAD"]);
  const verifiedCommit = input.terminal_attestation.repository?.head_commit;
  if (!verifiedCommit || sourceCommit !== verifiedCommit) {
    blocked.push(
      reason("source_commit_unverified", "workspace source commit does not match terminal proof"),
    );
  }
  const targetCommit = targetRepo.head;
  const sourceTree = git(binding.active_root, ["rev-parse", `${sourceCommit}^{tree}`]);
  const targetTree = git(targetRoot, ["rev-parse", `${targetCommit}^{tree}`]);
  const changedPaths = nulEntries(
    git(targetRoot, ["diff", "--name-only", "-z", `${targetCommit}..${sourceCommit}`]),
  );
  const targetDirty = nulEntries(
    git(targetRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  if (targetDirty.length > 0)
    blocked.push(reason("target_dirty", "integration target is not clean"));
  const operations = gitOperations(targetRoot);
  if (operations.length > 0) {
    blocked.push(
      reason("target_operation_in_progress", `Git operation in progress: ${operations.join(", ")}`),
    );
  }
  if (!isAncestor(targetRoot, targetCommit, sourceCommit)) {
    blocked.push(reason("divergent_history", "integration is not a fast-forward"));
  }
  const overwriteRisks = overwriteRiskPaths(targetRoot, changedPaths);
  if (overwriteRisks.length > 0) {
    blocked.push(
      reason(
        "untracked_overwrite",
        `untracked or ignored paths would be overwritten: ${overwriteRisks.join(", ")}`,
      ),
    );
  }
  return {
    schema_version: 1,
    provider_id: PROVIDER_ID,
    binding_id: binding.binding_id,
    operation: "fast_forward",
    target_root: targetRoot,
    target_ref: targetRef,
    target_commit: targetCommit,
    target_tree: targetTree,
    source_commit: sourceCommit,
    source_tree: sourceTree,
    changed_paths: changedPaths,
    blocked,
    unknowns: [],
    prepared_at: new Date().toISOString(),
  };
}

async function applyAuthorizedIntegration(
  coordRoot: string,
  input: AuthorizedProviderIntegrationInput,
): Promise<ProviderIntegrationResult> {
  const claim = requiredClaim(coordRoot, input.binding);
  const releaseBinding = acquireLease(
    coordRoot,
    workspaceLockPath(coordRoot, PROVIDER_ID, claim.binding_id),
    claim,
    "binding",
  );
  try {
    const releaseRepository = acquireRepositoryLease(coordRoot, claim);
    try {
      return await applyIntegrationUnderLease(coordRoot, input);
    } finally {
      releaseRepository();
    }
  } finally {
    releaseBinding();
  }
}

async function applyIntegrationUnderLease(
  coordRoot: string,
  input: AuthorizedProviderIntegrationInput,
): Promise<ProviderIntegrationResult> {
  const plan = readWorkflowSupplement<IntegrationPlan>(
    coordRoot,
    input.run_id,
    "integration/plan.json",
  );
  const authorization = readWorkflowSupplement<IntegrationAuthorization>(
    coordRoot,
    input.run_id,
    "integration/authorization.json",
  );
  if (
    input.schema_version !== 1 ||
    !plan ||
    !authorization ||
    stableDigest(plan) !== input.plan_sha256 ||
    stableDigest(authorization) !== input.authorization_sha256 ||
    authorization.plan_sha256 !== input.plan_sha256 ||
    authorization.decision.verdict !== "allow" ||
    input.run_id !== plan.run_id ||
    input.plan_id !== plan.plan_id ||
    input.binding_sha256 !== plan.binding_sha256 ||
    input.proof_sha256 !== plan.proof_sha256 ||
    input.terminal_attestation_sha256 !== plan.terminal_attestation_sha256 ||
    input.review_sha256 !== plan.review_sha256 ||
    stableDigest(input.accepted_unknowns) !== stableDigest(plan.accepted_unknowns) ||
    stableDigest(input.preview) !== stableDigest(plan.provider_preview) ||
    stableDigest(input.binding) !== stableDigest(plan.binding)
  ) {
    throw new Error("authorized integration plan is corrupt or denied");
  }
  const claim = requiredClaim(coordRoot, plan.binding);
  const sourceAttestation = reattachUnderLease(coordRoot, plan.binding, claim);
  const proofPath = join(coordRoot, ".harnery", "workflows", plan.run_id, "proof.json");
  if (!existsSync(proofPath)) throw new Error("workflow proof disappeared before integration");
  if (fileSha256(proofPath) !== plan.proof_sha256) {
    throw new Error("workflow proof bytes changed before integration");
  }
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as {
    execution?: { terminal_attestation?: WorkspaceAttestation };
  };
  const terminalAttestation = proof.execution?.terminal_attestation;
  if (
    !terminalAttestation ||
    !isWorkspaceAttestation(terminalAttestation, plan.binding) ||
    stableDigest(terminalAttestation) !== plan.terminal_attestation_sha256
  ) {
    throw new Error("workflow terminal attestation changed before integration");
  }
  const current = previewIntegrationWithAttestation(
    {
      schema_version: 1,
      run_id: plan.run_id,
      binding: plan.binding,
      binding_sha256: plan.binding_sha256,
      proof_sha256: plan.proof_sha256,
      terminal_attestation: terminalAttestation,
      terminal_attestation_sha256: plan.terminal_attestation_sha256,
      review_sha256: plan.review_sha256,
      accepted_unknowns: plan.accepted_unknowns,
      target: {
        root: plan.provider_preview.target_root,
        ref: plan.provider_preview.target_ref,
      },
    },
    sourceAttestation,
  );
  const expected = plan.provider_preview;
  if (
    current.provider_id !== expected.provider_id ||
    current.binding_id !== expected.binding_id ||
    current.target_root !== expected.target_root ||
    current.target_ref !== expected.target_ref ||
    current.source_commit !== expected.source_commit ||
    current.source_tree !== expected.source_tree
  ) {
    throw new Error("integration source, provider, or target identity drifted");
  }
  const targetHead = current.target_commit;
  if (current.blocked.length > 0) {
    throw new Error(
      `integration target is no longer authorized: ${current.blocked
        .map((item) => item.message)
        .join("; ")}`,
    );
  }
  if (targetHead === expected.source_commit) {
    return providerApplyResult(plan.plan_id, plan.binding.binding_id, "already_applied", current);
  }
  if (targetHead !== expected.target_commit || current.target_tree !== expected.target_tree) {
    throw new Error(
      `integration target is no longer authorized: ${
        current.blocked.map((item) => item.message).join("; ") || "target drift"
      }`,
    );
  }
  revalidateClaimResources(claim, validateConfiguredRoot(plan.binding.writable_root.configured));
  inspectIntegrationTarget(current.target_root, plan.binding);
  git(current.target_root, ["merge", "--ff-only", expected.source_commit]);
  const finalCommit = git(current.target_root, ["rev-parse", "HEAD"]);
  const finalTree = git(current.target_root, ["rev-parse", "HEAD^{tree}"]);
  if (finalCommit !== expected.source_commit || finalTree !== expected.source_tree) {
    throw new Error("fast-forward result does not match the authorized source");
  }
  return {
    schema_version: 1,
    binding_id: plan.binding.binding_id,
    plan_id: plan.plan_id,
    status: "applied",
    target_commit: finalCommit,
    target_tree: finalTree,
    applied_at: new Date().toISOString(),
  };
}

function providerApplyResult(
  planId: string,
  bindingId: string,
  status: "already_applied",
  preview: ProviderIntegrationPreview,
): ProviderIntegrationResult {
  return {
    schema_version: 1,
    binding_id: bindingId,
    plan_id: planId,
    status,
    target_commit: preview.target_commit,
    target_tree: preview.target_tree,
    applied_at: new Date().toISOString(),
  };
}

function bindingFromClaim(claim: WorkspaceClaim): WorkspaceBinding {
  const gitdir = git(claim.workspace_root, ["rev-parse", "--git-dir"]);
  const gitdirReal = realpathSync(resolve(claim.workspace_root, gitdir));
  const repository: GitRepositoryBinding = {
    source_root: claim.repository.source_root,
    common_dir: claim.repository.common_dir,
    base_commit: claim.repository.base_commit,
    target_commit: claim.repository.target_commit,
    target_ref: claim.repository.target_ref,
    workspace_ref: claim.repository.workspace_ref,
    workspace_branch: claim.repository.workspace_branch,
    gitdir: { realpath: gitdirReal, identity: filesystemIdentity(gitdirReal) },
    branch_created_by_provider: true,
  };
  return {
    schema_version: 1,
    binding_id: claim.binding_id,
    workspace_id: claim.workspace_id,
    run_id: claim.request.run_id,
    owner: claim.request.owner,
    provider: {
      id: claim.provider_id,
      version: claim.provider_version,
      capability_digest: claim.request.capability_digest,
    },
    isolation: claim.request.requested_isolation,
    network_access: claim.request.network_access,
    workspace_root: claim.workspace_root,
    workspace_root_identity: filesystemIdentity(claim.workspace_root),
    active_root: claim.active_root,
    active_root_identity: filesystemIdentity(claim.active_root),
    integration_root: claim.repository.source_root.realpath,
    writable_root: claim.writable_root,
    repository,
    generation: 1,
    recovery_token: claim.recovery_token,
    request_sha256: claim.request_sha256,
    created_at: claim.created_at,
  };
}

function inspectSourceRepository(cwd: string): {
  sourceRoot: { configured: string; realpath: string; identity: FilesystemIdentity };
  commonDir: { realpath: string; identity: FilesystemIdentity };
  head: string;
  targetRef: string;
  requestedRelativePath: string;
} {
  if (!isAbsolute(cwd) || !existsSync(cwd)) {
    throw new Error("requested repository must exist at an absolute path");
  }
  const requestedCwd = validateConfiguredRoot(cwd);
  const bare = git(cwd, ["rev-parse", "--is-bare-repository"]);
  if (bare !== "false") throw new Error("bare repositories are unsupported");
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error("requested path is not inside a Git worktree");
  }
  const sourceRoot = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
  if (!containsPath(sourceRoot, requestedCwd.realpath)) {
    throw new Error("requested working directory is outside the resolved Git worktree");
  }
  if (lstatSync(join(sourceRoot, ".git")).isSymbolicLink()) {
    throw new Error("symlink Git directories are unsupported");
  }
  if (!lstatSync(join(sourceRoot, ".git")).isDirectory()) {
    throw new Error("linked worktree and submodule source repositories are unsupported");
  }
  const requestedGitDir = realpathSync(join(sourceRoot, ".git"));
  const gitDir = realpathSync(resolve(sourceRoot, git(sourceRoot, ["rev-parse", "--git-dir"])));
  const commonDir = realpathSync(
    resolve(sourceRoot, git(sourceRoot, ["rev-parse", "--git-common-dir"])),
  );
  if (gitDir !== requestedGitDir || commonDir !== requestedGitDir) {
    throw new Error("resolved Git authority does not match the requested checkout");
  }
  const branch = gitMaybe(sourceRoot, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (!branch.ok || !branch.out) throw new Error("detached integration targets are unsupported");
  const targetRef = `refs/heads/${branch.out}`;
  if (!REF_FORMAT.test(targetRef)) throw new Error("target branch ref has unsupported syntax");
  const head = git(sourceRoot, ["rev-parse", "HEAD"]);
  if (!OBJECT_FORMAT.test(head))
    throw new Error("repository HEAD has an unsupported object format");
  return {
    sourceRoot: {
      configured: sourceRoot,
      realpath: sourceRoot,
      identity: filesystemIdentity(sourceRoot),
    },
    commonDir: { realpath: commonDir, identity: filesystemIdentity(commonDir) },
    head,
    targetRef,
    requestedRelativePath: relative(sourceRoot, requestedCwd.realpath),
  };
}

function inspectFrozenSourceAuthority(
  sourceRoot: GitRepositoryBinding["source_root"],
  commonDir: GitRepositoryBinding["common_dir"],
  targetRef: string,
): ReturnType<typeof inspectSourceRepository> {
  const configured = validateConfiguredRoot(sourceRoot.configured);
  if (
    configured.realpath !== sourceRoot.realpath ||
    !sameFilesystemIdentity(configured.identity, sourceRoot.identity)
  ) {
    throw new Error("configured source repository identity changed");
  }
  assertPathIdentity(sourceRoot.realpath, sourceRoot.identity, "source repository");
  assertPathIdentity(commonDir.realpath, commonDir.identity, "Git common dir");
  const current = inspectSourceRepository(sourceRoot.configured);
  if (
    current.sourceRoot.realpath !== sourceRoot.realpath ||
    !sameFilesystemIdentity(current.sourceRoot.identity, sourceRoot.identity)
  ) {
    throw new Error("configured checkout no longer resolves to the frozen source repository");
  }
  if (
    current.commonDir.realpath !== commonDir.realpath ||
    !sameFilesystemIdentity(current.commonDir.identity, commonDir.identity)
  ) {
    throw new Error("configured checkout no longer resolves to the frozen Git common dir");
  }
  if (current.targetRef !== targetRef) {
    throw new Error("configured checkout no longer owns the frozen target ref");
  }
  return current;
}

function inspectBoundRepository(
  binding: WorkspaceBinding,
  claim: WorkspaceClaim,
  workspaceExists: boolean,
  releaseExpected: boolean,
): {
  repository: NonNullable<WorkspaceAttestation["repository"]>;
  drift: string[];
} {
  const repositoryBinding = binding.repository;
  if (!repositoryBinding) {
    throw new Error("local Git workspace binding is missing repository authority");
  }
  const drift: string[] = [];
  let sourceRootMatch = false;
  let commonDirMatch = false;
  let gitdirMatch = false;
  let worktreeRegistered = false;
  let sourceRootObservation: NonNullable<WorkspaceAttestation["repository"]>["source_root"] = {
    configured: repositoryBinding.source_root.configured,
  };
  let commonDirObservation: NonNullable<WorkspaceAttestation["repository"]>["common_dir"];
  let activeGitdirObservation: NonNullable<WorkspaceAttestation["repository"]>["active_gitdir"];
  let currentRef: string | undefined;
  let workspaceRefOid: string | undefined;
  let targetRefOid: string | undefined;
  let headCommit: string | undefined;
  let baseIsAncestor: boolean | null = null;
  let targetIsAncestor: boolean | null = null;
  let dirtyPaths: string[] = [];
  let conflicts: string[] = [];
  let operationInProgress: string[] = [];

  if (
    stableDigest(claim.repository.source_root) !== stableDigest(repositoryBinding.source_root) ||
    stableDigest(claim.repository.common_dir) !== stableDigest(repositoryBinding.common_dir)
  ) {
    drift.push("claim and binding repository authority differ");
  } else {
    try {
      const configured = validateConfiguredRoot(repositoryBinding.source_root.configured);
      sourceRootObservation = {
        configured: configured.configured,
        realpath: configured.realpath,
        identity: configured.identity,
      };
      sourceRootMatch =
        configured.realpath === repositoryBinding.source_root.realpath &&
        sameFilesystemIdentity(configured.identity, repositoryBinding.source_root.identity);
    } catch {
      sourceRootMatch = false;
    }
    try {
      const currentCommonRealpath = realpathSync(repositoryBinding.common_dir.realpath);
      const currentCommonIdentity = filesystemIdentity(currentCommonRealpath);
      commonDirObservation = {
        realpath: currentCommonRealpath,
        identity: currentCommonIdentity,
      };
      commonDirMatch =
        currentCommonRealpath === repositoryBinding.common_dir.realpath &&
        sameFilesystemIdentity(currentCommonIdentity, repositoryBinding.common_dir.identity);
    } catch {
      commonDirMatch = false;
    }
  }

  let source: ReturnType<typeof inspectSourceRepository> | undefined;
  if (sourceRootMatch && commonDirMatch) {
    try {
      source = inspectFrozenSourceAuthority(
        repositoryBinding.source_root,
        repositoryBinding.common_dir,
        repositoryBinding.target_ref,
      );
    } catch (error) {
      drift.push(`repository authority inspection failed: ${(error as Error).message}`);
      sourceRootMatch = false;
    }
  }

  if (source) {
    const registered = gitMaybe(source.sourceRoot.realpath, ["worktree", "list", "--porcelain"]);
    if (!registered.ok) {
      drift.push("Git worktree inventory is unavailable");
    }
    const inventory = registered.ok ? parseWorktreeInventory(registered.out) : [];
    const entry = inventory.find((item) => resolve(item.path) === binding.workspace_root);
    worktreeRegistered = Boolean(entry && entry.ref === repositoryBinding.workspace_ref);
    const workspaceRef = gitMaybe(source.sourceRoot.realpath, [
      "rev-parse",
      "--verify",
      repositoryBinding.workspace_ref,
    ]);
    const targetRef = gitMaybe(source.sourceRoot.realpath, [
      "rev-parse",
      "--verify",
      repositoryBinding.target_ref,
    ]);
    workspaceRefOid = workspaceRef.ok ? workspaceRef.out : undefined;
    targetRefOid = targetRef.ok ? targetRef.out : undefined;
    if (!targetRef.ok) drift.push("frozen target ref cannot be resolved");

    if (workspaceExists) {
      try {
        const currentGitdirRealpath = realpathSync(repositoryBinding.gitdir.realpath);
        const currentGitdirIdentity = filesystemIdentity(currentGitdirRealpath);
        activeGitdirObservation = {
          realpath: currentGitdirRealpath,
          identity: currentGitdirIdentity,
        };
        gitdirMatch =
          currentGitdirRealpath === repositoryBinding.gitdir.realpath &&
          sameFilesystemIdentity(currentGitdirIdentity, repositoryBinding.gitdir.identity);
      } catch {
        gitdirMatch = false;
      }
      if (gitdirMatch) {
        try {
          const resolvedCommon = realpathSync(
            resolve(
              binding.workspace_root,
              git(binding.workspace_root, ["rev-parse", "--git-common-dir"]),
            ),
          );
          const resolvedGitdir = realpathSync(
            resolve(
              binding.workspace_root,
              git(binding.workspace_root, ["rev-parse", "--git-dir"]),
            ),
          );
          commonDirObservation = {
            realpath: resolvedCommon,
            identity: filesystemIdentity(resolvedCommon),
          };
          activeGitdirObservation = {
            realpath: resolvedGitdir,
            identity: filesystemIdentity(resolvedGitdir),
          };
          commonDirMatch =
            resolvedCommon === repositoryBinding.common_dir.realpath &&
            sameFilesystemIdentity(
              commonDirObservation.identity,
              repositoryBinding.common_dir.identity,
            );
          gitdirMatch =
            resolvedGitdir === repositoryBinding.gitdir.realpath &&
            sameFilesystemIdentity(
              activeGitdirObservation.identity,
              repositoryBinding.gitdir.identity,
            );
        } catch (error) {
          drift.push(`workspace repository inspection failed: ${(error as Error).message}`);
          gitdirMatch = false;
        }
      }
      if (gitdirMatch && commonDirMatch) {
        const resolvedCurrentRef = gitMaybe(binding.workspace_root, ["symbolic-ref", "-q", "HEAD"]);
        const head = gitMaybe(binding.workspace_root, ["rev-parse", "HEAD"]);
        const dirty = gitMaybe(binding.workspace_root, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        const unresolved = gitMaybe(binding.workspace_root, [
          "diff",
          "--name-only",
          "-z",
          "--diff-filter=U",
        ]);
        currentRef = resolvedCurrentRef.ok ? resolvedCurrentRef.out : undefined;
        headCommit = head.ok ? head.out : undefined;
        dirtyPaths = dirty.ok ? nulEntries(dirty.out) : [];
        conflicts = unresolved.ok ? nulEntries(unresolved.out) : [];
        operationInProgress = gitOperations(binding.workspace_root);
        baseIsAncestor = head.ok
          ? isAncestor(binding.workspace_root, repositoryBinding.base_commit, head.out)
          : null;
        targetIsAncestor = head.ok
          ? isAncestor(binding.workspace_root, repositoryBinding.target_commit, head.out)
          : null;
        if (!resolvedCurrentRef.ok) drift.push("workspace current ref cannot be resolved");
        if (!head.ok) drift.push("workspace HEAD cannot be resolved");
        if (!dirty.ok) drift.push("workspace dirty paths cannot be inspected");
        if (!unresolved.ok) drift.push("workspace conflicts cannot be inspected");
      }
    } else if (releaseExpected) {
      const foreignRegistration = inventory.some(
        (item) =>
          resolve(item.path) === binding.workspace_root ||
          item.ref === repositoryBinding.workspace_ref,
      );
      worktreeRegistered = foreignRegistration;
    }
  }

  if (!sourceRootMatch) drift.push("source repository identity mismatch");
  if (!commonDirMatch) drift.push("Git common-dir identity mismatch");
  if (workspaceExists && currentRef !== repositoryBinding.workspace_ref) {
    drift.push("workspace current ref does not match the frozen workspace ref");
  }
  if (workspaceExists && workspaceRefOid !== headCommit) {
    drift.push("workspace HEAD and provider ref are incoherent");
  }
  if (workspaceExists && baseIsAncestor !== true) {
    drift.push("workspace HEAD no longer descends from its frozen base");
  }
  if (workspaceExists && targetIsAncestor !== true) {
    drift.push("workspace HEAD no longer descends from its frozen target");
  }

  return {
    repository: {
      source_root: sourceRootObservation,
      common_dir: commonDirObservation,
      active_gitdir: activeGitdirObservation,
      worktree_registered: worktreeRegistered,
      current_ref: currentRef,
      workspace_ref_oid: workspaceRefOid,
      target_ref_oid: targetRefOid,
      head_commit: headCommit,
      base_is_ancestor: baseIsAncestor,
      target_is_ancestor: targetIsAncestor,
      dirty_paths: dirtyPaths,
      conflicts,
      operation_in_progress: operationInProgress,
    },
    drift,
  };
}

function inspectIntegrationTarget(
  targetRoot: string,
  binding: WorkspaceBinding,
): ReturnType<typeof inspectSourceRepository> {
  const target = inspectSourceRepository(targetRoot);
  if (
    !binding.repository ||
    target.sourceRoot.realpath !== binding.repository.source_root.realpath ||
    !sameFilesystemIdentity(target.sourceRoot.identity, binding.repository.source_root.identity) ||
    target.commonDir.realpath !== binding.repository.common_dir.realpath ||
    !sameFilesystemIdentity(target.commonDir.identity, binding.repository.common_dir.identity)
  ) {
    throw new Error("integration target repository identity does not match the binding");
  }
  if (resolve(target.sourceRoot.realpath) !== resolve(targetRoot)) {
    throw new Error("integration target must be the repository root");
  }
  return target;
}

function revalidateClaimResources(claim: WorkspaceClaim, root: ValidatedRoot): void {
  assertPathIdentity(root.realpath, claim.writable_root.identity, "writable root");
  assertPathIdentity(
    claim.repository.source_root.realpath,
    claim.repository.source_root.identity,
    "source repository",
  );
  assertPathIdentity(
    claim.repository.common_dir.realpath,
    claim.repository.common_dir.identity,
    "Git common dir",
  );
  inspectFrozenSourceAuthority(
    claim.repository.source_root,
    claim.repository.common_dir,
    claim.repository.target_ref,
  );
  if (!containsPath(root.realpath, claim.workspace_root)) {
    throw new Error("claimed workspace path escapes its writable root");
  }
  if (!containsPath(claim.workspace_root, claim.active_root)) {
    throw new Error("claimed active workspace path escapes its workspace root");
  }
  if (
    !containsPath(root.realpath, claim.repository.source_root.realpath) ||
    !containsPath(root.realpath, claim.repository.common_dir.realpath)
  ) {
    throw new Error("source repository authority escapes its writable root");
  }
}

function validateRequest(request: WorkspaceAllocationRequest): void {
  const { idempotency_key: idempotencyKey, ...requestWithoutKey } = request;
  if (
    request.schema_version !== 1 ||
    request.requested_isolation !== "worktree" ||
    !request.run_id ||
    !isAbsolute(request.requested_cwd) ||
    !Array.isArray(request.allowed_paths) ||
    request.allowed_paths.some((path) => !validFrozenFilesystemPath(path)) ||
    request.writable_roots.length === 0 ||
    request.writable_roots.some((path) => !validFrozenFilesystemPath(path)) ||
    stableDigest(request.selected_writable_root) !== stableDigest(request.writable_roots[0]) ||
    request.provider_id !== PROVIDER_ID ||
    !/^[a-f0-9]{64}$/.test(request.capability_digest) ||
    !/^[a-f0-9]{64}$/.test(idempotencyKey) ||
    idempotencyKey !== stableDigest(requestWithoutKey) ||
    !/^[a-f0-9]{64}$/.test(request.script.sha256) ||
    (request.owner.kind === "work_attempt" &&
      (!request.owner.work_item_id ||
        !Number.isSafeInteger(request.owner.attempt) ||
        request.owner.attempt < 1)) ||
    (request.owner.kind === "standalone" &&
      (request.owner.work_item_id !== null || request.owner.attempt !== null))
  ) {
    throw new Error("workspace allocation request is invalid");
  }
}

function validFrozenFilesystemPath(
  path: WorkspaceAllocationRequest["selected_writable_root"],
): boolean {
  return Boolean(
    path &&
      isAbsolute(path.configured) &&
      resolve(path.configured) === path.configured &&
      isAbsolute(path.realpath) &&
      resolve(path.realpath) === path.realpath &&
      typeof path.identity?.platform === "string" &&
      typeof path.identity.device === "string" &&
      typeof path.identity.inode === "string",
  );
}

function assertAllowedPathAuthority(
  allowedPaths: WorkspaceAllocationRequest["allowed_paths"],
  candidate: string,
  label: string,
): void {
  if (
    allowedPaths.length > 0 &&
    !allowedPaths.some((allowedPath) => {
      const current = validateConfiguredRoot(allowedPath.configured);
      return (
        current.realpath === allowedPath.realpath &&
        sameFilesystemIdentity(current.identity, allowedPath.identity) &&
        containsPath(allowedPath.realpath, candidate)
      );
    })
  ) {
    throw new Error(`${label} is outside frozen policy path authority`);
  }
}

function requiredClaim(coordRoot: string, binding: WorkspaceBinding): WorkspaceClaim {
  const claim = readWorkspaceClaim(coordRoot, binding.provider.id, binding.binding_id);
  if (!claim) throw new Error(`workspace ownership claim is missing`);
  const storedBinding = readWorkspaceBinding(coordRoot, binding.provider.id, binding.binding_id);
  if (!storedBinding) throw new Error("immutable workspace binding is missing");
  if (stableDigest(storedBinding) !== stableDigest(binding)) {
    throw new Error("supplied workspace binding does not match immutable provider binding");
  }
  if (
    claim.recovery_token !== binding.recovery_token ||
    stableDigest(claim.request) !== claim.request_sha256 ||
    claim.request_sha256 !== binding.request_sha256 ||
    claim.binding_id !== binding.binding_id ||
    claim.workspace_id !== binding.workspace_id ||
    claim.provider_id !== binding.provider.id ||
    claim.provider_version !== binding.provider.version ||
    claim.request.run_id !== binding.run_id ||
    stableDigest(claim.request.owner) !== stableDigest(binding.owner) ||
    claim.workspace_root !== binding.workspace_root ||
    claim.active_root !== binding.active_root ||
    stableDigest(claim.writable_root) !== stableDigest(binding.writable_root) ||
    stableDigest(claim.repository.source_root) !== stableDigest(binding.repository?.source_root) ||
    stableDigest(claim.repository.common_dir) !== stableDigest(binding.repository?.common_dir) ||
    claim.repository.base_commit !== binding.repository?.base_commit ||
    claim.repository.target_commit !== binding.repository?.target_commit ||
    claim.repository.target_ref !== binding.repository?.target_ref ||
    claim.repository.workspace_ref !== binding.repository?.workspace_ref ||
    claim.repository.workspace_branch !== binding.repository?.workspace_branch
  ) {
    throw new Error("workspace ownership claim does not match the binding");
  }
  return claim;
}

function sameDeterministicClaim(actual: WorkspaceClaim, expected: WorkspaceClaim): boolean {
  const deterministic = (claim: WorkspaceClaim) => ({
    schema_version: claim.schema_version,
    provider_id: claim.provider_id,
    provider_version: claim.provider_version,
    binding_id: claim.binding_id,
    workspace_id: claim.workspace_id,
    request: claim.request,
    request_sha256: claim.request_sha256,
    workspace_root: claim.workspace_root,
    active_root: claim.active_root,
    writable_root: claim.writable_root,
    repository: claim.repository,
  });
  return (
    /^[a-f0-9]{64}$/.test(actual.recovery_token) &&
    Number.isFinite(Date.parse(actual.created_at)) &&
    stableDigest(deterministic(actual)) === stableDigest(deterministic(expected))
  );
}

function ensureInitialEvent(coordRoot: string, claim: WorkspaceClaim): void {
  if (readWorkspaceEvents(coordRoot, claim.provider_id, claim.binding_id).length === 0) {
    appendWorkspaceEvent(coordRoot, claim, "allocation_recorded", {
      claim: workspaceClaimPath(coordRoot, claim.provider_id, claim.binding_id),
    });
  }
}

function capabilityDigestForClaim(claim: WorkspaceClaim): string {
  const basis = {
    schema_version: 1 as const,
    provider_id: PROVIDER_ID,
    provider_version: PROVIDER_VERSION,
    isolation: ["worktree"] as const,
    reattach: "supported" as const,
    cancellation: "partial" as const,
    cleanup: "ownership_gated" as const,
    integration: ["fast_forward"] as const,
    network_attestation: "unknown" as const,
    filesystem_identity: "supported" as const,
  };
  void claim;
  return stableDigest(basis);
}

function acquireRepositoryLease(coordRoot: string, claim: WorkspaceClaim): () => void {
  const leaseDir = join(resolve(coordRoot), ".harnery", "workspaces", PROVIDER_ID, ".leases");
  mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
  const key = stableDigest({
    common: claim.repository.common_dir.identity,
    root: claim.writable_root.identity,
  });
  return acquireLease(coordRoot, join(leaseDir, `repository-${key}.lock`), claim, "repository");
}

function acquireLease(
  coordRoot: string,
  path: string,
  claim: WorkspaceClaim,
  scope: string,
): () => void {
  const authoritySha256 = stableDigest({
    binding_id: claim.binding_id,
    request_sha256: claim.request_sha256,
    scope,
  });
  const lease = acquireNoClobberLease({
    path,
    scope,
    authoritySha256,
    staleAfterMs: LOCK_STALE_MS,
    metadata: {
      binding_id: claim.binding_id,
      request_sha256: claim.request_sha256,
    },
    validateStaleOwner: (owner) => {
      const bindingId = owner.metadata?.binding_id;
      const requestSha256 = owner.metadata?.request_sha256;
      if (!bindingId || !requestSha256) return false;
      if (bindingId === claim.binding_id && requestSha256 === claim.request_sha256) return true;
      if (scope !== "repository") return false;
      const priorClaim = readWorkspaceClaim(coordRoot, PROVIDER_ID, bindingId);
      return priorClaim?.request_sha256 === requestSha256;
    },
  });
  if (lease.recovered_owner) {
    appendWorkspaceEvent(coordRoot, claim, "stale_lock_recovered", {
      scope,
      prior_pid: lease.recovered_owner.pid,
      prior_host: lease.recovered_owner.host,
    });
  }
  return () => lease.release();
}

function reason(code: string, message: string): ProviderUnsupportedReason {
  return { code, message };
}

function supportedGitVersion(output: string): boolean {
  const match = /^git version (\d+)\.(\d+)/.exec(output);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 31);
}

function rollbackAllocationThroughDescriptor(
  coordRoot: string,
  claim: WorkspaceClaim,
  workspaceFd: number,
): void {
  gitMaybeWithDirectoryDescriptor(
    claim.repository.source_root.realpath,
    ["worktree", "remove", "--force", descriptorPath(workspaceFd)],
    workspaceFd,
  );
  const inventory = worktreeInventory(claim.repository.source_root.realpath);
  const registrationRemains = inventory.some(
    (item) =>
      resolve(item.path) === claim.workspace_root || item.ref === claim.repository.workspace_ref,
  );
  if (registrationRemains) {
    appendWorkspaceEvent(coordRoot, claim, "blocked", {
      reason: "allocation rollback could not prove registration absence",
    });
    throw new Error("allocation rollback could not prove exact worktree registration absence");
  }
  const currentRef = gitMaybe(claim.repository.source_root.realpath, [
    "rev-parse",
    "--verify",
    claim.repository.workspace_ref,
  ]);
  if (currentRef.ok) {
    if (currentRef.out !== claim.repository.base_commit) {
      throw new Error("allocation rollback found a changed workspace ref");
    }
    git(claim.repository.source_root.realpath, [
      "update-ref",
      "-d",
      claim.repository.workspace_ref,
      currentRef.out,
    ]);
  }
  if (
    gitMaybe(claim.repository.source_root.realpath, [
      "rev-parse",
      "--verify",
      claim.repository.workspace_ref,
    ]).ok
  ) {
    throw new Error("allocation rollback could not prove workspace ref absence");
  }
  appendWorkspaceEvent(coordRoot, claim, "allocation_rolled_back");
}
