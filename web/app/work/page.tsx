import Link from "next/link";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { WorkStateBadge } from "@/components/WorkStateBadge";
import { hostInfo } from "@/lib/config";
import { coordRoot } from "@/lib/coord-reader";
import { readDurableWork } from "@/lib/work-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Work · Harnery" };

export default function WorkPage() {
  const records = readDurableWork(coordRoot());
  const { binName } = hostInfo();
  return (
    <PageShell>
      <PageHeader
        title="Work"
        description="Durable objectives that survive across workflow attempts. Current state is derived from immutable intent, append-only events, approvals, and run proof."
      />
      {records.length === 0 ? (
        <EmptyState>
          No durable work yet. Create one with <code>{binName} work create</code>.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {records.map(({ intent, projection }) => (
            <li key={intent.id}>
              <Link
                href={`/work/${encodeURIComponent(intent.id)}`}
                className="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/25"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <WorkStateBadge state={projection.state} />
                  <span className="font-medium">{intent.title}</span>
                  <span className="text-xs text-muted-foreground">{intent.id}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {projection.attempts_used}/{intent.max_attempts} attempts
                  </span>
                  <span>next: {projection.next_action}</span>
                  <span>{projection.reason}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
