import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/NavBar";
import { WorkStateBadge } from "@/components/WorkStateBadge";
import { coordRoot } from "@/lib/coord-reader";
import { readDurableWorkItem } from "@/lib/work-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ workId: string }>;
}

export default async function WorkItemPage({ params }: PageProps) {
  const { workId } = await params;
  const record = readDurableWorkItem(coordRoot(), decodeURIComponent(workId));
  if (!record) notFound();
  const { intent, projection, events } = record;
  return (
    <div className="min-h-screen">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <p className="mb-3 text-xs">
          <Link href="/work" className="text-muted-foreground hover:text-foreground">
            ← all work
          </Link>
        </p>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <WorkStateBadge state={projection.state} />
          <h1 className="text-xl font-semibold">{intent.title}</h1>
        </div>
        <p className="mb-6 text-xs text-muted-foreground">
          {intent.id} · {projection.attempts_used}/{intent.max_attempts} attempts · next:{" "}
          {projection.next_action}
        </p>

        <section className="mb-8 rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Objective</h2>
          <p className="mt-2 text-sm">{intent.objective}</p>
          <p className="mt-3 text-xs text-muted-foreground">{projection.reason}</p>
          {intent.acceptance.length ? (
            <>
              <h3 className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Acceptance
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {intent.acceptance.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          ) : null}
          {intent.dependencies.length ? (
            <>
              <h3 className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Dependencies
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {intent.dependencies.map((dependency) => (
                  <li key={dependency}>
                    <Link
                      href={`/work/${encodeURIComponent(dependency)}`}
                      className="hover:underline"
                    >
                      {dependency}
                    </Link>
                    {projection.unresolved_dependencies.includes(dependency)
                      ? " · unresolved"
                      : " · satisfied"}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        {projection.approval_id ? (
          <section className="mb-8 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <h2 className="text-sm font-semibold">Approval</h2>
            <code className="mt-2 block break-all text-xs">{projection.approval_id}</code>
            <code className="mt-1 block break-all text-xs">
              harn workflow approvals show {projection.approval_id}
            </code>
          </section>
        ) : null}

        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold">Attempts</h2>
          {projection.attempts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No attempts yet.</p>
          ) : (
            <ul className="space-y-2">
              {projection.attempts.map((attempt) => (
                <li
                  key={attempt.run_id}
                  className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Attempt {attempt.number}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {attempt.status}
                    </span>
                    <Link
                      href={`/workflows/${encodeURIComponent(attempt.run_id)}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {attempt.run_id}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="rounded-lg border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            Append-only history ({events.length})
          </summary>
          <ol className="mt-3 space-y-2 text-xs">
            {events.map((event) => (
              <li key={event.seq} className="rounded bg-muted/50 px-3 py-2">
                <span className="font-mono">
                  {event.seq}. {event.event}
                </span>{" "}
                · {event.actor} · {new Date(event.ts).toLocaleString()}
                {event.reason ? (
                  <span className="block pt-1 text-muted-foreground">{event.reason}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      </main>
    </div>
  );
}
