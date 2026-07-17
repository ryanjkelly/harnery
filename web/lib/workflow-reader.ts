import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
}

export interface WorkflowRunSummary {
  runId: string;
  name: string;
  startedAt?: string;
  endedAt?: string;
  status: "running" | "done" | "failed" | "stale";
  stages: string[];
  agents: WorkflowAgentRow[];
  agentsCached: number;
  costUsd: number;
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
  attempts?: number;
  cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  ok?: boolean;
  error?: string;
}

/** A run with no journal writes for this long, and no run.end, is "stale"
 * (orchestrator likely killed) rather than "running". */
const STALE_MS = 10 * 60 * 1000;

/** Live workflow children for a run: heartbeats in `.harnery/active/` whose
 * `workflow_run_id` matches. Session-id keyed so the detail page can badge
 * journal rows whose child session is still alive. */
export function readLiveChildSessions(root: string, runId: string): Set<string> {
  const dir = join(root, ".harnery", "active");
  const live = new Set<string>();
  if (!existsSync(dir)) return live;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        workflow_run_id?: string;
        session_id?: string;
        ended_at?: string;
      };
      if (hb.workflow_run_id === runId && hb.session_id && !hb.ended_at) {
        live.add(hb.session_id);
      }
    } catch {
      /* skip */
    }
  }
  return live;
}

export function readWorkflowRuns(root: string): WorkflowRunSummary[] {
  const dir = join(root, ".harnery", "workflows");
  if (!existsSync(dir)) return [];
  const runs: WorkflowRunSummary[] = [];
  for (const runId of readdirSync(dir)) {
    const run = readWorkflowRun(root, runId);
    if (run) runs.push(run);
  }
  // Newest first (run ids embed an ISO timestamp, but sort on startedAt to be safe).
  runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return runs;
}

export function readWorkflowRun(root: string, runId: string): WorkflowRunSummary | null {
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
  let agentsCached = 0;
  let costUsd = 0;

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
      case "stage.start":
        if (e.title && !stages.includes(e.title)) stages.push(e.title);
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
          });
        }
        break;
      case "agent.end":
        if (e.id) {
          const row = agents.get(e.id);
          if (row) {
            row.status = "done";
            row.attempts = e.attempts;
            row.costUsd = e.cost_usd;
            row.durationMs = e.duration_ms;
            row.sessionId = e.session_id;
          }
          costUsd += e.cost_usd ?? 0;
        }
        break;
      case "agent.failed":
        if (e.id) {
          const row = agents.get(e.id);
          if (row) row.status = "failed";
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

  const status: WorkflowRunSummary["status"] = endedAt
    ? runOk
      ? "done"
      : "failed"
    : Date.now() - Date.parse(mtimeIso) > STALE_MS
      ? "stale"
      : "running";

  return {
    runId,
    name,
    startedAt,
    endedAt,
    status,
    stages,
    agents: Array.from(agents.values()),
    agentsCached,
    costUsd: Math.round(costUsd * 10_000) / 10_000,
    lastActivityAt: mtimeIso,
  };
}
