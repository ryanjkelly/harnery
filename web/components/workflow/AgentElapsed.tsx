"use client";

import { useEffect, useState } from "react";

import { useFormatDateTime } from "@/components/FormattedDateTime";
import { Tooltip } from "@/components/ui/tooltip";
import { agentLiveness, HEARTBEAT_GRACE_MS } from "@/lib/agent-liveness";

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
 * This exists to show the absence of trouble. A run transcript records nothing
 * between an agent's start and end, so a page built only from transcript writes
 * draws a twenty-minute agent and a dead orchestrator exactly the same way. A
 * clock that visibly advances says the agent is working. A clock sitting next to
 * `no live session` says it is not.
 *
 * The clock starts on mount rather than during render, and that part matters.
 * Reading the wall clock while rendering makes the server's HTML and the
 * client's first pass disagree by however long the response took, which React
 * treats as a hydration mismatch and repairs by throwing the subtree away. Both
 * passes render the same placeholder, and only the effect introduces time.
 *
 * The start time in the tooltip goes through the operator's own datetime
 * preference and timezone, like every other timestamp in the dashboard.
 */
export function AgentElapsed({ startedAt, live }: Props) {
  const started = Date.parse(startedAt);
  const formatDateTime = useFormatDateTime();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    if (live) {
      const id = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(id);
    }
    // A row that is not live yet may just be young. Tick once more when the
    // grace window closes so it can move from starting to a real warning on its
    // own. After that, stop: a settled stall is frozen by definition, and
    // animating its clock would be a lie.
    const remaining = HEARTBEAT_GRACE_MS - (Date.now() - started);
    if (remaining <= 0) return;
    const id = window.setTimeout(() => setNow(Date.now()), remaining + 250);
    return () => window.clearTimeout(id);
  }, [live, started]);

  if (Number.isNaN(started)) return null;
  const elapsed = now === null ? "" : formatElapsed(now - started);

  if (!live) {
    // Before the first tick the elapsed time is unknown on both the server and
    // the client's first pass, so say nothing rather than guessing which of the
    // two states this is. The effect resolves it a frame later.
    const state = agentLiveness({ startedAt, live, now });
    if (state !== "stalled") {
      return (
        <Tooltip
          content={`Started ${formatDateTime(startedAt)}. A child session registers its heartbeat a beat after the agent starts, so a row this young has no live session yet without anything being wrong.`}
        >
          <span className="cursor-help text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{elapsed}</span>
            {state === "starting" && <span>{" starting…"}</span>}
          </span>
        </Tooltip>
      );
    }
    return (
      <Tooltip
        content={`Started ${formatDateTime(startedAt)} and transcripted as running, but no live child session has been registered for over ${Math.round(HEARTBEAT_GRACE_MS / 1000)}s. Either the agent is between attempts, or the orchestrator exited without writing agent.end.`}
      >
        <span className="cursor-help text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">{elapsed}</span>
          <span className="text-amber-600 dark:text-amber-400">{" no live session"}</span>
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      content={`Working since ${formatDateTime(startedAt)}. The clock advances while the agent's child session stays alive, so a long quiet stretch here is work rather than a hang.`}
    >
      <span className="inline-flex cursor-help items-center gap-1 text-xs text-sky-600 dark:text-sky-400">
        <span className="live-dot" />
        <span className="font-mono tabular-nums">{elapsed}</span>
      </span>
    </Tooltip>
  );
}
