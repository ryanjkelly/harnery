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

import {
  CircleDashed,
  Hammer,
  Network,
  PackageCheck,
  Pencil,
  Search,
  TestTube,
  TriangleAlert,
  Wrench,
} from "lucide-react";
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
import { codecEvidenceReceiptRows } from "@/lib/codec/evidence-receipt";
import { stableCodecPanelOrder } from "@/lib/codec/panel-order";
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
  const [lastSignalAt, setLastSignalAt] = useState(initialScene.generated_at);
  const [clockNow, setClockNow] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // The server-rendered scene counts as a snapshot: its cues never animate.
  const seenCues = useRef<Set<string>>(new Set(initialScene.transients.map((t) => t.cue_id)));
  const glowTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

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
          const sourceDegraded = next.panels.find(
            (panel) => panel.instance_id === cue.from_instance_id,
          )?.telemetry?.value;
          const targetDegraded = next.panels.find(
            (panel) => panel.instance_id === cue.to_instance_id,
          )?.telemetry?.value;
          if (sourceDegraded !== "degraded" && targetDegraded !== "degraded") {
            animatePing(cue.from_instance_id, cue.to_instance_id, next);
          }
        }
      }
      if (seenCues.current.size > 500) {
        seenCues.current = new Set([...seenCues.current].slice(-250));
      }
      setScene(next);
      setLastSignalAt(new Date().toISOString());
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
      heartbeat: () => setLastSignalAt(new Date().toISOString()),
      stale: () => setLastSignalAt(new Date().toISOString()),
    },
    onFallbackChange: refetch,
    fetchOnFallbackStart: false, // the page server-renders a complete scene
  });

  const degraded = status === "reconnecting" || status === "polling";
  const current = stableCodecPanelOrder(scene.panels.filter((p) => p.presence.value === "online"));
  const stale = stableCodecPanelOrder(scene.panels.filter((p) => p.presence.value === "unknown"));
  const ended = stableCodecPanelOrder(scene.panels.filter((p) => p.presence.value === "offline"));
  const panels = [...current, ...stale, ...ended];
  const transportLabel =
    status === "live"
      ? "SSE live"
      : status === "polling"
        ? "polling"
        : status === "reconnecting"
          ? "reconnecting"
          : "connecting";
  const signalAge =
    clockNow === null
      ? "waiting for signal"
      : `${formatElapsed(Math.max(0, clockNow - Date.parse(lastSignalAt)))} ago`;
  const parentNameFor = (panel: CodecPanelScene) =>
    panel.parent_instance_id
      ? scene.panels.find((p) => p.instance_id === panel.parent_instance_id?.value)?.identity
          .display_name
      : undefined;

  return (
    <div
      data-codec-scene
      className={cn(styles.codecArena, AMBIENCE_CLASS[scene.team_ambience.value])}
    >
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className={styles.sceneRail}>
        <Badge
          data-codec-feed-status
          variant={degraded ? "secondary" : "outline"}
          className={styles.feedBadge}
          title={`Transport: ${transportLabel}; last signal ${signalAge}`}
        >
          feed {transportLabel} · {signalAge}
        </Badge>
        {degraded && <span>showing the last known scene</span>}
        <Badge variant="outline" title={`Team ambience: ${scene.team_ambience.value}`}>
          ambience {scene.team_ambience.value}
        </Badge>
        <Badge variant="outline" title="Agent presence summary">
          {current.length} live · {stale.length} stale · {ended.length} ended
        </Badge>
      </div>

      {panels.length === 0 ? (
        <p className={styles.emptyScene}>
          No active agents. Panels appear when a session starts.
        </p>
      ) : (
        <div ref={gridRef} className="relative">
          <RelationshipLines scene={scene} gridRef={gridRef} />
          <div data-codec-grid className={styles.panelGrid}>
            {panels.map((panel) => (
              <CodecPanel
                key={panel.instance_id}
                panel={panel}
                parentName={parentNameFor(panel)}
                glowing={Boolean(glowing[panel.instance_id])}
              />
            ))}
          </div>
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
        <title>Agent relationships</title>
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

const PANEL_PALETTES = [
  styles.paletteCyan,
  styles.paletteViolet,
  styles.paletteCoral,
  styles.paletteLime,
  styles.paletteGold,
  styles.palettePink,
];

function panelPalette(name: string): string | undefined {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PANEL_PALETTES[hash % PANEL_PALETTES.length];
}

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
      data-codec-card
      data-activity={panel.activity.value}
      data-expression={panel.expression.value}
      className={cn(
        styles.codecPanel,
        panelPalette(panel.identity.display_name),
        ATTENTION_RING[panel.attention.value],
        panel.friction && "ring-1 ring-amber-400/50",
        panel.attention.value === "error" && styles.errorFlash,
        glowing ? styles.pingArrive : styles.pingArriveFade,
        offline && styles.panelOffline,
        unknownPresence && styles.panelStale,
      )}
    >
      <div className={styles.portraitColumn}>
        <Portrait panel={panel} />
        <div className={styles.portraitReadout}>
          <span>{humanizeCueToken(panel.expression.value)}</span>
          <span>{humanizeCueToken(panel.activity.value)}</span>
        </div>
      </div>

      <div className={styles.panelBody}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
          <div className="truncate">
            <AgentChip name={panel.identity.display_name} />
          </div>
          <p
            className="break-words text-xs text-muted-foreground"
            title={panel.identity.task?.value}
          >
            {panel.identity.task?.value ?? "no declared task"}
          </p>
          </div>
          <ContextGauge panel={panel} />
        </div>

        <FocusBubble panel={panel} />
        <OperationCue panel={panel} />

        <div className={styles.statusRail}>
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
          <Badge
            variant="outline"
            title={`Progress rhythm: ${panel.progress_rhythm.value} (${panel.progress_rhythm.provenance}, ${panel.progress_rhythm.confidence} confidence)`}
            className={cn(
              panel.progress_rhythm.provenance === "inferred" &&
                "border-dashed border-muted-foreground/60 text-foreground/80",
            )}
          >
            {panel.progress_rhythm.value}
            {panel.progress_rhythm.provenance === "inferred" && (
              <span className="ml-1 opacity-70">· inferred</span>
            )}
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
        {panel.artifact_cue && (
          <Badge
            variant="secondary"
            title={`Artifact: ${panel.artifact_cue.value.operation} ${panel.artifact_cue.value.kind} (${panel.artifact_cue.provenance})`}
          >
            <PackageCheck className="mr-1 size-3" aria-hidden />
            {panel.artifact_cue.value.operation} {humanizeCueToken(panel.artifact_cue.value.kind)}
          </Badge>
        )}
        {panel.friction && (
          <Badge
            variant="secondary"
            className="border-amber-400/50 text-amber-700 dark:text-amber-300"
            title={`Friction: ${panel.friction.value} (${panel.friction.provenance}, ${panel.friction.confidence} confidence)`}
          >
            <TriangleAlert className="mr-1 size-3" aria-hidden />
            {humanizeCueToken(panel.friction.value)}
          </Badge>
        )}
        {panel.telemetry?.value === "degraded" && (
          <Badge
            variant="outline"
            className={cn(
              "border-dashed border-muted-foreground/60 text-foreground/80",
              styles.flexibleBadge,
            )}
            title={`Observer telemetry is degraded${panel.telemetry_reason ? `: ${humanizeCueToken(panel.telemetry_reason.value)}` : ""}; order-sensitive animation is suppressed`}
          >
            observer degraded
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

        {panel.remote_source && (
          <p
            data-codec-remote-source
            className="mt-2 text-[11px] text-muted-foreground"
            title="Remote source freshness is measured from the encrypted presence relay and its bounded Codec digest"
          >
            relay {panel.remote_source.relay.value.state} ·{" "}
            {formatElapsed(panel.remote_source.relay.value.age_ms)} old
            {panel.remote_source.digest ? (
              <>
                {" "}
                · digest {panel.remote_source.digest.value.state} ·{" "}
                {formatElapsed(panel.remote_source.digest.value.age_ms)} old
              </>
            ) : (
              <> · digest unavailable</>
            )}
          </p>
        )}

        <ActionTrail actions={panel.recent_actions} />
      </div>
      <div className={styles.evidenceFooter}>
        <EvidenceReceipt panel={panel} />
      </div>
    </section>
  );
}

function EvidenceReceipt({ panel }: { panel: CodecPanelScene }) {
  const rows = codecEvidenceReceiptRows(panel);
  const groups = ["state", "activity", "source"] as const;
  return (
    <details data-codec-evidence-receipt className="mt-2 border-t pt-2 text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Evidence receipt · {rows.length} signals
      </summary>
      <section
        className="mt-2 max-h-64 overflow-auto overscroll-contain rounded-md border bg-muted/20 shadow-inner"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: this bounded table is a keyboard-scrollable region
        tabIndex={0}
        aria-label={`Evidence signals for ${panel.identity.display_name}; scroll for more`}
      >
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 border-b bg-background/95 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur-sm">
            <tr>
              <th className="w-24 px-2 py-1.5">Signal</th>
              <th className="px-2 py-1.5">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const groupedRows = rows.filter((row) => row.group === group);
              if (groupedRows.length === 0) return null;
              return [
                <tr key={`${group}-heading`} className="border-b bg-muted/45">
                  <th
                    colSpan={2}
                    className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {group}
                  </th>
                </tr>,
                ...groupedRows.map((row) => (
                  <tr
                    key={`${row.channel}-${row.observed_at}-${row.evidence_event_ids.join("-")}`}
                    className="border-b last:border-0"
                  >
                    <th className="w-24 px-2 py-1.5 align-top font-medium">{row.channel}</th>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      <span className="text-foreground">{row.value}</span>
                      {row.detail && <span className="block text-foreground/80">{row.detail}</span>}
                      <span className="block text-foreground/75">
                        {row.provenance} · {row.confidence} · {formatReceiptTime(row.observed_at)}
                      </span>
                      {row.expires_at && (
                        <span className="block text-foreground/75">
                          expires {formatReceiptTime(row.expires_at)}
                        </span>
                      )}
                      {row.evidence_event_ids.length > 0 && (
                        <code className="block break-all rounded border bg-background/60 px-1 text-[10px] text-foreground/80">
                          {row.evidence_event_ids.join(" · ")}
                        </code>
                      )}
                    </td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </section>
    </details>
  );
}

function formatReceiptTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : "unknown time";
}

/** Current operation is a span-derived fact, separate from declared task and
 * expressive styling. Its state names observable flow, never cognition. */
function OperationCue({ panel }: { panel: CodecPanelScene }) {
  const operation = panel.operation;
  if (!operation) return null;
  const Icon = CATEGORY_ICONS[operation.value.category] ?? CircleDashed;
  const stateLabel = humanizeCueToken(operation.value.state);
  return (
    <div
      role="status"
      className={styles.operationCue}
      aria-label={`Current operation: ${operation.value.label}, ${stateLabel}`}
      title={`Current operation (${operation.provenance}): ${operation.value.label} · ${stateLabel}`}
    >
      <Icon className={styles.operationIcon} aria-hidden />
      <span className={styles.operationLabel}>{operation.value.label}</span>
      <span
        className={cn(
          styles.operationState,
          operation.value.state === "output-flow" &&
            panel.telemetry?.value !== "degraded" &&
            styles.outputFlow,
        )}
      >
        {stateLabel}
        {operation.value.elapsed_ms !== undefined &&
          ` · ${formatElapsed(operation.value.elapsed_ms)}`}
      </span>
    </div>
  );
}

function humanizeCueToken(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function formatElapsed(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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
        styles.focusBubble,
        inferred ? "border-dashed text-muted-foreground" : "text-foreground",
      )}
      title={`Focus (${bubble.value.basis}): ${bubble.value.text}`}
    >
      <span className={styles.focusText}>{bubble.value.text}</span>
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
        // biome-ignore lint/performance/noImgElement: local 512px WebP pack assets should not be re-encoded
        <img
          src={`/api/codec-pack/${panel.character.pack_id}/${panel.expression.value}?v=${panel.character.pack_version}`}
          alt=""
          width={512}
          height={512}
          onError={() => setFailed(true)}
          className={cn(
            styles.portraitImage,
            online && panel.activity.value === "working" && styles.breathing,
            !online && styles.portraitImageOffline,
          )}
        />
      ) : (
        <span
          className={cn(
            styles.portraitFallback,
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
    <ul className={styles.actionTrail} aria-label="Recent actions">
      {actions.map((action) => {
        const Icon = CATEGORY_ICONS[action.category] ?? CircleDashed;
        return (
          <li
            key={action.event_id}
            className={cn(
              styles.actionIcon,
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
          </li>
        );
      })}
    </ul>
  );
}
