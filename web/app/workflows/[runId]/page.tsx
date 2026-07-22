import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/NavBar";
import { WorkflowStatusBadge } from "@/components/WorkflowStatusBadge";
import { coordRoot } from "@/lib/coord-reader";
import { readLiveChildSessions, readWorkflowRun } from "@/lib/workflow-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ runId: string }>;
}

/**
 * /workflows/[runId]: one run as a stages → agents tree, journal-driven so it
 * stays inspectable while the run is live and after the orchestrator exits.
 */
export default async function WorkflowRunPage({ params }: PageProps) {
  const { runId } = await params;
  const run = readWorkflowRun(coordRoot(), decodeURIComponent(runId));
  if (!run) notFound();
  const liveChildren = readLiveChildSessions(coordRoot(), run.runId);

  const byStage = new Map<string, typeof run.agents>();
  for (const a of run.agents) {
    const key = a.stage || "(no stage)";
    byStage.set(key, [...(byStage.get(key) ?? []), a]);
  }
  // Preserve declared stage order; agents with unknown stages append after.
  const orderedStages = [
    ...run.stages.filter((s) => byStage.has(s)),
    ...Array.from(byStage.keys()).filter((s) => !run.stages.includes(s)),
  ];

  return (
    <div className="min-h-screen">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <p className="mb-3 text-xs">
          <Link href="/workflows" className="text-muted-foreground hover:text-foreground">
            ← all runs
          </Link>
        </p>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <WorkflowStatusBadge status={run.status} />
          <h1 className="text-xl font-semibold">{run.name}</h1>
        </div>
        <p className="mb-6 text-xs text-muted-foreground">
          {run.runId}
          {run.startedAt ? ` · started ${new Date(run.startedAt).toLocaleString()}` : ""}
          {run.endedAt ? ` · ended ${new Date(run.endedAt).toLocaleString()}` : ""}
          {` · $${run.costUsd.toFixed(4)}`}
          {run.agentsCached > 0 ? ` · ${run.agentsCached} cached` : ""}
          {run.billing.length > 0 ? ` · billing: ${run.billing.join(", ")}` : ""}
        </p>

        {run.proof ? (
          <section className="mb-8 rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Run proof</h2>
              <span className="text-xs text-muted-foreground">
                {run.proof.acceptance.summary.satisfied} satisfied ·{" "}
                {run.proof.acceptance.summary.unsatisfied} unsatisfied ·{" "}
                {run.proof.acceptance.summary.unknown} unknown
              </span>
            </div>
            {run.proof.run.objective ? (
              <p className="mb-4 text-sm">{run.proof.run.objective}</p>
            ) : null}
            {run.proof.policy ? (
              <div className="mb-4 rounded-md border border-border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Policy: {run.proof.policy.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {run.proof.policy.summary.allowed} allowed · {run.proof.policy.summary.denied}{" "}
                    denied · {run.proof.policy.summary.asked} asked
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {run.proof.policy.isolation} · network {run.proof.policy.network_access}
                  </span>
                </div>
                {run.proof.policy.decisions.length > 0 ? (
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                      {run.proof.policy.decisions.length} decision
                      {run.proof.policy.decisions.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {run.proof.policy.decisions.map((decision) => (
                        <li key={decision.id} className="rounded bg-muted/50 px-2 py-1.5">
                          <span className="font-mono">{decision.id}</span> · {decision.verdict}
                          {decision.initial_verdict === "ask" ? " after ask" : ""} ·{" "}
                          {decision.phase} · {decision.request.action}
                          <span className="block break-all pt-0.5">{decision.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}
            {run.proof.acceptance.criteria.length > 0 ? (
              <ul className="mb-4 space-y-1">
                {run.proof.acceptance.criteria.map((criterion) => (
                  <li
                    key={criterion.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <WorkflowStatusBadge
                      status={
                        criterion.status === "satisfied"
                          ? "done"
                          : criterion.status === "unsatisfied"
                            ? "failed"
                            : "stale"
                      }
                    />
                    <span className="font-mono text-xs text-muted-foreground">{criterion.id}</span>
                    <span className="min-w-0 flex-1">{criterion.statement}</span>
                    {criterion.evidence_ids.length > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {criterion.evidence_ids.join(", ")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {run.proof.evidence.length > 0 ? (
              <div className="mb-4">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Evidence
                </h3>
                <ul className="space-y-1">
                  {run.proof.evidence.map((evidence) => (
                    <li
                      key={evidence.id}
                      className="rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {evidence.id}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {evidence.kind} · {evidence.status} · {evidence.source}
                        </span>
                        <span>{evidence.label}</span>
                      </div>
                      {evidence.summary ? (
                        <p className="mt-1 text-xs text-muted-foreground">{evidence.summary}</p>
                      ) : null}
                      {evidence.ref ? (
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {evidence.ref}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Repository: {run.proof.repository.before.branch ?? "unknown"} →{" "}
              {run.proof.repository.after.branch ?? "unknown"} · HEAD{" "}
              {run.proof.repository.before.head?.slice(0, 8) ?? "unknown"} →{" "}
              {run.proof.repository.after.head?.slice(0, 8) ?? "unknown"} ·{" "}
              {run.proof.repository.drift.dirty_paths_added.length} dirty added ·{" "}
              {run.proof.repository.drift.dirty_paths_cleared.length} cleared
            </p>
            {run.proof.unknowns.length > 0 ? (
              <details className="mt-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{run.proof.unknowns.length} unknowns</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {run.proof.unknowns.map((unknown, index) => (
                    <li key={`${unknown.code}-${unknown.agent_id ?? unknown.harness ?? index}`}>
                      {unknown.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}

        {orderedStages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents journaled yet.</p>
        ) : (
          <div className="space-y-6">
            {orderedStages.map((stageTitle) => (
              <section key={stageTitle}>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">── {stageTitle}</h2>
                <ul className="space-y-1">
                  {(byStage.get(stageTitle) ?? []).map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                    >
                      <WorkflowStatusBadge
                        status={a.sessionId && liveChildren.has(a.sessionId) ? "running" : a.status}
                      />
                      <span className="font-mono text-xs text-muted-foreground">{a.id}</span>
                      {a.harness ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {a.harness}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">{a.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {a.attempts !== undefined
                          ? `${a.attempts} attempt${a.attempts === 1 ? "" : "s"}`
                          : ""}
                        {a.durationMs !== undefined ? ` · ${Math.round(a.durationMs / 1000)}s` : ""}
                        {a.costUsd !== undefined ? ` · $${a.costUsd.toFixed(4)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
