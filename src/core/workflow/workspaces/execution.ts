import { existsSync } from "node:fs";
import { type NormalizedPolicy, policyDigest } from "../../policy/index.ts";
import type { WorkflowRunManifest } from "../run-state.ts";
import type { EngineOpts, WorkflowAttemptContext, WorkflowWorkContext } from "../types.ts";
import { WorkspaceAttestationError, workspaceAttestationFromError } from "./attestation-error.ts";
import {
  assertContainedExisting,
  containsPath,
  filesystemIdentity,
  sameFilesystemIdentity,
  validateConfiguredRoot,
} from "./paths.ts";
import { appendWorkflowJournalEvent, stableDigest, writeWorkspaceRequest } from "./state.ts";
import type {
  WorkspaceAttestation,
  WorkspaceBinding,
  WorkspaceIsolation,
  WorkspaceProvider,
  WorkspaceUnsupportedExecutionEvidence,
} from "./types.ts";
import { isWorkspaceAttestation, isWorkspaceBinding } from "./validate.ts";

interface WorkspaceResumeState {
  manifest: WorkflowRunManifest;
}

export async function resolveWorkspaceBinding(input: {
  opts: EngineOpts;
  resumeState: WorkspaceResumeState | undefined;
  runId: string;
  cwd: string;
  isolation: string;
  absScript: string;
  scriptSha256: string;
  provider: WorkspaceProvider | undefined;
  workContext: Readonly<WorkflowWorkContext> | undefined;
  attemptContext: Readonly<WorkflowAttemptContext> | undefined;
  policy: NormalizedPolicy | undefined;
  onUnsupportedFallback?: (evidence: WorkspaceUnsupportedExecutionEvidence) => void;
}): Promise<WorkspaceBinding | undefined> {
  if (input.isolation === "shared") return undefined;
  if (
    input.isolation !== "worktree" &&
    input.isolation !== "sandbox" &&
    input.isolation !== "remote"
  ) {
    throw new Error(`unsupported workflow isolation ${JSON.stringify(input.isolation)}`);
  }
  if (input.resumeState && !input.resumeState.manifest.execution.workspace_binding) {
    return undefined;
  }
  const capability = input.isolation as WorkspaceIsolation;
  const provider = input.provider;
  if (!provider) {
    if (input.resumeState?.manifest.execution.workspace_binding) {
      throw new Error("isolated workflow resume requires the frozen workspace provider");
    }
    const fallback: WorkspaceUnsupportedExecutionEvidence = {
      schema_version: 1,
      run_id: input.runId,
      requested_isolation: capability,
      effective_isolation: "shared",
      selection_reason: "provider_not_configured",
      terminal_lifecycle_state: "shared",
      drift: [],
      unsupported: [
        {
          code: "provider_not_configured",
          message: "no workspace provider is configured; shared execution was selected",
        },
      ],
      unknowns: [],
      receipts: {},
    };
    appendWorkflowJournalEvent(input.opts.coordRoot, input.runId, "workspace.compatibility", {
      requested_isolation: fallback.requested_isolation,
      effective_isolation: fallback.effective_isolation,
      selection_reason: fallback.selection_reason,
      unsupported: fallback.unsupported,
    });
    input.onUnsupportedFallback?.(fallback);
    return undefined;
  }

  const frozenBinding = input.resumeState?.manifest.execution.workspace_binding;
  if (frozenBinding) {
    const roots = input.opts.workspace?.writableRoots;
    if (!roots || roots.length === 0) {
      throw new Error("isolated workflow resume requires explicit writable roots");
    }
    assertWorkspaceRootAuthority(frozenBinding, roots, input.policy?.allowed_paths ?? []);
    const probe = await provider.probe({
      requested_cwd: frozenBinding.repository?.source_root.configured ?? input.cwd,
      writable_roots: roots,
    });
    if (
      probe.capabilities.provider_id !== frozenBinding.provider.id ||
      probe.capabilities.provider_version !== frozenBinding.provider.version ||
      probe.capabilities.capability_digest !== frozenBinding.provider.capability_digest
    ) {
      throw new Error("parked workflow provider identity or capabilities drifted");
    }
    const providerBinding = await provider.readBinding(frozenBinding);
    if (JSON.stringify(providerBinding) !== JSON.stringify(frozenBinding)) {
      throw new Error("parked workflow binding differs from the immutable provider record");
    }
    const reattached = await provider.reattach(frozenBinding);
    if (!isWorkspaceAttestation(reattached, frozenBinding) || reattached.status !== "ok") {
      if (isWorkspaceAttestation(reattached, frozenBinding)) {
        throw new WorkspaceAttestationError(
          `workflow run ${input.runId} could not reattach its frozen workspace`,
          reattached,
        );
      }
      throw new Error(`workflow run ${input.runId} could not reattach its frozen workspace`);
    }
    appendWorkflowJournalEvent(input.opts.coordRoot, input.runId, "workspace.reattach", {
      binding_id: frozenBinding.binding_id,
      provider_id: frozenBinding.provider.id,
      attestation_sha256: stableDigest(reattached),
    });
    return frozenBinding;
  }

  const roots = input.opts.workspace?.writableRoots;
  if (roots?.length !== 1) {
    throw new Error("isolated workflow allocation requires one explicitly selected writable root");
  }
  const selectedRoot = validateConfiguredRoot(roots[0]!);
  const sourceRoot = validateConfiguredRoot(input.cwd);
  const allowedRoots = (input.policy?.allowed_paths ?? []).map((path) =>
    validateConfiguredRoot(path),
  );
  if (
    sourceRoot.configured !== input.cwd ||
    (allowedRoots.length > 0 &&
      !allowedRoots.some((path) => containsPath(path.realpath, sourceRoot.realpath)))
  ) {
    throw new Error("workflow source root is outside frozen path authority");
  }
  if (
    allowedRoots.length > 0 &&
    !allowedRoots.some((path) => containsPath(path.realpath, selectedRoot.realpath))
  ) {
    throw new Error("workspace writable root is outside frozen path authority");
  }
  const probe = await provider.probe({
    requested_cwd: input.cwd,
    writable_roots: [selectedRoot.configured],
  });
  if (
    !probe.supported ||
    probe.unsupported.length > 0 ||
    !probe.capabilities.isolation.includes(capability)
  ) {
    if (input.policy?.allowed_isolation?.includes("shared")) {
      const unsupported =
        probe.unsupported.length > 0
          ? [...probe.unsupported]
          : [
              {
                code: "isolation_unsupported",
                message: `provider does not support ${capability} isolation`,
              },
            ];
      const fallback: WorkspaceUnsupportedExecutionEvidence = {
        schema_version: 1,
        run_id: input.runId,
        requested_isolation: capability,
        effective_isolation: "shared",
        selection_reason: "provider_unsupported",
        provider: {
          id: probe.capabilities.provider_id,
          version: probe.capabilities.provider_version,
          capability_digest: probe.capabilities.capability_digest,
        },
        terminal_lifecycle_state: "shared",
        drift: [],
        unsupported,
        unknowns: [...probe.unknowns],
        receipts: {},
      };
      appendWorkflowJournalEvent(input.opts.coordRoot, input.runId, "workspace.fallback", {
        requested_isolation: fallback.requested_isolation,
        effective_isolation: fallback.effective_isolation,
        selection_reason: fallback.selection_reason,
        provider_id: fallback.provider?.id,
        unsupported: fallback.unsupported,
      });
      input.onUnsupportedFallback?.(fallback);
      return undefined;
    }
    throw new Error(
      `workspace provider ${probe.capabilities.provider_id} does not support ${capability}: ${
        probe.unsupported.map((item) => item.message).join("; ") || "unsupported capability"
      }`,
    );
  }
  if (input.opts.workItemId && !input.attemptContext) {
    throw new Error("isolated work-linked execution requires a frozen attempt identity");
  }
  const requestWithoutKey = {
    schema_version: 1 as const,
    run_id: input.runId,
    owner:
      input.opts.workItemId && input.attemptContext
        ? {
            kind: "work_attempt" as const,
            work_item_id: input.opts.workItemId,
            attempt: input.attemptContext.number,
          }
        : { kind: "standalone" as const, work_item_id: null, attempt: null },
    requested_cwd: input.cwd,
    requested_isolation: capability,
    network_access: input.opts.networkAccess ?? "unknown",
    script: { path: input.absScript, sha256: input.scriptSha256 },
    policy_sha256: input.policy ? policyDigest(input.policy) : null,
    allowed_paths: allowedRoots,
    writable_roots: [selectedRoot],
    selected_writable_root: selectedRoot,
    provider_id: probe.capabilities.provider_id,
    capability_digest: probe.capabilities.capability_digest,
  };
  const request = {
    ...requestWithoutKey,
    idempotency_key: stableDigest(requestWithoutKey),
  };
  writeWorkspaceRequest(input.opts.coordRoot, request);
  appendWorkflowJournalEvent(input.opts.coordRoot, input.runId, "execution.allocate.start", {
    provider_id: probe.capabilities.provider_id,
    request_sha256: stableDigest(request),
  });
  const binding = await provider.allocate(request);
  if (
    !isWorkspaceBinding(binding, input.runId) ||
    binding.request_sha256 !== stableDigest(request) ||
    stableDigest(binding.owner) !== stableDigest(request.owner) ||
    binding.provider.id !== probe.capabilities.provider_id ||
    binding.provider.version !== probe.capabilities.provider_version ||
    binding.provider.capability_digest !== probe.capabilities.capability_digest ||
    binding.isolation !== capability
  ) {
    throw new Error("workspace provider returned a binding that does not match the frozen request");
  }
  const providerBinding = await provider.readBinding(binding);
  if (JSON.stringify(providerBinding) !== JSON.stringify(binding)) {
    throw new Error("workspace provider returned bytes that differ from its immutable binding");
  }
  assertWorkspaceRootAuthority(
    binding,
    [selectedRoot.configured],
    input.policy?.allowed_paths ?? [],
  );
  const attestation = await provider.reattach(binding);
  if (!isWorkspaceAttestation(attestation, binding) || attestation.status !== "ok") {
    if (isWorkspaceAttestation(attestation, binding)) {
      throw new WorkspaceAttestationError(
        "workspace provider returned a binding that failed initial attestation",
        attestation,
      );
    }
    throw new Error("workspace provider returned a binding that failed initial attestation");
  }
  appendWorkflowJournalEvent(input.opts.coordRoot, input.runId, "execution.allocate.end", {
    binding_id: binding.binding_id,
    provider_id: binding.provider.id,
    active_root: binding.active_root,
    attestation_sha256: stableDigest(attestation),
  });
  return binding;
}

