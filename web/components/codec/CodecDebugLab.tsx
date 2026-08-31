"use client";

import Link from "next/link";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { CodecScene } from "@/lib/codec/contracts";
import {
  buildCodecDebugScene,
  type CodecDebugAgent,
  type CodecDebugCardState,
  createDefaultCodecDebugState,
  DEBUG_ACTIVITIES,
  DEBUG_ATTENTION_STATES,
  DEBUG_EXPRESSIONS,
  DEBUG_LIFECYCLES,
  DEBUG_PRESENCES,
  DEBUG_TELEMETRY_STATES,
} from "@/lib/codec/debug-scene";
import {
  CODEC_EFFECT_KINDS,
  type CodecEffectKind,
  type CodecEffectPreview,
} from "@/lib/codec/effects/contracts";
import type { CodecLayout } from "@/lib/codec/layout";
import { CodecView, type CodecViewportOverride } from "./CodecView";
import codecStyles from "./codec.module.css";
import styles from "./codecDebug.module.css";

interface CodecDebugLabProps {
  agents: CodecDebugAgent[];
}

const AMBIENCES: readonly CodecScene["team_ambience"]["value"][] = [
  "calm",
  "busy",
  "alert",
  "unknown",
];

type CodecLayoutPresetId = "live" | "mobile" | "tablet" | "desktop-short" | "desktop-tall";

interface CodecLayoutPreset {
  id: CodecLayoutPresetId;
  label: string;
  detail: string;
  viewport?: CodecViewportOverride;
}

const BROWSER_LAYOUT_PRESET: CodecLayoutPreset = {
  id: "live",
  label: "Browser",
  detail: "live size",
};

const LAYOUT_PRESETS: readonly CodecLayoutPreset[] = [
  BROWSER_LAYOUT_PRESET,
  { id: "mobile", label: "Mobile", detail: "390 × 844", viewport: { width: 390, height: 844 } },
  { id: "tablet", label: "Tablet", detail: "900 × 900", viewport: { width: 900, height: 900 } },
  {
    id: "desktop-short",
    label: "Short desktop",
    detail: "1600 × 760",
    viewport: { width: 1_600, height: 760 },
  },
  {
    id: "desktop-tall",
    label: "Tall desktop",
    detail: "1920 × 960",
    viewport: { width: 1_920, height: 960 },
  },
];

function initialStates(agents: CodecDebugAgent[]): Record<string, CodecDebugCardState> {
  return Object.fromEntries(
    agents.map((agent, index) => [agent.id, createDefaultCodecDebugState(index)]),
  );
}

