import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/NavBar";
import { WorkflowStatusBadge } from "@/components/WorkflowStatusBadge";
import { coordRoot } from "@/lib/coord-reader";
import { readWorkflowRun } from "@/lib/workflow-reader";

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
        </p>

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
                      <WorkflowStatusBadge status={a.status} />
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