function assertWorkspaceRootAuthority(
  binding: WorkspaceBinding,
  configuredRoots: readonly string[],
  allowedPaths: readonly string[],
): void {
  const roots = configuredRoots.map((root) => validateConfiguredRoot(root));
  const authority = roots.find(
    (root) =>
      root.configured === binding.writable_root.configured &&
      root.realpath === binding.writable_root.realpath &&
      sameFilesystemIdentity(root.identity, binding.writable_root.identity),
  );
  if (!authority) {
    throw new Error("workspace provider binding is outside the explicit writable-root authority");
  }
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
    throw new Error("workspace provider binding is outside frozen policy path authority");
  }
  assertContainedExisting(authority, binding.workspace_root, "workspace root");
  assertContainedExisting(authority, binding.active_root, "active workspace root");
  if (
    !sameFilesystemIdentity(
      filesystemIdentity(binding.workspace_root),
      binding.workspace_root_identity,
    )
  ) {
    throw new Error("workspace root identity differs from the frozen binding");
  }
  if (
    !sameFilesystemIdentity(filesystemIdentity(binding.active_root), binding.active_root_identity)
  ) {
    throw new Error("active workspace root identity differs from the frozen binding");
  }
}

export async function attestTerminal(
  provider: WorkspaceProvider | undefined,
  binding: WorkspaceBinding,
): Promise<WorkspaceAttestation> {
  if (!provider) return failedWorkspaceAttestation(binding, "workspace provider is unavailable");
  try {
    const attestation = await provider.attest(binding);
    return isWorkspaceAttestation(attestation, binding)
      ? attestation
      : failedWorkspaceAttestation(binding, "workspace provider returned invalid attestation");
  } catch (error) {
    return (
      workspaceAttestationFromError(error, binding) ??
      failedWorkspaceAttestation(binding, errorMessage(error))
    );
  }
}

