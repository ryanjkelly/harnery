import Link from "next/link";
import { AgentChipProvider } from "@/components/AgentChip";
import { EventsLogTable } from "@/components/log-table/EventsLogTable";
import { NavBar } from "@/components/NavBar";
import { coordRoot } from "@/lib/coord-reader";
import { readDashboard } from "@/lib/dashboard-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Events · Harnery" };

interface PageProps {
  searchParams: Promise<{ limit?: string; type?: string; instance?: string; q?: string }>;
}

/**
 * /events: canonical V3 event-ledger view.
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
  const q = sp.q ?? null;
  const { data, agentNames, instanceToName, summaries, allKinds } = await readDashboard(
    "eventsPage",
    { limit, instanceId: instanceId ?? undefined },
  );

  const initialAgentName = instanceId ? (instanceToName[instanceId] ?? null) : null;

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <NavBar scannedDir={coordRoot()} />
      <main className="flex-1 min-h-0 flex flex-col w-full px-6 pb-6">
        <header className="mb-4 flex items-baseline justify-between flex-wrap gap-3 shrink-0">
          <h1 className="text-xl font-semibold tracking-tight">Events</h1>
          <div className="text-xs text-muted-foreground flex items-center gap-3">
            <span>{data.meta.total_lines.toLocaleString()} events in buffer</span>
            <code className="font-mono text-muted-foreground/80">Event Ledger V3</code>
            <Link href="/live" className="underline hover:text-foreground">
              commands-only view →
            </Link>
          </div>
        </header>

        <AgentChipProvider summaries={summaries}>
          <EventsLogTable
            initialRows={data.rows}
            agentNames={agentNames}
            instanceToName={instanceToName}
            initialAgent={initialAgentName}
            initialSearch={q}
            initialKind={type}
            knownKinds={allKinds}
          />
        </AgentChipProvider>
      </main>
    </div>
  );
}
