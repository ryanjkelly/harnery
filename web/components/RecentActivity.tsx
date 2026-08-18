"use client";

import { useMemo } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EventRow } from "@/lib/coord-reader";
import { describeEventV3, type EventDisplayVariantV3 } from "@/lib/event-v3-display";

/**
 * Recent activity for one agent, projected from the canonical V3 display DTO.
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
  const display = describeEventV3(event);
  const typeColor = variantClass(display.variant);

  return (
    <div className="flex gap-2 px-2 py-0.5 items-baseline">
      <span className="shrink-0 text-muted-foreground tabular-nums text-[10px]">{time}</span>
      <span className={`shrink-0 w-22 uppercase text-[10px] tracking-wider ${typeColor}`}>
        {display.kind}
      </span>
      <div className="min-w-0 flex-1 text-foreground/75 truncate">{display.summary}</div>
    </div>
  );
}

function variantClass(variant: EventDisplayVariantV3): string {
  if (variant === "success") return "text-emerald-500";
  if (variant === "destructive") return "text-rose-500";
  if (variant === "warning") return "text-amber-500";
  if (variant === "info") return "text-sky-500";
  if (variant === "accent") return "text-cyan-500";
  if (variant === "secondary") return "text-purple-500";
  return "text-muted-foreground";
}