export async function attestWorkspaceFailure(
  provider: WorkspaceProvider | undefined,
  binding: WorkspaceBinding,
  error: unknown,
): Promise<WorkspaceAttestation> {
  const carried = workspaceAttestationFromError(error, binding);
  if (carried) return carried;
  const observed = await attestTerminal(provider, binding);
  if (observed.status !== "ok") return observed;
  return {
    ...observed,
    provider_drift: [...observed.provider_drift, errorMessage(error)],
    resource_state: observed.workspace_exists ? "blocked" : "lost",
    status: observed.workspace_exists ? "blocked" : "lost",
  };
}

function failedWorkspaceAttestation(
  binding: WorkspaceBinding,
  message: string,
): WorkspaceAttestation {
  const workspaceExists = existsSync(binding.workspace_root);
  let rootMatch = false;
  let workspaceContained = false;
  let activeContained = false;
  let workspaceIdentity: WorkspaceAttestation["filesystem"]["workspace_identity"];
  let activeIdentity: WorkspaceAttestation["filesystem"]["active_identity"];
  try {
    const root = validateConfiguredRoot(binding.writable_root.configured);
    rootMatch =
      root.realpath === binding.writable_root.realpath &&
      sameFilesystemIdentity(root.identity, binding.writable_root.identity);
    if (workspaceExists) {
      const workspaceReal = assertContainedExisting(root, binding.workspace_root, "workspace root");
      workspaceContained = workspaceReal === binding.workspace_root;
      workspaceIdentity = filesystemIdentity(workspaceReal);
    }
    if (existsSync(binding.active_root)) {
      const activeReal = assertContainedExisting(root, binding.active_root, "active root");
      activeContained = activeReal === binding.active_root;
      activeIdentity = filesystemIdentity(activeReal);
    }
  } catch {
    // Preserve the facts that could be observed before path validation failed.
  }
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
      integration_root: null,
    },
    filesystem: {
      root_identity_match: rootMatch,
      workspace_identity: workspaceIdentity,
      active_identity: activeIdentity,
    },
    provider_drift: [message],
    workspace_exists: workspaceExists,
    resource_state: workspaceExists ? "blocked" : "lost",
    unsupported: [],
    unknowns: [],
    status: workspaceExists ? "blocked" : "lost",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
