"use client";

import { useMemo } from "react";

import { useHostInfo } from "@/components/HostInfoProvider";
import { LogTable } from "@/components/log-table/LogTable";
import { makeHookEventRenderer } from "@/components/log-table/event-renderers";
import type { EventRow } from "@/lib/coord-reader";

interface Props {
  initialRows: EventRow[];
  agentNames: string[];
  instanceToName: Record<string, string>;
  initialAgent?: string | null;
  initialKind?: string | null;
  knownKinds?: string[];
}

/**
 * /events client shell: wraps `<LogTable>` with the hook-event renderer
 * and the live SSE stream `/api/events-stream`.
 *
 * Server pre-renders the initial 500 rows for first paint; the SSE snapshot
 * replaces them on connect so SSR + live state stay in sync. After that,
 * each new event appended to `.harnery/events.ndjson` streams in as it
 * lands.
 */
export function EventsLogTable({
  initialRows,
  agentNames,
  instanceToName,
  initialAgent,
  initialKind,
  knownKinds,
}: Props) {
  const { repoRoot } = useHostInfo();
  const renderer = useMemo(
    () => makeHookEventRenderer(instanceToName, repoRoot),
    [instanceToName, repoRoot],
  );
  return (
    <LogTable
      initialRows={initialRows}
      renderer={renderer}
      sseUrl="/api/events-stream"
      snapshotUrl="/api/events?limit=500"
      agentNames={agentNames}
      initialAgent={initialAgent}
      initialKind={initialKind}
      knownKinds={knownKinds}
      emptyStateHint="No hook events yet. Anything an agent does (tool calls, prompts, turn boundaries) lands here once .harnery/events.ndjson has been written."
    />
  );
}
