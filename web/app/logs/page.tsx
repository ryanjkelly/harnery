import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { LogFlow } from "@/components/log-flow/LogFlow";
import { cn } from "@/lib/cn";
import { coordRoot } from "@/lib/coord-reader";
import { readLogFlowSnapshot } from "@/lib/log-flow-reader";
import { TONE } from "@/lib/tone";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Log flow · Harnery" };

export default function LogsPage() {
  const root = coordRoot();
  const snapshot = readLogFlowSnapshot(root);
  return (
    <PageShell width="wide">
      <PageHeader
        title="Log flow"
        meta={
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
              TONE.done.pill,
            )}
          >
            <span
              className={cn("size-1.5 rounded-full shadow-[0_0_10px_currentColor]", TONE.done.dot)}
            />
            LIVE
          </span>
        }
        description="Structured log events enter at the right edge and move left through one lane per family. Color identifies the source; shape and glow identify severity."
        actions={
          <span className="font-mono">
            {snapshot.lanes.length} families · {snapshot.totalRecords} recent records
          </span>
        }
      />
      <LogFlow initialSnapshot={snapshot} />
    </PageShell>
  );
}
