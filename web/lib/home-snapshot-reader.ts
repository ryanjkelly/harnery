import {
  buildAgentSummaryMap,
  buildEndedAgentSummaries,
  buildSubagentSummaries,
} from "./agent-summary";
import { detectAnomalies } from "./anomalies";
import { readAgents, readEvents, readInstanceIdentities } from "./coord-reader";

/** Assemble homepage data inside the dashboard reader worker. */
export function readHomeSnapshot() {
  const snap = readAgents();
  // 30-minute activity window. 600 events is enough to populate the lanes
  // even on busy multi-agent days (~20 events/min ceiling per agent).
  const recentEvents = readEvents({ limit: 600 });
  const anomalies = detectAnomalies({}, snap, recentEvents);
  const identities = readInstanceIdentities();
  const instanceToName: Record<string, string> = {};
  for (const hb of [...snap.active, ...snap.stale, ...snap.terminal]) {
    instanceToName[hb.instance_id] = hb.name;
  }
  // Fill in agents whose session has ended (heartbeat gone) from the durable
  // canonical V3 session ledger; otherwise the timeline silently drops
  // their events: ActivityTimeline skips any instance_id it can't name.
  for (const [iid, id] of Object.entries(identities)) {
    if (!instanceToName[iid]) instanceToName[iid] = id.name;
  }

  // Hover-card data for every name surfaced on the page (timeline lanes +
  // active/stale cards). Same layering as the live page: ended/subagent
  // summaries from the durable log first, live summaries override on collision.
  const agentNames = Array.from(new Set(Object.values(instanceToName))).sort();
  const summaries = {
    ...buildEndedAgentSummaries(identities),
    ...buildSubagentSummaries(identities, snap),
    ...buildAgentSummaryMap(agentNames, identities, snap),
  };

  return { snap, recentEvents, identities, anomalies, instanceToName, summaries };
}

export type HomeSnapshot = ReturnType<typeof readHomeSnapshot>;
