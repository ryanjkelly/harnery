import { Plus } from "lucide-react";
import Link from "next/link";

import { AgentChipProvider } from "@/components/AgentChip";
import { CouncilCard } from "@/components/CouncilCard";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Section } from "@/components/layout/Section";
import { hostInfo } from "@/lib/config";
import type { CouncilSummary } from "@/lib/coord-reader";
import { readDashboard } from "@/lib/dashboard-reader";

export const dynamic = "force-dynamic";

export default async function CouncilsPage() {
  const { snap, summaries } = await readDashboard("councilsPage");

  return (
    <AgentChipProvider summaries={summaries}>
      <PageShell width="wide">
        <PageHeader
          title="Councils"
          actions={
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex gap-3">
                <span>
                  <strong className="text-foreground">{snap.active.length}</strong> active
                </span>
                <span>
                  <strong className="text-foreground">{snap.closed.length}</strong> closed
                </span>
                <span>
                  <strong className="text-foreground">{snap.archived.length}</strong> archived
                </span>
              </div>
              <Link
                href="/councils/new"
                className="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-2.5 text-[0.8rem] font-medium h-11 sm:h-7 hover:bg-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Plus className="size-3.5" />
                New council
              </Link>
            </div>
          }
        />

        <CouncilSection title="Active" councils={snap.active} archived={false} emptyHint />
        <CouncilSection title="Closed" councils={snap.closed} archived={false} />
        <CouncilSection title="Archived" councils={snap.archived} archived={true} />

        {snap.meta.count === 0 && <EmptyState>No councils yet.</EmptyState>}
      </PageShell>
    </AgentChipProvider>
  );
}

function CouncilSection({
  title,
  councils,
  archived,
  emptyHint,
}: {
  title: string;
  councils: CouncilSummary[];
  archived: boolean;
  emptyHint?: boolean;
}) {
  if (councils.length === 0) {
    if (!emptyHint) return null;
    return (
      <Section title={title}>
        <EmptyState>
          No active councils. Convene one via{" "}
          <Link href="/councils/new" className="underline hover:text-foreground">
            New council
          </Link>{" "}
          (web member-picker) or{" "}
          <code className="font-mono text-xs">
            {`${hostInfo().binName} council create "..." --member A --member B --member C`}
          </code>
          .
        </EmptyState>
      </Section>
    );
  }
  return (
    <Section title={title}>
      <div className={`grid grid-cols-1 lg:grid-cols-2 gap-3 ${archived ? "opacity-90" : ""}`}>
        {councils.map((c) => (
          <CouncilCard key={c.council_id} council={c} archived={archived} />
        ))}
      </div>
    </Section>
  );
}
