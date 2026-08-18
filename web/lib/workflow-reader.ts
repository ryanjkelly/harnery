import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkflowProof } from "harnery/core/workflow";
import {
  inspectWorkflowWorkspace,
  type WorkflowWorkspaceInspection,
} from "harnery/core/workflow/workspaces/inspect";
import { readLiveCoordinationRows } from "../../src/core/agents/state/live-coordination-view";
import { stableScopeId } from "../../src/core/workflow/scope-id";

/**
 * Transcript-driven reader for workflow runs (`.harnery/workflows/<run-id>/
 * transcript.jsonl`). The transcript is the source of truth for run structure —
 * the V2 coordination projection only adds live color.
 */

export interface WorkflowAgentRow {
  id: string;
  label: string;
  stage: string;
  adapter?: string;
  model?: string | null;
  status: "running" | "done" | "failed" | "cached";
  attempts?: number;
  costUsd?: number;
  durationMs?: number;
  sessionId?: string;
  /** `agent.start` ts. The anchor for a live elapsed timer, which is the only
   * thing distinguishing a working agent from a hung one mid-run: a child that
   * works for 18 minutes writes nothing to the transcript between its two ends. */
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
  /** "adapter=mode" per adapter used (from billing.probe transcript events). */
  billing: string[];
  /** Terminal proof packet, absent for live and pre-proof runs. */
  proof?: WorkflowProof;
  /** Validated workspace projection, including an explicit error on bad authority. */
  workspace?: WorkflowWorkspaceInspection;
  /** Transcript mtime — the liveness signal for status=running vs stale. */
  lastActivityAt: string;
  /** Durable work item this run is an attempt at, from `run.json`. Absent for a
   * run launched directly from a script rather than against a work item. */
  workItemId?: string;
  /** Which attempt at that work item this run is, and what triggered it. */
  attempt?: { number?: number; trigger?: string };
}

