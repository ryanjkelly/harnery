import Link from "next/link";
import { NavBar } from "@/components/NavBar";
import { WorkflowStatusBadge } from "@/components/WorkflowStatusBadge";
import { coordRoot } from "@/lib/coord-reader";
import { readWorkflowRuns } from "@/lib/workflow-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Workflows · Harnery" };

/**
 * /workflows: journal-driven list of workflow runs. The globally-mounted
 * LiveRefresher re-renders on coord-layer change (workflow children emit
 * canonical events), so a running fan-out updates without bespoke polling.
 */
export default function WorkflowsPage() {
  const runs = readWorkflowRuns(coordRoot());

  return (
    <div className="min-h-screen">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="mb-1 text-xl font-semibold">Workflow runs</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Bounded, schema-gated multi-subagent runs from{" "}
          <code className="text-xs">workflow run</code>. Journals live in{" "}
          <code className="text-xs">.harnery/workflows/</code>.
        </p>

        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs yet. Start one with <code>workflow run &lt;script&gt;</code>.
          </p>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.runId}>
                <Link
                  href={`/workflows/${encodeURIComponent(run.runId)}`}
                  className="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/25"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <WorkflowStatusBadge status={run.status} />
                    <span className="font-medium">{run.name}</span>
                    <span className="text-xs text-muted-foreground">{run.runId}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {run.agents.length} agent{run.agents.length === 1 ? "" : "s"}
                      {run.agentsCached > 0 ? ` (${run.agentsCached} cached)` : ""}
                    </span>
                    <span>${run.costUsd.toFixed(4)}</span>
                    <span>{run.stages.join(" → ") || "no stages"}</span>
                    {run.parkedApprovalId ? <span>approval {run.parkedApprovalId}</span> : null}
                    {run.startedAt ? <span>{new Date(run.startedAt).toLocaleString()}</span> : null}
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
