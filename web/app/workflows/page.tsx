import Link from "next/link";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkflowStatusBadge } from "@/components/WorkflowStatusBadge";
import { WorkspaceStateBadge } from "@/components/WorkspaceStateBadge";
import { coordRoot } from "@/lib/coord-reader";
import { describeRunCost } from "@/lib/workflow-cost";
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

  /*
   * Repeat attempts at the same work item look identical in this list: same
   * name, different timestamp and run id. One work item in this repo has five,
   * and telling them apart meant reading run ids. Runs arrive newest-first, so
   * the first occurrence of a work item is its latest attempt.
   */
  const attemptsPerItem = new Map<string, number>();
  for (const r of runs) {
    if (!r.workItemId) continue;
    attemptsPerItem.set(r.workItemId, (attemptsPerItem.get(r.workItemId) ?? 0) + 1);
  }
  const latestSeen = new Set<string>();
  const isLatestAttempt = new Map<string, boolean>();
  for (const r of runs) {
    if (!r.workItemId) continue;
    isLatestAttempt.set(r.runId, !latestSeen.has(r.workItemId));
    latestSeen.add(r.workItemId);
  }

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
                    {run.workItemId && (attemptsPerItem.get(run.workItemId) ?? 0) > 1 ? (
                      <Tooltip
                        content={`${
                          run.attempt?.number !== undefined
                            ? `Attempt ${run.attempt.number} of ${attemptsPerItem.get(run.workItemId)}`
                            : `One of ${attemptsPerItem.get(run.workItemId)} attempts, in a manifest written before attempts were numbered`
                        } at work item ${run.workItemId}${
                          run.attempt?.trigger ? `, triggered by ${run.attempt.trigger}` : ""
                        }.${
                          isLatestAttempt.get(run.runId)
                            ? " This is the most recent attempt."
                            : " A later attempt exists, so this one is history."
                        }`}
                      >
                        <span
                          className={
                            isLatestAttempt.get(run.runId)
                              ? "cursor-help rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-xs text-sky-600 dark:text-sky-400"
                              : "cursor-help rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                          }
                        >
                          {run.attempt?.number !== undefined
                            ? `attempt ${run.attempt.number}/${attemptsPerItem.get(run.workItemId)}`
                            : `one of ${attemptsPerItem.get(run.workItemId)} attempts`}
                          {isLatestAttempt.get(run.runId) ? " · latest" : ""}
                        </span>
                      </Tooltip>
                    ) : null}
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
                    <Tooltip content={describeRunCost(run).hint}>
                      <span className="cursor-help">{describeRunCost(run).label}</span>
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
