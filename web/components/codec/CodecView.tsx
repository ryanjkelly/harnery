"use client";

/**
 * Codec panel grid — evidence-first presentation with the cinematic layer.
 *
 * Renders one reusable panel per agent from a sanitized CodecScene and keeps
 * it current over /api/codec-stream via the shared useLiveSignal primitive
 * (SSE, watchdogs, polling fallback, visibility handling). Every visual cue
 * keeps a text equivalent, all motion sits behind prefers-reduced-motion,
 * View-only controls may change presentation (side panels, replay, fullscreen)
 * but never mutate coordination state.
 *
 * Transient rule (plan § browser transport): snapshot hydration is static —
 * cue ids arriving in a snapshot are marked seen without animating; effects
 * run only for previously unseen cue ids delivered by later `scene` events,
 * so a missed interval is never replayed.
 */

import {
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  FolderOpen,
  Hammer,
  Maximize2,
  Minimize2,
  Network,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Pencil,
  Play,
  Search,
  TestTube,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { AgentChip } from "@/components/AgentChip";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import {
  CODEC_SCHEMA_VERSION,
  type CodecIntentSignal,
  type CodecPanelScene,
  type CodecRecentAction,
  type CodecRemoteMachine,
  type CodecScene,
} from "@/lib/codec/contracts";
import { stableCodecPanelOrder } from "@/lib/codec/panel-order";
import type { CodecReplayPhase } from "@/lib/codec/replay-scene";
import { codecSemantic } from "@/lib/codec/semantic-contract";
import { summarizeCodecTeam } from "@/lib/codec/team-summary";
import { useLiveSignal } from "@/lib/useLiveSignal";
import { CodecRuntimeStrip } from "./CodecRuntimeStrip";
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

const REMOTE_PANEL_STORAGE_KEY = "harnery.codec.remote-panel";
const TEAM_PANEL_STORAGE_KEY = "harnery.codec.team-panel";

interface CodecViewProps {
  initialScene: CodecScene;
  mode?: "live" | "replay";
  replayPhases?: CodecReplayPhase[];
}

export function CodecView({ initialScene, mode = "live", replayPhases = [] }: CodecViewProps) {
  const [scene, setScene] = useState<CodecScene>(initialScene);
  const [glowing, setGlowing] = useState<Record<string, boolean>>({});
  const [announcement, setAnnouncement] = useState("");
  const [lastSignalAt, setLastSignalAt] = useState(initialScene.generated_at);
  const [clockNow, setClockNow] = useState<number | null>(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(true);
  const [showRemotePanel, setShowRemotePanel] = useState(true);
  const [showTeamPanel, setShowTeamPanel] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const replayHydrated = useRef(false);
  // The server-rendered scene counts as a snapshot: its cues never animate.
  const seenCues = useRef<Set<string>>(new Set(initialScene.transients.map((t) => t.cue_id)));
  const glowTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const syncLayout = () => setMobileLayout(query.matches);
    syncLayout();
    query.addEventListener("change", syncLayout);
    return () => query.removeEventListener("change", syncLayout);
  }, []);

  useEffect(() => {
    try {
      setShowRemotePanel(localStorage.getItem(REMOTE_PANEL_STORAGE_KEY) !== "hidden");
      setShowTeamPanel(localStorage.getItem(TEAM_PANEL_STORAGE_KEY) !== "hidden");
    } catch {
      // Storage can be unavailable in hardened browser contexts; defaults stay open.
    }
    const syncFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    setFullscreenAvailable(Boolean(document.fullscreenEnabled));
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const toggleRemotePanel = useCallback(() => {
    setShowRemotePanel((current) => {
      const next = !current;
      try {
        localStorage.setItem(REMOTE_PANEL_STORAGE_KEY, next ? "visible" : "hidden");
      } catch {
        // The in-memory preference still works for this page lifetime.
      }
      return next;
    });
  }, []);

  const toggleTeamPanel = useCallback(() => {
    setShowTeamPanel((current) => {
      const next = !current;
      try {
        localStorage.setItem(TEAM_PANEL_STORAGE_KEY, next ? "visible" : "hidden");
      } catch {
        // The in-memory preference still works for this page lifetime.
      }
      return next;
    });
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      setAnnouncement("Browser fullscreen request was blocked");
    }
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
    dot.dataset.codecPingParticle = "true";
    dot.dataset.fromInstance = fromId;
    dot.dataset.toInstance = toId;
    const startX = a.left + a.width / 2;
    const startY = a.top + a.height / 2;
    const deltaX = b.left + b.width / 2 - startX;
    const deltaY = b.top + b.height / 2 - startY;
    dot.style.left = `${startX - 12}px`;
    dot.style.top = `${startY - 12}px`;
    dot.style.setProperty("--ping-angle", `${Math.atan2(deltaY, deltaX)}rad`);
    document.body.appendChild(dot);
    const travel = dot.animate(
      [
        { transform: "translate(0, 0) scale(0.55)", opacity: 0 },
        { transform: "translate(0, 0) scale(1.3)", opacity: 1, offset: 0.12 },
        {
          transform: `translate(${deltaX * 0.72}px, ${deltaY * 0.72}px) scale(1)`,
          opacity: 1,
          offset: 0.72,
        },
        {
          transform: `translate(${deltaX}px, ${deltaY}px) scale(2.35)`,
          opacity: 1,
          offset: 0.9,
        },
        {
          transform: `translate(${deltaX}px, ${deltaY}px) scale(3.2)`,
          opacity: 0,
        },
      ],
      { duration: 1_050, easing: "cubic-bezier(0.2, 0.75, 0.2, 1)" },
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
    enabled: mode === "live",
  });

  const activeReplayPhase = replayPhases[replayIndex];

  useEffect(() => {
    if (mode !== "replay" || !activeReplayPhase) return;
    ingestScene(activeReplayPhase.scene, replayHydrated.current);
    replayHydrated.current = true;
  }, [activeReplayPhase, ingestScene, mode]);

  useEffect(() => {
    if (mode !== "replay") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setReplayPlaying(false);
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== "replay" || !replayPlaying || replayPhases.length < 2) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        setReplayIndex((index) => (index + 1) % replayPhases.length);
      }
    }, 3_600);
    return () => clearInterval(timer);
  }, [mode, replayPhases.length, replayPlaying]);

  const degraded = mode === "live" && (status === "reconnecting" || status === "polling");
  const current = stableCodecPanelOrder(scene.panels.filter((p) => p.presence.value === "online"));
  const stale = stableCodecPanelOrder(scene.panels.filter((p) => p.presence.value === "unknown"));
  const ended = stableCodecPanelOrder(scene.panels.filter((p) => p.presence.value === "offline"));
  const panels = [...current, ...stale, ...ended];
  const transportLabel =
    mode === "replay"
      ? "offline replay"
      : status === "live"
        ? "SSE live"
        : status === "polling"
          ? "polling"
          : status === "reconnecting"
            ? "reconnecting"
            : "connecting";
  const signalAge =
    mode === "replay"
      ? (activeReplayPhase?.label ?? "synthetic phase")
      : clockNow === null
        ? "waiting for signal"
        : `${formatElapsed(Math.max(0, clockNow - Date.parse(lastSignalAt)))} ago`;
  const parentNameFor = (panel: CodecPanelScene) =>
    panel.parent_instance_id
      ? scene.panels.find((p) => p.instance_id === panel.parent_instance_id?.value)?.identity
          .display_name
      : undefined;
  const remotePanelOpen = showRemotePanel && scene.remote_machines.length > 0;
  const teamPanelOpen = showTeamPanel && panels.length > 0;

  return (
    <div
      data-codec-scene
      data-remote-panel={remotePanelOpen ? "open" : "closed"}
      data-team-panel={teamPanelOpen ? "open" : "closed"}
      data-fullscreen={fullscreen ? "true" : "false"}
      data-codec-layout={mobileLayout ? "mobile" : "desktop"}
      className={cn(styles.codecArena, AMBIENCE_CLASS[scene.team_ambience.value])}
    >
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className={styles.sceneStatus}>
        {mode === "replay" && activeReplayPhase && (
          <section
            data-codec-replay-banner
            data-codec-replay-phase={activeReplayPhase.label}
            className={styles.replayBanner}
            aria-label="Replay controls"
          >
            <div>
              <p className={styles.replayKicker}>Synthetic replay · no live agents</p>
              <h2>{activeReplayPhase.label}</h2>
              <p>{activeReplayPhase.note}</p>
            </div>
            <div className={styles.replayControls}>
              <button
                type="button"
                aria-label="Previous replay phase"
                onClick={() => {
                  setReplayPlaying(false);
                  setReplayIndex(
                    (index) => (index - 1 + replayPhases.length) % replayPhases.length,
                  );
                }}
              >
                <ChevronLeft aria-hidden />
              </button>
              <button
                type="button"
                aria-label={replayPlaying ? "Pause replay" : "Play replay"}
                aria-pressed={replayPlaying}
                onClick={() => setReplayPlaying((playing) => !playing)}
              >
                {replayPlaying ? <Pause aria-hidden /> : <Play aria-hidden />}
              </button>
              <button
                type="button"
                aria-label="Next replay phase"
                onClick={() => {
                  setReplayPlaying(false);
                  setReplayIndex((index) => (index + 1) % replayPhases.length);
                }}
              >
                <ChevronRight aria-hidden />
              </button>
              <span>
                {replayIndex + 1} / {replayPhases.length}
              </span>
            </div>
          </section>
        )}
        <div className={styles.sceneStatusBar}>
          <div className={styles.sceneRail}>
            <Badge
              data-codec-feed-status
              variant={degraded ? "secondary" : "outline"}
              className={styles.feedBadge}
              title={
                mode === "replay"
                  ? `Synthetic phase: ${signalAge}; no live transport`
                  : `Transport: ${transportLabel}; last signal ${signalAge}`
              }
            >
              {mode === "replay" ? "demo" : "feed"} {transportLabel} · {signalAge}
            </Badge>
            {degraded && <span>showing the last known scene</span>}
            <Badge variant="outline" title={`Team ambience: ${scene.team_ambience.value}`}>
              ambience {scene.team_ambience.value}
            </Badge>
            <Badge variant="outline" title="Agent presence summary">
              {current.length} live · {stale.length} stale · {ended.length} ended
            </Badge>
            {scene.semantic_service && (
              <Badge
                data-codec-semantic-service
                data-state={scene.semantic_service.state}
                variant={scene.semantic_service.running ? "outline" : "secondary"}
                title={
                  scene.semantic_service.running
                    ? `Semantic reader running · ${scene.semantic_service.model_calls} model calls · ${scene.semantic_service.pending_count} pending`
                    : "Semantic reader stopped. Start explicitly with: harn semantic service start"
                }
              >
                semantic {scene.semantic_service.running ? "on" : "off"}
                {scene.semantic_service.last_error_code
                  ? ` · ${humanizeCueToken(scene.semantic_service.last_error_code)}`
                  : ""}
              </Badge>
            )}
          </div>
          <SceneControls
            remoteAvailable={scene.remote_machines.length > 0}
            teamAvailable={panels.length > 0}
            remoteOpen={remotePanelOpen}
            teamOpen={teamPanelOpen}
            fullscreen={fullscreen}
            fullscreenAvailable={fullscreenAvailable}
            onToggleRemote={toggleRemotePanel}
            onToggleTeam={toggleTeamPanel}
            onToggleFullscreen={toggleFullscreen}
          />
        </div>
      </div>

      {panels.length === 0 ? (
        <p className={styles.emptyScene}>No active agents. Panels appear when a session starts.</p>
      ) : mobileLayout ? (
        <MobileCodecDeck
          scene={scene}
          panels={panels}
          parentNameFor={parentNameFor}
          glowing={glowing}
        />
      ) : (
        <>
          {remotePanelOpen && <RemoteFleet machines={scene.remote_machines} />}
          {teamPanelOpen && <TeamPulse scene={scene} />}
          <div ref={gridRef} data-codec-card-stage className={styles.cardStage}>
            <RelationshipLines scene={scene} gridRef={gridRef} />
            <div
              data-codec-grid
              data-panel-count={panels.length}
              data-panel-density={panels.length <= 4 ? "featured" : "dense"}
              className={styles.panelGrid}
            >
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
          <ActivityLedger panels={panels} />
        </>
      )}
    </div>
  );
}

