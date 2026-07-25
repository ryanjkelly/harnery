"use client";

import { useMemo } from "react";

import { useHostInfo } from "@/components/HostInfoProvider";
import { LogTable } from "@/components/log-table/LogTable";
import { makeHookEventRenderer } from "@/components/log-table/event-renderers";
import type { EventRow } from "@/lib/coord-reader";

interface Props {
  runId: string;
  initialRows: EventRow[];
  agentNames: string[];
  instanceToName: Record<string, string>;
}

/**
 * Run-scoped activity log for `/workflows/[runId]`.
 *
 * The run journal is a poor activity feed by construction — an agent that works
 * for eighteen minutes writes exactly two lines to it, one at each end. The
 * activity is in the coordination stream instead: workflow children run with
 * hooks on, so each one emits ordinary `tool.pre_use` / `tool.post_use` rows to
 * the run's coord root, tagged with its own session id. `?run=` on the events
 * endpoints filters `events.ndjson` down to this run's child sessions, which is
 * what makes the page worth watching at all.
 *
 * Autoscroll, pause-on-scroll-away, search, and row expansion all come from the
 * shared <LogTable> unchanged; this binding only supplies the scope. Note the
 * house convention is newest-at-top, the same direction `/live` reads.
 */
export function WorkflowActivityLog({ runId, initialRows, agentNames, instanceToName }: Props) {
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
      emptyStateHint="No child activity recorded for this run. Workflow children emit to the coord root they run in, so a run executed in another checkout keeps its activity there."
    />
  );
}
