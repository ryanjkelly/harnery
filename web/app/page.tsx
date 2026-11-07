import { ActivityTimeline } from "@/components/ActivityTimeline";
import { AgentCard } from "@/components/AgentCard";
import { AgentChipProvider } from "@/components/AgentChip";
import { AnomalyBanner } from "@/components/AnomalyBanner";
import { ClaimsTable } from "@/components/ClaimsTable";
import { EmptyState } from "@/components/layout/EmptyState";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Section } from "@/components/layout/Section";
import { readDashboard } from "@/lib/dashboard-reader";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { snap, recentEvents, anomalies, instanceToName, summaries } = await readDashboard("home");

  return (
    <AgentChipProvider summaries={summaries}>
      {/* Global chrome shows the coord root like every other page; the
          heartbeat scan dir (`.harnery/active`) is a dashboard detail. */}
      <PageShell width="wide">
        <PageHeader
          title="Agents coordination"
          actions={
            <>
              <span>
                <strong className="text-foreground">{snap.active.length}</strong> active
              </span>
              <span>
                <strong className="text-foreground">{snap.stale.length}</strong> stale
              </span>
              <span>
                <strong className="text-foreground">{snap.terminal.length}</strong> terminal
              </span>
              <span>
                <strong className="text-foreground">{snap.claims.length}</strong> claims
              </span>
            </>
          }
        />

        <AnomalyBanner anomalies={anomalies} />

        <div className="mb-6">
          <ActivityTimeline
            initialEvents={recentEvents.rows}
            instanceToName={instanceToName}
            windowMinutes={30}
          />
        </div>

        {!snap.meta.read_state.ok && (
          <Notice tone="danger" title="Cannot read the coordination ledger" className="mb-6">
            <p className="font-mono text-xs">{snap.meta.read_state.reason}</p>
            <p className="mt-1 text-xs">
              Agents may be running even though none are listed. A web build older than the ledger
              is the usual cause; rebuild and restart this server.
            </p>
          </Notice>
        )}

        {snap.meta.invalid.length > 0 && (
          <Notice
            tone="warn"
            title={`${snap.meta.invalid.length} invalid heartbeat(s) skipped`}
            className="mb-6"
          >
            <ul className="font-mono text-xs">
              {snap.meta.invalid.map((iv) => (
                <li key={iv.file}>
                  <span className="text-muted-foreground">{iv.file}</span>: {iv.issue}
                </li>
              ))}
            </ul>
          </Notice>
        )}

        <Section title="Active">
          {snap.active.length === 0 ? (
            <EmptyState>No active agents.</EmptyState>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {snap.active.map((hb) => (
                <AgentCard key={hb.instance_id} hb={hb} stale={false} />
              ))}
            </div>
          )}
        </Section>

        {snap.stale.length > 0 && (
          <Section
            title={`Stale (≥ ${snap.meta.stale_threshold_seconds / 60}m since last heartbeat)`}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {snap.stale.map((hb) => (
                <AgentCard key={hb.instance_id} hb={hb} stale={true} />
              ))}
            </div>
          </Section>
        )}

        {snap.terminal.length > 0 && (
          <Section title="Terminal">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 opacity-75">
              {snap.terminal.map((hb) => (
                <AgentCard key={hb.generation_id ?? hb.instance_id} hb={hb} stale={false} />
              ))}
            </div>
          </Section>
        )}

        <Section title="File claims" className="mb-0">
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <ClaimsTable claims={snap.claims} />
          </div>
        </Section>
      </PageShell>
    </AgentChipProvider>
  );
}