function MobileCodecDeck({
  scene,
  panels,
  parentNameFor,
  glowing,
}: {
  scene: CodecScene;
  panels: CodecPanelScene[];
  parentNameFor: (panel: CodecPanelScene) => string | undefined;
  glowing: Record<string, boolean>;
}) {
  const summary = summarizeCodecTeam(scene);
  const working = panels.filter((panel) => panel.activity.value === "working").length;
  const needsInput = panels.filter((panel) => panel.activity.value === "needs-input").length;

  const focusAgent = (panel: CodecPanelScene) => {
    document
      .getElementById(`mobile-agent-${panel.instance_id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  };

  return (
    <section data-codec-mobile-view className={styles.mobileDeck} aria-label="Mobile Codec view">
      <div data-codec-mobile-overview className={styles.mobileOverview}>
        <div className={styles.mobileOverviewLead}>
          <p className={styles.mobileEyebrow}>Pocket command deck</p>
          <h2>{panels.length} agents in view</h2>
          <p>
            {working} working · {needsInput} need input · {summary.machines.length} machine
            {summary.machines.length === 1 ? "" : "s"}
          </p>
        </div>
        <dl className={styles.mobileMetrics}>
          <div>
            <dt>Links</dt>
            <dd>{summary.relationships.length}</dd>
          </div>
          <div>
            <dt>Active</dt>
            <dd>{summary.dependencies.active}</dd>
          </div>
          <div>
            <dt>Waiting</dt>
            <dd>{summary.dependencies.waiting}</dd>
          </div>
          <div>
            <dt>Blocked</dt>
            <dd>{summary.dependencies.blocked}</dd>
          </div>
        </dl>
      </div>

      <nav
        data-codec-mobile-agent-rail
        className={styles.mobileAgentRail}
        aria-label="Jump to agent card"
      >
        {panels.map((panel) => (
          <button
            key={panel.instance_id}
            type="button"
            data-activity={panel.activity.value}
            onClick={() => focusAgent(panel)}
            aria-label={`Show ${panel.identity.display_name}`}
          >
            <span className={styles.mobileAgentBeacon} aria-hidden />
            <AgentChip name={panel.identity.display_name} prefix="" />
          </button>
        ))}
      </nav>

      <div className={styles.mobileDeckLabel}>
        <span>Swipe agents</span>
        <span>{panels.length} cards</span>
      </div>
      <div data-codec-mobile-card-track className={styles.mobileCardTrack}>
        {panels.map((panel, index) => (
          <MobileCodecPanel
            key={panel.instance_id}
            panel={panel}
            parentName={parentNameFor(panel)}
            glowing={Boolean(glowing[panel.instance_id])}
            position={index + 1}
            total={panels.length}
          />
        ))}
      </div>
    </section>
  );
}

function MobileCodecPanel({
  panel,
  parentName,
  glowing,
  position,
  total,
}: {
  panel: CodecPanelScene;
  parentName?: string;
  glowing: boolean;
  position: number;
  total: number;
}) {
  const offline = panel.presence.value === "offline";
  const unknownPresence = panel.presence.value === "unknown";

  return (
    <article
      id={`mobile-agent-${panel.instance_id}`}
      aria-label={`Agent ${panel.identity.display_name}, card ${position} of ${total}`}
      data-instance={panel.instance_id}
      data-codec-mobile-card
      data-activity={panel.activity.value}
      data-attention={panel.attention.value}
      className={cn(
        styles.mobileCodecCard,
        panelPalette(panel.identity.display_name),
        ATTENTION_RING[panel.attention.value],
        glowing ? styles.pingArrive : styles.pingArriveFade,
        offline && styles.panelOffline,
        unknownPresence && styles.panelStale,
      )}
    >
      <header className={styles.mobileCardHeader}>
        <div>
          <p className={styles.mobileCardOrdinal}>
            Agent {String(position).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </p>
          <AgentChip
            name={panel.identity.display_name}
            prefix=""
            className={styles.mobileCardName}
          />
        </div>
        <div className={styles.cardUtilities}>
          {panel.has_artifact_workspace && (
            <a
              data-codec-artifacts-link
              href={`/browse?agent=${encodeURIComponent(panel.instance_id)}`}
              target="_blank"
              rel="noreferrer"
              className={styles.artifactFolderButton}
              aria-label={`Browse ${panel.identity.display_name}'s artifacts in a new tab`}
            >
              <FolderOpen aria-hidden />
            </a>
          )}
          <ContextGauge panel={panel} />
        </div>
      </header>

      <div className={styles.mobileCardHero}>
        <div className={styles.mobilePortraitColumn}>
          <PortraitSurface panel={panel} />
        </div>
        <div className={styles.mobileCardSnapshot}>
          <p className={styles.mobileTaskLabel}>Current assignment</p>
          <p className={styles.mobileTask}>
            {panel.identity.task?.value ?? "No task has been declared"}
          </p>
          <CodecRuntimeStrip panel={panel} />
          <FocusBubble panel={panel} />
          <OperationCue panel={panel} />
        </div>
      </div>

      <div className={styles.mobileCardDetails}>
        <IntentHistory intents={panel.intent_history ?? []} />
        <PanelStatusRail panel={panel} parentName={parentName} />
        <SemanticRead panel={panel} />
        <ActionTrail
          actions={panel.recent_actions}
          active={
            panel.presence.value === "online" &&
            panel.activity.value === "working" &&
            panel.telemetry?.value !== "degraded"
          }
        />
      </div>
    </article>
  );
}

