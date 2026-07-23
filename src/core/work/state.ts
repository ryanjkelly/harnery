import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readWorkflowApproval } from "../workflow/approvals.ts";
import { readWorkflowProof } from "../workflow/proof.ts";
import { readWorkflowRunManifest, workflowScriptDigest } from "../workflow/run-state.ts";

export const WORK_INTENT_SCHEMA_VERSION = 1 as const;
export const WORK_EVENT_SCHEMA_VERSION = 1 as const;

const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_TITLE = 200;
const MAX_OBJECTIVE = 4_000;
const MAX_ACCEPTANCE = 50;
const MAX_ACCEPTANCE_ITEM = 500;
const MAX_DEPENDENCIES = 50;
const MAX_SOURCE_REF = 1_000;
const MAX_ACTOR = 200;
const MAX_REASON = 2_000;
const MAX_INTENT_BYTES = 128 * 1024;
const MAX_EVENTS_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_EVENTS = 1_000;
const FOREIGN_LEASE_STALE_MS = 24 * 60 * 60 * 1_000;

export type WorkState =
  | "waiting"
  | "ready"
  | "running"
  | "awaiting_approval"
  | "in_review"
  | "blocked"
  | "succeeded"
  | "cancelled";

export type WorkNextAction =
  | "wait_for_dependencies"
  | "run"
  | "wait_for_run"
  | "resolve_approval"
  | "resume"
  | "retry"
  | "review"
  | "none";

export interface WorkIntent {
  schema_version: typeof WORK_INTENT_SCHEMA_VERSION;
  id: string;
  title: string;
  objective: string;
  acceptance: string[];
  dependencies: string[];
  workflow: { path: string; sha256: string };
  max_attempts: number;
  source?: { kind: "human" | "workflow" | "external"; ref?: string };
  created_at: string;
}

export type WorkEventType =
  | "work.created"
  | "work.reconciled"
  | "attempt.started"
  | "attempt.resumed"
  | "work.accepted"
  | "work.cancelled"
  | "work.reopened";

export interface WorkEvent {
  schema_version: typeof WORK_EVENT_SCHEMA_VERSION;
  work_id: string;
  seq: number;
  ts: string;
  event: WorkEventType;
  actor: string;
  reason?: string;
  run_id?: string;
  attempt?: number;
  state?: WorkState;
  next_action?: WorkNextAction;
}

export interface WorkAttempt {
  number: number;
  run_id: string;
  started_at: string;
  status: "running" | "parked" | "succeeded" | "failed" | "lost";
  approval_id?: string;
  proof_path?: string;
}

export interface WorkProjection {
  id: string;
  title: string;
  state: WorkState;
  reason: string;
  next_action: WorkNextAction;
  unresolved_dependencies: string[];
  attempts: WorkAttempt[];
  attempts_used: number;
  attempts_remaining: number;
  latest_run_id?: string;
  approval_id?: string;
  proof_path?: string;
  updated_at: string;
}

export interface WorkRecord {
  intent: WorkIntent;
  events: WorkEvent[];
  projection: WorkProjection;
}

export interface CreateWorkItemInput {
  coordRoot: string;
  title: string;
  objective: string;
  workflowPath: string;
  acceptance?: string[];
  dependencies?: string[];
  maxAttempts?: number;
  source?: WorkIntent["source"];
  id?: string;
  actor?: string;
}

