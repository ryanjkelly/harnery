"use client";

/**
 * Codec panel grid — evidence-first presentation with the cinematic layer.
 *
 * Renders one reusable panel per agent from a sanitized CodecScene and keeps
 * it current over /api/codec-stream via the shared useLiveSignal primitive
 * (SSE, watchdogs, polling fallback, visibility handling). Every visual cue
 * keeps a text equivalent, all motion sits behind prefers-reduced-motion,
 * and there are no control affordances by design.
 *
 * Transient rule (plan § browser transport): snapshot hydration is static —
 * cue ids arriving in a snapshot are marked seen without animating; effects
 * run only for previously unseen cue ids delivered by later `scene` events,
 * so a missed interval is never replayed.
 */

import { CircleDashed, Hammer, Network, Pencil, Search, TestTube, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentChip } from "@/components/AgentChip";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import {
  CODEC_SCHEMA_VERSION,
  type CodecPanelScene,
  type CodecRecentAction,
  type CodecScene,
} from "@/lib/codec/contracts";
import { useLiveSignal } from "@/lib/useLiveSignal";
import styles from "./codec.module.css";

/* eslint-disable @next/next/no-img-element -- pack portraits are local
 * runtime assets served by our own route; next/image optimization would
 * re-encode already-sized webp files for no benefit. */

const CATEGORY_ICONS: Record<CodecRecentAction["category"], typeof Search> = {
  research: Search,
  diagnostic: Wrench,
  build: Hammer,
  edit: Pencil,
  test: TestTube,
  coordinate: Network,
  other: CircleDashed,
};

const AMBIENCE_CLASS: Record<string, string | undefined> = {
  calm: styles.ambCalm,
  busy: styles.ambBusy,
  alert: styles.ambAlert,
};