export function CodecDebugLab({ agents }: CodecDebugLabProps) {
  const maximum = agents.length;
  const [count, setCount] = useState(Math.min(8, maximum));
  const [states, setStates] = useState(() => initialStates(agents));
  const [selectedId, setSelectedId] = useState(agents[0]?.id ?? "");
  const [effectKind, setEffectKind] = useState<CodecEffectKind>("ping");
  const [effectFrom, setEffectFrom] = useState(agents[0]?.id ?? "");
  const [effectTarget, setEffectTarget] = useState(agents[1]?.id ?? agents[0]?.id ?? "");
  const [effectSequence, setEffectSequence] = useState(0);
  const [autoEffect, setAutoEffect] = useState(false);
  const [ambience, setAmbience] = useState<CodecScene["team_ambience"]["value"]>("busy");
  const [showRelationships, setShowRelationships] = useState(true);
  const [showRemoteAgents, setShowRemoteAgents] = useState(true);
  const [randomization, setRandomization] = useState(0);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [layoutPresetId, setLayoutPresetId] = useState<CodecLayoutPresetId>("live");
  const [layoutSnapshot, setLayoutSnapshot] = useState<CodecLayout | null>(null);

  const visibleAgents = agents.slice(0, count);
  const visibleIds = useMemo(
    () => new Set(visibleAgents.map((agent) => agent.id)),
    [visibleAgents],
  );
  const selectedState = states[selectedId];
  const layoutPreset =
    LAYOUT_PRESETS.find((preset) => preset.id === layoutPresetId) ?? BROWSER_LAYOUT_PRESET;
  const simulatedViewport = layoutPreset.viewport;
  const viewportStyle = simulatedViewport
    ? ({
        width: `${simulatedViewport.width}px`,
        height: `${simulatedViewport.height}px`,
        "--codec-debug-viewport-width": `${simulatedViewport.width}px`,
        "--codec-debug-viewport-height": `${simulatedViewport.height}px`,
      } as CSSProperties)
    : undefined;

  useEffect(() => {
    const first = visibleAgents[0]?.id ?? "";
    if (!visibleIds.has(selectedId)) setSelectedId(first);
    if (!visibleIds.has(effectFrom)) setEffectFrom(first);
    if (!visibleIds.has(effectTarget) || (effectKind === "ping" && effectTarget === effectFrom)) {
      setEffectTarget(visibleAgents.find((agent) => agent.id !== effectFrom)?.id ?? first);
    }
  }, [effectFrom, effectKind, effectTarget, selectedId, visibleAgents, visibleIds]);

  useEffect(() => {
    if (!autoEffect || visibleAgents.length === 0) return;
    const timer = window.setInterval(() => setEffectSequence((value) => value + 1), 6_500);
    return () => window.clearInterval(timer);
  }, [autoEffect, visibleAgents.length]);

  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 820px)");
    const matchViewport = () => setControlsOpen(!mobileQuery.matches);
    matchViewport();
    mobileQuery.addEventListener("change", matchViewport);
    return () => mobileQuery.removeEventListener("change", matchViewport);
  }, []);

  const scene = useMemo(
    () =>
      buildCodecDebugScene({
        agents: visibleAgents,
        states,
        ambience,
        showRelationships,
        showRemoteAgents,
      }),
    [ambience, showRelationships, showRemoteAgents, states, visibleAgents],
  );

  const effectPreview: CodecEffectPreview | undefined =
    effectSequence > 0 && effectTarget
      ? {
          sequence: effectSequence,
          kind: effectKind,
          targetInstanceId: effectTarget,
          ...(effectKind === "ping" && effectFrom ? { sourceInstanceId: effectFrom } : {}),
        }
      : undefined;

  function setCardState<K extends keyof CodecDebugCardState>(
    key: K,
    value: CodecDebugCardState[K],
  ) {
    if (!selectedId) return;
    setStates((current) => ({
      ...current,
      [selectedId]: { ...(current[selectedId] ?? createDefaultCodecDebugState(0)), [key]: value },
    }));
  }

  function resetScene() {
    setStates(initialStates(agents));
    setCount(Math.min(8, maximum));
    setSelectedId(agents[0]?.id ?? "");
    setEffectKind("ping");
    setEffectFrom(agents[0]?.id ?? "");
    setEffectTarget(agents[1]?.id ?? agents[0]?.id ?? "");
    setEffectSequence(0);
    setAutoEffect(false);
    setAmbience("busy");
    setShowRelationships(true);
    setShowRemoteAgents(true);
    setRandomization(0);
    setLayoutPresetId("live");
    setLayoutSnapshot(null);
  }

  function randomizeVisibleCards() {
    const nextRound = randomization + 1;
    setRandomization(nextRound);
    setStates((current) => {
      const next = { ...current };
      visibleAgents.forEach((agent, index) => {
        const seed = index + nextRound;
        next[agent.id] = {
          activity: DEBUG_ACTIVITIES[seed % DEBUG_ACTIVITIES.length] ?? "working",
          lifecycle: DEBUG_LIFECYCLES[(seed * 3) % DEBUG_LIFECYCLES.length] ?? "active",
          presence: DEBUG_PRESENCES[(seed * 5) % DEBUG_PRESENCES.length] ?? "online",
          expression: DEBUG_EXPRESSIONS[(seed * 7) % DEBUG_EXPRESSIONS.length] ?? "neutral",
          attention: DEBUG_ATTENTION_STATES[(seed * 11) % DEBUG_ATTENTION_STATES.length] ?? "none",
          telemetry:
            DEBUG_TELEMETRY_STATES[(seed * 13) % DEBUG_TELEMETRY_STATES.length] ?? "healthy",
          contextUsedPercent: 8 + ((seed * 17) % 89),
        };
      });
      return next;
    });
  }

  const effectDisabled =
    visibleAgents.length === 0 ||
    !effectTarget ||
    (effectKind === "ping" &&
      (visibleAgents.length < 2 || !effectFrom || effectFrom === effectTarget));

  return (
    <div className={styles.debugShell} data-codec-debug-shell>
      <aside className={styles.controlRail} data-codec-control-rail aria-label="Codec scene lab">
        <header className={styles.debugHeader}>
          <div className={styles.headerTopline}>
            <p className={styles.eyebrow}>Synthetic scene · no coordination writes</p>
            <Link className={styles.liveLink} href="/codec" prefetch={false}>
              Live Codec
            </Link>
          </div>
          <h1>Codec scene lab</h1>
          <p>Build a repeatable scene, then inspect the real Codec surface beside it.</p>
        </header>

        <section
          className={styles.console}
          data-open={controlsOpen ? "true" : "false"}
          data-codec-debug-controls
        >
          <button
            type="button"
            className={styles.consoleToggle}
            data-codec-controls-toggle
            aria-expanded={controlsOpen}
            onClick={(event) => {
              event.preventDefault();
              setControlsOpen((current) => !current);
            }}
          >
            <span className={styles.summaryLabel}>Scene controls</span>
            <span className={styles.summaryState}>
              {count} cards · {ambience}
            </span>
          </button>
          {controlsOpen ? (
            <div className={styles.controlGrid}>
              <fieldset className={styles.controlGroup}>
                <legend>
                  <span className={styles.legendIndex}>01</span>
                  Card load
                </legend>
                <label className={styles.rangeLabel}>
                  <span>Agent cards</span>
                  <output>{count}</output>
                  <input
                    aria-label="Agent card count"
                    data-codec-card-count
                    type="range"
                    min="0"
                    max={maximum}
                    value={count}
                    onChange={(event) => setCount(Number(event.target.value))}
                  />
                </label>
                <div className={styles.presetRow}>
                  {[1, 3, 4, 5, 6, 8, 16, 32, maximum]
                    .filter(
                      (value, index, values) => value <= maximum && values.indexOf(value) === index,
                    )
                    .map((value) => (
                      <button
                        type="button"
                        key={value}
                        data-codec-count-preset={value}
                        aria-pressed={count === value}
                        onClick={() => setCount(value)}
                      >
                        {value}
                      </button>
                    ))}
                </div>
                <label>
                  Ambience
                  <select
                    value={ambience}
                    onChange={(event) => setAmbience(event.target.value as typeof ambience)}
                  >
                    {AMBIENCES.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={showRelationships}
                    onChange={(event) => setShowRelationships(event.target.checked)}
                  />
                  Relationship lines
                </label>
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={showRemoteAgents}
                    onChange={(event) => setShowRemoteAgents(event.target.checked)}
                  />
                  Remote agents
                </label>
              </fieldset>

              <fieldset className={styles.controlGroup}>
                <legend>
                  <span className={styles.legendIndex}>02</span>
                  Layout lab
                </legend>
                <div className={styles.viewportPresetGrid}>
                  {LAYOUT_PRESETS.map((preset) => (
                    <button
                      type="button"
                      key={preset.id}
                      data-codec-layout-preset-button={preset.id}
                      aria-pressed={layoutPresetId === preset.id}
                      onClick={() => {
                        setLayoutPresetId(preset.id);
                        setLayoutSnapshot(null);
                      }}
                    >
                      <span>{preset.label}</span>
                      <small>{preset.detail}</small>
                    </button>
                  ))}
                </div>
                <p className={styles.controlHint}>
                  {simulatedViewport
                    ? "The preview uses a 1:1 viewport canvas. Scroll the frame when it is wider than the browser."
                    : "The preview follows the current browser and available stage size."}
                </p>
              </fieldset>

              <fieldset className={styles.controlGroup} disabled={visibleAgents.length === 0}>
                <legend>
                  <span className={styles.legendIndex}>03</span>
                  Animation engine
                </legend>
                <label>
                  Effect
                  <select
                    aria-label="Codec effect"
                    data-codec-effect-kind
                    value={effectKind}
                    onChange={(event) => setEffectKind(event.target.value as CodecEffectKind)}
                  >
                    {CODEC_EFFECT_KINDS.map((kind) => (
                      <option value={kind} key={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  From
                  <select
                    aria-label="Effect source"
                    disabled={effectKind !== "ping"}
                    value={effectFrom}
                    onChange={(event) => setEffectFrom(event.target.value)}
                  >
                    {visibleAgents.map((agent) => (
                      <option value={agent.id} key={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Target
                  <select
                    aria-label="Effect target"
                    value={effectTarget}
                    onChange={(event) => setEffectTarget(event.target.value)}
                  >
                    {visibleAgents.map((agent) => (
                      <option value={agent.id} key={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className={styles.primaryButton}
                  type="button"
                  data-codec-trigger-effect
                  data-codec-trigger-ping={effectKind === "ping" ? "true" : undefined}
                  disabled={effectDisabled}
                  onClick={() => setEffectSequence((value) => value + 1)}
                >
                  Trigger {effectKind}
                </button>
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={autoEffect}
                    disabled={effectDisabled}
                    onChange={(event) => setAutoEffect(event.target.checked)}
                  />
                  Repeat every 6.5 seconds
                </label>
                <p className={styles.controlHint} aria-live="polite">
                  {effectSequence > 0
                    ? `${effectKind} cue ${effectSequence} emitted.`
                    : "No effect cue emitted yet."}
                </p>
              </fieldset>

              <fieldset className={styles.controlGroup} disabled={!selectedState}>
                <legend>
                  <span className={styles.legendIndex}>04</span>
                  Individual card
                </legend>
                <label>
                  Agent
                  <select
                    aria-label="Card to edit"
                    value={selectedId}
                    onChange={(event) => setSelectedId(event.target.value)}
                  >
                    {visibleAgents.map((agent) => (
                      <option value={agent.id} key={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className={styles.stateGrid}>
                  <label>
                    Activity
                    <select
                      data-codec-activity-control
                      value={selectedState?.activity ?? "working"}
                      onChange={(event) =>
                        setCardState(
                          "activity",
                          event.target.value as CodecDebugCardState["activity"],
                        )
                      }
                    >
                      {DEBUG_ACTIVITIES.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Lifecycle
                    <select
                      data-codec-lifecycle-control
                      value={selectedState?.lifecycle ?? "active"}
                      onChange={(event) =>
                        setCardState(
                          "lifecycle",
                          event.target.value as CodecDebugCardState["lifecycle"],
                        )
                      }
                    >
                      {DEBUG_LIFECYCLES.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Presence
                    <select
                      value={selectedState?.presence ?? "online"}
                      onChange={(event) =>
                        setCardState(
                          "presence",
                          event.target.value as CodecDebugCardState["presence"],
                        )
                      }
                    >
                      {DEBUG_PRESENCES.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Expression
                    <select
                      value={selectedState?.expression ?? "neutral"}
                      onChange={(event) =>
                        setCardState(
                          "expression",
                          event.target.value as CodecDebugCardState["expression"],
                        )
                      }
                    >
                      {DEBUG_EXPRESSIONS.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Attention
                    <select
                      value={selectedState?.attention ?? "none"}
                      onChange={(event) =>
                        setCardState(
                          "attention",
                          event.target.value as CodecDebugCardState["attention"],
                        )
                      }
                    >
                      {DEBUG_ATTENTION_STATES.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Telemetry
                    <select
                      value={selectedState?.telemetry ?? "healthy"}
                      onChange={(event) =>
                        setCardState(
                          "telemetry",
                          event.target.value as CodecDebugCardState["telemetry"],
                        )
                      }
                    >
                      {DEBUG_TELEMETRY_STATES.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className={styles.rangeLabel}>
                  <span>Context used</span>
                  <output>{selectedState?.contextUsedPercent ?? 0}%</output>
                  <input
                    aria-label="Selected card context used"
                    type="range"
                    min="0"
                    max="100"
                    value={selectedState?.contextUsedPercent ?? 0}
                    onChange={(event) =>
                      setCardState("contextUsedPercent", Number(event.target.value))
                    }
                  />
                </label>
              </fieldset>

              <fieldset className={styles.controlGroup}>
                <legend>
                  <span className={styles.legendIndex}>05</span>
                  Utilities
                </legend>
                <button type="button" data-codec-randomize onClick={randomizeVisibleCards}>
                  Randomize visible cards
                </button>
                <button type="button" data-codec-reset onClick={resetScene}>
                  Reset scene
                </button>
                <p className={styles.controlHint}>
                  Use the Codec toolbar to hide panels or test fullscreen. Resize the browser to
                  inspect the mobile deck.
                </p>
              </fieldset>
            </div>
          ) : null}
        </section>
      </aside>

      <section
        className={styles.previewPane}
        data-codec-preview-pane
        aria-label="Codec scene preview"
      >
        <header className={styles.previewHeader} data-codec-preview-status>
          <div>
            <p className={styles.previewEyebrow}>Live preview</p>
            <h2 data-codec-preview-title>Scene output · {layoutPreset.label}</h2>
          </div>
          <div
            className={styles.previewMeta}
            role="status"
            aria-label="Preview state"
            data-codec-layout-readout
          >
            <span className={styles.renderState}>
              <i aria-hidden />
              Rendering
            </span>
            <span>{count} agents</span>
            <span data-codec-layout-composition>
              {layoutSnapshot?.composition ?? "measuring layout"}
            </span>
            <span data-codec-layout-grid>
              {layoutSnapshot
                ? `${layoutSnapshot.rows} rows × ${layoutSnapshot.columns} columns`
                : "—"}
            </span>
            <span data-codec-layout-card-height>{layoutSnapshot?.cardHeight ?? "—"}</span>
            <span data-codec-layout-overflow>{layoutSnapshot?.bodyOverflow ?? "—"} overflow</span>
          </div>
        </header>
        <div className={styles.stageFrame} data-codec-layout-frame>
          <div
            className={styles.viewportCanvas}
            data-codec-layout-preset={layoutPreset.id}
            data-simulated={simulatedViewport ? "true" : "false"}
            style={viewportStyle}
          >
            <div className={codecStyles.codecStage} data-codec-debug-stage>
              <CodecView
                initialScene={scene}
                mode="debug"
                effectPreview={effectPreview}
                viewportOverride={simulatedViewport}
                onLayoutChange={setLayoutSnapshot}
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