export function createWorkItem(input: CreateWorkItemInput): WorkRecord {
  const coordRoot = resolve(input.coordRoot);
  const id = input.id ?? newWorkId();
  assertWorkId(id);
  const workflowPath = resolve(input.workflowPath);
  if (!isAbsolute(workflowPath) || !existsSync(workflowPath)) {
    throw new Error(`work workflow does not exist at ${workflowPath}`);
  }
  const dependencies = uniqueStrings(
    input.dependencies ?? [],
    "work dependencies",
    MAX_DEPENDENCIES,
  );
  for (const dependency of dependencies) {
    assertWorkId(dependency);
    if (dependency === id) throw new Error("work item cannot depend on itself");
    readWorkIntent(coordRoot, dependency);
  }
  assertNoDependencyCycle(coordRoot, id, dependencies);
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("work maxAttempts must be an integer from 1 to 100");
  }
  const acceptance = (input.acceptance ?? []).map((value, index) =>
    boundedString(value, `work acceptance[${index}]`, MAX_ACCEPTANCE_ITEM),
  );
  if (acceptance.length > MAX_ACCEPTANCE) {
    throw new Error(`work acceptance exceeds ${MAX_ACCEPTANCE} criteria`);
  }
  const source = normalizeSource(input.source);
  const intent: WorkIntent = {
    schema_version: WORK_INTENT_SCHEMA_VERSION,
    id,
    title: boundedString(input.title, "work title", MAX_TITLE),
    objective: boundedString(input.objective, "work objective", MAX_OBJECTIVE),
    acceptance,
    dependencies,
    workflow: { path: workflowPath, sha256: workflowScriptDigest(workflowPath) },
    max_attempts: maxAttempts,
    source,
    created_at: new Date().toISOString(),
  };
  const dir = workDir(coordRoot, id);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivateJson(join(dir, "intent.json"), intent, MAX_INTENT_BYTES);
  const release = acquireWorkLease(coordRoot, id);
  try {
    appendWorkEvent(coordRoot, id, {
      event: "work.created",
      actor: boundedActor(input.actor),
      reason: "durable work intent created",
    });
  } finally {
    release();
  }
  return readWorkItem(coordRoot, id);
}

export function readWorkItem(coordRoot: string, workId: string): WorkRecord {
  const intent = readWorkIntent(coordRoot, workId);
  const events = readWorkEvents(coordRoot, workId);
  return { intent, events, projection: deriveWorkProjection(coordRoot, intent, events) };
}

export function listWorkItems(coordRoot: string): WorkRecord[] {
  const base = join(resolve(coordRoot), ".harnery", "work");
  if (!existsSync(base)) return [];
  const records: WorkRecord[] = [];
  for (const name of readdirSync(base)) {
    if (!WORK_ID.test(name) || !existsSync(join(base, name, "intent.json"))) continue;
    records.push(readWorkItem(coordRoot, name));
  }
  return records.sort((a, b) => b.intent.created_at.localeCompare(a.intent.created_at));
}

export function reconcileWorkItem(coordRoot: string, workId: string, actor?: string): WorkRecord {
  const before = readWorkItem(coordRoot, workId);
  const last = [...before.events].reverse().find((event) => event.event === "work.reconciled");
  if (
    last?.state === before.projection.state &&
    last.reason === before.projection.reason &&
    last.next_action === before.projection.next_action
  ) {
    return before;
  }
  // Reconciliation is observational. An active runner owns the append lease;
  // report its live projection now and let the runner append the transition
  // when it releases the lease.
  if (workLeaseIsLive(coordRoot, workId)) return before;
  const release = acquireWorkLease(coordRoot, workId);
  try {
    const current = readWorkItemIgnoringLease(coordRoot, workId);
    const latest = [...current.events].reverse().find((event) => event.event === "work.reconciled");
    if (
      latest?.state !== current.projection.state ||
      latest.reason !== current.projection.reason ||
      latest.next_action !== current.projection.next_action
    ) {
      appendWorkEvent(coordRoot, workId, {
        event: "work.reconciled",
        actor: boundedActor(actor, "reconciler"),
        reason: current.projection.reason,
        state: current.projection.state,
        next_action: current.projection.next_action,
      });
    }
  } finally {
    release();
  }
  return readWorkItem(coordRoot, workId);
}

export function reconcileAllWorkItems(coordRoot: string, actor?: string): WorkRecord[] {
  return listWorkItems(coordRoot).map((record) =>
    reconcileWorkItem(coordRoot, record.intent.id, actor),
  );
}

export function acceptWorkItem(
  coordRoot: string,
  workId: string,
  input: { actor?: string; reason?: string } = {},
): WorkRecord {
  return appendGovernanceEvent(coordRoot, workId, "work.accepted", ["in_review"], input);
}

export function cancelWorkItem(
  coordRoot: string,
  workId: string,
  input: { actor?: string; reason?: string } = {},
): WorkRecord {
  return appendGovernanceEvent(
    coordRoot,
    workId,
    "work.cancelled",
    ["waiting", "ready", "blocked", "in_review"],
    input,
  );
}

