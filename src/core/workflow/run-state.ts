import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RepoSnapshot } from "../context/index.ts";
import {
  type NormalizedPolicy,
  normalizePolicy,
  type PolicyIsolation,
  type PolicyNetworkAccess,
  policyDigest,
} from "../policy/index.ts";
import { assertWorkflowRunId, readWorkflowApproval } from "./approvals.ts";
import { isCanonicalWorkflowAttemptContext } from "./attempt-context.ts";
import { readJsonRecord, writeImmutableJson } from "./durable-record.ts";
import { normalizeWorkflowSpecialists } from "./specialists.ts";
import type {
  WorkflowAttemptContext,
  WorkflowSpecialistProfile,
  WorkflowWorkContext,
} from "./types.ts";
import { isCanonicalWorkflowWorkContext } from "./work-context.ts";
import type {
  WorkspaceAllocationRequest,
  WorkspaceBinding,
  WorkspaceUnsupportedExecutionEvidence,
} from "./workspaces/index.ts";
import {
  assertWorkspaceManifestAuthority,
  isWorkspaceBinding,
  isWorkspaceUnsupportedExecutionEvidence,
} from "./workspaces/validate.ts";

export const WORKFLOW_RUN_MANIFEST_SCHEMA_VERSION = 1 as const;

const MANIFEST_LIMIT_BYTES = 256 * 1024;
const FOREIGN_LEASE_STALE_MS = 24 * 60 * 60 * 1_000;

export interface WorkflowRunManifest {
  schema_version: typeof WORKFLOW_RUN_MANIFEST_SCHEMA_VERSION;
  run_id: string;
  work_item_id?: string;
  work_context?: WorkflowWorkContext;
  attempt_context?: WorkflowAttemptContext;
  name: string;
  started_at: string;
  script: { path: string; sha256: string };
  repository_before: RepoSnapshot;
  execution: {
    cwd: string;
    default_harness: string;
    max_agents: number;
    concurrency: number;
    subscription_only: boolean;
    allow_api_billing: boolean;
    approval_mode: "deny" | "park";
    approval_addressee: string;
    isolation: PolicyIsolation;
    network_access: PolicyNetworkAccess;
    policy?: NormalizedPolicy;
    specialists?: Record<string, WorkflowSpecialistProfile>;
    workspace_binding?: WorkspaceBinding;
    workspace_fallback?: WorkspaceUnsupportedExecutionEvidence;
  };
}

export interface WriteWorkflowRunManifestInput {
  coordRoot: string;
  manifest: WorkflowRunManifest;
}

export function workflowScriptDigest(scriptPath: string): string {
  return createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
}

