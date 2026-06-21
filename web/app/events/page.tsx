import { AgentChipProvider } from "@/components/AgentChip";
import { EventsLogTable } from "@/components/log-table/EventsLogTable";
import { NavBar } from "@/components/NavBar";
import {
  buildAgentSummaryMap,
  buildEndedAgentSummaries,
  buildSubagentSummaries,
} from "@/lib/agent-summary";
import {
  coordRoot,
  readAgents,
  readEvents,
  readInstanceIdentities,
} from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Events · Harnery" };

interface PageProps {
  searchParams: Promise<{ limit?: string; type?: string; instance?: string }>;
}

/**
 * /events: canonical hook-event log from `.harnery/events.ndjson`.
 *
 * Server renders the most-recent N rows for first paint, then the client
 * subscribes to `/api/events-stream` for live appends. Both pages
 * (/events + /live) are SSE-driven for feature parity: same toolbar,
 * pause/clear buttons, same auto-scroll behavior.
 *
 * The whole page lives inside a `fixed inset-0 flex flex-col overflow-hidden`
 * shell so the only scroll surface is the log table itself.
 */
export default async function EventsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const limit = sp.limit ? Number(sp.limit) : 500;
  const type = sp.type ?? null;
  const instanceId = sp.instance ?? null;
  const data = readEvents({ limit, instanceId: instanceId ?? undefined });
  const snap = readAgents();

  // Durable instance_id → identity from session.start (main agents) +
  // subagent.start (Agent-tool dispatches). Unlike heartbeats, these persist in
  // the append-only log after a session ends, so a finished agent keeps its
  // name instead of reverting to a raw instance_id. One scan, shared with the
  // summary builders below.
  const identities = readInstanceIdentities();
  const instanceToName: Record<string, string> = {};
  for (const hb of [...snap.active, ...snap.stale]) {
    instanceToName[hb.instance_id] = hb.name;
  }
  // Live heartbeats win (freshest name); the durable log fills every agent that
  // has since exited (main sessions and subagents alike), so neither shows a
  // raw id in the agent column.
  for (const [iid, id] of Object.entries(identities)) {
    if (!instanceToName[iid]) instanceToName[iid] = id.name;
  }
  const namesInEvents = new Set<string>();
  for (const r of data.rows) {
    if (r.instance_id && instanceToName[r.instance_id]) {
      namesInEvents.add(instanceToName[r.instance_id]);
    }
  }
  const agentNames = Array.from(namesInEvents).sort();
  // Hover cards, lowest-priority first: ended main agents (session.start) and
  // subagents (subagent.start) from the durable log, then live/recent main
  // agents from heartbeats + scratch, which override the rest on any name
  // collision so a live agent always shows its richer card.
  const summaries = {
    ...buildEndedAgentSummaries(identities),
    ...buildSubagentSummaries(identities),
    ...buildAgentSummaryMap(agentNames, identities),
  };

  const initialAgentName = instanceId
    ? (instanceToName[instanceId] ?? null)
    : null;

  const allKinds = Array.from(
    new Set(data.rows.map((r) => r.event_type)),
  ).sort();

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} />
      <main className="flex-1 min-h-0 flex flex-col w-full px-6 pb-6">
        <header className="mb-4 flex items-baseline justify-between flex-wrap gap-3 shrink-0">
          <h1 className="text-xl font-semibold tracking-tight">Events</h1>
          <div className="text-xs text-muted-foreground flex items-center gap-3">
            <span>
              {data.meta.total_lines.toLocaleString()} events in buffer
            </span>
            <code className="font-mono text-muted-foreground/80">
              .harnery/events.ndjson
            </code>
          </div>
        </header>

        <AgentChipProvider summaries={summaries}>
          <EventsLogTable
            initialRows={data.rows}
            agentNames={agentNames}
            instanceToName={instanceToName}
            initialAgent={initialAgentName}
            initialKind={type}
            knownKinds={allKinds}
          />
        </AgentChipProvider>
      </main>
    </div>
  );
}
