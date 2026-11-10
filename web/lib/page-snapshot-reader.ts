import {
  buildAgentSummaryMap,
  buildEndedAgentSummaries,
  buildSubagentSummaries,
} from "./agent-summary";
import { readAgents, readEvents, readInstanceIdentities } from "./coord-reader";

export interface EventsPageOptions {
  limit: number;
  instanceId?: string;
}

/** Keep the initial table and all hover-card assembly in the reader worker. */
export function readEventsPageSnapshot(options: EventsPageOptions) {
  const data = readEvents(options);
  const snap = readAgents();
  const identities = readInstanceIdentities();
  const instanceToName: Record<string, string> = {};
  for (const hb of [...snap.active, ...snap.stale]) {
    instanceToName[hb.instance_id] = hb.name;
  }
  // Current names win; durable identities retain names for ended sessions.
  for (const [iid, identity] of Object.entries(identities)) {
    if (!instanceToName[iid]) instanceToName[iid] = identity.name;
  }
  const namesInEvents = new Set<string>();
  for (const row of data.rows) {
    if (row.instance_id && instanceToName[row.instance_id]) {
      namesInEvents.add(instanceToName[row.instance_id]);
    }
  }
  const agentNames = Array.from(namesInEvents).sort();
  // Live summaries override historical and subagent cards on name collisions.
  const summaries = {
    ...buildEndedAgentSummaries(identities),
    ...buildSubagentSummaries(identities, snap),
    ...buildAgentSummaryMap(agentNames, identities, snap),
  };
  const allKinds = Array.from(new Set(data.rows.map((row) => row.event_type))).sort();
  return { data, agentNames, instanceToName, summaries, allKinds };
}

export type EventsPageSnapshot = ReturnType<typeof readEventsPageSnapshot>;