function SceneControls({
  remoteAvailable,
  teamAvailable,
  remoteOpen,
  teamOpen,
  fullscreen,
  fullscreenAvailable,
  onToggleRemote,
  onToggleTeam,
  onToggleFullscreen,
}: {
  remoteAvailable: boolean;
  teamAvailable: boolean;
  remoteOpen: boolean;
  teamOpen: boolean;
  fullscreen: boolean;
  fullscreenAvailable: boolean;
  onToggleRemote: () => void;
  onToggleTeam: () => void;
  onToggleFullscreen: () => Promise<void>;
}) {
  const RemoteIcon = remoteOpen ? PanelLeftClose : PanelLeftOpen;
  const TeamIcon = teamOpen ? PanelRightClose : PanelRightOpen;
  const FullscreenIcon = fullscreen ? Minimize2 : Maximize2;
  return (
    <nav
      data-codec-scene-controls
      className={styles.sceneControls}
      aria-label="Codec view controls"
    >
      <Tooltip
        side="bottom"
        align="end"
        content={`${remoteOpen ? "Hide" : "Show"} the Remote fleet side panel. This preference persists in this browser.`}
      >
        <button
          type="button"
          data-codec-panel-toggle="remote"
          aria-label={`${remoteOpen ? "Hide" : "Show"} Remote fleet panel`}
          aria-pressed={remoteOpen}
          disabled={!remoteAvailable}
          onClick={onToggleRemote}
        >
          <RemoteIcon aria-hidden />
          <span>Fleet</span>
        </button>
      </Tooltip>
      <Tooltip
        side="bottom"
        align="end"
        content={`${teamOpen ? "Hide" : "Show"} the Coordination field side panel. This preference persists in this browser.`}
      >
        <button
          type="button"
          data-codec-panel-toggle="team"
          aria-label={`${teamOpen ? "Hide" : "Show"} Coordination field panel`}
          aria-pressed={teamOpen}
          disabled={!teamAvailable}
          onClick={onToggleTeam}
        >
          <TeamIcon aria-hidden />
          <span>Field</span>
        </button>
      </Tooltip>
      <Tooltip
        side="bottom"
        align="end"
        content={
          fullscreenAvailable
            ? `${fullscreen ? "Exit" : "Enter"} browser fullscreen mode.`
            : "This browser does not expose the Fullscreen API."
        }
      >
        <button
          type="button"
          data-codec-fullscreen-toggle
          aria-label={`${fullscreen ? "Exit" : "Enter"} browser fullscreen`}
          aria-pressed={fullscreen}
          disabled={!fullscreenAvailable}
          onClick={() => void onToggleFullscreen()}
        >
          <FullscreenIcon aria-hidden />
          <span>{fullscreen ? "Exit full screen" : "Full screen"}</span>
        </button>
      </Tooltip>
    </nav>
  );
}

