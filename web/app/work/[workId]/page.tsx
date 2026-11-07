import Link from "next/link";
import { notFound } from "next/navigation";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Eyebrow, Section, SectionHeader } from "@/components/layout/Section";
import { Badge } from "@/components/ui/badge";
import { WorkStateBadge } from "@/components/WorkStateBadge";
import { cn } from "@/lib/cn";
import { coordRoot } from "@/lib/coord-reader";
import { TONE } from "@/lib/tone";
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
    <PageShell>
      <PageHeader
        back={{ href: "/work", label: "all work" }}
        title={intent.title}
        meta={<WorkStateBadge state={projection.state} />}
        description={
          <>
            {intent.id} · {projection.attempts_used}/{intent.max_attempts} attempts · next:{" "}
            {projection.next_action}
          </>
        }
      />

      <section className="mb-8 rounded-lg border border-border bg-card p-4">
        <SectionHeader className="mb-0" title="Objective" />
        <p className="mt-2 text-sm">{intent.objective}</p>
        <p className="mt-3 text-xs text-muted-foreground">{projection.reason}</p>
        {intent.acceptance.length ? (
          <>
            <Eyebrow role="heading" aria-level={3} className="mt-5">
              Acceptance
            </Eyebrow>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {intent.acceptance.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        ) : null}
        {intent.dependencies.length ? (
          <>
            <Eyebrow role="heading" aria-level={3} className="mt-5">
              Dependencies
            </Eyebrow>
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
        <section className={cn("mb-8 rounded-lg border p-4", TONE.warn.surface)}>
          <SectionHeader className="mb-0" title="Approval" />
          <code className="mt-2 block break-all text-xs">{projection.approval_id}</code>
          <code className="mt-1 block break-all text-xs">
            harn workflow approvals show {projection.approval_id}
          </code>
        </section>
      ) : null}

      <Section title="Attempts">
        {projection.attempts.length === 0 ? (
          <EmptyState>No attempts yet.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {projection.attempts.map((attempt) => (
              <li
                key={attempt.run_id}
                className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Attempt {attempt.number}</span>
                  <Badge tone="neutral">{attempt.status}</Badge>
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
      </Section>

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
              · {event.actor} · <FormattedDateTime iso={event.ts} />
              {event.reason ? (
                <span className="block pt-1 text-muted-foreground">{event.reason}</span>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </PageShell>
  );
}
