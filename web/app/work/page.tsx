import Link from "next/link";
import { NavBar } from "@/components/NavBar";
import { WorkStateBadge } from "@/components/WorkStateBadge";
import { coordRoot } from "@/lib/coord-reader";
import { readDurableWork } from "@/lib/work-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Work · Harnery" };

export default function WorkPage() {
  const records = readDurableWork(coordRoot());
  return (
    <div className="min-h-screen">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="mb-1 text-xl font-semibold">Durable work</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Objectives that survive across workflow attempts. Current state is derived from immutable
          intent, append-only events, approvals, and run proof.
        </p>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No durable work yet. Create one with <code>harn work create</code>.
          </p>
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
      </main>
    </div>
  );
}
