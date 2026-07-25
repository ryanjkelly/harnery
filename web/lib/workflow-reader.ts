import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowProof } from "harnery/core/workflow";
import {
  inspectWorkflowWorkspace,
  type WorkflowWorkspaceInspection,
} from "harnery/core/workflow/workspaces/inspect";

/**
 * Journal-driven reader for workflow runs (`.harnery/workflows/<run-id>/
 * journal.jsonl`). The journal is the source of truth for run structure —
 * heartbeats only add live color — so this reader needs nothing but fs.
 */

export interface WorkflowAgentRow {
  id: string;
  label: string;
  stage: string;
  harness?: string;
  model?: string | null;
  status: "running" | "done" | "failed" | "cached";
  attempts?: number;
  costUsd?: number;
  durationMs?: number;
  sessionId?: string;
  /** `agent.start` ts. The anchor for a live elapsed timer, which is the only
   * thing distinguishing a working agent from a hung one mid-run: a child that
   * works for 18 minutes writes nothing to the journal between its two ends. */
  startedAt?: string;
  /** `agent.end` / `agent.failed` ts. Absent while the agent is in flight. */
  endedAt?: string;
}

export interface WorkflowRunSummary {
  runId: string;
  name: string;
  startedAt?: string;
  endedAt?: string;
  status: "running" | "parked" | "done" | "failed" | "stale";
  /** Durable approval currently holding the run, only while status=parked. */
  parkedApprovalId?: string;
  stages: string[];
  agents: WorkflowAgentRow[];
  agentsCached: number;
  costUsd: number;
  /** "harness=mode" per harness used (from billing.probe journal events). */
  billing: string[];
  /** Terminal proof packet, absent for live and pre-proof runs. */
  proof?: WorkflowProof;
  /** Validated workspace projection, including an explicit error on bad authority. */
  workspace?: WorkflowWorkspaceInspection;
  /** Journal mtime — the liveness signal for status=running vs stale. */
  lastActivityAt: string;
}

interface JournalLine {
  ts?: string;
  event?: string;
  stage?: string;
  id?: string;
  label?: string;
  title?: string;
  name?: string;
  harness?: string;
  model?: string | null;
  mode?: string;
  attempts?: number;
  cost_usd?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  ok?: boolean;
  error?: string;
  approval_id?: string;
}

/** A run with no journal writes for this long, and no run.end, is "stale"
 * (orchestrator likely killed) rather than "running". */
const STALE_MS = 10 * 60 * 1000;

/** One child harness session belonging to a workflow run. */
export interface WorkflowChildSession {
  sessionId: string;
  /** The agent row this session ran, when known: from the heartbeat's
   * `workflow_agent_id` while live, or the journal's `agent.end` once ended. */
  agentId?: string;
  /** A heartbeat for this session is present and unterminated. */
  live: boolean;
}

interface ChildHeartbeat {
  workflow_run_id?: string;
  workflow_agent_id?: string;
  session_id?: string;
  ended_at?: string;
}

/**
 * Workflow-child heartbeats in `.harnery/active/`, indexed by run id.
 *
 * Read once per page render and shared across runs: the directory holds one
 * file per *active agent in the repo*, so re-scanning it inside a per-run loop
 * turned one cheap directory read into a quadratic one.
 */
export function readWorkflowChildHeartbeats(root: string): Map<string, ChildHeartbeat[]> {
  const dir = join(root, ".harnery", "active");
  const byRun = new Map<string, ChildHeartbeat[]>();
  if (!existsSync(dir)) return byRun;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(join(dir, f), "utf8")) as ChildHeartbeat;
      if (!hb.workflow_run_id || !hb.session_id) continue;
      byRun.set(hb.workflow_run_id, [...(byRun.get(hb.workflow_run_id) ?? []), hb]);
    } catch {
      /* skip */
    }
  }
  return byRun;
}

/**
 * Every child harness session of a run, live and finished.
 *
 * Both sources are needed, and together they leave no gap: a live child appears
 * only in `.harnery/active/` (the journal does not learn its session id until
 * `agent.end`, because the harness mints the id and only reports it in the
 * result envelope), and a finished child appears only in the journal (its
 * heartbeat is deleted on session end).
 *
 * This is the join key for run-scoped activity: child sessions write ordinary
 * `tool.pre_use` / `tool.post_use` events to the run's coord root, so filtering
 * `events.ndjson` to these session ids yields what the run actually did.
 */
export function readWorkflowChildSessions(root: string, runId: string): WorkflowChildSession[] {
  const byId = new Map<string, WorkflowChildSession>();
  const heartbeats = readWorkflowChildHeartbeats(root);
  for (const hb of heartbeats.get(runId) ?? []) {
    if (!hb.session_id) continue;
    byId.set(hb.session_id, {
      sessionId: hb.session_id,
      agentId: hb.workflow_agent_id,
      live: !hb.ended_at,
    });
  }
  const run = readWorkflowRun(root, runId, heartbeats);
  for (const agent of run?.agents ?? []) {
    if (!agent.sessionId) continue;
    const existing = byId.get(agent.sessionId);
    // The journal is authoritative for which agent ran a session; the heartbeat
    // is authoritative for whether it is still running.
    byId.set(agent.sessionId, {
      sessionId: agent.sessionId,
      agentId: agent.id,
      live: existing?.live ?? false,
    });
  }
  return Array.from(byId.values());
}

