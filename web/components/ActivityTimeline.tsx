"use client";

import { useEffect, useMemo, useState } from "react";

import { AgentChip } from "@/components/AgentChip";
import { useDateTimeFormat } from "@/components/DateTimeFormatProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EventRow } from "@/lib/coord-reader";
import { describeEventV3 } from "@/lib/event-v3-display";
import { NO_DATA } from "@/lib/format/no-data";
import { formatTemplate } from "@/lib/format/template";

interface Props {
  /** Initial server-rendered events. LiveRefresher fires router.refresh()
   * on coord-state changes so the parent re-renders with fresh props. */
  initialEvents: EventRow[];
  /** Map of instance_id → agent name for resolving lanes. */
  instanceToName: Record<string, string>;
  /** Window in minutes shown on the timeline. */
  windowMinutes?: number;
}

interface AgentLane {
  agent_name: string;
  events: TimelineDot[];
}

interface TimelineDot {
  ts: number;
  kind:
    | "action_started"
    | "action_completed_ok"
    | "action_completed_fail"
    | "narration"
    | "session"
    | "task";
  label?: string;
}

/**
 * Cross-agent activity timeline. One horizontal lane per agent, dots placed
 * along the lane by time. Color encodes event type. Hover reveals the cmd
 * or tool. Useful for "what is everyone doing right now" at a glance.
 *
 * Uses the shared V3 display projection, so this page and `/events` cannot
 * drift into separate event-name or payload interpretations.
 */
export function ActivityTimeline({ initialEvents, instanceToName, windowMinutes = 30 }: Props) {
  const [mounted, setMounted] = useState(false);
  const [tick, setTick] = useState(0);
  const prefs = useDateTimeFormat();
  const userTz = prefs.timezone;

  useEffect(() => {
    setMounted(true);
    // Refresh window-end every 15s so dots slide out of the window over time.
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const { lanes, windowEnd, windowStart } = useMemo(() => {
    const latestEventTs = initialEvents.length
      ? Math.max(...initialEvents.map((e) => new Date(e.ts).getTime()))
      : 0;
    const windowEnd = mounted ? Date.now() : latestEventTs || 0;
    const windowStart = windowEnd - windowMinutes * 60_000;
    const byAgent = new Map<string, TimelineDot[]>();
    for (const ev of initialEvents) {
      const ts = new Date(ev.ts).getTime();
      if (ts < windowStart || ts > windowEnd) continue;
      const agent = ev.instance_id ? instanceToName[ev.instance_id] : null;
      if (!agent) continue;

      const display = describeEventV3(ev);
      const kind = display.timeline_kind;
      if (!kind) continue;
      const label = display.summary;
      const arr = byAgent.get(agent) ?? [];
      arr.push({ ts, kind, label });
      byAgent.set(agent, arr);
    }
    const lanes: AgentLane[] = Array.from(byAgent.entries())
      .map(([agent_name, dots]) => ({ agent_name, events: dots }))
      .sort((a, b) => a.agent_name.localeCompare(b.agent_name));
    return { lanes, windowEnd, windowStart };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEvents, windowMinutes, mounted, tick]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-baseline justify-between gap-2">
          <span>Activity timeline ({windowMinutes}m)</span>
          <span className="text-[10px] text-muted-foreground font-mono">
            {mounted ? (
              <>
                {formatRangeBound(windowStart, userTz, prefs.timestamp.template)} →{" "}
                {formatRangeBound(windowEnd, userTz, prefs.timestamp.template)}
              </>
            ) : (
              <>{NO_DATA}</>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {lanes.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No agent activity in the last {windowMinutes} minutes.
          </p>
        ) : (
          <div className="space-y-1.5">
            {lanes.map((lane) => (
              <Lane
                key={lane.agent_name}
                lane={lane}
                windowStart={windowStart}
                windowEnd={windowEnd}
                timeZone={userTz}
                template={prefs.datetime.template}
              />
            ))}
            <Legend />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Lane({
  lane,
  windowStart,
  windowEnd,
  timeZone,
  template,
}: {
  lane: AgentLane;
  windowStart: number;
  windowEnd: number;
  timeZone: string;
  template: string;
}) {
  const span = windowEnd - windowStart;
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 w-20 text-xs truncate">
        <AgentChip
          name={lane.agent_name}
          prefix=""
          className="font-mono tabular-nums text-foreground/80"
        />
      </span>
      <div className="relative h-5 flex-1 rounded border border-border/40 bg-muted/20 overflow-hidden">
        {lane.events.map((dot, idx) => {
          const pct = ((dot.ts - windowStart) / span) * 100;
          const colorClass = dotColor(dot.kind);
          return (
            <span
              key={`${dot.ts}-${idx}`}
              className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-2 rounded-full ${colorClass}`}
              style={{ left: `${pct.toFixed(2)}%` }}
              title={`${formatTime(dot.ts, timeZone, template)} · ${dot.kind} · ${
                dot.label?.slice(0, 80) ?? ""
              }`}
            />
          );
        })}
      </div>
      <span className="shrink-0 w-10 text-[10px] tabular-nums text-muted-foreground text-right">
        {lane.events.length}
      </span>
    </div>
  );
}

function Legend() {
  const items: Array<{ kind: TimelineDot["kind"]; label: string }> = [
    { kind: "action_started", label: "tool start" },
    { kind: "action_completed_ok", label: "ok" },
    { kind: "action_completed_fail", label: "fail" },
    { kind: "narration", label: "turn end" },
    { kind: "task", label: "task" },
    { kind: "session", label: "session" },
  ];
  return (
    <div className="mt-2 flex items-center gap-3 flex-wrap text-[10px] text-muted-foreground">
      {items.map((it) => (
        <span key={it.kind} className="flex items-center gap-1">
          <span className={`inline-block size-2 rounded-full ${dotColor(it.kind)}`} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function formatRangeBound(ts: number, timeZone: string, template: string): string {
  if (!ts) return NO_DATA;
  // Compact range label ("10:00 → 10:30"). Uses the user's Timestamp
  // template directly. That template is already meant for dense time-of-day
  // contexts, so its tokens (millis, AM/PM, zone) carry through cleanly.
  return formatTemplate(new Date(ts), template, { timeZone });
}

function formatTime(ts: number, timeZone: string, template: string): string {
  if (!ts) return NO_DATA;
  // Full user Date + Time template for per-event tooltips.
  return formatTemplate(new Date(ts), template, { timeZone });
}

function dotColor(kind: TimelineDot["kind"]): string {
  switch (kind) {
    case "action_started":
      return "bg-sky-500";
    case "action_completed_ok":
      return "bg-emerald-500";
    case "action_completed_fail":
      return "bg-rose-500";
    case "narration":
      return "bg-cyan-500";
    case "task":
      return "bg-purple-500";
    case "session":
      return "bg-slate-400";
    default:
      return "bg-muted-foreground";
  }
}