export function writeWorkflowRunManifest(input: WriteWorkflowRunManifestInput): string {
  assertWorkflowRunId(input.manifest.run_id);
  assertWorkspaceManifestAuthority(
    input.manifest,
    readManifestWorkspaceRequest(input.coordRoot, input.manifest.run_id),
  );
  const path = workflowRunManifestPath(input.coordRoot, input.manifest.run_id);
  if (existsSync(path))
    throw new Error(`workflow run ${input.manifest.run_id} already has a manifest`);
  const body = `${JSON.stringify(input.manifest, null, 2)}\n`;
  if (Buffer.byteLength(body) > MANIFEST_LIMIT_BYTES) {
    throw new Error(`workflow run manifest exceeds ${MANIFEST_LIMIT_BYTES} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeImmutableJson(path, input.manifest);
  return path;
}

export function readWorkflowRunManifest(coordRoot: string, runId: string): WorkflowRunManifest {
  assertWorkflowRunId(runId);
  const path = workflowRunManifestPath(coordRoot, runId);
  if (!existsSync(path)) throw new Error(`workflow run ${runId} has no resume manifest at ${path}`);
  const bytes = statSync(path).size;
  if (bytes <= 0 || bytes > MANIFEST_LIMIT_BYTES) {
    throw new Error(`workflow run manifest at ${path} has invalid size ${bytes}`);
  }
  let manifest: WorkflowRunManifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as WorkflowRunManifest;
  } catch (error) {
    throw new Error(`cannot parse workflow run manifest at ${path}: ${(error as Error).message}`);
  }
  if (
    manifest.schema_version !== WORKFLOW_RUN_MANIFEST_SCHEMA_VERSION ||
    manifest.run_id !== runId ||
    (manifest.work_item_id !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(manifest.work_item_id)) ||
    (manifest.work_context !== undefined &&
      (!manifest.work_item_id ||
        manifest.work_context.id !== manifest.work_item_id ||
        !isCanonicalWorkflowWorkContext(manifest.work_context))) ||
    (manifest.attempt_context !== undefined &&
      (!manifest.work_item_id ||
        !manifest.work_context ||
        !isCanonicalWorkflowAttemptContext(manifest.attempt_context))) ||
    typeof manifest.name !== "string" ||
    manifest.name.length === 0 ||
    manifest.name.length > 200 ||
    !validTimestamp(manifest.started_at) ||
    !manifest.script?.path ||
    !isAbsolute(manifest.script.path) ||
    !/^[a-f0-9]{64}$/.test(manifest.script.sha256) ||
    !validRepoSnapshot(manifest.repository_before) ||
    !validExecution(manifest.execution)
  ) {
    throw new Error(`workflow run manifest at ${path} has an unsupported or mismatched schema`);
  }
  assertWorkspaceManifestAuthority(manifest, readManifestWorkspaceRequest(coordRoot, runId));
  return manifest;
}

export function assertWorkflowRunResumable(
  coordRoot: string,
  runId: string,
): { manifest: WorkflowRunManifest; approvalId: string } {
  const manifest = readWorkflowRunManifest(coordRoot, runId);
  const journalPath = join(coordRoot, ".harnery", "workflows", runId, "journal.jsonl");
  if (!existsSync(journalPath)) throw new Error(`workflow run ${runId} has no journal`);
  let approvalId: string | undefined;
  let terminal = false;
  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { event?: string; approval_id?: string };
      if (event.event === "run.parked" && typeof event.approval_id === "string") {
        approvalId = event.approval_id;
      }
      if (event.event === "run.end") terminal = true;
    } catch {
      throw new Error(`workflow run ${runId} has a malformed journal line`);
    }
  }
  if (terminal) throw new Error(`workflow run ${runId} is already terminal`);
  if (!approvalId) throw new Error(`workflow run ${runId} is not parked on an approval`);
  const approval = readWorkflowApproval(coordRoot, approvalId);
  if (approval.request.run_id !== runId) {
    throw new Error(`workflow run ${runId} has a mismatched parked approval`);
  }
  if (approval.status === "pending") {
    throw new Error(`workflow run ${runId} is still waiting on approval ${approvalId}`);
  }
  return { manifest, approvalId };
}

export function assertWorkflowScriptUnchanged(manifest: WorkflowRunManifest): void {
  const path = resolve(manifest.script.path);
  if (!existsSync(path)) throw new Error(`workflow script no longer exists at ${path}`);
  const actual = workflowScriptDigest(path);
  if (actual !== manifest.script.sha256) {
    throw new Error(
      `workflow script changed since run ${manifest.run_id} parked; start a new run instead of reusing its approval`,
    );
  }
}

export function workflowRunManifestPath(coordRoot: string, runId: string): string {
  assertWorkflowRunId(runId);
  return join(coordRoot, ".harnery", "workflows", runId, "run.json");
}

/** Acquire an exclusive, crash-recoverable lease for one resume segment. */
export function acquireWorkflowResumeLease(coordRoot: string, runId: string): () => void {
  assertWorkflowRunId(runId);
  const path = join(coordRoot, ".harnery", "workflows", runId, "resume.lock");
  const owner = { pid: process.pid, host: hostname(), created_at: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });

  const acquire = (): boolean => {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      chmodSync(path, 0o600);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };

  if (!acquire()) {
    const existing = readResumeLease(path);
    if (existing && resumeLeaseIsLive(existing)) {
      throw new Error(
        `workflow run ${runId} is already being resumed by pid ${existing.pid} on ${existing.host}`,
      );
    }
    unlinkSync(path);
    if (!acquire())
      throw new Error(`workflow run ${runId} resume lease raced with another process`);
  }

  return () => {
    try {
      const existing = readResumeLease(path);
      if (existing?.pid === owner.pid && existing.host === owner.host) unlinkSync(path);
    } catch {
      // Best effort. A stale lease is recoverable on the next resume attempt.
    }
  };
}

function readResumeLease(path: string): { pid: number; host: string; created_at: string } | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.host === "string" &&
      typeof value.created_at === "string"
      ? { pid: value.pid, host: value.host, created_at: value.created_at }
      : null;
  } catch {
    return null;
  }
}

function resumeLeaseIsLive(lease: { pid: number; host: string; created_at: string }): boolean {
  if (lease.host !== hostname()) {
    const age = Date.now() - Date.parse(lease.created_at);
    return Number.isFinite(age) && age < FOREIGN_LEASE_STALE_MS;
  }
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function validExecution(value: WorkflowRunManifest["execution"]): boolean {
  if (!value || typeof value !== "object") return false;
  return (
    isAbsolute(value.cwd) &&
    typeof value.default_harness === "string" &&
    value.default_harness.length > 0 &&
    positiveSafeInteger(value.max_agents) &&
    positiveSafeInteger(value.concurrency) &&
    typeof value.subscription_only === "boolean" &&
    typeof value.allow_api_billing === "boolean" &&
    (value.approval_mode === "deny" || value.approval_mode === "park") &&
    typeof value.approval_addressee === "string" &&
    value.approval_addressee.length > 0 &&
    value.approval_addressee.length <= 200 &&
    ["shared", "worktree", "sandbox", "remote"].includes(value.isolation) &&
    ["enabled", "disabled", "unknown"].includes(value.network_access) &&
    validSpecialists(value.specialists) &&
    validFrozenPolicy(value.policy, value.workspace_binding?.integration_root ?? value.cwd) &&
    validWorkspaceBinding(value.workspace_binding) &&
    validWorkspaceFallback(value.workspace_fallback) &&
    !(value.workspace_binding && value.workspace_fallback) &&
    (value.workspace_fallback === undefined ||
      value.workspace_fallback.requested_isolation === value.isolation)
  );
}

function readManifestWorkspaceRequest(
  coordRoot: string,
  runId: string,
): WorkspaceAllocationRequest | undefined {
  const path = join(coordRoot, ".harnery", "workflows", runId, "workspace-request.json");
  return existsSync(path)
    ? readJsonRecord<WorkspaceAllocationRequest>(path, "workspace request")
    : undefined;
}

function validWorkspaceBinding(binding: WorkspaceBinding | undefined): boolean {
  return binding === undefined || isWorkspaceBinding(binding);
}

function validWorkspaceFallback(
  fallback: WorkspaceUnsupportedExecutionEvidence | undefined,
): boolean {
  return fallback === undefined || isWorkspaceUnsupportedExecutionEvidence(fallback);
}

function validSpecialists(
  specialists: Record<string, WorkflowSpecialistProfile> | undefined,
): boolean {
  if (specialists === undefined) return true;
  try {
    return (
      JSON.stringify(normalizeWorkflowSpecialists(specialists)) === JSON.stringify(specialists)
    );
  } catch {
    return false;
  }
}

function validFrozenPolicy(policy: NormalizedPolicy | undefined, cwd: string): boolean {
  if (policy === undefined) return true;
  try {
    const normalized = normalizePolicy(policy, { baseDir: cwd });
    return policyDigest(normalized) === policyDigest(policy);
  } catch {
    return false;
  }
}

function validRepoSnapshot(value: RepoSnapshot): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    isAbsolute(value.cwd) &&
    (value.root === undefined || isAbsolute(value.root)) &&
    (value.branch === undefined || typeof value.branch === "string") &&
    (value.head === undefined || typeof value.head === "string") &&
    Array.isArray(value.dirty_paths) &&
    value.dirty_paths.every((path) => typeof path === "string") &&
    (value.dirty_paths_truncated === undefined || typeof value.dirty_paths_truncated === "boolean")
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
