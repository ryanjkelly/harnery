/** Deterministic Codec scenes for the interactive dashboard debug harness. */

import {
  CODEC_SCHEMA_VERSION,
  type CodecActivity,
  type CodecAttention,
  type CodecContextBand,
  type CodecExpression,
  type CodecLifecycle,
  type CodecPanelScene,
  type CodecPresence,
  type CodecScene,
  type CodecTelemetry,
  type Presented,
} from "./contracts";

export const DEBUG_EXPRESSIONS: readonly CodecExpression[] = [
  "neutral",
  "focused",
  "curious",
  "deliberating",
  "investigating",
  "building",
  "coordinating",
  "waiting",
  "recovering",
  "celebrating",
  "alert",
  "observing",
  "wrapping-up",
  "compacting",
  "conducting",
  "weighing",
  "planning",
  "verifying",
  "strained",
  "blocked",
  "dormant",
];

export const DEBUG_ACTIVITIES: readonly CodecActivity[] = [
  "working",
  "needs-input",
  "idle",
  "unknown",
];
export const DEBUG_LIFECYCLES: readonly CodecLifecycle[] = ["active", "blocked", "done", "unknown"];
export const DEBUG_PRESENCES: readonly CodecPresence[] = ["online", "unknown", "offline"];
export const DEBUG_ATTENTION_STATES: readonly CodecAttention[] = [
  "none",
  "input",
  "friction",
  "error",
  "completion",
];
export const DEBUG_TELEMETRY_STATES: readonly CodecTelemetry[] = ["healthy", "degraded", "unknown"];

export interface CodecDebugAgent {
  id: string;
  name: string;
  packId: string;
  packVersion: string;
}

export interface CodecDebugCardState {
  activity: CodecActivity;
  lifecycle: CodecLifecycle;
  presence: CodecPresence;
  expression: CodecExpression;
  attention: CodecAttention;
  telemetry: CodecTelemetry;
  contextUsedPercent: number;
}

export interface CodecDebugPing {
  sequence: number;
  fromId: string;
  toId: string;
}

interface BuildCodecDebugSceneOptions {
  agents: CodecDebugAgent[];
  states: Record<string, CodecDebugCardState>;
  ambience: CodecScene["team_ambience"]["value"];
  showRelationships: boolean;
  showRemoteAgents: boolean;
  ping?: CodecDebugPing;
}

const OBSERVED_AT = "2026-08-26T17:00:00.000Z";
const EXPIRES_AT = "2099-12-31T23:59:59.000Z";

