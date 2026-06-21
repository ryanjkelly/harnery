"use client";

import { useMemo } from "react";

import { useHostInfo } from "@/components/HostInfoProvider";
import { LogTable } from "@/components/log-table/LogTable";
import { makeSessionEventRenderer } from "@/components/log-table/event-renderers";
import type { SessionEvent } from "@/lib/session-events";

interface Props {
  agentNames: string[];
  initialAgent?: string | null;
  /** Forwarded to the renderer so session events whose producer wrote
   * `agent_name: "unknown"` still resolve to the right name when the
   * `instance_id` matches an active or stale heartbeat. */
  instanceToName: Record<string, string>;
}

/**
 * /live client shell: wraps `<LogTable>` with the session-event renderer
 * and an SSE-driven live append source.
 *
 * Unlike `/events` (where the server pre-renders the initial 500 rows), the
 * snapshot here comes from the SSE endpoint's `snapshot` envelope. That
 * keeps the two code paths (initial load + appended-event) walking through
 * the same parse + rendering pipeline.
 */
export function LiveLogTable({
  agentNames,
  initialAgent,
  instanceToName,
}: Props) {
  const { binName } = useHostInfo();
  const renderer = useMemo(
    () => makeSessionEventRenderer(instanceToName),
    [instanceToName],
  );
  return (
    <LogTable<SessionEvent>
      initialRows={[]}
      renderer={renderer}
      sseUrl="/api/live-events"
      snapshotUrl="/api/session-events?lines=1000"
      agentNames={agentNames}
      initialAgent={initialAgent}
      emptyStateHint={`No events yet. Run \`${binName} session "..." -- <cmd>\` to produce some.`}
    />
  );
}
