import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Heartbeat } from "../agents/index.ts";
import { coordFreshnessSeconds } from "../config.ts";
import { readGovernor, readGovernorServiceRuntime } from "../governor/read.ts";
import { readWorkItem, type WorkRecord } from "../work/read.ts";
import type { CanonicalGuardEvent } from "./storage.ts";
import type { RunQualityRoleWait, RunQualityWaitKind } from "./types.ts";

/** Resolve only durable or fresh wait evidence; ambiguous evidence is never exempt. */
export function resolveRunQualityRoleWait(
  coordRoot: string,
  heartbeat: Heartbeat,
  events: CanonicalGuardEvent[],
  now: string,
): RunQualityRoleWait {
  const observedAt = heartbeat.last_heartbeat || now;
  const role =
    stringValue(heartbeat.role) ??
    workflowRole(coordRoot, heartbeat, events) ??
    (heartbeat.workflow_run_id
      ? "workflow_agent"
      : heartbeat.governor_goal_id
        ? "governor"
        : "session");
  const candidates: RunQualityRoleWait[] = [];

  const approvalId = stringValue(heartbeat.approval_id) ?? parkedApprovalId(coordRoot, heartbeat);
  if (approvalId && approvalPending(coordRoot, approvalId)) {
    candidates.push(wait(role, "approval", "workflow_approval", now, true, approvalId));
  }

  const decisionId = stringValue(heartbeat.decision_id);
  if (decisionId && decisionOpen(coordRoot, decisionId)) {
    candidates.push(wait(role, "decision", "decision_docket", now, true, decisionId));
  }

  const workId = stringValue(heartbeat.work_item_id);
  if (workId) addWorkWait(coordRoot, role, workId, candidates, now);
  const goalId = stringValue(heartbeat.governor_goal_id);
  if (goalId) addGovernorWait(coordRoot, role, goalId, candidates, now);

  const wakeAt = stringValue(heartbeat.next_wake_at);
  if (wakeAt) {
    const future =
      Date.parse(wakeAt) > Date.parse(now) &&
      !!goalId &&
      governorScheduleOpen(coordRoot, goalId, wakeAt);
    candidates.push({
      ...wait(role, "scheduled", "declared_wake", observedAt, future),
      wake_at: wakeAt,
    });
  }

  const latestInput = [...events]
    .reverse()
    .find(
      (event) =>
        event.instance_id === heartbeat.instance_id &&
        event.event_type === "interaction.input_requested",
    );
  const latestResume = [...events]
    .reverse()
    .find(
      (event) =>
        event.instance_id === heartbeat.instance_id &&
        (event.event_type === "user_prompt.submit" || event.event_type === "tool.pre_use"),
    );
  if (latestInput && (!latestResume || latestInput.event_id > latestResume.event_id)) {
    const age = Date.parse(now) - Date.parse(heartbeat.last_heartbeat);
    const fresh = Number.isFinite(age) && age <= coordFreshnessSeconds(coordRoot) * 1000;
    candidates.push(wait(role, "needs_input", "interaction_event", latestInput.ts, fresh));
  }

  const freshCandidates = deduplicateWaits(candidates.filter((candidate) => candidate.fresh));
  if (freshCandidates.length > 1) {
    return wait(role, "unknown", "conflicting_wait_evidence", now, false);
  }
  return freshCandidates[0] ?? wait(role, "none", "heartbeat", observedAt, true);
}

function governorScheduleOpen(coordRoot: string, goalId: string, wakeAt: string): boolean {
  try {
    return readGovernorServiceRuntime(coordRoot)?.goals[goalId]?.next_wake_at === wakeAt;
  } catch {
    return false;
  }
}

function addWorkWait(
  coordRoot: string,
  role: string,
  workId: string,
  candidates: RunQualityRoleWait[],
  now: string,
): void {
  if (!safeId(workId)) return;
  try {
    addWorkRecordWait(coordRoot, role, readWorkItem(coordRoot, workId), candidates, now);
  } catch {
    // Missing or malformed durable work grants no exemption.
  }
}

