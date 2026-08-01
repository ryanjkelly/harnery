import type { WorkflowRunSummary } from "./workflow-reader";

/**
 * How to state a run's cost without overclaiming.
 *
 * A adapter reports what an agent cost only when that agent finishes, so a run
 * with nothing finished yet has no cost to report. Printing `$0.0000` there says
 * something different and false: that the run was free. The four states are
 * genuinely different claims and the label says which one it is.
 *
 * `stale` matters as much as `running`. Its orchestrator died without writing
 * `run.end`, so no further cost will ever arrive; calling that "pending" implies
 * a number is on the way. Five such runs sat in one repo, each of which really
 * did spend nothing observable, but none of which was ever going to report.
 */
export function describeRunCost(run: WorkflowRunSummary): { label: string; hint: string } {
  const amount = `$${run.costUsd.toFixed(4)}`;

  if (run.endedAt) {
    return {
      label: amount,
      hint: "Total cost of every agent in this run, summed from each agent.end.",
    };
  }

  if (run.status === "stale") {
    return run.costUsd > 0
      ? {
          label: `${amount} before it stopped`,
          hint: "What the agents that finished had cost. This run never wrote run.end, so its orchestrator most likely died and no further cost will arrive.",
        }
      : {
          label: "cost unreported",
          hint: "No agent of this run ever reported a cost, and none will: the run never wrote run.end, so its orchestrator most likely died. This is not a claim that the run was free.",
        };
  }

  return run.costUsd > 0
    ? {
        label: `${amount} so far`,
        hint: "Cost of the agents that have finished. Agents still working report nothing until they end, so this number only grows.",
      }
    : {
        label: "cost pending",
        hint: "No cost reported yet. A adapter reports an agent's cost only when it finishes, so a run whose first agent is still working has nothing to show. This is not a claim that the run is free.",
      };
}
