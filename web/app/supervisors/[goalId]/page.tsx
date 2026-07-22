import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/NavBar";
import { SupervisorStateBadge } from "@/components/SupervisorStateBadge";
import { Badge } from "@/components/ui/badge";
import { WorkStateBadge } from "@/components/WorkStateBadge";
import { coordRoot } from "@/lib/coord-reader";
import { readSupervisorBackgroundService, readSupervisorGoal } from "@/lib/supervisor-reader";

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
  const { intent, projection, work, plans } = record;
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
          {intent.id} · active root {projection.root_work_id} · next: {projection.next_action}
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
            {intent.replanning ? (
              <span>
                generation {projection.plan_generation} · {projection.replans_used}/
                {intent.replanning.max_replans} replans
              </span>
            ) : null}
          </div>
          {projection.attention_work.length ? (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
              Attention: {projection.attention_work.join(", ")}
            </p>
          ) : null}
        </section>

        {intent.replanning ? (
          <section className="mb-8">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">Replanning history</h2>
              <Badge variant={intent.replanning.auto_apply ? "warning" : "muted"}>
                {intent.replanning.auto_apply ? "automatic application" : "review required"}
              </Badge>
            </div>
            {plans.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No replanning attempts. The planner runs only after the active graph has no legal
                progress action.
              </p>
            ) : (
              <ul className="space-y-2">
                {[...plans].reverse().map((plan) => (
                  <li
                    key={plan.request.id}
                    className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          plan.status === "applied"
                            ? "success"
                            : plan.status === "proposed" || plan.status === "awaiting_approval"
                              ? "warning"
                              : plan.status === "failed" || plan.status === "rejected"
                                ? "destructive"
                                : "muted"
                        }
                      >
                        {plan.status.replaceAll("_", " ")}
                      </Badge>
                      <span className="font-medium">{plan.request.id}</span>
                      <span className="text-xs text-muted-foreground">
                        generation request {plan.request.sequence}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      prior root {plan.request.prior_root_work_id} · planner run{" "}
                      {plan.request.workflow_run_id}
                    </p>
                    {plan.reason ? <p className="mt-2 text-xs">{plan.reason}</p> : null}
                    {plan.proposal?.work.length ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {plan.proposal.work.length} proposed work item
                        {plan.proposal.work.length === 1 ? "" : "s"} · proposed root{" "}
                        {plan.proposal.root}
                      </p>
                    ) : null}
                    {plan.status === "proposed" ? (
                      <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                        Review with{" "}
                        <code>
                          harn supervisor plan show {intent.id} {plan.request.id}
                        </code>
                        , then approve or reject it explicitly.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <section className="mb-8 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Background wake state</h2>
            <Badge variant={enrolled ? (service.running ? "info" : "warning") : "muted"}>
              {enrolled
                ? service.running
                  ? "enrolled · live"
                  : "enrolled · stopped"
                : "not enrolled"}
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
                  {workIntent.id === projection.root_work_id ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      active root
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {workIntent.id} · {workProjection.attempts_used}/{workIntent.max_attempts}{" "}
                  attempts · next: {workProjection.next_action}
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
            {intent.replanning ? (
              <>
                <div>
                  <dt className="text-xs text-muted-foreground">Planner specialist</dt>
                  <dd>{intent.replanning.planner_specialist}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Apply proposals</dt>
                  <dd>{intent.replanning.auto_apply ? "automatically" : "after review"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Template catalog</dt>
                  <dd>{Object.keys(intent.replanning.templates).length} frozen templates</dd>
                </div>
              </>
            ) : null}
          </dl>
        </section>
      </main>
    </div>
  );
}
