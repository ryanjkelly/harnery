import { describe, expect, test } from "bun:test";
import { describeRunCost } from "./workflow-cost";
import type { WorkflowRunSummary } from "./workflow-reader";

function run(over: Partial<WorkflowRunSummary>): WorkflowRunSummary {
  return {
    runId: "wf-1",
    name: "run",
    status: "running",
    stages: [],
    agents: [],
    agentsCached: 0,
    costUsd: 0,
    billing: [],
    lastActivityAt: new Date().toISOString(),
    ...over,
  };
}

describe("describeRunCost", () => {
  test("a finished run states its total plainly", () => {
    const { label } = describeRunCost(
      run({ status: "done", endedAt: "2026-07-25T00:00:00Z", costUsd: 3.0395 }),
    );
    expect(label).toBe("$3.0395");
  });

  test("a running run with nothing finished says pending rather than zero", () => {
    // $0.0000 here would read as "this run was free", which is a different and
    // false claim: the harness has simply not reported yet.
    const { label } = describeRunCost(run({ status: "running", costUsd: 0 }));
    expect(label).toBe("cost pending");
  });

  test("a running run with a finished agent marks its total as partial", () => {
    const { label } = describeRunCost(run({ status: "running", costUsd: 1.5 }));
    expect(label).toBe("$1.5000 so far");
  });

  test("a stale run is not pending, because nothing more will arrive", () => {
    // Its orchestrator died without writing run.end. Calling that "pending"
    // implies a number is on the way.
    expect(describeRunCost(run({ status: "stale", costUsd: 0 })).label).toBe("cost unreported");
    expect(describeRunCost(run({ status: "stale", costUsd: 2.25 })).label).toBe(
      "$2.2500 before it stopped",
    );
  });

  test("every state explains itself on hover", () => {
    for (const r of [
      run({ status: "done", endedAt: "2026-07-25T00:00:00Z", costUsd: 1 }),
      run({ status: "running", costUsd: 0 }),
      run({ status: "running", costUsd: 1 }),
      run({ status: "stale", costUsd: 0 }),
      run({ status: "stale", costUsd: 1 }),
    ]) {
      expect(describeRunCost(r).hint.length).toBeGreaterThan(20);
    }
  });
});
