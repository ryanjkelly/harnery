"use client";

import { useEffect, useState } from "react";

import { Tooltip } from "@/components/ui/tooltip";

interface Props {
  /** `agent.start` ts. */
  startedAt: string;
  /** A child heartbeat for this run is alive, so the quiet is work in progress
   * rather than an orchestrator that died. */
  live: boolean;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Ticking elapsed time for an agent that is still in flight.
 *
 * The point is negative information: a run journal records nothing between an
 * agent's start and end, so a page built only from journal writes shows a
 * twenty-minute agent and a dead orchestrator identically. A clock that visibly
 * advances says "this is work"; a clock next to `no live session` says the
 * opposite. Rendered client-side because the elapsed value has to keep moving
 * after the server response is sent.
 */
export function AgentElapsed({ startedAt, live }: Props) {
  const started = Date.parse(startedAt);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    // Only a live agent needs a ticking clock; a stalled row is frozen by
    // definition, so leave its last value alone rather than animating a lie.
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  if (Number.isNaN(started)) return null;
  const elapsed = formatElapsed(now - started);

  if (!live) {
    return (
      <Tooltip content="Journaled as running, but no live child session is registered for this run. Either the agent is between attempts or the orchestrator exited without writing agent.end.">
        <span className="text-xs text-muted-foreground">
          {elapsed} · <span className="text-amber-600 dark:text-amber-400">no live session</span>
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={`Working since ${new Date(started).toLocaleTimeString()}`}>
      <span className="inline-flex items-center gap-1 text-xs text-sky-600 dark:text-sky-400">
        <span className="live-dot" />
        <span className="font-mono tabular-nums">{elapsed}</span>
      </span>
    </Tooltip>
  );
}
