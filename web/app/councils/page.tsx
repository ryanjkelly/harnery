import { Plus } from "lucide-react";
import Link from "next/link";

import { AgentChipProvider } from "@/components/AgentChip";
import { CouncilCard } from "@/components/CouncilCard";
import { NavBar } from "@/components/NavBar";
import { type CouncilSummary, coordRoot } from "@/lib/coord-reader";
import { readDashboard } from "@/lib/dashboard-reader";

export const dynamic = "force-dynamic";

export default async function CouncilsPage() {
  const { snap, summaries } = await readDashboard("councilsPage");

  return (
    <AgentChipProvider summaries={summaries}>
      <NavBar scannedDir={coordRoot()} />
      <main className="w-full max-w-screen-2xl mx-auto px-6 pb-10">
        <header className="mb-6 flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-xl font-semibold tracking-tight">Councils</h1>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="text-xs text-muted-foreground flex gap-3">
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
        </header>

        <Section title="Active" councils={snap.active} archived={false} emptyHint />
        <Section title="Closed" councils={snap.closed} archived={false} />
        <Section title="Archived" councils={snap.archived} archived={true} />

        {snap.meta.count === 0 && (
          <p className="text-sm text-muted-foreground italic">No councils yet.</p>
        )}
      </main>
    </AgentChipProvider>
  );
}

function Section({
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
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground italic">
          No active councils. Convene one via{" "}
          <Link href="/councils/new" className="underline hover:text-foreground">
            New council
          </Link>{" "}
          (web member-picker) or{" "}
          <code className="font-mono text-xs">
            harn agents council create &quot;...&quot; --member A --member B --member C
          </code>
          .
        </p>
      </section>
    );
  }
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
        {title}
      </h2>
      <div className={`grid grid-cols-1 lg:grid-cols-2 gap-3 ${archived ? "opacity-90" : ""}`}>
        {councils.map((c) => (
          <CouncilCard key={c.council_id} council={c} archived={archived} />
        ))}
      </div>
    </section>
  );
}
