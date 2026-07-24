import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  canonicalJson,
  fsyncParentDirectory,
  readJsonRecord,
  stableDigest,
  writeImmutableJson,
} from "../durable-record.ts";
import type {
  GitRepositoryBinding,
  IntegrationApplyAttempt,
  IntegrationApplyReceipt,
  IntegrationAuthorization,
  IntegrationPlan,
  IntegrationReviewRecord,
  WorkspaceAllocationRequest,
  WorkspaceBinding,
  WorkspaceCancellationReceipt,
  WorkspaceCleanupAttempt,
  WorkspaceCleanupIntent,
  WorkspaceCleanupReceipt,
  WorkspaceCleanupResult,
} from "./types.ts";

const JSON_LIMIT = 512 * 1024;
const EVENT_LIMIT = 32 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface WorkspaceClaim {
  schema_version: 1;
  provider_id: string;
  provider_version: string;
  binding_id: string;
  workspace_id: string;
  request: WorkspaceAllocationRequest;
  request_sha256: string;
  recovery_token: string;
  created_at: string;
  workspace_root: string;
  active_root: string;
  writable_root: WorkspaceBinding["writable_root"];
  repository: {
    source_root: GitRepositoryBinding["source_root"];
    common_dir: GitRepositoryBinding["common_dir"];
    base_commit: string;
    target_commit: string;
    target_ref: string;
    workspace_ref: string;
    workspace_branch: string;
  };
}

export interface WorkspaceProviderEvent {
  schema_version: 1;
  seq: number;
  previous_sha256: string | null;
  record_sha256: string;
  event: string;
  recorded_at: string;
  request_sha256: string;
  binding_id: string;
  workspace_id: string;
  data: Record<string, unknown>;
}

export function workflowRunDir(coordRoot: string, runId: string): string {
  assertId(runId, "run id");
  return join(resolve(coordRoot), ".harnery", "workflows", runId);
}

export function workspaceRequestPath(coordRoot: string, runId: string): string {
  return join(workflowRunDir(coordRoot, runId), "workspace-request.json");
}

export function workspaceClaimPath(
  coordRoot: string,
  providerId: string,
  bindingId: string,
): string {
  assertId(providerId, "provider id");
  assertId(bindingId, "binding id");
  return join(resolve(coordRoot), ".harnery", "workspaces", providerId, bindingId, "claim.json");
}

export function workspaceEventsPath(
  coordRoot: string,
  providerId: string,
  bindingId: string,
): string {
  return join(dirname(workspaceClaimPath(coordRoot, providerId, bindingId)), "events.jsonl");
}

export function workspaceBindingPath(
  coordRoot: string,
  providerId: string,
  bindingId: string,
): string {
  return join(dirname(workspaceClaimPath(coordRoot, providerId, bindingId)), "binding.json");
}

export function workspaceLockPath(
  coordRoot: string,
  providerId: string,
  bindingId: string,
): string {
  return join(dirname(workspaceClaimPath(coordRoot, providerId, bindingId)), "operation.lease");
}

export function writeWorkspaceRequest(
  coordRoot: string,
  request: WorkspaceAllocationRequest,
): string {
  const path = workspaceRequestPath(coordRoot, request.run_id);
  writeImmutableJson(path, request);
  return path;
}

export function readWorkspaceRequest(
  coordRoot: string,
  runId: string,
): WorkspaceAllocationRequest | undefined {
  const path = workspaceRequestPath(coordRoot, runId);
  return existsSync(path)
    ? readJsonRecord<WorkspaceAllocationRequest>(path, "workspace request")
    : undefined;
}

export function writeWorkspaceClaim(coordRoot: string, claim: WorkspaceClaim): boolean {
  const path = workspaceClaimPath(coordRoot, claim.provider_id, claim.binding_id);
  try {
    return writeImmutableJson(path, claim);
  } catch (error) {
    // A competing allocation may have won the exclusive link with its one
    // random recovery token. The caller must read and validate that claim.
    if (existsSync(path) && (error as Error).message.includes("immutable record already exists")) {
      return false;
    }
    throw error;
  }
}

export function readWorkspaceClaim(
  coordRoot: string,
  providerId: string,
  bindingId: string,
): WorkspaceClaim | undefined {
  const path = workspaceClaimPath(coordRoot, providerId, bindingId);
  return existsSync(path) ? readJsonRecord<WorkspaceClaim>(path, "workspace claim") : undefined;
}

export function writeWorkspaceBinding(coordRoot: string, binding: WorkspaceBinding): boolean {
  return writeImmutableJson(
    workspaceBindingPath(coordRoot, binding.provider.id, binding.binding_id),
    binding,
  );
}

