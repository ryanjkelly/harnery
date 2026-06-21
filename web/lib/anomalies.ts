/**
 * Anomaly detector: surfaces patterns in heartbeats + session events that
 * suggest an agent is stuck, looping, or otherwise needs operator attention.
 *
 * Runs server-side on the dashboard. Heuristics, not absolutes; the goal is
 * to nudge the operator to look, not to take action automatically. Mirrors
 * the upstream app's lib/agents-coord/anomalies.ts, adapted for harnery's event
 * shape (event_type + data:Record).
 *
 * Heuristics today:
 *  - **stop_loop**: same `command_start` cmd repeated N+ times in a row in
 *    the last 5 minutes for one agent. Catches the stop-hook write-flush race.
 *  - **task_stale**: `task_updated_at` older than 30min while heartbeats are
 *    still arriving fresh: agent declaring a task at session start and
 *    never updating it.
 *  - **failed_commands**: ≥3 non-zero exits from one agent in a 2-minute
 *    window: usually means the agent is fighting one persistent error.
 */

import { readAgents, readEvents, type Heartbeat } from "./coord-reader";

export type AnomalySeverity = "info" | "warning";

export interface Anomaly {
  id: string;
  severity: AnomalySeverity;
  agent: string;
  /** Durable persona id, used by the banner to link to the agent's page. */
  agent_id?: string;
  kind: "stop_loop" | "task_stale" | "failed_commands";
  message: string;
  detail?: string;
}

interface AnomalyOptions {
  /** Lookback window in seconds for event-based heuristics. Default 600. */
  windowSeconds?: number;
  /** Lookback events to inspect. Default 600 (enough for active sessions). */
  events?: number;
}

export function detectAnomalies(opts: AnomalyOptions = {}): Anomaly[] {
  const { windowSeconds = 600, events: eventLimit = 600 } = opts;
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;

  const eventsResp = readEvents({ limit: eventLimit });
  const agents = readAgents();
  const all: Heartbeat[] = [...agents.active, ...agents.stale];
  const byInstance = new Map<string, Heartbeat>();
  for (const hb of all) byInstance.set(hb.instance_id, hb);

  // Bucket events by agent (resolved via instance_id → name).
  const byAgent = new Map<string, typeof eventsResp.rows>();
  for (const ev of eventsResp.rows) {
    if (new Date(ev.ts).getTime() < cutoff) continue;
    const hb = ev.instance_id ? byInstance.get(ev.instance_id) : null;
    const agentName = hb?.name ?? null;
    if (!agentName) continue;
    const arr = byAgent.get(agentName) ?? [];
    arr.push(ev);
    byAgent.set(agentName, arr);
  }

  const out: Anomaly[] = [];

  for (const [agent, evs] of byAgent.entries()) {
    const hb = all.find((h) => h.name === agent);
    const agent_id = hb?.instance_id;

    // ── Heuristic 1: repeated identical command_start in a row
    const recentStarts = evs
      .filter((e) => e.event_type === "command_start")
      .slice(-12)
      .reverse(); // readEvents returns newest-first; flip so oldest-first
    if (recentStarts.length >= 4) {
      const cmds = recentStarts.map((e) =>
        String((e.data?.cmd ?? "") as string).trim(),
      );
      const last = cmds[cmds.length - 1] ?? "";
      let streak = 0;
      for (let i = cmds.length - 1; i >= 0; i--) {
        if (cmds[i] === last && last.length > 0) streak++;
        else break;
      }
      if (streak >= 4) {
        out.push({
          id: `${agent}:stop_loop:${last.slice(0, 32)}`,
          severity: "warning",
          agent,
          agent_id,
          kind: "stop_loop",
          message: `${agent} ran the same command ${streak} times in a row`,
          detail: last.slice(0, 200),
        });
      }
    }

    // ── Heuristic 2: ≥3 non-zero exits in the window
    const failedEnds = evs.filter((e) => {
      if (e.event_type !== "command_end") return false;
      const exit = e.data?.exit;
      return typeof exit === "number" && exit !== 0;
    });
    if (failedEnds.length >= 3) {
      out.push({
        id: `${agent}:failed_commands`,
        severity: "warning",
        agent,
        agent_id,
        kind: "failed_commands",
        message: `${agent} had ${failedEnds.length} failed commands in the last ${Math.round(
          windowSeconds / 60,
        )} min`,
      });
    }
  }

  // ── Heuristic 3: heartbeat fresh but task_updated_at stale (≥30min)
  const STALE_TASK_SECONDS = 30 * 60;
  for (const hb of all) {
    if (!hb.task) continue;
    if (!hb.task_updated_at) continue;
    if (hb.age_seconds > 300) continue; // only flag active agents
    const taskAge = (now - new Date(hb.task_updated_at).getTime()) / 1000;
    if (taskAge < STALE_TASK_SECONDS) continue;
    const minutes = Math.round(taskAge / 60);
    out.push({
      id: `${hb.name}:task_stale`,
      severity: "info",
      agent: hb.name,
      agent_id: hb.instance_id,
      kind: "task_stale",
      message: `${hb.name}'s task hasn't been refreshed in ${minutes} min`,
      detail: hb.task,
    });
  }

  return out;
}
