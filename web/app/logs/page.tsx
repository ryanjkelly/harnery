import { LogFlow } from "@/components/log-flow/LogFlow";
import { NavBar } from "@/components/NavBar";
import { coordRoot } from "@/lib/coord-reader";
import { readLogFlowSnapshot } from "@/lib/log-flow-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Log flow · Harnery" };

export default function LogsPage() {
  const root = coordRoot();
  const snapshot = readLogFlowSnapshot(root);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <NavBar scannedDir={root} />
      <main className="mx-auto w-full max-w-screen-2xl px-3 pb-12 sm:px-6">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">Log flow</h1>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_10px_currentColor]" />
                LIVE
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              Structured log events enter at the right edge and move left through one lane per
              family. Color identifies the source; shape and glow identify severity.
            </p>
          </div>
          <div className="text-right font-mono text-xs text-muted-foreground">
            {snapshot.lanes.length} families · {snapshot.totalRecords} recent records
          </div>
        </header>
        <LogFlow initialSnapshot={snapshot} />
      </main>
    </div>
  );
}