interface TranscriptLine {
  ts?: string;
  event?: string;
  stage?: string;
  id?: string;
  label?: string;
  title?: string;
  name?: string;
  adapter?: string;
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

/** A run with no transcript writes for this long, and no run.end, is "stale"
 * (orchestrator likely killed) rather than "running". */
const STALE_MS = 10 * 60 * 1000;

/** One child adapter session belonging to a workflow run. */
export interface WorkflowChildSession {
  sessionId: string;
  /** The agent row this session ran, when known: from the heartbeat's
   * `workflow_agent_id` while live, or the transcript's `agent.end` once ended. */
  agentId?: string;
  /** A heartbeat for this session is present and unterminated. */
  live: boolean;
}

interface WorkflowChildGeneration {
  workflow_run_id?: string;
  workflow_agent_id?: string;
  session_id?: string;
  native_session_id?: string;
  ended_at?: string;
}

/**
 * Workflow-child V2 generations indexed by canonical run id.
 *
 * Read once per page render and shared across runs: the directory holds one
 * file per *active agent in the repo*, so re-scanning it inside a per-run loop
 * turned one cheap directory read into a quadratic one.
 */
export function readWorkflowChildGenerations(root: string): Map<string, WorkflowChildGeneration[]> {
  const byRun = new Map<string, WorkflowChildGeneration[]>();
  for (const row of readLiveCoordinationRows(root)) {
    if (!row.workflow_run_id || !row.session_id) continue;
    const generation: WorkflowChildGeneration = {
      workflow_run_id: row.workflow_run_id,
      workflow_agent_id: row.workflow_agent_id ?? row.agent_id,
      session_id: row.session_id,
      native_session_id: row.native_session_id,
    };
    byRun.set(row.workflow_run_id, [...(byRun.get(row.workflow_run_id) ?? []), generation]);
  }
  return byRun;
}

/**
 * Every child adapter session of a run, live and finished.
 *
 * Both sources are needed, and together they leave no gap: a live child appears
 * only in the V2 coordination projection (the transcript does not learn its session id until
 * `agent.end`, because the adapter mints the id and only reports it in the
 * result envelope), and a finished child appears only in the transcript (its
 * heartbeat is deleted on session end).
 *
 * This is the join key for run-scoped activity: child sessions write ordinary
 * canonical tool events to the run's coord root, so filtering
 * the V2 ledger to these generation bindings yields what the run actually did.
 */
export function readWorkflowChildSessions(
  root: string,
  runId: string,
  /** Root holding the children's V2 ledger, when the run executed in another checkout. */
  opts: { coordinationRoot?: string } = {},
): WorkflowChildSession[] {
  const byId = new Map<string, WorkflowChildSession>();
  const generations = readWorkflowChildGenerations(opts.coordinationRoot ?? root);
  for (const hb of generations.get(stableScopeId("run", runId)) ?? []) {
    const sessionId = hb.native_session_id ?? hb.session_id;
    if (!sessionId) continue;
    byId.set(sessionId, {
      sessionId,
      agentId: hb.workflow_agent_id,
      live: !hb.ended_at,
    });
  }
  const run = readWorkflowRun(root, runId, generations);
  for (const agent of run?.agents ?? []) {
    if (!agent.sessionId) continue;
    const existing = byId.get(agent.sessionId);
    // The transcript is authoritative for which agent ran a session; the V2 generation
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
  // Liveness comes from the heartbeats in the root a run actually executed in,
  // so a run driven from a sibling checkout is judged against its own children
  // rather than being called stale for the absence of local ones. Roots are
  // scanned once each: a repo has a handful of them across many runs.
  const generationsByRoot = new Map<string, Map<string, WorkflowChildGeneration[]>>();
  const generationsFor = (r: string): Map<string, WorkflowChildGeneration[]> => {
    const cached = generationsByRoot.get(r);
    if (cached) return cached;
    const fresh = readWorkflowChildGenerations(r);
    generationsByRoot.set(r, fresh);
    return fresh;
  };
  for (const runId of readdirSync(dir)) {
    const run = readWorkflowRun(root, runId, generationsFor(resolveRunCoordRoot(root, runId).root));
    if (run) runs.push(run);
  }
  // Newest first (run ids embed an ISO timestamp, but sort on startedAt to be safe).
  runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return runs;
}

export function readWorkflowRun(
  root: string,
  runId: string,
  /** Pre-read V2 generation index so a list page scans the ledger once per root. */
  generations?: Map<string, WorkflowChildGeneration[]>,
): WorkflowRunSummary | null {
  const transcriptPath = join(root, ".harnery", "workflows", runId, "transcript.jsonl");
  if (!existsSync(transcriptPath)) return null;

  let mtimeIso = new Date(0).toISOString();
  try {
    mtimeIso = statSync(transcriptPath).mtime.toISOString();
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
  const manifest = readRunManifestFacts(root, runId);

  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: TranscriptLine;
    try {
      e = JSON.parse(line) as TranscriptLine;
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
        if (e.adapter && e.mode) billing.push(`${e.adapter}=${e.mode}`);
        break;
      case "agent.start":
        if (e.id) {
          agents.set(e.id, {
            id: e.id,
            label: e.label ?? e.id,
            stage: e.stage ?? "",
            adapter: e.adapter,
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

  // A live child heartbeat outranks transcript quiet. Transcript mtime alone reported
  // a healthy run as STALE, because an agent that works for longer than
  // STALE_MS writes nothing between `agent.start` and `agent.end`. The quiet
  // is the work, not a dead orchestrator.
  const generationIndex = generations ?? readWorkflowChildGenerations(root);
  const hasLiveChild = (generationIndex.get(stableScopeId("run", runId)) ?? []).some(
    (generation) => !generation.ended_at,
  );

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
    workItemId: manifest.workItemId,
    attempt: manifest.attempt,
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

/**
 * Work item + attempt facts from the run manifest.
 *
 * Kept separate from the workspace inspection, which reads the same file for a
 * different purpose: these are plain identity fields, and a manifest that fails
 * workspace validation should still be able to say which attempt it was.
 */
function readRunManifestFacts(
  root: string,
  runId: string,
): { workItemId?: string; attempt?: { number?: number; trigger?: string } } {
  const path = join(root, ".harnery", "workflows", runId, "run.json");
  if (!existsSync(path)) return {};
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      work_item_id?: string;
      attempt_context?: { number?: number; trigger?: string };
    };
    const attempt = manifest.attempt_context;
    return {
      workItemId: manifest.work_item_id,
      // Only surface an attempt when it says something; early manifests carry
      // a work item with no attempt context at all.
      attempt:
        attempt && (attempt.number !== undefined || attempt.trigger !== undefined)
          ? { number: attempt.number, trigger: attempt.trigger }
          : undefined,
    };
  } catch {
    return {};
  }
}

/** Where a run's child activity lives, and how confidently we know it. */
export interface RunCoordRoot {
  /** Repo root whose `.harnery/` holds this run's child events. */
  root: string;
  /** The resolved root is not the one the dashboard is scanning. */
  foreign: boolean;
  /** `execution.cwd` from the manifest, when it recorded one. */
  recordedCwd?: string;
  /**
   * Why the local root was used instead of the recorded one.
   *
   * `cwd-missing` is the one worth showing an operator: the run really did
   * execute somewhere else and that somewhere is gone, so its activity is
   * unrecoverable rather than merely elsewhere. The other two are ordinary.
   */
  fallback?: "no-cwd" | "cwd-missing" | "no-coord-root";
}

/** How far up from the run's cwd to look for an enclosing `.harnery/`. Matches
 * the depth `coordRoot()` walks. */
const COORD_ROOT_WALK_LIMIT = 8;

/**
 * Resolve the coord root that holds a run's child events.
 *
 * A workflow child writes its events to whichever coord root it runs in, which
 * is not always the root holding the run transcript: a run driven from a sibling
 * checkout, a submodule, or a temporary workspace transcripts here and emits
 * there. Reading the local stream for such a run finds nothing, which the page
 * used to present as "this run did nothing".
 *
 * The recorded cwd is a directory, not a coord root, so this walks up from it
 * the same way `coordRoot()` does. When that walk comes up empty the local root
 * is the right answer and not a consolation prize: a run whose cwd sits outside
 * any checkout was transcripted here because the orchestrator's own root was here.
 */
export function resolveRunCoordRoot(localRoot: string, runId: string): RunCoordRoot {
  const manifestPath = join(localRoot, ".harnery", "workflows", runId, "run.json");
  let cwd: string | undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      execution?: { cwd?: string };
    };
    cwd = manifest.execution?.cwd?.trim() || undefined;
  } catch {
    // No manifest, or unreadable. Local root, no explanation owed.
  }
  if (!cwd) return { root: localRoot, foreign: false, fallback: "no-cwd" };
  if (!existsSync(cwd)) {
    return { root: localRoot, foreign: false, recordedCwd: cwd, fallback: "cwd-missing" };
  }
  let dir = cwd;
  for (let i = 0; i < COORD_ROOT_WALK_LIMIT; i++) {
    if (existsSync(join(dir, ".harnery"))) {
      return { root: dir, foreign: dir !== localRoot, recordedCwd: cwd };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: localRoot, foreign: false, recordedCwd: cwd, fallback: "no-coord-root" };
}

function readWorkspaceInspection(
  root: string,
  runId: string,
): WorkflowWorkspaceInspection | undefined {
  const path = join(root, ".harnery", "workflows", runId, "run.json");
  return existsSync(path) ? inspectWorkflowWorkspace(root, runId) : undefined;
}
