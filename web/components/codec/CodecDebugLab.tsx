"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
import { CodecView } from "./CodecView";
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

  const visibleAgents = agents.slice(0, count);
  const visibleIds = useMemo(
    () => new Set(visibleAgents.map((agent) => agent.id)),
    [visibleAgents],
  );
  const selectedState = states[selectedId];

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
    <>
      <header className={styles.debugHeader}>
        <div>
          <p className={styles.eyebrow}>Synthetic scene · no coordination writes</p>
          <h1>Codec debug console</h1>
          <p>Drive the real Codec view through repeatable card, layout, and animation states.</p>
        </div>
        <Link href="/codec" prefetch={false}>
          Live Codec
        </Link>
      </header>

      <details className={styles.console} open data-codec-debug-controls>
        <summary>
          <span>Scene controls</span>
          <span className={styles.summaryState}>
            {count} cards · {ambience}
          </span>
        </summary>
        <div className={styles.controlGrid}>
          <fieldset className={styles.controlGroup}>
            <legend>Card load</legend>
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
              {[1, 4, 8, 16, 32, maximum]
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

          <fieldset className={styles.controlGroup} disabled={visibleAgents.length === 0}>
            <legend>Animation engine</legend>
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
            <legend>Individual card</legend>
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
                    setCardState("activity", event.target.value as CodecDebugCardState["activity"])
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
                    setCardState("presence", event.target.value as CodecDebugCardState["presence"])
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
                onChange={(event) => setCardState("contextUsedPercent", Number(event.target.value))}
              />
            </label>
          </fieldset>

          <fieldset className={styles.controlGroup}>
            <legend>Utilities</legend>
            <button type="button" onClick={randomizeVisibleCards}>
              Randomize visible cards
            </button>
            <button type="button" onClick={resetScene}>
              Reset scene
            </button>
            <p className={styles.controlHint}>
              Use the Codec toolbar below to hide side panels or test fullscreen. Browser width
              switches the same component to its mobile deck.
            </p>
          </fieldset>
        </div>
      </details>

      <div className={codecStyles.codecStage} data-codec-debug-stage>
        <CodecView initialScene={scene} mode="debug" effectPreview={effectPreview} />
      </div>
    </>
  );
}