export function readWorkspaceBinding(
  coordRoot: string,
  providerId: string,
  bindingId: string,
): WorkspaceBinding | undefined {
  const path = workspaceBindingPath(coordRoot, providerId, bindingId);
  return existsSync(path) ? readJsonRecord<WorkspaceBinding>(path, "workspace binding") : undefined;
}

export function appendWorkspaceEvent(
  coordRoot: string,
  claim: WorkspaceClaim,
  event: string,
  data: Record<string, unknown> = {},
): WorkspaceProviderEvent {
  if (!event || event.length > 100 || Buffer.byteLength(JSON.stringify(data)) > EVENT_LIMIT / 2) {
    throw new Error("workspace provider event is invalid or too large");
  }
  const path = workspaceEventsPath(coordRoot, claim.provider_id, claim.binding_id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existed = existsSync(path);
  const prior = readWorkspaceEvents(coordRoot, claim.provider_id, claim.binding_id);
  const basis = {
    schema_version: 1 as const,
    seq: prior.length + 1,
    previous_sha256: prior.at(-1)?.record_sha256 ?? null,
    event,
    recorded_at: new Date().toISOString(),
    request_sha256: claim.request_sha256,
    binding_id: claim.binding_id,
    workspace_id: claim.workspace_id,
    data,
  };
  const record: WorkspaceProviderEvent = {
    ...basis,
    record_sha256: stableDigest(basis),
  };
  const line = `${canonicalJson(record)}\n`;
  if (Buffer.byteLength(line) > EVENT_LIMIT)
    throw new Error("workspace provider event is too large");
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  if (!existed) fsyncParentDirectory(path);
  return record;
}

export function readWorkspaceEvents(
  coordRoot: string,
  providerId: string,
  bindingId: string,
): WorkspaceProviderEvent[] {
  const path = workspaceEventsPath(coordRoot, providerId, bindingId);
  if (!existsSync(path)) return [];
  if (statSync(path).size > JSON_LIMIT * 4) throw new Error("workspace event journal is too large");
  const claim = readWorkspaceClaim(coordRoot, providerId, bindingId);
  if (!claim) throw new Error("workspace event authority claim is missing");
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      if (Buffer.byteLength(line) > EVENT_LIMIT) {
        throw new Error(`workspace event ${index + 1} is too large`);
      }
      let record: WorkspaceProviderEvent;
      try {
        record = JSON.parse(line) as WorkspaceProviderEvent;
      } catch (error) {
        throw new Error(`cannot parse workspace event ${index + 1}: ${(error as Error).message}`);
      }
      const { record_sha256, ...basis } = record;
      const previous = index === 0 ? null : recordsDigestPlaceholder();
      if (
        record.schema_version !== 1 ||
        record.seq !== index + 1 ||
        record.binding_id !== bindingId ||
        record.workspace_id !== claim.workspace_id ||
        record.request_sha256 !== claim.request_sha256 ||
        record_sha256 !== stableDigest(basis) ||
        (index === 0 && record.previous_sha256 !== null)
      ) {
        throw new Error(`workspace event ${index + 1} is corrupt`);
      }
      void previous;
      return record;
    });
  for (let index = 1; index < records.length; index++) {
    if (records[index]!.previous_sha256 !== records[index - 1]!.record_sha256) {
      throw new Error(`workspace event ${index + 1} breaks the digest chain`);
    }
  }
  return records;
}

// Keeps the JSON parser above free of a closure over a partially initialized array.
function recordsDigestPlaceholder(): null {
  return null;
}

export function appendWorkflowJournalEvent(
  coordRoot: string,
  runId: string,
  event: string,
  data: Record<string, unknown>,
): void {
  const path = join(workflowRunDir(coordRoot, runId), "journal.jsonl");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existed = existsSync(path);
  const line = `${JSON.stringify({
    schema_version: 1,
    run_id: runId,
    ts: new Date().toISOString(),
    event,
    ...data,
  })}\n`;
  if (Buffer.byteLength(line) > EVENT_LIMIT) throw new Error("workflow journal event is too large");
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!existed) fsyncParentDirectory(path);
}

export type WorkflowSupplement =
  | WorkspaceBinding
  | IntegrationReviewRecord
  | IntegrationPlan
  | IntegrationAuthorization
  | IntegrationApplyReceipt
  | WorkspaceCleanupResult
  | WorkspaceCancellationReceipt
  | WorkspaceCleanupIntent
  | WorkspaceCleanupReceipt;

