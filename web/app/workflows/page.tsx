import Link from "next/link";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkflowStatusBadge } from "@/components/WorkflowStatusBadge";
import { WorkspaceStateBadge } from "@/components/WorkspaceStateBadge";
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
                    {run.workspace ? <WorkspaceStateBadge inspection={run.workspace} /> : null}
                    <span className="font-medium">{run.name}</span>
                    <Tooltip content="Run id. Two runs of the same work item share a name, so this is what tells them apart.">
                      <span className="cursor-help font-mono text-xs text-muted-foreground">
                        {run.runId}
                      </span>
                    </Tooltip>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <Tooltip content="Agents this run dispatched. `0 agents` means it failed before spawning any, which usually points at the script or the policy rather than at the work. Cached agents were skipped because an identical call already had a result.">
                      <span className="cursor-help">
                        {run.agents.length} agent{run.agents.length === 1 ? "" : "s"}
                        {run.agentsCached > 0 ? ` (${run.agentsCached} cached)` : ""}
                      </span>
                    </Tooltip>
                    <Tooltip content="Total cost of every agent in the run. It stays at $0.0000 until the first agent finishes, because cost is only reported on completion.">
                      <span className="cursor-help">${run.costUsd.toFixed(4)}</span>
                    </Tooltip>
                    <Tooltip content="Stages in declared order. `no stages` means the script never reached a stage boundary.">
                      <span className="cursor-help">{run.stages.join(" → ") || "no stages"}</span>
                    </Tooltip>
                    {run.parkedApprovalId ? (
                      <Tooltip content="The run is parked on a durable approval and will not do further protected work until someone resolves it. Resolve with `workflow approvals`, then resume the run explicitly.">
                        <span className="cursor-help">approval {run.parkedApprovalId}</span>
                      </Tooltip>
                    ) : null}
                    {run.startedAt ? (
                      <Tooltip content="When the run started.">
                        <span className="cursor-help">
                          <FormattedDateTime iso={run.startedAt} />
                        </span>
                      </Tooltip>
                    ) : null}
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