export function reopenWorkItem(
  coordRoot: string,
  workId: string,
  input: { actor?: string; reason?: string } = {},
): WorkRecord {
  return appendGovernanceEvent(
    coordRoot,
    workId,
    "work.reopened",
    ["blocked", "in_review", "succeeded", "cancelled"],
    input,
  );
}

export function assertWorkId(workId: string): void {
  if (!WORK_ID.test(workId)) throw new Error(`invalid work id ${JSON.stringify(workId)}`);
}

export function newWorkId(): string {
  return `work-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

export function newWorkflowRunId(): string {
  return `wf-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

function deriveWorkProjection(
  coordRoot: string,
  intent: WorkIntent,
  events: WorkEvent[],
  ignoreLease = false,
): WorkProjection {
  const latestGovernance = [...events]
    .reverse()
    .find((event) => ["work.accepted", "work.cancelled", "work.reopened"].includes(event.event));
  const terminal =
    latestGovernance?.event === "work.accepted" || latestGovernance?.event === "work.cancelled";
  const attemptEvents = events.filter((event) => event.event === "attempt.started");
  const attempts = attemptEvents.map((event) => inspectAttempt(coordRoot, event, intent));
  const base = {
    id: intent.id,
    title: intent.title,
    unresolved_dependencies: [] as string[],
    attempts,
    attempts_used: attempts.length,
    attempts_remaining: Math.max(0, intent.max_attempts - attempts.length),
    latest_run_id: attempts.at(-1)?.run_id,
    approval_id: attempts.at(-1)?.approval_id,
    proof_path: attempts.at(-1)?.proof_path,
    updated_at: events.at(-1)?.ts ?? intent.created_at,
  };
  if (terminal) {
    const accepted = latestGovernance?.event === "work.accepted";
    return {
      ...base,
      state: accepted ? "succeeded" : "cancelled",
      reason: latestGovernance?.reason ?? (accepted ? "work accepted" : "work cancelled"),
      next_action: "none",
    };
  }
  const reopenSeq = latestGovernance?.event === "work.reopened" ? latestGovernance.seq : 0;
  const currentAttempts = attemptEvents
    .filter((event) => event.seq > reopenSeq)
    .map((event) => inspectAttempt(coordRoot, event, intent));
  const unresolved = intent.dependencies.filter((dependency) => {
    try {
      return readWorkItem(coordRoot, dependency).projection.state !== "succeeded";
    } catch {
      return true;
    }
  });
  if (unresolved.length > 0) {
    return {
      ...base,
      state: "waiting",
      reason: `waiting for ${unresolved.length} dependenc${unresolved.length === 1 ? "y" : "ies"}`,
      next_action: "wait_for_dependencies",
      unresolved_dependencies: unresolved,
    };
  }
  if (!ignoreLease && workLeaseIsLive(coordRoot, intent.id)) {
    return {
      ...base,
      state: "running",
      reason: "workflow attempt holds the work lease",
      next_action: "wait_for_run",
    };
  }
  const latest = currentAttempts.at(-1);
  if (!latest) {
    return {
      ...base,
      state: "ready",
      reason: reopenSeq > 0 ? "work reopened for a new attempt" : "dependencies are satisfied",
      next_action: "run",
    };
  }
  if (latest.status === "running") {
    return {
      ...base,
      state: "running",
      reason: `workflow attempt ${latest.number} is running`,
      next_action: "wait_for_run",
    };
  }
  if (latest.status === "parked") {
    const approval = latest.approval_id
      ? readWorkflowApproval(coordRoot, latest.approval_id)
      : undefined;
    const resolved = approval?.status === "approved" || approval?.status === "denied";
    return {
      ...base,
      state: "awaiting_approval",
      reason: resolved
        ? `approval ${latest.approval_id} is resolved; resume the same attempt`
        : `workflow attempt ${latest.number} is parked for approval`,
      next_action: resolved ? "resume" : "resolve_approval",
      approval_id: latest.approval_id,
    };
  }
  if (latest.status === "succeeded") {
    return {
      ...base,
      state: "in_review",
      reason: `workflow attempt ${latest.number} produced passing proof; acceptance remains explicit`,
      next_action: "review",
    };
  }
  const attemptsRemaining = intent.max_attempts - attempts.length;
  return {
    ...base,
    state: "blocked",
    reason:
      latest.status === "failed"
        ? `workflow attempt ${latest.number} failed`
        : `workflow attempt ${latest.number} ended without terminal evidence`,
    next_action: attemptsRemaining > 0 ? "retry" : "none",
  };
}

function inspectAttempt(coordRoot: string, event: WorkEvent, intent: WorkIntent): WorkAttempt {
  const runId = event.run_id as string;
  const attempt: WorkAttempt = {
    number: event.attempt as number,
    run_id: runId,
    started_at: event.ts,
    status: "lost",
  };
  const proofPath = join(coordRoot, ".harnery", "workflows", runId, "proof.json");
  const manifestPath = join(coordRoot, ".harnery", "workflows", runId, "run.json");
  let manifest: ReturnType<typeof readWorkflowRunManifest> | undefined;
  if (existsSync(manifestPath)) {
    manifest = readWorkflowRunManifest(coordRoot, runId);
    if (manifest.work_item_id !== event.work_id) {
      throw new Error(`workflow run ${runId} does not belong to work item ${event.work_id}`);
    }
    if (
      manifest.work_context !== undefined &&
      JSON.stringify(manifest.work_context) !== JSON.stringify(workContextForIntent(intent))
    ) {
      throw new Error(
        `workflow run ${runId} work context does not match work item ${event.work_id}`,
      );
    }
  }
  if (existsSync(proofPath)) {
    if (!existsSync(manifestPath)) {
      throw new Error(`workflow run ${runId} has proof without a work-linked manifest`);
    }
    const proof = readWorkflowProof(coordRoot, runId);
    if (proof.run.work_item_id !== event.work_id) {
      throw new Error(`workflow proof ${runId} does not belong to work item ${event.work_id}`);
    }
    if (JSON.stringify(proof.run.work_context) !== JSON.stringify(manifest?.work_context)) {
      throw new Error(`workflow proof ${runId} work context does not match its run manifest`);
    }
    attempt.proof_path = proofPath;
    attempt.status =
      proof.run.status === "succeeded" &&
      proof.acceptance.summary.unsatisfied === 0 &&
      proof.acceptance.summary.unknown === 0
        ? "succeeded"
        : "failed";
    return attempt;
  }
  const journalPath = join(coordRoot, ".harnery", "workflows", runId, "journal.jsonl");
  if (existsSync(journalPath)) {
    let parked: string | undefined;
    let resumed = false;
    for (const line of readBoundedLines(journalPath, MAX_EVENTS_BYTES, "workflow journal")) {
      const value = parseObject(line, `workflow run ${runId} journal`);
      if (value.event === "run.parked" && typeof value.approval_id === "string") {
        parked = value.approval_id;
        resumed = false;
      }
      if (value.event === "run.resume") resumed = true;
    }
    if (parked && !resumed) {
      attempt.status = "parked";
      attempt.approval_id = parked;
      return attempt;
    }
  }
  if (workflowResumeLeaseIsLive(coordRoot, runId)) attempt.status = "running";
  return attempt;
}

function workContextForIntent(intent: WorkIntent): {
  schema_version: 1;
  id: string;
  title: string;
  objective: string;
  acceptance: string[];
} {
  return {
    schema_version: 1,
    id: intent.id,
    title: intent.title,
    objective: intent.objective,
    acceptance: [...intent.acceptance],
  };
}

function appendGovernanceEvent(
  coordRoot: string,
  workId: string,
  event: "work.accepted" | "work.cancelled" | "work.reopened",
  allowed: WorkState[],
  input: { actor?: string; reason?: string },
): WorkRecord {
  const release = acquireWorkLease(coordRoot, workId);
  try {
    const current = readWorkItemIgnoringLease(coordRoot, workId);
    if (!allowed.includes(current.projection.state)) {
      throw new Error(
        `work item ${workId} cannot ${event.replace("work.", "")} from state ${current.projection.state}`,
      );
    }
    appendWorkEvent(coordRoot, workId, {
      event,
      actor: boundedActor(input.actor),
      reason: boundedOptional(input.reason, "work reason", MAX_REASON),
    });
  } finally {
    release();
  }
  return reconcileWorkItem(coordRoot, workId, input.actor);
}

/** @internal Runner seam; not a separate persistence contract. */
export function appendReconcileIfChanged(
  coordRoot: string,
  record: WorkRecord,
  actor: string,
): void {
  const last = [...record.events].reverse().find((event) => event.event === "work.reconciled");
  if (
    last?.state === record.projection.state &&
    last.reason === record.projection.reason &&
    last.next_action === record.projection.next_action
  ) {
    return;
  }
  appendWorkEvent(coordRoot, record.intent.id, {
    event: "work.reconciled",
    actor,
    reason: record.projection.reason,
    state: record.projection.state,
    next_action: record.projection.next_action,
  });
}

/** @internal Runner seam; not a separate persistence contract. */
export function appendWorkEvent(
  coordRoot: string,
  workId: string,
  input: Omit<WorkEvent, "schema_version" | "work_id" | "seq" | "ts">,
): WorkEvent {
  const events = readWorkEvents(coordRoot, workId);
  if (events.length === 0 && input.event !== "work.created") {
    appendWorkEvent(coordRoot, workId, {
      event: "work.created",
      actor: "recovery",
      reason: "recovered creation receipt from immutable intent",
    });
    return appendWorkEvent(coordRoot, workId, input);
  }
  if (events.length >= MAX_EVENTS)
    throw new Error(`work item ${workId} exceeds ${MAX_EVENTS} events`);
  const event: WorkEvent = {
    schema_version: WORK_EVENT_SCHEMA_VERSION,
    work_id: workId,
    seq: events.length + 1,
    ts: new Date().toISOString(),
    ...input,
  };
  validateWorkEvent(event, workId, event.seq);
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
    throw new Error(`work event exceeds ${MAX_EVENT_BYTES} bytes`);
  }
  const path = join(workDir(coordRoot, workId), "events.jsonl");
  const existingBytes = existsSync(path) ? statSync(path).size : 0;
  if (existingBytes + Buffer.byteLength(line) > MAX_EVENTS_BYTES) {
    throw new Error("work event log would exceed its limit");
  }
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return event;
}