function ActivityLedger({ panels }: { panels: CodecPanelScene[] }) {
  return (
    <section
      data-codec-activity-ledger
      className={styles.activityLedger}
      aria-labelledby="codec-activity-ledger-title"
    >
      <header>
        <p className={styles.teamPulseKicker}>Live ledger</p>
        <h2 id="codec-activity-ledger-title">What every agent is doing now</h2>
      </header>
      <ol>
        {panels.map((panel) => {
          const operation = panel.operation?.value;
          const lastAction = panel.recent_actions[0];
          const summary = operation
            ? `${operation.intent ?? operation.label} · ${humanizeCueToken(operation.state)}`
            : (panel.identity.task?.value ?? "No declared task");
          return (
            <li key={panel.instance_id} data-activity={panel.activity.value}>
              <span className={styles.activityBeacon} aria-hidden />
              <strong>{panel.identity.display_name}</strong>
              <span title={summary}>{summary}</span>
              <small>
                {panel.activity.value}
                {lastAction
                  ? ` · ${lastAction.category} ${lastAction.outcome} · ${formatReceiptTime(lastAction.observed_at)}`
                  : " · no recent tool signal"}
              </small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function RemoteFleet({ machines }: { machines: CodecRemoteMachine[] }) {
  const fresh = machines.filter((machine) => machine.state === "fresh").length;
  const aging = machines.filter((machine) => machine.state === "aging").length;
  const offline = machines.filter((machine) => machine.state === "offline").length;
  return (
    <section
      data-codec-remote-fleet
      className={styles.remoteFleet}
      aria-label="Remote fleet health"
    >
      <header>
        <div>
          <p className={styles.teamPulseKicker}>Remote fleet</p>
          <strong>
            {fresh} fresh · {aging} aging · {offline} offline
          </strong>
        </div>
        <small>expired relay files never restore agent cards</small>
      </header>
      <ul>
        {machines.map((machine) => (
          <li key={machine.machine} data-state={machine.state}>
            <span aria-hidden />
            <strong>{machine.machine}</strong>
            <small>
              {machine.state} · {formatElapsed(machine.age_ms)} since relay
              {machine.visible_agent_count > 0
                ? ` · ${machine.visible_agent_count} visible ${machine.visible_agent_count === 1 ? "agent" : "agents"}`
                : ""}
            </small>
          </li>
        ))}
      </ul>
    </section>
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
  kind: "dependency" | "shared-coordination";
  status: "active" | "waiting" | "blocked";
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
          kind: rel.kind,
          status: rel.status,
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
            data-relationship-kind={line.kind}
            data-relationship-status={line.status}
            className={cn(
              styles.flowLine,
              line.kind === "shared-coordination" && styles.flowLineCoordination,
              line.status === "waiting" && styles.flowLineWaiting,
              line.status === "blocked" && styles.flowLineBlocked,
            )}
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

function TeamPulse({ scene }: { scene: CodecScene }) {
  const summary = summarizeCodecTeam(scene);
  const dependencyTotal =
    summary.dependencies.active + summary.dependencies.waiting + summary.dependencies.blocked;

  return (
    <section
      data-codec-team-map
      className={styles.teamPulse}
      aria-labelledby="codec-team-map-title"
    >
      <header className={styles.teamPulseHeader}>
        <div>
          <p className={styles.teamPulseKicker}>Coordination field</p>
          <h2 id="codec-team-map-title">
            {summary.machines.length} {summary.machines.length === 1 ? "machine" : "machines"} ·{" "}
            {summary.relationships.length} live{" "}
            {summary.relationships.length === 1 ? "link" : "links"}
          </h2>
        </div>
        <div className={styles.relationshipLegend}>
          <span data-tone="coordination">delegation</span>
          <span data-tone="active">active dependency</span>
          <span data-tone="waiting">waiting</span>
          <span data-tone="blocked">blocked</span>
        </div>
      </header>

      <div className={styles.teamPulseBody}>
        <section className={styles.machineLanes} aria-label="Agents by machine">
          {summary.machines.map((machine) => (
            <article
              key={machine.key}
              className={cn(styles.machineLane, machine.remote && styles.machineLaneRemote)}
            >
              <header>
                <span className={styles.machineBeacon} aria-hidden />
                <strong>{machine.label}</strong>
                <small>{machine.remote ? "relay" : "local"}</small>
              </header>
              <ul>
                {machine.panels.map((panel) => (
                  <li
                    key={panel.instance_id}
                    data-presence={panel.presence.value}
                    data-activity={panel.activity.value}
                    title={`${panel.identity.display_name}: ${panel.activity.value}, ${panel.presence.value}`}
                  >
                    <span aria-hidden />
                    {panel.identity.display_name}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>

        <dl className={styles.teamMetrics}>
          <div data-tone="coordination">
            <dt>Delegated</dt>
            <dd>{summary.delegated}</dd>
          </div>
          <div data-tone="active">
            <dt>Active</dt>
            <dd>{summary.dependencies.active}</dd>
          </div>
          <div data-tone="waiting">
            <dt>Waiting</dt>
            <dd>{summary.dependencies.waiting}</dd>
          </div>
          <div data-tone="blocked">
            <dt>Blocked</dt>
            <dd>{summary.dependencies.blocked}</dd>
          </div>
        </dl>
        <p className="sr-only">
          {summary.local_agents} local agents, {summary.remote_agents} remote agents,{" "}
          {dependencyTotal} dependencies.
        </p>
      </div>
    </section>
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
      data-attention={panel.attention.value}
      data-expression={panel.expression.value}
      data-telemetry={panel.telemetry?.value ?? "unknown"}
      className={cn(
        styles.codecPanel,
        panelPalette(panel.identity.display_name),
        ATTENTION_RING[panel.attention.value],
        panel.friction && "ring-1 ring-amber-400/50",
        panel.attention.value === "error" && styles.errorFlash,
        panel.attention.value === "completion" && styles.completionBurst,
        glowing ? styles.pingArrive : styles.pingArriveFade,
        offline && styles.panelOffline,
        unknownPresence && styles.panelStale,
      )}
    >
      <div className={styles.portraitColumn}>
        <PortraitSurface panel={panel} />
      </div>

      <div className={styles.panelBody}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div data-codec-agent-name className="truncate">
              <AgentChip
                name={panel.identity.display_name}
                prefix=""
                className={styles.panelName}
              />
            </div>
            <Tooltip
              side="bottom"
              align="start"
              triggerClassName={styles.fullWidthTooltip}
              content={
                panel.identity.task ? (
                  <div className="space-y-1">
                    <p className="font-semibold">Declared task</p>
                    <p>{panel.identity.task.value}</p>
                    <p className="text-muted-foreground">
                      {panel.identity.task.provenance} · {panel.identity.task.confidence} confidence
                      · observed {formatReceiptTime(panel.identity.task.observed_at)}
                    </p>
                  </div>
                ) : (
                  "No task has been declared for this agent."
                )
              }
            >
              <p data-codec-task className="break-words text-pretty text-xs text-muted-foreground">
                {panel.identity.task?.value ?? "no declared task"}
              </p>
            </Tooltip>
          </div>
          <div className={styles.cardUtilities}>
            {panel.has_artifact_workspace && (
              <Tooltip
                side="bottom"
                align="end"
                content={`Open ${panel.identity.display_name}'s managed artifact workspaces in Harnery Browse.`}
              >
                <a
                  data-codec-artifacts-link
                  href={`/browse?agent=${encodeURIComponent(panel.instance_id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.artifactFolderButton}
                  aria-label={`Browse ${panel.identity.display_name}'s artifacts in a new tab`}
                >
                  <FolderOpen aria-hidden />
                </a>
              </Tooltip>
            )}
            <ContextGauge panel={panel} />
          </div>
        </div>

        <CodecRuntimeStrip panel={panel} />
        <FocusBubble panel={panel} />
        <OperationCue panel={panel} />
        <SemanticRead panel={panel} />
        <IntentHistory intents={panel.intent_history ?? []} />

        <PanelStatusRail panel={panel} parentName={parentName} />

        {panel.remote_source && (
          <Tooltip
            side="top"
            align="start"
            triggerClassName={styles.fullWidthTooltip}
            content="Remote freshness is measured from the encrypted presence relay and its bounded Codec digest. Raw #intent text never crosses the relay."
          >
            <p data-codec-remote-source className="mt-2 text-[11px] text-muted-foreground">
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
          </Tooltip>
        )}

        <ActionTrail
          actions={panel.recent_actions}
          active={
            panel.presence.value === "online" &&
            panel.activity.value === "working" &&
            panel.telemetry?.value !== "degraded"
          }
        />
      </div>
    </section>
  );
}

function PortraitSurface({ panel }: { panel: CodecPanelScene }) {
  return (
    <Tooltip
      side="right"
      triggerClassName={styles.portraitTooltipTrigger}
      content={
        <div className="space-y-1">
          <p className="font-semibold">{panel.identity.display_name}&apos;s live portrait</p>
          <p>
            Expression {humanizeCueToken(panel.expression.value)} · activity{" "}
            {humanizeCueToken(panel.activity.value)} · presence {panel.presence.value}
          </p>
          <p className="text-muted-foreground">
            Character pack {panel.character.pack_id} · expression and activity are evidence-backed
            when provenance allows.
          </p>
        </div>
      }
    >
      <div data-codec-portrait-surface className={styles.portraitTooltipSurface}>
        <Portrait panel={panel} />
        <div
          data-codec-portrait-readout
          data-presence={panel.presence.value}
          className={styles.portraitReadout}
        >
          <div className={styles.portraitReadoutHeader}>
            <span className={styles.portraitReadoutBeacon} aria-hidden />
            <span className={styles.portraitReadoutKicker}>Live state</span>
            <span className={styles.portraitReadoutPresence}>
              {humanizeCueToken(panel.presence.value)}
            </span>
          </div>
          <strong className={styles.portraitReadoutExpression}>
            {humanizeCueToken(panel.expression.value)}
          </strong>
          <div className={styles.portraitReadoutActivity}>
            <span className={styles.portraitReadoutActivityLabel}>Activity</span>
            <strong className={styles.portraitReadoutActivityValue}>
              {humanizeCueToken(panel.activity.value)}
            </strong>
          </div>
          <span className={styles.portraitReadoutMeter} aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </Tooltip>
  );
}

function PanelStatusRail({ panel, parentName }: { panel: CodecPanelScene; parentName?: string }) {
  const offline = panel.presence.value === "offline";
  const unknownPresence = panel.presence.value === "unknown";

  return (
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
            <span className="ml-1 opacity-90">· inferred</span>
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
              <span className="ml-1 opacity-90">· inferred</span>
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
      {panel.artifact_cue && <ArtifactCue cue={panel.artifact_cue} />}
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
  );
}

function SemanticRead({ panel }: { panel: CodecPanelScene }) {
  const semantic = codecSemantic(panel);
  if (!semantic) return null;

  const readerLabel = semantic.reader.resolved_model_id ?? semantic.reader.configured_model;
  const stateLabel = semantic.state === "current" ? "current" : humanizeCueToken(semantic.state);
  const receiptReason = semantic.receipt?.reason_code
    ? humanizeCueToken(semantic.receipt.reason_code)
    : undefined;

  return (
    <details
      data-codec-semantic-read
      data-state={semantic.state}
      className={cn(styles.semanticRead, semantic.state !== "current" && styles.semanticReadMuted)}
    >
      <summary className={styles.semanticSummaryLine}>
        <span className={styles.semanticEyebrow}>Semantic read</span>
        {semantic.phase?.value && semantic.phase.value !== "unknown" && (
          <span className={styles.semanticPhase}>{humanizeCueToken(semantic.phase.value)}</span>
        )}
        <span className={styles.semanticState}>{stateLabel}</span>
      </summary>
      <div className={styles.semanticBody}>
        {semantic.state === "current" ? (
          <>
            {semantic.summary && <p className={styles.semanticCopy}>{semantic.summary.value}</p>}
            {semantic.purpose && (
              <p className={styles.semanticDetail}>
                <span>Purpose</span> {semantic.purpose.value}
              </p>
            )}
            {semantic.recent_result && (
              <p className={styles.semanticDetail}>
                <span>Recent result</span> {semantic.recent_result.value}
              </p>
            )}
            {semantic.attention && (
              <p className={styles.semanticDetail}>
                <span>Attention</span> {semantic.attention.value}
              </p>
            )}
            {semantic.next_step && (
              <p data-codec-semantic-prediction className={styles.semanticPrediction}>
                <span>Predicted next</span> {semantic.next_step.value}
              </p>
            )}
            {semantic.tags && semantic.tags.value.length > 0 && (
              <p className={styles.semanticTags}>{semantic.tags.value.join(" · ")}</p>
            )}
          </>
        ) : (
          <p className={styles.semanticCopy}>
            Reader {stateLabel}
            {receiptReason ? ` · ${receiptReason}` : ""}. No model meaning is being shown.
          </p>
        )}
        <p className={styles.semanticReceipt}>
          <span>{semantic.reader.harness}</span>
          <span>{readerLabel}</span>
          <span>model synthesis</span>
          {semantic.reader.model_attestation && (
            <span>{humanizeCueToken(semantic.reader.model_attestation)}</span>
          )}
          {semantic.state === "current" && (
            <span>expires {formatSemanticTime(semantic.expires_at)}</span>
          )}
        </p>
      </div>
    </details>
  );
}

function formatSemanticTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "unknown";
}

function ArtifactCue({ cue }: { cue: NonNullable<CodecPanelScene["artifact_cue"]> }) {
  return (
    <Tooltip
      side="top"
      align="start"
      className="max-w-sm p-2"
      content={<ArtifactCueDetails cue={cue} />}
    >
      <Badge data-codec-artifact-cue variant="secondary">
        <PackageCheck className="mr-1 size-3" aria-hidden />
        {cue.value.operation} {humanizeCueToken(cue.value.kind)}
      </Badge>
    </Tooltip>
  );
}

function ArtifactCueDetails({ cue }: { cue: NonNullable<CodecPanelScene["artifact_cue"]> }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const imageHash = cue.value.kind === "image" ? cue.value.image_hash : undefined;
  const imageUrl = imageHash ? `/api/image/${imageHash}` : undefined;
  return (
    <div className="space-y-2">
      <div>
        <p className="font-semibold">
          Artifact · {cue.value.operation} {humanizeCueToken(cue.value.kind)}
        </p>
        <p className="text-muted-foreground">
          {cue.provenance} · {cue.confidence} confidence · observed{" "}
          {formatReceiptTime(cue.observed_at)}
        </p>
        {(cue.value.image_media_type || cue.value.image_bytes !== undefined) && (
          <p className="text-muted-foreground">
            {[cue.value.image_media_type, formatCompactBytes(cue.value.image_bytes)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
      {imageUrl && (
        <a
          data-codec-artifact-image-link
          href={imageUrl}
          target="_blank"
          rel="noreferrer"
          className="group block overflow-hidden rounded-md border border-border bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {previewFailed ? (
            <span className="flex h-28 items-center justify-center px-4 text-center text-muted-foreground">
              Preview unavailable · open the retained image in a new tab
            </span>
          ) : (
            // biome-ignore lint/performance/noImgElement: content-addressed Harnery thumbnail is already resized by the image API
            <img
              src={`${imageUrl}?w=360`}
              alt="Created artifact preview"
              loading="lazy"
              decoding="async"
              onError={() => setPreviewFailed(true)}
              className="max-h-52 w-full object-contain"
            />
          )}
          <span className="flex items-center justify-center gap-1 border-t border-border px-2 py-1.5 font-medium text-foreground group-hover:bg-muted/50">
            Open full-size image in a new tab <ExternalLink className="size-3" aria-hidden />
          </span>
        </a>
      )}
    </div>
  );
}

function formatCompactBytes(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function IntentHistory({ intents }: { intents: CodecIntentSignal[] }) {
  const visible = intents.slice(0, 3);
  return (
    <section data-codec-intent-history className={styles.intentHistory} aria-label="Recent intents">
      {visible.length > 0 ? (
        <ol>
          {visible.map((intent, index) => (
            <li key={intent.event_id} data-depth={index + 1}>
              <Tooltip
                side="bottom"
                align="start"
                triggerClassName={styles.intentTooltipTrigger}
                className="max-w-sm"
                content={
                  <div className="space-y-1">
                    <p className="font-semibold">
                      #{index + 1} · {intent.text}
                    </p>
                    <p className="text-muted-foreground">
                      {intent.tool_name ?? humanizeCueToken(intent.category)} ·{" "}
                      {humanizeCueToken(intent.event_type)} · observed{" "}
                      {formatReceiptTime(intent.observed_at)}
                    </p>
                    <p className="text-muted-foreground">
                      {intent.live_overlay ? "Local live-display overlay" : "Sanitized event label"}
                      {intent.adapter ? ` · ${intent.adapter}` : ""}
                    </p>
                    <code className="block break-all text-[10px] text-foreground/75">
                      {intent.event_id}
                    </code>
                  </div>
                }
              >
                <span data-codec-intent-line className={styles.intentLine}>
                  {intent.text}
                </span>
              </Tooltip>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.intentEmpty}>No recent local #intent signals</p>
      )}
    </section>
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
  const Icon = operation
    ? (CATEGORY_ICONS[operation.value.category] ?? CircleDashed)
    : CircleDashed;
  const label = operation
    ? operation.value.label
    : panel.presence.value === "online"
      ? "Between operations"
      : "No active operation";
  const stateLabel = operation ? humanizeCueToken(operation.value.state) : "standby";
  const headline = operation?.value.intent ?? label;
  const toolLabel = operation?.value.tool_name
    ? humanizeCueToken(operation.value.tool_name)
    : label;
  const metadata = operation
    ? [
        toolLabel,
        humanizeCueToken(operation.value.category),
        stateLabel,
        operation.value.elapsed_ms !== undefined
          ? formatElapsed(operation.value.elapsed_ms)
          : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    : "standby";
  const outputSummary = operation?.value.output_observations
    ? `${operation.value.output_observations} output ${operation.value.output_observations === 1 ? "signal" : "signals"}${
        operation.value.output_bytes !== undefined
          ? ` · ${formatCompactBytes(operation.value.output_bytes)}`
          : ""
      }`
    : undefined;
  return (
    <Tooltip
      side="bottom"
      align="start"
      triggerClassName={styles.fullWidthTooltip}
      content={
        operation ? (
          <div className="space-y-1">
            <p className="font-semibold">{headline}</p>
            {operation.value.intent && (
              <p className="text-muted-foreground">Observed operation · {operation.value.label}</p>
            )}
            <p>{metadata}</p>
            {outputSummary && <p>{outputSummary}</p>}
            {operation.value.duration_sample_count !== undefined && (
              <p className="text-muted-foreground">
                {operation.value.duration_sample_count} comparable successful duration samples
                {operation.value.long_running_threshold_ms !== undefined
                  ? ` · long-running after ${formatElapsed(operation.value.long_running_threshold_ms)}`
                  : " · baseline still forming"}
              </p>
            )}
            <p className="text-muted-foreground">
              {operation.provenance} · {operation.confidence} confidence · observed{" "}
              {formatReceiptTime(operation.observed_at)}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="font-semibold">No open operation span</p>
            <p className="text-muted-foreground">
              This stable placeholder holds the card layout between observed operation events.
            </p>
          </div>
        )
      }
    >
      <div
        data-codec-operation-cue
        data-enriched={operation ? "true" : undefined}
        data-placeholder={operation ? undefined : "true"}
        role="status"
        className={cn(
          styles.operationCue,
          panel.presence.value === "online" &&
            operation &&
            panel.activity.value === "working" &&
            panel.telemetry?.value !== "degraded" &&
            styles.operationCueLive,
          !operation && styles.operationCuePlaceholder,
        )}
        aria-label={operation ? `Current operation: ${headline}. ${metadata}` : label}
      >
        <Icon className={styles.operationIcon} aria-hidden />
        <span className={styles.operationLabel}>{headline}</span>
        <span
          className={cn(
            styles.operationState,
            operation?.value.state === "output-flow" &&
              panel.telemetry?.value !== "degraded" &&
              styles.outputFlow,
          )}
        >
          {metadata}
          {outputSummary && ` · ${outputSummary}`}
        </span>
      </div>
    </Tooltip>
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
    <Tooltip
      side="bottom"
      align="start"
      triggerClassName={styles.fullWidthTooltip}
      content={
        <div className="space-y-1">
          <p className="font-semibold">Focus capsule · {bubble.value.text}</p>
          <p className="text-muted-foreground">
            {bubble.value.basis} · {bubble.provenance} provenance · {bubble.confidence} confidence
            {bubble.value.live_overlay ? " · local live-display overlay" : ""}
          </p>
        </div>
      }
    >
      <p
        data-codec-focus
        className={cn(
          "mt-2 flex w-full max-w-full flex-wrap items-center gap-x-1 gap-y-0 rounded-2xl border px-2.5 py-1 text-pretty text-xs leading-relaxed",
          styles.focusBubble,
          inferred ? "border-dashed text-muted-foreground" : "text-foreground",
        )}
      >
        <span className={styles.focusText}>{bubble.value.text}</span>
        {inferred && <span className="flex-none opacity-90">· inferred</span>}
      </p>
    </Tooltip>
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
  const usage = panel.context_usage?.value;
  return (
    <Tooltip
      side="left"
      content={
        <div className="space-y-1">
          <p className="font-semibold">Context capacity · {band}</p>
          {usage ? (
            <>
              <p>
                {usage.used_percent.toFixed(1)}% used · {usage.remaining_percent.toFixed(1)}%
                remaining
              </p>
              {usage.used_tokens !== undefined && usage.limit_tokens !== undefined && (
                <p>
                  {usage.used_tokens.toLocaleString()} / {usage.limit_tokens.toLocaleString()}{" "}
                  tokens
                  {usage.remaining_tokens !== undefined
                    ? ` · ${usage.remaining_tokens.toLocaleString()} remaining`
                    : ""}
                </p>
              )}
            </>
          ) : (
            <p>Exact usage is unavailable for this observation.</p>
          )}
          <p className="text-muted-foreground">
            {panel.context_band.provenance} · {panel.context_band.confidence} confidence · observed{" "}
            {formatReceiptTime(panel.context_band.observed_at)}
          </p>
        </div>
      }
    >
      <div
        data-codec-context-gauge
        className="flex flex-none flex-col items-center gap-0.5"
        aria-label={label}
        role="img"
      >
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
    </Tooltip>
  );
}

function ActionTrail({ actions, active }: { actions: CodecRecentAction[]; active: boolean }) {
  if (actions.length === 0) return null;
  return (
    <ul
      className={cn(styles.actionTrail, active && styles.actionTrailLive)}
      aria-label="Recent actions"
    >
      {actions.map((action, index) => {
        const Icon = CATEGORY_ICONS[action.category] ?? CircleDashed;
        return (
          <li key={action.event_id}>
            <Tooltip
              side="top"
              content={`${humanizeCueToken(action.category)} action · ${action.outcome} · observed ${formatReceiptTime(action.observed_at)} · event ${action.event_id}`}
            >
              <span
                data-codec-action
                style={{ "--trail-index": index } as CSSProperties}
                className={cn(
                  styles.actionIcon,
                  action.outcome === "error"
                    ? "border-red-300 text-red-600 dark:border-red-900 dark:text-red-400"
                    : "text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                <span className="sr-only">
                  {action.category} {action.outcome}
                </span>
              </span>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