function addGovernorWait(
  coordRoot: string,
  role: string,
  goalId: string,
  candidates: RunQualityRoleWait[],
  now: string,
): void {
  if (!safeId(goalId)) return;
  try {
    const governor = readGovernor(coordRoot, goalId);
    for (const work of governor.work) addWorkRecordWait(coordRoot, role, work, candidates, now);
  } catch {
    // Missing or malformed governor state grants no exemption.
  }
}

function addWorkRecordWait(
  coordRoot: string,
  role: string,
  work: WorkRecord,
  candidates: RunQualityRoleWait[],
  now: string,
): void {
  const approvalId = work.projection.approval_id;
  if (
    work.projection.state === "awaiting_approval" &&
    approvalId &&
    approvalPending(coordRoot, approvalId)
  ) {
    candidates.push(wait(role, "approval", "durable_work", now, true, approvalId));
  }
  const decisionId = work.projection.blocked_on_decision;
  if (decisionId && decisionOpen(coordRoot, decisionId)) {
    candidates.push(wait(role, "decision", "durable_work", now, true, decisionId));
  }
}

function deduplicateWaits(candidates: RunQualityRoleWait[]): RunQualityRoleWait[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.wait_kind}:${candidate.record_id ?? candidate.wake_at ?? candidate.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function wait(
  role: string,
  waitKind: RunQualityWaitKind,
  source: string,
  observedAt: string,
  fresh: boolean,
  recordId?: string,
): RunQualityRoleWait {
  return {
    role,
    wait_kind: waitKind,
    source,
    observed_at: observedAt,
    fresh,
    ...(recordId ? { record_id: recordId } : {}),
  };
}

function parkedApprovalId(coordRoot: string, heartbeat: Heartbeat): string | undefined {
  const runId = stringValue(heartbeat.workflow_run_id);
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(runId)) return undefined;
  const path = join(coordRoot, ".harnery", "workflows", runId, "transcript.jsonl");
  if (!existsSync(path) || statSync(path).size > 4 * 1024 * 1024) return undefined;
  let parked: string | undefined;
  let terminal = false;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.event === "run.parked") parked = stringValue(value.approval_id);
      if (value.event === "run.end") terminal = true;
    }
  } catch {
    return undefined;
  }
  return terminal ? undefined : parked;
}

function workflowRole(
  coordRoot: string,
  heartbeat: Heartbeat,
  events: CanonicalGuardEvent[],
): string | undefined {
  const runId = stringValue(heartbeat.workflow_run_id);
  if (!runId || !safeId(runId)) return undefined;
  const start = [...events]
    .reverse()
    .find(
      (event) =>
        event.instance_id === heartbeat.instance_id && event.event_type === "session.start",
    );
  const workflowAgentId = stringValue(start?.data.workflow_agent_id);
  if (!workflowAgentId) return undefined;
  const path = join(coordRoot, ".harnery", "workflows", runId, "transcript.jsonl");
  if (!existsSync(path) || statSync(path).size > 4 * 1024 * 1024) return undefined;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.event !== "agent.start" || value.id !== workflowAgentId) continue;
      return stringValue(value.specialist) ?? "workflow_agent";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function approvalPending(coordRoot: string, approvalId: string): boolean {
  if (!safeId(approvalId)) return false;
  const dir = join(coordRoot, ".harnery", "approvals", approvalId);
  return existsSync(join(dir, "request.json")) && !existsSync(join(dir, "decision.json"));
}

function decisionOpen(coordRoot: string, decisionId: string): boolean {
  if (!safeId(decisionId)) return false;
  const path = join(coordRoot, ".harnery", "decisions", `${decisionId}.json`);
  if (!existsSync(path) || statSync(path).size > 512 * 1024) return false;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { status?: string };
    return !["archived", "superseded", "wontfix"].includes(value.status ?? "");
  } catch {
    return false;
  }
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