function readWorkIntent(coordRoot: string, workId: string): WorkIntent {
  assertWorkId(workId);
  const path = join(workDir(coordRoot, workId), "intent.json");
  if (!existsSync(path)) throw new Error(`work item ${workId} does not exist`);
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_INTENT_BYTES) throw new Error(`work intent has invalid size ${size}`);
  const intent = parseObject(
    readFileSync(path, "utf8"),
    `work intent ${workId}`,
  ) as unknown as WorkIntent;
  validateWorkIntent(intent, workId);
  return intent;
}

function readWorkEvents(coordRoot: string, workId: string): WorkEvent[] {
  assertWorkId(workId);
  const path = join(workDir(coordRoot, workId), "events.jsonl");
  if (!existsSync(path)) return [];
  const events = readBoundedLines(path, MAX_EVENTS_BYTES, `work item ${workId} events`).map(
    (line, index) => {
      const event = parseObject(
        line,
        `work item ${workId} event ${index + 1}`,
      ) as unknown as WorkEvent;
      validateWorkEvent(event, workId, index + 1);
      return event;
    },
  );
  validateWorkHistory(events, workId);
  return events;
}

/** @internal Runner seam; not a separate persistence contract. */
export function readWorkItemIgnoringLease(coordRoot: string, workId: string): WorkRecord {
  const intent = readWorkIntent(coordRoot, workId);
  const events = readWorkEvents(coordRoot, workId);
  return { intent, events, projection: deriveWorkProjection(coordRoot, intent, events, true) };
}