export function CodecView({ initialScene }: { initialScene: CodecScene }) {
  const [scene, setScene] = useState<CodecScene>(initialScene);
  const [glowing, setGlowing] = useState<Record<string, boolean>>({});
  const [announcement, setAnnouncement] = useState("");
  const gridRef = useRef<HTMLDivElement | null>(null);
  // The server-rendered scene counts as a snapshot: its cues never animate.
  const seenCues = useRef<Set<string>>(new Set(initialScene.transients.map((t) => t.cue_id)));
  const glowTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const animatePing = useCallback((fromId: string, toId: string, next: CodecScene) => {
    const nameOf = (id: string) =>
      next.panels.find((p) => p.instance_id === id)?.identity.display_name ?? "unknown";
    setAnnouncement(`agent-${nameOf(fromId)} pinged agent-${nameOf(toId)}`);

    // Arrival glow (works with reduced motion: a static outline that fades).
    setGlowing((prev) => ({ ...prev, [toId]: true }));
    const prior = glowTimers.current.get(toId);
    if (prior) clearTimeout(prior);
    glowTimers.current.set(
      toId,
      setTimeout(() => {
        setGlowing((prev) => {
          const { [toId]: _gone, ...rest } = prev;
          return rest;
        });
        glowTimers.current.delete(toId);
      }, 1600),
    );

    // Traveling particle, motion-gated.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const grid = gridRef.current;
    if (!grid) return;
    const fromEl = grid.querySelector(`[data-instance="${CSS.escape(fromId)}"]`);
    const toEl = grid.querySelector(`[data-instance="${CSS.escape(toId)}"]`);
    if (!fromEl || !toEl) return;
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    const dot = document.createElement("div");
    dot.className = styles.pingDot ?? "";
    dot.style.left = `${a.left + a.width / 2 - 5}px`;
    dot.style.top = `${a.top + a.height / 2 - 5}px`;
    document.body.appendChild(dot);
    const travel = dot.animate(
      [
        { transform: "translate(0, 0)", opacity: 1 },
        {
          transform: `translate(${b.left + b.width / 2 - (a.left + a.width / 2)}px, ${
            b.top + b.height / 2 - (a.top + a.height / 2)
          }px)`,
          opacity: 0.85,
        },
      ],
      { duration: 650, easing: "ease-in-out" },
    );
    travel.onfinish = () => dot.remove();
    travel.oncancel = () => dot.remove();
  }, []);

  const ingestScene = useCallback(
    (next: CodecScene, animate: boolean) => {
      for (const cue of next.transients) {
        if (seenCues.current.has(cue.cue_id)) continue;
        seenCues.current.add(cue.cue_id);
        if (animate && cue.kind === "message" && cue.from_instance_id && cue.to_instance_id) {
          animatePing(cue.from_instance_id, cue.to_instance_id, next);
        }
      }
      if (seenCues.current.size > 500) {
        seenCues.current = new Set([...seenCues.current].slice(-250));
      }
      setScene(next);
    },
    [animatePing],
  );

  const parseScene = (ev: MessageEvent): CodecScene | null => {
    try {
      return parseCodecScene(JSON.parse(ev.data as string));
    } catch {
      return null;
    }
  };

  const refetch = useCallback(() => {
    void fetch("/api/codec-scene")
      .then((res) => (res.ok ? res.json() : null))
      .then((next: unknown) => {
        // Polling recovery is snapshot semantics: no replay of missed cues.
        const scene = parseCodecScene(next);
        if (scene) ingestScene(scene, false);
      })
      .catch(() => {
        // polling failure; the status chip already says we're degraded
      });
  }, [ingestScene]);

  const status = useLiveSignal({
    streamUrl: "/api/codec-stream",
    events: {
      snapshot: (ev) => {
        const next = parseScene(ev);
        if (next) ingestScene(next, false);
      },
      scene: (ev) => {
        const next = parseScene(ev);
        if (next) ingestScene(next, true);
      },
      heartbeat: () => {},
      stale: () => {},
    },
    onFallbackChange: refetch,
    fetchOnFallbackStart: false, // the page server-renders a complete scene
  });

  const degraded = status === "reconnecting" || status === "polling";
  const current = scene.panels.filter((p) => p.presence.value === "online");
  const stale = scene.panels.filter((p) => p.presence.value === "unknown");
  const ended = scene.panels.filter((p) => p.presence.value === "offline");
  const parentNameFor = (panel: CodecPanelScene) =>
    panel.parent_instance_id
      ? scene.panels.find((p) => p.instance_id === panel.parent_instance_id?.value)?.identity
          .display_name
      : undefined;

  return (
    <div className={cn("rounded-xl", AMBIENCE_CLASS[scene.team_ambience.value])}>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={degraded ? "secondary" : "outline"} title={`Feed: ${status}`}>
          {degraded ? "feed degraded — showing last known state" : `feed ${status}`}
        </Badge>
        <Badge variant="outline" title={`Team ambience: ${scene.team_ambience.value}`}>
          ambience {scene.team_ambience.value}
        </Badge>
      </div>

      {current.length === 0 && stale.length === 0 && ended.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No active agents. Panels appear when a session starts.
        </p>
      ) : (
        <div ref={gridRef} className="relative">
          <RelationshipLines scene={scene} gridRef={gridRef} />
          {current.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No live agents. Panels appear when a session is online.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
              {current.map((panel) => (
                <CodecPanel
                  key={panel.instance_id}
                  panel={panel}
                  parentName={parentNameFor(panel)}
                  glowing={Boolean(glowing[panel.instance_id])}
                />
              ))}
            </div>
          )}
          {stale.length > 0 && (
            <>
              <p className="mt-6 mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Stale presence
              </p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
                {stale.map((panel) => (
                  <CodecPanel
                    key={panel.instance_id}
                    panel={panel}
                    parentName={parentNameFor(panel)}
                    glowing={false}
                  />
                ))}
              </div>
            </>
          )}
          {ended.length > 0 && (
            <>
              <p className="mt-6 mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Recently ended
              </p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
                {ended.map((panel) => (
                  <CodecPanel
                    key={panel.instance_id}
                    panel={panel}
                    parentName={parentNameFor(panel)}
                    glowing={false}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function parseCodecScene(value: unknown): CodecScene | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { schema_version?: unknown };
  return candidate.schema_version === CODEC_SCHEMA_VERSION ? (value as CodecScene) : null;
}

/** Relationship line colors: violet = shared coordination (delegation), and
 * the dependency ramp cyan (active) / amber (waiting) / red (blocked). */
const LINE_COLORS: Record<string, string> = {
  "shared-coordination": "rgba(167, 139, 250, 0.55)",
  active: "rgba(56, 189, 248, 0.55)",
  waiting: "rgba(245, 158, 11, 0.6)",
  blocked: "rgba(239, 68, 68, 0.6)",
};

interface LineGeom {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  label: string;
}

/** Persistent directional lines between panels, measured from the rendered
 * grid. Lines are structure, not events: they redraw with the scene and on
 * resize, and never animate into existence. */
function RelationshipLines({
  scene,
  gridRef,
}: {
  scene: CodecScene;
  gridRef: { current: HTMLDivElement | null };
}) {
  const [lines, setLines] = useState<LineGeom[]>([]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const nameOf = (id: string) =>
      scene.panels.find((p) => p.instance_id === id)?.identity.display_name ?? id.slice(0, 8);

    const measure = () => {
      const gridRect = grid.getBoundingClientRect();
      const next: LineGeom[] = [];
      for (const rel of scene.relationships) {
        const fromEl = grid.querySelector(`[data-instance="${CSS.escape(rel.from_instance_id)}"]`);
        const toEl = grid.querySelector(`[data-instance="${CSS.escape(rel.to_instance_id)}"]`);
        if (!fromEl || !toEl) continue;
        const a = fromEl.getBoundingClientRect();
        const b = toEl.getBoundingClientRect();
        const colorKey = rel.kind === "shared-coordination" ? rel.kind : rel.status;
        next.push({
          id: rel.relationship_id,
          x1: a.left + a.width / 2 - gridRect.left,
          y1: a.top + a.height / 2 - gridRect.top,
          x2: b.left + b.width / 2 - gridRect.left,
          y2: b.top + b.height / 2 - gridRect.top,
          color: LINE_COLORS[colorKey] ?? LINE_COLORS.active ?? "",
          label:
            rel.kind === "shared-coordination"
              ? `${nameOf(rel.to_instance_id)} delegated by ${nameOf(rel.from_instance_id)}`
              : `${nameOf(rel.to_instance_id)} depends on ${nameOf(rel.from_instance_id)} (${rel.status})`,
        });
      }
      setLines(next);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [scene, gridRef]);

  if (lines.length === 0) return null;
  return (
    <>
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ zIndex: 1 }}
      >
        {lines.map((line) => (
          <line
            key={line.id}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke={line.color}
            strokeWidth={2}
            strokeLinecap="round"
            className={styles.flowLine}
          />
        ))}
      </svg>
      <ul className="sr-only" aria-label="Agent relationships">
        {lines.map((line) => (
          <li key={line.id}>{line.label}</li>
        ))}
      </ul>
    </>
  );
}

/** Attention overlays tint the panel edge; the house color grammar (sky =
 * act now, amber = friction, red = error, emerald = done) carries state. */
const ATTENTION_RING: Record<string, string> = {
  input: "ring-1 ring-sky-400/60",
  error: "ring-1 ring-red-500/70",
  friction: "ring-1 ring-amber-400/50",
  completion: "ring-1 ring-emerald-400/60",
};

function CodecPanel({
  panel,
  parentName,
  glowing,
}: {
  panel: CodecPanelScene;
  parentName?: string;
  glowing: boolean;
}) {
  const offline = panel.presence.value === "offline";
  const unknownPresence = panel.presence.value === "unknown";

  return (
    <section
      aria-label={`Agent ${panel.identity.display_name}`}
      data-instance={panel.instance_id}
      className={cn(
        "relative z-[2] rounded-lg border bg-card p-3 text-card-foreground",
        ATTENTION_RING[panel.attention.value],
        panel.attention.value === "error" && styles.errorFlash,
        glowing ? styles.pingArrive : styles.pingArriveFade,
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

      <FocusBubble panel={panel} />

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
        {panel.ledger_state?.value === "recovery-required" && (
          <Badge
            variant="destructive"
            title="Ledger state: recovery-required (open spans after the turn closed)"
          >
            recovering
          </Badge>
        )}
        {panel.ledger_state?.value === "ending" && (
          <Badge variant="secondary" title="Ledger state: ending (finalization pending)">
            ending
          </Badge>
        )}
        {offline && (
          <Badge variant="secondary" title="Presence: offline (event-backed)">
            offline
          </Badge>
        )}
        {unknownPresence && (
          <Badge variant="outline" title="Presence unknown: no fresh V3 observation">
            presence unknown
          </Badge>
        )}
        {panel.progress_rhythm.value !== "unknown" && (
          <Badge variant="outline" title={`Progress rhythm: ${panel.progress_rhythm.value}`}>
            {panel.progress_rhythm.value}
          </Badge>
        )}
        {panel.expression.value !== "neutral" &&
          !(
            panel.ledger_state?.value === "recovery-required" &&
            panel.expression.value === "recovering"
          ) && (
            <Badge
              variant="outline"
              title={`Expression: ${panel.expression.value} (${panel.expression.provenance}, ${panel.expression.confidence} confidence)`}
              className={cn(
                panel.expression.provenance === "inferred" && "border-dashed text-muted-foreground",
              )}
            >
              {panel.expression.value}
              {panel.expression.provenance === "inferred" && (
                <span className="ml-1 opacity-70">· inferred</span>
              )}
            </Badge>
          )}
        {panel.attention.value !== "none" && (
          <Badge
            variant={panel.attention.value === "error" ? "destructive" : "secondary"}
            title={`Attention: ${panel.attention.value} (expires ${panel.attention.expires_at ?? "soon"})`}
          >
            {panel.attention.value}
          </Badge>
        )}
        {parentName && (
          <Badge variant="outline" title={`Delegated by ${parentName} (event-backed parentage)`}>
            ↳ {parentName}
          </Badge>
        )}
        {panel.machine && (
          <Badge variant="secondary" title={`Running on ${panel.machine} (via the presence relay)`}>
            @ {panel.machine}
          </Badge>
        )}
      </div>

      <ActionTrail actions={panel.recent_actions} />
    </section>
  );
}

/** Intent capsule: solid treatment for event-backed focus, dotted + labeled
 * for inferred. Never inner monologue; always carries a text equivalent. */
function FocusBubble({ panel }: { panel: CodecPanelScene }) {
  const bubble = panel.focus_bubble;
  if (!bubble) return null;
  const inferred = bubble.value.basis === "inferred";
  return (
    <p
      className={cn(
        "mt-2 inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
        inferred ? "border-dashed text-muted-foreground" : "text-foreground",
      )}
      title={`Focus (${bubble.value.basis}): ${bubble.value.text}`}
    >
      <span className="truncate">{bubble.value.text}</span>
      {inferred && <span className="flex-none opacity-70">· inferred</span>}
    </p>
  );
}

/** Character-pack portrait with the neutral-letter treatment as fallback.
 * The scanline frame matches the pack art; working portraits breathe gently
 * (motion-gated); offline/unknown presence renders subdued static. */
function Portrait({ panel }: { panel: CodecPanelScene }) {
  const [failed, setFailed] = useState(false);
  const letter = (panel.identity.display_name[0] ?? "?").toUpperCase();
  const usePack = panel.character.pack_id !== "fallback-neutral" && !failed;
  const online = panel.presence.value === "online";

  return (
    <span className={cn(styles.portraitFrame, !online && styles.portraitStatic)} aria-hidden>
      {usePack ? (
        <img
          src={`/api/codec-pack/${panel.character.pack_id}/${panel.expression.value}?v=${panel.character.pack_version}`}
          alt=""
          width={48}
          height={48}
          onError={() => setFailed(true)}
          className={cn(
            "size-12 rounded-md border object-cover",
            online && panel.activity.value === "working" && styles.breathing,
            !online && "opacity-70 grayscale",
          )}
        />
      ) : (
        <span
          className={cn(
            "grid size-12 place-items-center rounded-md border bg-muted font-mono text-lg font-bold",
            online ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {letter}
        </span>
      )}
    </span>
  );
}

/** Diegetic capacity gauge: three segments from the context band. Absent
 * telemetry renders nothing at all — a permanently neutral battery erodes
 * trust in the cues that do carry evidence. */
function ContextGauge({ panel }: { panel: CodecPanelScene }) {
  const band = panel.context_band.value;
  if (band === "unknown") return null;
  const lit = band === "ample" ? 3 : band === "reduced" ? 2 : 1;
  const label = `Context capacity ${band}`;
  return (
    <div className="flex flex-none flex-col items-center gap-0.5" aria-label={label} role="img">
      {[3, 2, 1].map((segment) => (
        <span
          key={segment}
          className={cn(
            "h-1.5 w-5 rounded-sm",
            segment <= lit ? (band === "low" ? "bg-amber-500" : "bg-emerald-500") : "bg-muted",
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
