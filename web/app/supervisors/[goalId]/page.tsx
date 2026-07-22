import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/NavBar";
import { SupervisorStateBadge } from "@/components/SupervisorStateBadge";
import { WorkStateBadge } from "@/components/WorkStateBadge";
import { Badge } from "@/components/ui/badge";
import { coordRoot } from "@/lib/coord-reader";
import {
  readSupervisorBackgroundService,
  readSupervisorGoal,
} from "@/lib/supervisor-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ goalId: string }>;
}

export default async function SupervisorGoalPage({ params }: PageProps) {
  const { goalId } = await params;
  const root = coordRoot();
  const decodedGoalId = decodeURIComponent(goalId);
  const record = readSupervisorGoal(root, decodedGoalId);
  if (!record) notFound();
  const { intent, projection, work } = record;
  const service = readSupervisorBackgroundService(root);
  const serviceRuntime = service.runtime?.goals[intent.id];
  const enrolled = service.config?.goal_ids.includes(intent.id) ?? false;
  return (
    <div className="min-h-screen">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <p className="mb-3 text-xs">
          <Link href="/supervisors" className="text-muted-foreground hover:text-foreground">
            ← all goals
          </Link>
        </p>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <SupervisorStateBadge state={projection.state} />
          <h1 className="text-xl font-semibold">{intent.title}</h1>
        </div>
        <p className="mb-6 text-xs text-muted-foreground">
          {intent.id} · root {intent.root_work_id} · next: {projection.next_action}
        </p>

        <section className="mb-8 rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Current decision</h2>
          <p className="mt-2 text-sm">{projection.reason}</p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>{projection.work_ids.length} work items</span>
            <span>
              {projection.attempts_used}/{intent.limits.max_total_attempts} attempts
            </span>
            <span>{projection.specialists.length} specialists</span>
          </div>
          {projection.attention_work.length ? (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
              Attention: {projection.attention_work.join(", ")}
            </p>
          ) : null}
        </section>

        <section className="mb-8 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Background wake state</h2>
            <Badge variant={enrolled ? (service.running ? "info" : "warning") : "muted"}>
              {enrolled ? (service.running ? "enrolled · live" : "enrolled · stopped") : "not enrolled"}
            </Badge>
          </div>
          {serviceRuntime ? (
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Wake state</dt>
                <dd>{serviceRuntime.state.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Service errors</dt>
                <dd>{serviceRuntime.consecutive_errors}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last tick result</dt>
                <dd>{serviceRuntime.last_stop_reason ?? "not run"}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Enroll this goal with <code>harn supervisor service start {intent.id}</code>.
            </p>
          )}
          {serviceRuntime?.last_error ? (
            <p className="mt-3 text-xs text-red-700 dark:text-red-300">
              {serviceRuntime.last_error}
            </p>
          ) : null}
        </section>

        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold">Work graph</h2>
          <ul className="space-y-2">
            {work.map(({ intent: workIntent, projection: workProjection }) => (
              <li
                key={workIntent.id}
                className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <WorkStateBadge state={workProjection.state} />
                  <Link
                    href={`/work/${encodeURIComponent(workIntent.id)}`}
                    className="font-medium hover:underline"
                  >
                    {workIntent.title}
                  </Link>
                  {workIntent.id === intent.root_work_id ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      root
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {workIntent.id} · {workProjection.attempts_used}/{workIntent.max_attempts} attempts
                  · next: {workProjection.next_action}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-8 rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Specialist team</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {Object.entries(intent.specialists).map(([id, profile]) => (
              <li key={id} className="rounded bg-muted/50 px-3 py-2">
                <span className="font-medium">{id}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {profile.harness ?? "default harness"}
                  {profile.model ? ` · ${profile.model}` : ""}
                  {profile.effort ? ` · ${profile.effort}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Frozen automation</h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Accept passing proof</dt>
              <dd>{String(intent.automation.accept_passing_proof)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Resume approved</dt>
              <dd>{String(intent.automation.resume_approved)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Retry blocked</dt>
              <dd>{String(intent.automation.retry_blocked)}</dd>
            </div>
          </dl>
        </section>
      </main>
    </div>
  );
}