function validateWorkIntent(intent: WorkIntent, workId: string): void {
  if (
    intent.schema_version !== WORK_INTENT_SCHEMA_VERSION ||
    intent.id !== workId ||
    !validTimestamp(intent.created_at) ||
    !isAbsolute(intent.workflow?.path) ||
    !/^[a-f0-9]{64}$/.test(intent.workflow.sha256) ||
    !Number.isSafeInteger(intent.max_attempts) ||
    intent.max_attempts < 1 ||
    intent.max_attempts > 100
  ) {
    throw new Error(`work intent ${workId} has an unsupported or mismatched schema`);
  }
  boundedString(intent.title, "work title", MAX_TITLE);
  boundedString(intent.objective, "work objective", MAX_OBJECTIVE);
  if (!Array.isArray(intent.acceptance) || intent.acceptance.length > MAX_ACCEPTANCE) {
    throw new Error("work acceptance has an invalid shape");
  }
  intent.acceptance.forEach((value, index) => {
    boundedString(value, `work acceptance[${index}]`, MAX_ACCEPTANCE_ITEM);
  });
  uniqueStrings(intent.dependencies, "work dependencies", MAX_DEPENDENCIES).forEach(assertWorkId);
  normalizeSource(intent.source);
}

function validateWorkEvent(event: WorkEvent, workId: string, seq: number): void {
  const eventTypes: WorkEventType[] = [
    "work.created",
    "work.reconciled",
    "attempt.started",
    "attempt.resumed",
    "work.accepted",
    "work.cancelled",
    "work.reopened",
  ];
  if (
    event.schema_version !== WORK_EVENT_SCHEMA_VERSION ||
    event.work_id !== workId ||
    event.seq !== seq ||
    !validTimestamp(event.ts) ||
    !eventTypes.includes(event.event)
  ) {
    throw new Error(`work item ${workId} event ${seq} has an unsupported or mismatched schema`);
  }
  boundedActor(event.actor);
  boundedOptional(event.reason, "work reason", MAX_REASON);
  if (event.event === "attempt.started" || event.event === "attempt.resumed") {
    if (
      !event.run_id ||
      !RUN_ID.test(event.run_id) ||
      !Number.isSafeInteger(event.attempt) ||
      (event.attempt ?? 0) < 1
    ) {
      throw new Error(`work item ${workId} event ${seq} has invalid attempt data`);
    }
  }
  if (event.event === "work.reconciled") {
    const states: WorkState[] = [
      "waiting",
      "ready",
      "running",
      "awaiting_approval",
      "in_review",
      "blocked",
      "succeeded",
      "cancelled",
    ];
    const actions: WorkNextAction[] = [
      "wait_for_dependencies",
      "run",
      "wait_for_run",
      "resolve_approval",
      "resume",
      "retry",
      "review",
      "none",
    ];
    if (
      !event.state ||
      !states.includes(event.state) ||
      !event.next_action ||
      !actions.includes(event.next_action)
    ) {
      throw new Error(`work item ${workId} event ${seq} has invalid reconciliation data`);
    }
  }
}