export function appendCleanupAttempt(
  coordRoot: string,
  runId: string,
  input: Omit<WorkspaceCleanupAttempt, "seq" | "previous_sha256" | "record_sha256">,
): WorkspaceCleanupAttempt {
  const path = join(workflowRunDir(coordRoot, runId), "cleanup", "attempts.jsonl");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existed = existsSync(path);
  const prior = readCleanupAttempts(coordRoot, runId);
  const basis = {
    ...input,
    seq: prior.length + 1,
    previous_sha256: prior.at(-1)?.record_sha256 ?? null,
  };
  const attempt: WorkspaceCleanupAttempt = {
    ...basis,
    record_sha256: stableDigest(basis),
  };
  const line = `${canonicalJson(attempt)}\n`;
  if (Buffer.byteLength(line) > EVENT_LIMIT) {
    throw new Error("workspace cleanup attempt is too large");
  }
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  if (!existed) fsyncParentDirectory(path);
  return attempt;
}

export function appendIntegrationAttempt(
  coordRoot: string,
  runId: string,
  input: Omit<IntegrationApplyAttempt, "seq" | "previous_sha256" | "record_sha256">,
): IntegrationApplyAttempt {
  const path = join(workflowRunDir(coordRoot, runId), "integration", "attempts.jsonl");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existed = existsSync(path);
  const prior = readIntegrationAttempts(coordRoot, runId);
  const basis = {
    ...input,
    seq: prior.length + 1,
    previous_sha256: prior.at(-1)?.record_sha256 ?? null,
  };
  const attempt: IntegrationApplyAttempt = {
    ...basis,
    record_sha256: stableDigest(basis),
  };
  appendChainedRecord(path, attempt, "integration attempt");
  if (!existed) fsyncParentDirectory(path);
  return attempt;
}

export function readIntegrationAttempts(
  coordRoot: string,
  runId: string,
): IntegrationApplyAttempt[] {
  return readChainedRecords<IntegrationApplyAttempt>(
    join(workflowRunDir(coordRoot, runId), "integration", "attempts.jsonl"),
    "integration attempt",
  );
}

export function readCleanupAttempts(coordRoot: string, runId: string): WorkspaceCleanupAttempt[] {
  return readChainedRecords<WorkspaceCleanupAttempt>(
    join(workflowRunDir(coordRoot, runId), "cleanup", "attempts.jsonl"),
    "workspace cleanup attempt",
  );
}

function appendChainedRecord(
  path: string,
  record: WorkspaceCleanupAttempt | IntegrationApplyAttempt,
  label: string,
): void {
  const line = `${canonicalJson(record)}\n`;
  if (Buffer.byteLength(line) > EVENT_LIMIT) {
    throw new Error(`${label} is too large`);
  }
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function readChainedRecords<
  T extends {
    schema_version: 1;
    seq: number;
    previous_sha256: string | null;
    record_sha256: string;
  },
>(path: string, label: string): T[] {
  if (!existsSync(path)) return [];
  if (statSync(path).size > JSON_LIMIT * 4) {
    throw new Error(`${label} journal is too large`);
  }
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      let record: T;
      try {
        record = JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`cannot parse ${label} ${index + 1}: ${(error as Error).message}`);
      }
      const { record_sha256, ...basis } = record;
      if (
        record.schema_version !== 1 ||
        record.seq !== index + 1 ||
        record_sha256 !== stableDigest(basis) ||
        (index === 0 && record.previous_sha256 !== null)
      ) {
        throw new Error(`${label} ${index + 1} is corrupt`);
      }
      return record;
    });
  for (let index = 1; index < records.length; index++) {
    if (records[index]!.previous_sha256 !== records[index - 1]!.record_sha256) {
      throw new Error(`${label} ${index + 1} breaks the digest chain`);
    }
  }
  return records;
}

export function writeWorkflowSupplement(
  coordRoot: string,
  runId: string,
  relativePath: string,
  value: WorkflowSupplement,
): string {
  if (
    relativePath.startsWith("/") ||
    relativePath.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("workflow supplement path is unsafe");
  }
  const path = join(workflowRunDir(coordRoot, runId), relativePath);
  writeImmutableJson(path, value);
  return path;
}

export function readWorkflowSupplement<T>(
  coordRoot: string,
  runId: string,
  relativePath: string,
): T | undefined {
  const path = join(workflowRunDir(coordRoot, runId), relativePath);
  return existsSync(path) ? readJsonRecord<T>(path, relativePath) : undefined;
}

function assertId(value: string, field: string): void {
  if (!ID.test(value)) throw new Error(`${field} is invalid`);
}

export {
  canonicalJson,
  fileSha256,
  readJsonRecord,
  stableDigest,
  writeImmutableJson,
} from "../durable-record.ts";