export function readWorkflowRuns(root: string): WorkflowRunSummary[] {
  const dir = join(root, ".harnery", "workflows");
  if (!existsSync(dir)) return [];
  const runs: WorkflowRunSummary[] = [];
  const heartbeats = readWorkflowChildHeartbeats(root);
  for (const runId of readdirSync(dir)) {
    const run = readWorkflowRun(root, runId, heartbeats);
    if (run) runs.push(run);
  }
  // Newest first (run ids embed an ISO timestamp, but sort on startedAt to be safe).
  runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return runs;
}

export function readWorkflowRun(
  root: string,
  runId: string,
  /** Pre-read heartbeat index, so a list page scans `.harnery/active/` once
   * instead of once per run. Read on demand when omitted. */
  heartbeats?: Map<string, ChildHeartbeat[]>,
): WorkflowRunSummary | null {
  const journalPath = join(root, ".harnery", "workflows", runId, "journal.jsonl");
  if (!existsSync(journalPath)) return null;

  let mtimeIso = new Date(0).toISOString();
  try {
    mtimeIso = statSync(journalPath).mtime.toISOString();
  } catch {
    /* keep epoch */
  }

  const agents = new Map<string, WorkflowAgentRow>();
  const stages: string[] = [];
  let name = runId;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let runOk: boolean | undefined;
  let parkedApprovalId: string | undefined;
  let agentsCached = 0;
  let costUsd = 0;
  const billing: string[] = [];
  const proof = readProof(root, runId);
  const workspace = readWorkspaceInspection(root, runId);

  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: JournalLine;
    try {
      e = JSON.parse(line) as JournalLine;
    } catch {
      continue;
    }
    switch (e.event) {
      case "run.start":
        name = e.name ?? runId;
        startedAt = e.ts;
        break;
      case "run.parked":
        parkedApprovalId = e.approval_id;
        break;
      case "run.resume":
        parkedApprovalId = undefined;
        break;
      case "stage.start":
        if (e.title && !stages.includes(e.title)) stages.push(e.title);
        break;
      case "billing.probe":
        if (e.harness && e.mode) billing.push(`${e.harness}=${e.mode}`);
        break;
      case "agent.start":
        if (e.id) {
          agents.set(e.id, {
            id: e.id,
            label: e.label ?? e.id,
            stage: e.stage ?? "",
            harness: e.harness,
            model: e.model ?? null,
            status: "running",
            startedAt: e.ts,
          });
        }
        break;
      case "agent.end":
        if (e.id) {
          const row = agents.get(e.id);
          if (row) {
            row.status = "done";
            row.attempts = e.attempts;
            row.costUsd = e.total_cost_usd ?? e.cost_usd;
            row.durationMs = e.duration_ms;
            row.sessionId = e.session_id;
            row.endedAt = e.ts;
          }
          costUsd += e.total_cost_usd ?? e.cost_usd ?? 0;
        }
        break;
      case "agent.failed":
        if (e.id) {
          const row = agents.get(e.id);
          if (row) {
            row.status = "failed";
            row.endedAt = e.ts;
          }
        }
        break;
      case "agent.cached":
        agentsCached++;
        if (e.id) {
          agents.set(e.id, {
            id: e.id,
            label: e.label ?? e.id,
            stage: e.stage ?? "",
            status: "cached",
          });
        }
        break;
      case "run.end":
        endedAt = e.ts;
        runOk = e.ok;
        break;
      default:
        break;
    }
  }

  // A live child heartbeat outranks journal quiet. Journal mtime alone reported
  // a healthy run as STALE, because an agent that works for longer than
  // STALE_MS writes nothing between `agent.start` and `agent.end`. The quiet
  // is the work, not a dead orchestrator.
  const hbIndex = heartbeats ?? readWorkflowChildHeartbeats(root);
  const hasLiveChild = (hbIndex.get(runId) ?? []).some((hb) => !hb.ended_at);

  const status: WorkflowRunSummary["status"] = endedAt
    ? runOk
      ? "done"
      : "failed"
    : parkedApprovalId
      ? "parked"
      : hasLiveChild || Date.now() - Date.parse(mtimeIso) <= STALE_MS
        ? "running"
        : "stale";

  return {
    runId,
    name,
    startedAt,
    endedAt,
    status,
    parkedApprovalId,
    stages,
    agents: Array.from(agents.values()),
    agentsCached,
    costUsd: Math.round(costUsd * 10_000) / 10_000,
    billing,
    proof,
    workspace,
    lastActivityAt: mtimeIso,
  };
}

function readProof(root: string, runId: string): WorkflowProof | undefined {
  const path = join(root, ".harnery", "workflows", runId, "proof.json");
  if (!existsSync(path)) return undefined;
  try {
    const proof = JSON.parse(readFileSync(path, "utf8")) as WorkflowProof;
    return proof.schema_version === 1 && proof.run?.id === runId ? proof : undefined;
  } catch {
    return undefined;
  }
}

function readWorkspaceInspection(
  root: string,
  runId: string,
): WorkflowWorkspaceInspection | undefined {
  const path = join(root, ".harnery", "workflows", runId, "run.json");
  return existsSync(path) ? inspectWorkflowWorkspace(root, runId) : undefined;
}
