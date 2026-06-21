"use client";

import { useMemo } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EventRow } from "@/lib/coord-reader";

/**
 * Recent activity for one agent. Compact color-coded row layout: tool
 * starts in sky, ok results in emerald, fails in rose, narration/turn-stop
 * in cyan, task changes in purple. Mirrors the upstream app's agents-coord/RecentActivity
 * with one adaptation: the upstream app's SessionEvent has flattened {type,cmd,exit,...}
 * fields; harnery's EventRow has event_type + data:Record. We classify on
 * event_type and pull cmd/tool/intent from data.
 *
 * Live updates ride on the parent layout's <LiveRefresher>, which fires
 * router.refresh() when .harnery/ changes; no per-component SSE.
 */
export function RecentActivity({ events }: { events: EventRow[] }) {
  const reversed = useMemo(() => [...events].reverse(), [events]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Recent activity ({events.length} event
          {events.length === 1 ? "" : "s"})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No events recorded yet for this agent.
          </p>
        ) : (
          <div className="max-h-100 overflow-y-auto rounded-md border border-border/40 divide-y divide-border/20 font-mono text-[11px] leading-relaxed">
            {reversed.map((ev, idx) => (
              <Row key={`${ev.event_id ?? ev.ts}-${idx}`} event={ev} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ event }: { event: EventRow }) {
  const time = event.ts.slice(11, 23);
  const data = event.data ?? {};

  let typeColor = "text-muted-foreground";
  let kind = event.event_type;
  let body: React.ReactNode = null;

  switch (event.event_type) {
    case "tool.pre_use": {
      typeColor = "text-sky-500";
      kind = "tool start";
      const tool = String(data.tool_name ?? "");
      const intent = data.intent ? String(data.intent) : "";
      body = (
        <span className="text-foreground/80 truncate">
          <span className="text-muted-foreground">{tool}</span>
          {intent && <> · {intent}</>}
        </span>
      );
      break;
    }
    case "tool.post_use": {
      const exit = data.exit;
      const ok = exit == null || (typeof exit === "number" && exit === 0);
      typeColor = ok ? "text-emerald-500" : "text-rose-500";
      kind = ok ? "tool ok" : "tool fail";
      const tool = String(data.tool_name ?? "");
      const dur = typeof data.duration_ms === "number" ? data.duration_ms : 0;
      body = (
        <span className="text-foreground/70">
          {ok ? "✓" : "✗"} {tool}
          {typeof exit === "number" && <> · exit {exit}</>}
          {dur > 0 && (
            <span className="text-muted-foreground tabular-nums">
              {" · "}
              {formatDuration(dur)}
            </span>
          )}
        </span>
      );
      break;
    }
    case "tool.post_use_failure": {
      typeColor = "text-rose-500";
      kind = "tool fail";
      const tool = String(data.tool_name ?? "");
      const reason = String(data.reason ?? data.error ?? "");
      body = (
        <span className="text-rose-700 dark:text-rose-300">
          ✗ {tool}
          {reason && <> · {truncate(reason, 100)}</>}
        </span>
      );
      break;
    }
    case "turn.stop": {
      typeColor = "text-cyan-500";
      kind = "turn end";
      const summary = String(data.turn_summary ?? "");
      body = (
        <span className="text-cyan-700 dark:text-cyan-300 italic">
          ⋯ {summary || "(no summary)"}
        </span>
      );
      break;
    }
    case "state.task_set": {
      typeColor = "text-purple-500";
      kind = "task";
      const task = String(data.task ?? "");
      body = (
        <span className="text-purple-700 dark:text-purple-300">
          → {task ? truncate(task, 100) : "(cleared)"}
        </span>
      );
      break;
    }
    case "session.start":
    case "session.end": {
      typeColor = "text-slate-500";
      kind = event.event_type === "session.start" ? "session start" : "session end";
      body = (
        <span className="text-muted-foreground italic">
          {String(data.model ?? "")}
        </span>
      );
      break;
    }
    case "user_prompt.submit": {
      typeColor = "text-amber-500";
      kind = "prompt";
      const prompt = String(data.prompt ?? data.text ?? "");
      body = (
        <span className="text-foreground/70">{truncate(prompt, 100)}</span>
      );
      break;
    }
    default: {
      body = (
        <span className="text-muted-foreground">
          {truncate(JSON.stringify(data), 160)}
        </span>
      );
    }
  }

  return (
    <div className="flex gap-2 px-2 py-0.5 items-baseline">
      <span className="shrink-0 text-muted-foreground tabular-nums text-[10px]">
        {time}
      </span>
      <span
        className={`shrink-0 w-22 uppercase text-[10px] tracking-wider ${typeColor}`}
      >
        {kind}
      </span>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