function validateWorkHistory(events: WorkEvent[], workId: string): void {
  if (events.length === 0) return;
  if (events[0]?.event !== "work.created") {
    throw new Error(`work item ${workId} history must begin with work.created`);
  }
  if (events.filter((event) => event.event === "work.created").length !== 1) {
    throw new Error(`work item ${workId} history has duplicate creation receipts`);
  }
  const attempts = new Map<string, number>();
  let attemptCount = 0;
  for (const event of events) {
    if (event.event === "attempt.started") {
      attemptCount++;
      if (event.attempt !== attemptCount || attempts.has(event.run_id as string)) {
        throw new Error(`work item ${workId} has invalid attempt ordering`);
      }
      attempts.set(event.run_id as string, event.attempt);
    }
    if (
      event.event === "attempt.resumed" &&
      attempts.get(event.run_id as string) !== event.attempt
    ) {
      throw new Error(`work item ${workId} resumes an unknown attempt`);
    }
  }
}

/** @internal Runner seam; not a separate persistence contract. */
export function assertWorkflowUnchanged(intent: WorkIntent): void {
  if (!existsSync(intent.workflow.path))
    throw new Error(`work workflow no longer exists at ${intent.workflow.path}`);
  if (workflowScriptDigest(intent.workflow.path) !== intent.workflow.sha256) {
    throw new Error(`work workflow changed since ${intent.id} was created; create a new work item`);
  }
}

function assertNoDependencyCycle(coordRoot: string, id: string, dependencies: string[]): void {
  const visit = (candidate: string, seen: Set<string>): void => {
    if (candidate === id) throw new Error(`work dependency cycle reaches ${id}`);
    if (seen.has(candidate)) return;
    seen.add(candidate);
    for (const dependency of readWorkIntent(coordRoot, candidate).dependencies)
      visit(dependency, seen);
  };
  for (const dependency of dependencies) visit(dependency, new Set());
}

