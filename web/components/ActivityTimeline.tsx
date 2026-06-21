"use client";

import { useEffect, useMemo, useState } from "react";

import { AgentChip } from "@/components/AgentChip";
import { useDateTimeFormat } from "@/components/DateTimeFormatProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EventRow } from "@/lib/coord-reader";
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
  kind: "command_start" | "command_end_ok" | "command_end_fail" | "narration" | "session" | "task";
  label?: string;
}

/**
 * Cross-agent activity timeline. One horizontal lane per agent, dots placed
 * along the lane by time. Color encodes event type. Hover reveals the cmd
 * or tool. Useful for "what is everyone doing right now" at a glance.
 *
 * Mirrors the upstream app's ActivityTimeline, adapted for harnery's event_type +
 * data:Record shape:
 *   - tool.pre_use         → command_start (sky)
 *   - tool.post_use ok=true → command_end_ok (emerald)
 *   - tool.post_use_failure → command_end_fail (rose)
 *   - turn.stop            → narration (cyan)
 *   - state.task_set       → task (purple)
 *   - session.start/end    → session (slate)
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

      const data = ev.data ?? {};
      let kind: TimelineDot["kind"] | null = null;
      let label: string | undefined;

      if (ev.event_type === "tool.pre_use") {
        kind = "command_start";
        label = String(
          (data.tool_name as string) ?? (data.cmd as string) ?? (data.intent as string) ?? "",
        );
      } else if (ev.event_type === "tool.post_use") {
        kind = "command_end_ok";
        const ok = (data.ok ?? true) === true;
        kind = ok ? "command_end_ok" : "command_end_fail";
        label = String(data.tool_name ?? "");
      } else if (ev.event_type === "tool.post_use_failure") {
        kind = "command_end_fail";
        label = String(data.tool_name ?? "");
      } else if (ev.event_type === "turn.stop") {
        kind = "narration";
        label = String(data.turn_summary ?? "");
      } else if (ev.event_type === "state.task_set") {
        kind = "task";
        label = String(data.task ?? "");
      } else if (ev.event_type === "session.start" || ev.event_type === "session.end") {
        kind = "session";
        label = ev.event_type;
      } else {
        continue;
      }
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
    { kind: "command_start", label: "tool start" },
    { kind: "command_end_ok", label: "ok" },
    { kind: "command_end_fail", label: "fail" },
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
    case "command_start":
      return "bg-sky-500";
    case "command_end_ok":
      return "bg-emerald-500";
    case "command_end_fail":
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