function shown<T>(value: T, expiresAt?: string): Presented<T> {
  return {
    value,
    provenance: "projection",
    confidence: "high",
    observed_at: OBSERVED_AT,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
}

export function createDefaultCodecDebugState(index: number): CodecDebugCardState {
  const expressions: readonly CodecExpression[] = [
    "coordinating",
    "building",
    "investigating",
    "focused",
    "waiting",
    "verifying",
    "planning",
    "observing",
  ];
  return {
    activity: index === 4 ? "needs-input" : "working",
    lifecycle: "active",
    presence: "online",
    expression: expressions[index % expressions.length] ?? "neutral",
    attention: index === 4 ? "input" : "none",
    telemetry: "healthy",
    contextUsedPercent: 18 + ((index * 11) % 68),
  };
}

function contextBand(usedPercent: number): CodecContextBand {
  if (usedPercent >= 85) return "low";
  if (usedPercent >= 65) return "reduced";
  return "ample";
}

function operationFor(state: CodecDebugCardState, index: number) {
  const categories = ["coordinate", "build", "diagnostic", "test", "edit"] as const;
  const category = categories[index % categories.length] ?? "other";
  const label =
    state.lifecycle === "done"
      ? "Complete"
      : state.activity === "needs-input"
        ? "Needs input"
        : state.activity === "idle"
          ? "Paused"
          : "Card test";
  return { category, label, state: "active" as const };
}

function debugPanel(
  agent: CodecDebugAgent,
  state: CodecDebugCardState,
  index: number,
  parentId: string | undefined,
  showRemoteAgents: boolean,
): CodecPanelScene {
  const remote = showRemoteAgents && index > 0 && index % 5 === 0;
  const attentionExpires = state.attention === "none" ? undefined : EXPIRES_AT;
  return {
    instance_id: agent.id,
    identity: {
      display_name: agent.name,
      task: shown(`Debug card ${index + 1}: ${state.activity}`),
    },
    ...(remote
      ? {
          machine: "debug-relay",
          remote_source: {
            relay: shown({ state: "fresh" as const, age_ms: 12_000 }),
            digest: shown({ state: "fresh" as const, age_ms: 18_000 }),
          },
        }
      : {}),
    presence: shown(state.presence),
    activity: shown(state.activity),
    lifecycle: shown(state.lifecycle),
    expression: shown(state.expression),
    attention: shown(state.attention, attentionExpires),
    context_band: shown(contextBand(state.contextUsedPercent)),
    context_usage: shown({
      used_percent: state.contextUsedPercent,
      remaining_percent: 100 - state.contextUsedPercent,
    }),
    runtime: shown({
      harness: "debug",
      model: "fixture",
      effort: "test",
      speed: null,
    }),
    progress_rhythm: shown(state.lifecycle === "done" ? "wrapping-up" : "in-motion"),
    recent_actions: [
      {
        category: operationFor(state, index).category,
        outcome: state.telemetry === "degraded" ? "error" : "ok",
        event_id: `evt_debug_${index}`,
        observed_at: OBSERVED_AT,
      },
    ],
    intent_history: [
      {
        text: `Exercise ${state.expression} expression`,
        event_id: `evt_debug_intent_${index}`,
        observed_at: OBSERVED_AT,
        event_type: "command.completed",
        category: operationFor(state, index).category,
        adapter: "codex",
      },
    ],
    operation: shown(operationFor(state, index)),
    ...(state.attention === "friction" ? { friction: shown("target-contention" as const) } : {}),
    telemetry: shown(state.telemetry),
    ...(state.telemetry === "degraded"
      ? { telemetry_reason: shown("context-observation-missing" as const) }
      : {}),
    ...(parentId ? { parent_instance_id: shown(parentId) } : {}),
    character: { pack_id: agent.packId, pack_version: agent.packVersion },
    updated_at: OBSERVED_AT,
  };
}

export function buildCodecDebugScene(options: BuildCodecDebugSceneOptions): CodecScene {
  const panels = options.agents.map((agent, index) =>
    debugPanel(
      agent,
      options.states[agent.id] ?? createDefaultCodecDebugState(index),
      index,
      index > 0 ? options.agents[0]?.id : undefined,
      options.showRemoteAgents,
    ),
  );
  const panelIds = new Set(panels.map((panel) => panel.instance_id));
  const remoteCount = panels.filter((panel) => panel.machine).length;
  const ping =
    options.ping &&
    options.ping.fromId !== options.ping.toId &&
    panelIds.has(options.ping.fromId) &&
    panelIds.has(options.ping.toId)
      ? options.ping
      : undefined;

  return {
    schema_version: CODEC_SCHEMA_VERSION,
    source_event_id: `evt_debug_scene_${options.ping?.sequence ?? 0}`,
    freshness: shown("live"),
    panels,
    remote_machines:
      remoteCount > 0
        ? [
            {
              machine: "debug-relay",
              state: "fresh",
              age_ms: 12_000,
              observed_at: OBSERVED_AT,
              visible_agent_count: remoteCount,
            },
          ]
        : [],
    relationships: options.showRelationships
      ? panels.slice(1).map((panel, index) => ({
          relationship_id: `debug-relationship-${index + 1}`,
          from_instance_id: panels[0]?.instance_id ?? panel.instance_id,
          to_instance_id: panel.instance_id,
          kind: "shared-coordination" as const,
          status:
            panel.lifecycle.value === "blocked"
              ? ("blocked" as const)
              : panel.activity.value === "needs-input"
                ? ("waiting" as const)
                : ("active" as const),
          provenance: "projection" as const,
        }))
      : [],
    transients: ping
      ? [
          {
            cue_id: `debug-ping-${ping.sequence}`,
            kind: "message",
            from_instance_id: ping.fromId,
            to_instance_id: ping.toId,
            occurred_at: OBSERVED_AT,
            expires_at: EXPIRES_AT,
            provenance: "projection",
          },
        ]
      : [],
    team_ambience: shown(options.ambience),
    generated_at: OBSERVED_AT,
  };
}
