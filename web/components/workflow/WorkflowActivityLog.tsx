"use client";

import { useMemo } from "react";

import { useHostInfo } from "@/components/HostInfoProvider";
import { makeHookEventRenderer } from "@/components/log-table/event-renderers";
import { LogTable } from "@/components/log-table/LogTable";
import type { EventRow } from "@/lib/coord-reader";

interface Props {
  runId: string;
  initialRows: EventRow[];
  agentNames: string[];
  instanceToName: Record<string, string>;
  /** Override the empty state when the server knows why it is empty (e.g. the
   * checkout the run executed in no longer exists). */
  emptyStateHint?: string;
}

/**
 * Run-scoped activity log for `/workflows/[runId]`.
 *
 * The run transcript is a poor activity feed by construction. An agent that works
 * for eighteen minutes writes exactly two lines to it, one at each end. The
 * activity lives in the canonical V3 ledger instead. Workflow children receive
 * an engine-owned V3 generation even when their headless adapter emits no hooks.
 * `?run=` resolves the run root and filters the ledger by its workflow scope.
 *
 * Autoscroll, pause-on-scroll-away, search, and row expansion all come from the
 * shared <LogTable> unchanged; this binding only supplies the scope. The house
 * convention is newest-at-top, the same direction `/live` reads.
 */
export function WorkflowActivityLog({
  runId,
  initialRows,
  agentNames,
  instanceToName,
  emptyStateHint,
}: Props) {
  const { repoRoot } = useHostInfo();
  const renderer = useMemo(
    () => makeHookEventRenderer(instanceToName, repoRoot),
    [instanceToName, repoRoot],
  );
  return (
    <LogTable<EventRow>
      initialRows={initialRows}
      renderer={renderer}
      sseUrl="/api/events-stream"
      sseSearchParams={{ run: runId }}
      snapshotUrl={`/api/events?limit=500&run=${encodeURIComponent(runId)}`}
      agentNames={agentNames}
      emptyStateHint={
        emptyStateHint ??
        "No child activity recorded for this run. Its children either emitted nothing, or emitted before hooks were wired into workflow spawns."
      }
    />
  );
}
