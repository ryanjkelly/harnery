
import { ActivityTimeline } from "@/components/ActivityTimeline";
import { AgentCard } from "@/components/AgentCard";
import { AgentChipProvider } from "@/components/AgentChip";
import { AnomalyBanner } from "@/components/AnomalyBanner";
import { ClaimsTable } from "@/components/ClaimsTable";
import { NavBar } from "@/components/NavBar";
import {
  buildAgentSummaryMap,
  buildEndedAgentSummaries,
  buildSubagentSummaries,
} from "@/lib/agent-summary";
import { detectAnomalies } from "@/lib/anomalies";
import {
  readAgents,
  readEvents,
  readInstanceIdentities,
} from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const snap = readAgents();
  const anomalies = detectAnomalies();
  // 30-minute activity window. 600 events is enough to populate the lanes
  // even on busy multi-agent days (~20 events/min ceiling per agent).
  const recentEvents = readEvents({ limit: 600 });
  const identities = readInstanceIdentities();
  const instanceToName: Record<string, string> = {};
  for (const hb of [...snap.active, ...snap.stale]) {
    instanceToName[hb.instance_id] = hb.name;
  }
  // Fill in agents whose session has ended (heartbeat gone) from the durable
  // session.start / subagent.start log; otherwise the timeline silently drops
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
    ...buildSubagentSummaries(identities),
    ...buildAgentSummaryMap(agentNames, identities),
  };

  return (
    <AgentChipProvider summaries={summaries}>
      <NavBar scannedDir={snap.meta.scanned_dir} />
      <main className="w-full max-w-screen-2xl mx-auto px-6 pb-10">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">
            Agents coordination
          </h1>
          <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 items-center">
            <span>
              <strong className="text-foreground">{snap.active.length}</strong>{" "}
              active
            </span>
            <span>
              <strong className="text-foreground">{snap.stale.length}</strong>{" "}
              stale
            </span>
            <span>
              <strong className="text-foreground">{snap.claims.length}</strong>{" "}
              claims
            </span>
          </div>
        </header>

        <AnomalyBanner anomalies={anomalies} />

        <div className="mb-6">
          <ActivityTimeline
            initialEvents={recentEvents.rows}
            instanceToName={instanceToName}
            windowMinutes={30}
          />
        </div>

        {snap.meta.invalid.length > 0 && (
          <div className="card p-3 mb-6 border-yellow-900 bg-yellow-950/40 text-yellow-200 text-sm">
            <strong>
              {snap.meta.invalid.length} invalid heartbeat(s) skipped
            </strong>
            <ul className="mt-1 font-mono text-xs">
              {snap.meta.invalid.map((iv) => (
                <li key={iv.file}>
                  <span className="text-muted-foreground">{iv.file}</span>:{" "}
                  {iv.issue}
                </li>
              ))}
            </ul>
          </div>
        )}

        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
            Active
          </h2>
          {snap.active.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No active agents.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {snap.active.map((hb) => (
                <AgentCard key={hb.instance_id} hb={hb} stale={false} />
              ))}
            </div>
          )}
        </section>

        {snap.stale.length > 0 && (
          <section className="mb-8">
            <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
              Stale (≥ {snap.meta.stale_threshold_seconds / 60}m since last
              heartbeat)
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 opacity-60">
              {snap.stale.map((hb) => (
                <AgentCard key={hb.instance_id} hb={hb} stale={true} />
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
            File claims
          </h2>
          <div className="card overflow-x-auto">
            <ClaimsTable claims={snap.claims} />
          </div>
        </section>
      </main>
    </AgentChipProvider>
  );
}
