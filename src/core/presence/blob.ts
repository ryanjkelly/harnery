/**
 * Presence blob: the per-machine payload published to
 * `refs/harnery/presence/<machine>` (ADR 0016). One blob describes every live
 * session on this machine; peers render it in their agents list / status box /
 * peer table, labeled by machine.
 */

import { createHash } from "node:crypto";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { readLiveCoordinationRows } from "../agents/state/live-coordination-view.ts";
import type { AgentActivity, TaskState } from "../agents/state/session-state.ts";

/** Mirror of the local heartbeat freshness window (commands/agents.ts). */
const FRESHNESS_SECS = 600;

/** Caps that bound the blob to ~1-2KB regardless of local state. */
const MAX_AGENTS = 20;
const MAX_FILES_PER_AGENT = 10;

export interface PresenceAgent {
  instance_id: string;
  name?: string;
  kind?: string;
  session_id?: string;
  platform?: string;
  task?: string;
  activity: AgentActivity;
  task_state: TaskState;
  task_state_reason?: string;
  files_touched?: string[];
  started_at?: string;
  last_heartbeat?: string;
}

export interface PresenceBlob {
  v: 1;
  machine: string;
  published_at: string;
  agents: PresenceAgent[];
}

export interface BuiltBlob {
  blob: PresenceBlob;
  /** Stable hash of the semantically-relevant projection — the change
   * detector that decides whether a publish is worth a push. */
  basisHash: string;
  json: string;
}

/**
 * Build this machine's presence blob from the authority-safe V2 projection.
 * Includes live sessions + subagents; excludes kind=transient stubs (they are
 * fold-artifacts of the local claim model, not sessions) and anything past the
 * freshness window.
 */
export function buildPresenceBlob(coordRoot: string, now: Date = new Date()): BuiltBlob {
  const machine = resolveMachineLabel();
  const agents: PresenceAgent[] = [];
  const cutoffMs = now.getTime() - FRESHNESS_SECS * 1000;

  for (const row of readLiveCoordinationRows(coordRoot)) {
    if (row.kind === "transient") continue;
    const ts = Date.parse(row.last_heartbeat);
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    agents.push({
      instance_id: row.instance_id,
      name: strOr(row.name),
      kind: strOr(row.kind),
      session_id: strOr(row.session_id),
      platform: strOr(row.platform),
      task: strOr(row.task),
      activity: activityOrUnknown(row.activity),
      task_state: taskStateOrActive(row.task_state),
      task_state_reason: clamp(strOr(row.task_state_reason), 160),
      files_touched: row.files_touched.slice(0, MAX_FILES_PER_AGENT),
      started_at: strOr(row.started_at),
      last_heartbeat: row.last_heartbeat,
    });
  }

  agents.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const capped = agents.slice(0, MAX_AGENTS);

  const blob: PresenceBlob = {
    v: 1,
    machine,
    published_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    agents: capped,
  };

  // Basis: the fields whose change should trigger a re-publish. Timestamps
  // Observation timestamps are excluded as pure churn; task/lifecycle/files
  // are the signals peers actually read.
  const basis = capped.map((a) => ({
    i: a.instance_id,
    n: a.name ?? null,
    k: a.kind ?? null,
    t: a.task ?? null,
    a: a.activity,
    l: a.task_state,
    r: a.task_state_reason ?? null,
    f: [...(a.files_touched ?? [])].sort(),
  }));
  const basisHash = createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);

  return { blob, basisHash, json: JSON.stringify(blob) };
}

function strOr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function activityOrUnknown(v: unknown): AgentActivity {
  return v === "working" || v === "needs_input" || v === "idle" ? v : "unknown";
}

function taskStateOrActive(v: unknown): TaskState {
  return v === "blocked" || v === "done" ? v : "active";
}

function clamp(v: string | undefined, max: number): string | undefined {
  if (!v) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}
