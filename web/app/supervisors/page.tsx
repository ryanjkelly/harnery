import Link from "next/link";
import { NavBar } from "@/components/NavBar";
import { SupervisorStateBadge } from "@/components/SupervisorStateBadge";
import { coordRoot } from "@/lib/coord-reader";
import { readSupervisors } from "@/lib/supervisor-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Goals · Harnery" };

export default function SupervisorsPage() {
  const records = readSupervisors(coordRoot());
  return (
    <div className="min-h-screen">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="mb-1 text-xl font-semibold">Durable goals</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Bounded specialist teams supervising static durable-work dependency graphs.
        </p>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No goals yet. Create one with <code>harn supervisor create</code>.
          </p>
        ) : (
          <ul className="space-y-2">
            {records.map(({ intent, projection }) => (
              <li key={intent.id}>
                <Link
                  href={`/supervisors/${encodeURIComponent(intent.id)}`}
                  className="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/25"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <SupervisorStateBadge state={projection.state} />
                    <span className="font-medium">{intent.title}</span>
                    <span className="text-xs text-muted-foreground">{intent.id}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{projection.work_ids.length} work items</span>
                    <span>
                      {projection.attempts_used}/{intent.limits.max_total_attempts} attempts
                    </span>
                    <span>next: {projection.next_action}</span>
                    <span>{projection.reason}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
