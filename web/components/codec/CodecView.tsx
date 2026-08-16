"use client";

/**
 * Codec panel grid — Phase 1 (neutral, truth-first).
 *
 * Renders one reusable panel per agent from a sanitized CodecScene and keeps
 * it current over /api/codec-stream via the shared useLiveSignal primitive
 * (SSE, watchdogs, polling fallback, visibility handling). Every visual cue
 * has a text equivalent, motion is limited to the existing live-dot pulse,
 * and there are no control affordances by design.
 *
 * Snapshot hydration is static: this phase carries no transient cues, and
 * when they arrive (Phase 3) effects start only for unseen cue IDs delivered
 * by later `scene` events, never for cues inside a snapshot.
 */

import { AgentChip } from "@/components/AgentChip";
import { Badge } from "@/components/ui/badge";
import type {
  CodecPanelScene,
  CodecRecentAction,
  CodecScene,
} from "@/lib/codec/contracts";
import { cn } from "@/lib/cn";
import { useLiveSignal } from "@/lib/useLiveSignal";
import {
  CircleDashed,
  Hammer,
  Network,
  Pencil,
  Search,
  TestTube,
  Wrench,
} from "lucide-react";
import { useCallback, useState } from "react";

const CATEGORY_ICONS: Record<CodecRecentAction["category"], typeof Search> = {
  research: Search,
  diagnostic: Wrench,
  build: Hammer,
  edit: Pencil,
  test: TestTube,
  coordinate: Network,
  other: CircleDashed,
};

export function CodecView({ initialScene }: { initialScene: CodecScene }) {
  const [scene, setScene] = useState<CodecScene>(initialScene);

  const applyScene = useCallback((ev: MessageEvent) => {
    try {
      const next = JSON.parse(ev.data as string) as CodecScene;
      if (next.schema_version !== 1) return; // fail closed on unknown versions
      setScene(next);
    } catch {
      // malformed frame; keep the last known scene
    }
  }, []);

  const refetch = useCallback(() => {
    void fetch("/api/codec-scene")
      .then((res) => (res.ok ? res.json() : null))
      .then((next: CodecScene | null) => {
        if (next && next.schema_version === 1) setScene(next);
      })
      .catch(() => {
        // polling failure; the status chip already says we're degraded
      });
  }, []);

  const status = useLiveSignal({
    streamUrl: "/api/codec-stream",
    events: {
      snapshot: applyScene,
      scene: applyScene,
      heartbeat: () => {},
      stale: () => {},
    },
    onFallbackChange: refetch,
    fetchOnFallbackStart: false, // the page server-renders a complete scene
  });

  const degraded = status === "reconnecting" || status === "polling";

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={degraded ? "secondary" : "outline"} title={`Feed: ${status}`}>
          {degraded ? "feed degraded — showing last known state" : `feed ${status}`}
        </Badge>
        <Badge variant="outline" title={`Team ambience: ${scene.team_ambience.value}`}>
          ambience {scene.team_ambience.value}
        </Badge>
      </div>

      {scene.panels.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No active agents. Panels appear when a session starts.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
          {scene.panels.map((panel) => (
            <CodecPanel key={panel.instance_id} panel={panel} />
          ))}
        </div>
      )}
    </div>
  );
}

function CodecPanel({ panel }: { panel: CodecPanelScene }) {
  const offline = panel.presence.value === "offline";
  const unknownPresence = panel.presence.value === "unknown";

  return (
    <section
      aria-label={`Agent ${panel.identity.display_name}`}
      className={cn(
        "rounded-lg border bg-card p-3 text-card-foreground",
        offline && "opacity-60",
        unknownPresence && "opacity-80",
      )}
    >
      <div className="flex items-center gap-3">
        <Portrait panel={panel} />
        <div className="min-w-0 flex-1">
          <div className="truncate">
            <AgentChip name={panel.identity.display_name} />
          </div>
          <p className="truncate text-xs text-muted-foreground" title={panel.identity.task?.value}>
            {panel.identity.task?.value ?? "no declared task"}
          </p>
        </div>
        <ContextGauge panel={panel} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1">
        <Badge
          variant={panel.activity.value === "needs-input" ? "default" : "outline"}
          title={`Activity: ${panel.activity.value} (${panel.activity.provenance})`}
        >
          {panel.activity.value === "working" && <span className="live-dot" aria-hidden />}
          {panel.activity.value}
        </Badge>
        {panel.lifecycle.value !== "unknown" && (
          <Badge
            variant={panel.lifecycle.value === "done" ? "secondary" : "outline"}
            title={`Lifecycle: ${panel.lifecycle.value} (${panel.lifecycle.provenance})`}
          >
            {panel.lifecycle.value}
          </Badge>
        )}
        {offline && (
          <Badge variant="secondary" title="Presence: offline (event-backed)">
            offline
          </Badge>
        )}
        {unknownPresence && (
          <Badge variant="outline" title="Presence unknown: heartbeat is stale">
            presence unknown
          </Badge>
        )}
        {panel.progress_rhythm.value !== "unknown" && (
          <Badge variant="outline" title={`Progress rhythm: ${panel.progress_rhythm.value}`}>
            {panel.progress_rhythm.value}
          </Badge>
        )}
      </div>

      <ActionTrail actions={panel.recent_actions} />
    </section>
  );
}

/** Phase 1 portrait: a stable neutral treatment (initial letter). Character
 * packs replace this in Phase 4; the slot and sizing already match. */
function Portrait({ panel }: { panel: CodecPanelScene }) {
  const letter = (panel.identity.display_name[0] ?? "?").toUpperCase();
  return (
    <div
      aria-hidden
      className={cn(
        "grid size-12 flex-none place-items-center rounded-md border bg-muted font-mono text-lg font-bold",
        panel.presence.value === "online" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {letter}
    </div>
  );
}

/** Diegetic capacity gauge: three segments from the context band. Unknown
 * renders all-neutral rather than implying an empty battery. */
function ContextGauge({ panel }: { panel: CodecPanelScene }) {
  const band = panel.context_band.value;
  const lit = band === "ample" ? 3 : band === "reduced" ? 2 : band === "low" ? 1 : 0;
  const label =
    band === "unknown" ? "Context capacity unknown" : `Context capacity ${band}`;
  return (
    <div className="flex flex-none flex-col items-center gap-0.5" aria-label={label} role="img">
      {[3, 2, 1].map((segment) => (
        <span
          key={segment}
          className={cn(
            "h-1.5 w-5 rounded-sm",
            band === "unknown"
              ? "bg-muted"
              : segment <= lit
                ? band === "low"
                  ? "bg-amber-500"
                  : "bg-emerald-500"
                : "bg-muted",
          )}
        />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

function ActionTrail({ actions }: { actions: CodecRecentAction[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-1.5" aria-label="Recent actions">
      {actions.map((action) => {
        const Icon = CATEGORY_ICONS[action.category] ?? CircleDashed;
        return (
          <span
            key={action.event_id}
            className={cn(
              "grid size-6 place-items-center rounded border",
              action.outcome === "error"
                ? "border-red-300 text-red-600 dark:border-red-900 dark:text-red-400"
                : "text-muted-foreground",
            )}
            title={`${action.category}: ${action.outcome}`}
          >
            <Icon className="size-3.5" aria-hidden />
            <span className="sr-only">
              {action.category} {action.outcome}
            </span>
          </span>
        );
      })}
    </div>
  );
}
