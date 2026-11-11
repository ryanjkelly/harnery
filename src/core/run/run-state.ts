import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RepoSnapshot } from "../context/index.ts";
import {
  type NormalizedPolicy,
  normalizePolicy,
  type PolicyNetworkAccess,
  policyDigest,
} from "../policy/index.ts";
import { writeImmutableJson } from "../storage/durable-record.ts";
import { assertWorkflowRunId, readWorkflowApproval } from "./approvals.ts";
import { normalizeWorkflowSpecialists } from "./specialists.ts";
import type { WorkflowSpecialistProfile } from "./types.ts";

export const WORKFLOW_RUN_MANIFEST_SCHEMA_VERSION = 2 as const;

const MANIFEST_LIMIT_BYTES = 256 * 1024;

/**
 * The frozen inputs of one run, written once before the first dispatch and read
 * back only to resume a parked run.
 *
 * Manifests written by earlier versions may also carry `work_item_id`,
 * `attempt_context`, and, under `execution`, `isolation`, `diagnostic_admission`,
 * `workspace_binding` and `workspace_fallback`. Those features are gone
 * (ADR 0238, ADR 0244). The reader ignores the fields, so such a manifest still
 * loads as history; a run that executed in an isolated workspace cannot be
 * resumed (see `assertWorkflowRunResumable`).
 */
export interface WorkflowRunManifest {
  schema_version: typeof WORKFLOW_RUN_MANIFEST_SCHEMA_VERSION;
  run_id: string;
  name: string;
  started_at: string;
  script: { path: string; sha256: string };
  repository_before: RepoSnapshot;
  execution: {
    cwd: string;
    default_adapter: string;
    max_agents: number;
    concurrency: number;
    subscription_only: boolean;
    allow_api_billing: boolean;
    approval_mode: "deny" | "park";
    approval_addressee: string;
    network_access: PolicyNetworkAccess;
    policy?: NormalizedPolicy;
    specialists?: Record<string, WorkflowSpecialistProfile>;
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
  if (manifest.repository_before.observation === undefined) {
    manifest.repository_before = {
      ...manifest.repository_before,
      observation: "unavailable",
      observation_detail: "No repository observation was recorded.",
    };
  }
  return manifest;
}

export function assertWorkflowRunResumable(
  coordRoot: string,
  runId: string,
): { manifest: WorkflowRunManifest; approvalId: string } {
  const manifest = readWorkflowRunManifest(coordRoot, runId);
  const isolation = executedOutsideSharedCheckout(manifest);
  if (isolation) {
    throw new Error(
      `workflow run ${runId} ran with ${isolation} isolation, which this version no longer supports; start a new run instead`,
    );
  }
  const transcriptPath = join(coordRoot, ".harnery", "workflows", runId, "transcript.jsonl");
  if (!existsSync(transcriptPath)) throw new Error(`workflow run ${runId} has no transcript`);
  let approvalId: string | undefined;
  let terminal = false;
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { event?: string; approval_id?: string };
      if (event.event === "run.parked" && typeof event.approval_id === "string") {
        approvalId = event.approval_id;
      }
      if (event.event === "run.end") terminal = true;
    } catch {
      throw new Error(`workflow run ${runId} has a malformed transcript line`);
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

function validExecution(value: WorkflowRunManifest["execution"]): boolean {
  if (!value || typeof value !== "object") return false;
  return (
    isAbsolute(value.cwd) &&
    typeof value.default_adapter === "string" &&
    value.default_adapter.length > 0 &&
    positiveSafeInteger(value.max_agents) &&
    positiveSafeInteger(value.concurrency) &&
    typeof value.subscription_only === "boolean" &&
    typeof value.allow_api_billing === "boolean" &&
    (value.approval_mode === "deny" || value.approval_mode === "park") &&
    typeof value.approval_addressee === "string" &&
    value.approval_addressee.length > 0 &&
    value.approval_addressee.length <= 200 &&
    ["enabled", "disabled", "unknown"].includes(value.network_access) &&
    validSpecialists(value.specialists) &&
    validFrozenPolicy(value.policy, value.cwd)
  );
}

/**
 * Names the isolation of a manifest written before isolated workspaces were
 * removed (ADR 0244), or returns undefined for a run that used the shared
 * checkout. Such a run's workspace no longer has a provider to reattach it.
 */
function executedOutsideSharedCheckout(manifest: WorkflowRunManifest): string | undefined {
  const execution = manifest.execution as WorkflowRunManifest["execution"] & {
    isolation?: unknown;
    workspace_binding?: unknown;
  };
  if (execution.isolation !== undefined && execution.isolation !== "shared") {
    return String(execution.isolation);
  }
  return execution.workspace_binding === undefined ? undefined : "worktree";
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
    (value.observation === undefined ||
      value.observation === "ok" ||
      value.observation === "partial" ||
      value.observation === "unavailable") &&
    (value.observation_detail === undefined ||
      (typeof value.observation_detail === "string" && value.observation_detail.length <= 500)) &&
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