function workDir(coordRoot: string, workId: string): string {
  assertWorkId(workId);
  return join(resolve(coordRoot), ".harnery", "work", workId);
}

/** @internal Runner seam; not a separate persistence contract. */
export function acquireWorkLease(coordRoot: string, workId: string): () => void {
  readWorkIntent(coordRoot, workId);
  const path = join(workDir(coordRoot, workId), "lease.json");
  const owner = {
    pid: process.pid,
    host: hostname(),
    created_at: new Date().toISOString(),
    nonce: randomUUID(),
  };
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
    const existing = readLease(path);
    if (existing && leaseIsLive(existing)) {
      throw new Error(
        `work item ${workId} is already active under pid ${existing.pid} on ${existing.host}`,
      );
    }
    unlinkSync(path);
    if (!acquire()) throw new Error(`work item ${workId} lease raced with another process`);
  }
  return () => {
    try {
      const existing = readLease(path);
      if (existing?.nonce === owner.nonce) unlinkSync(path);
    } catch {
      // A stale private lease is recoverable by the next mutation.
    }
  };
}

function workLeaseIsLive(coordRoot: string, workId: string): boolean {
  const lease = readLease(join(workDir(coordRoot, workId), "lease.json"));
  return lease ? leaseIsLive(lease) : false;
}

function workflowResumeLeaseIsLive(coordRoot: string, runId: string): boolean {
  const lease = readLease(join(coordRoot, ".harnery", "workflows", runId, "resume.lock"));
  return lease ? leaseIsLive(lease) : false;
}

function readLease(
  path: string,
): { pid: number; host: string; created_at: string; nonce?: string } | null {
  try {
    const value = parseObject(readFileSync(path, "utf8"), "work lease");
    return typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.host === "string" &&
      typeof value.created_at === "string"
      ? {
          pid: value.pid,
          host: value.host,
          created_at: value.created_at,
          nonce: typeof value.nonce === "string" ? value.nonce : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

function leaseIsLive(lease: { pid: number; host: string; created_at: string }): boolean {
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

function writePrivateJson(path: string, value: unknown, maxBytes: number): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > maxBytes)
    throw new Error(`private record exceeds ${maxBytes} bytes`);
  writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

function readBoundedLines(path: string, maxBytes: number, field: string): string[] {
  const size = statSync(path).size;
  if (size > maxBytes) throw new Error(`${field} exceeds ${maxBytes} bytes`);
  const body = readFileSync(path, "utf8");
  if (body.length > 0 && !body.endsWith("\n"))
    throw new Error(`${field} has a truncated final line`);
  const lines = body.split("\n").filter(Boolean);
  if (lines.length > MAX_EVENTS) throw new Error(`${field} exceeds ${MAX_EVENTS} records`);
  for (const line of lines) {
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES)
      throw new Error(`${field} contains an oversized record`);
  }
  return lines;
}

function parseObject(input: string, field: string): Record<string, unknown> {
  try {
    const value = JSON.parse(input) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("expected object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`cannot parse ${field}: ${(error as Error).message}`);
  }
}

function normalizeSource(source: WorkIntent["source"]): WorkIntent["source"] {
  if (!source) return undefined;
  if (!(source.kind === "human" || source.kind === "workflow" || source.kind === "external")) {
    throw new Error("work source kind must be human, workflow, or external");
  }
  return { kind: source.kind, ref: boundedOptional(source.ref, "work source ref", MAX_SOURCE_REF) };
}

function uniqueStrings(values: unknown, field: string, max: number): string[] {
  if (!Array.isArray(values) || values.length > max)
    throw new Error(`${field} must contain at most ${max} entries`);
  const result = values.map((value, index) => boundedString(value, `${field}[${index}]`, 100));
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicates`);
  return result;
}

/** @internal Runner seam; not a separate persistence contract. */
export function boundedActor(value?: string, fallback = "operator"): string {
  return boundedString(value ?? process.env.USER ?? fallback, "work actor", MAX_ACTOR);
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function boundedOptional(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, field, max);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
