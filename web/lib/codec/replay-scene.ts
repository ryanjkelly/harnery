/**
 * Deterministic, synthetic Codec scenes for the replay lab.
 *
 * These fixtures never read coordination state and never enter the live API.
 * Names, tasks, events, machines, and relationships are invented so the UI
 * can demonstrate its full visual vocabulary without impersonating real work.
 */

import {
  CODEC_SCHEMA_VERSION,
  type CodecActionCategory,
  type CodecActivity,
  type CodecAttention,
  type CodecExpression,
  type CodecLifecycle,
  type CodecPanelScene,
  type CodecProgressRhythm,
  type CodecScene,
  type Presented,
} from "./contracts";

export interface CodecReplayPhase {
  id: "dispatch" | "converge" | "release";
  label: string;
  note: string;
  scene: CodecScene;
}

const BASE = Date.parse("2026-08-21T15:00:00.000Z");
const PACKS = ["aurora", "basalt", "cobalt", "dune", "ember", "flint"] as const;

function at(offsetSeconds: number): string {
  return new Date(BASE + offsetSeconds * 1_000).toISOString();
}

function shown<T>(value: T, observedAt: string, expiresAt?: string): Presented<T> {
  return {
    value,
    provenance: "projection",
    confidence: "high",
    observed_at: observedAt,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
}

interface PanelSeed {
  id: string;
  name: string;
  task: string;
  pack: (typeof PACKS)[number];
  expression: CodecExpression;
  activity?: CodecActivity;
  lifecycle?: CodecLifecycle;
  rhythm?: CodecProgressRhythm;
  attention?: CodecAttention;
  operation: { category: CodecActionCategory; label: string; state?: "active" | "output-flow" };
  parent?: string;
  machine?: string;
  action?: CodecActionCategory;
  artifact?: "created" | "updated" | "published";
}

function replayPanel(seed: PanelSeed, phase: number): CodecPanelScene {
  const observedAt = at(phase * 18);
  const attention = seed.attention ?? "none";
  return {
    instance_id: seed.id,
    identity: {
      display_name: seed.name,
      task: shown(seed.task, observedAt),
    },
    ...(seed.machine
      ? {
          machine: seed.machine,
          remote_source: {
            relay: shown({ state: "fresh" as const, age_ms: 24_000 }, observedAt),
            digest: shown({ state: "fresh" as const, age_ms: 31_000 }, observedAt),
          },
        }
      : {}),
    presence: shown("online", observedAt),
    activity: shown(seed.activity ?? "working", observedAt),
    lifecycle: shown(seed.lifecycle ?? "active", observedAt),
    expression: shown(seed.expression, observedAt),
    attention: shown(attention, observedAt, attention === "none" ? undefined : at(phase * 18 + 30)),
    context_band: shown(phase === 2 && seed.id === "replay-nova" ? "reduced" : "ample", observedAt),
    runtime: shown(
      {
        harness: "replay",
        model: "recorded-scene",
        effort: null,
        speed: null,
      },
      observedAt,
    ),
    progress_rhythm: shown(seed.rhythm ?? "in-motion", observedAt),
    recent_actions: [
      {
        category: seed.action ?? seed.operation.category,
        outcome: "ok",
        event_id: `evt_replay_${phase}_${seed.id.replace("replay-", "")}`,
        observed_at: observedAt,
      },
    ],
    operation: shown(
      {
        category: seed.operation.category,
        label: seed.operation.label,
        state: seed.operation.state ?? "active",
      },
      observedAt,
    ),
    ...(seed.artifact
      ? { artifact_cue: shown({ operation: seed.artifact, kind: "artifact" }, observedAt) }
      : {}),
    ...(attention === "friction" ? { friction: shown("target-contention", observedAt) } : {}),
    ...(seed.parent ? { parent_instance_id: shown(seed.parent, observedAt) } : {}),
    telemetry: shown("healthy", observedAt),
    character: { pack_id: seed.pack, pack_version: "2" },
    updated_at: observedAt,
  };
}

function phase(
  index: number,
  id: CodecReplayPhase["id"],
  label: string,
  note: string,
  seeds: PanelSeed[],
  relationships: CodecScene["relationships"],
  transients: CodecScene["transients"],
): CodecReplayPhase {
  const generatedAt = at(index * 18);
  return {
    id,
    label,
    note,
    scene: {
      schema_version: CODEC_SCHEMA_VERSION,
      source_event_id: `evt_replay_phase_${id}`,
      freshness: shown("live", generatedAt),
      panels: seeds.map((seed) => replayPanel(seed, index)),
      remote_machines: [
        {
          machine: "relay-east-demo",
          state: "fresh",
          age_ms: 24_000,
          observed_at: generatedAt,
          visible_agent_count: 1,
        },
        {
          machine: "relay-west-demo",
          state: index === 0 ? "aging" : "fresh",
          age_ms: index === 0 ? 190_000 : 36_000,
          observed_at: generatedAt,
          visible_agent_count: 1,
        },
      ],
      relationships,
      transients,
      team_ambience: shown(index === 2 ? "calm" : "busy", generatedAt),
      generated_at: generatedAt,
    },
  };
}

export function createCodecReplayPhases(): CodecReplayPhase[] {
  const common = {
    nova: { id: "replay-nova", name: "Nova", pack: PACKS[0], parent: undefined },
    atlas: { id: "replay-atlas", name: "Atlas", pack: PACKS[1], parent: "replay-nova" },
    pixel: { id: "replay-pixel", name: "Pixel", pack: PACKS[2], parent: "replay-nova" },
    sage: { id: "replay-sage", name: "Sage", pack: PACKS[3], parent: "replay-nova" },
    ember: { id: "replay-ember", name: "Ember", pack: PACKS[4], parent: "replay-nova" },
    flux: {
      id: "replay-flux",
      name: "Flux",
      pack: PACKS[5],
      parent: "replay-nova",
      machine: "relay-east-demo",
    },
  } as const;

  return [
    phase(
      0,
      "dispatch",
      "Dispatch",
      "The lead fans work out; one dependency waits and another is blocked.",
      [
        {
          ...common.nova,
          task: "Stage the synthetic release",
          expression: "coordinating",
          operation: { category: "coordinate", label: "Delegating work" },
        },
        {
          ...common.atlas,
          task: "Build the scene adapter",
          expression: "building",
          operation: { category: "build", label: "Building adapter" },
        },
        {
          ...common.pixel,
          task: "Trace the relay evidence",
          expression: "investigating",
          operation: { category: "diagnostic", label: "Inspecting evidence" },
        },
        {
          ...common.sage,
          task: "Wait for the fixture",
          expression: "waiting",
          activity: "needs-input",
          operation: { category: "test", label: "Awaiting fixture" },
        },
        {
          ...common.ember,
          task: "Resolve the stylesheet claim",
          expression: "alert",
          attention: "friction",
          operation: { category: "edit", label: "Resolving contention" },
        },
        {
          ...common.flux,
          task: "Run remote checks",
          expression: "focused",
          operation: { category: "test", label: "Testing relay view" },
        },
      ],
      [
        {
          relationship_id: "replay-delegate-atlas",
          from_instance_id: "replay-nova",
          to_instance_id: "replay-atlas",
          kind: "shared-coordination",
          status: "active",
          provenance: "event",
        },
        {
          relationship_id: "replay-delegate-pixel",
          from_instance_id: "replay-nova",
          to_instance_id: "replay-pixel",
          kind: "shared-coordination",
          status: "active",
          provenance: "event",
        },
        {
          relationship_id: "replay-dep-flux",
          from_instance_id: "replay-atlas",
          to_instance_id: "replay-flux",
          kind: "dependency",
          status: "active",
          provenance: "projection",
        },
        {
          relationship_id: "replay-dep-sage",
          from_instance_id: "replay-pixel",
          to_instance_id: "replay-sage",
          kind: "dependency",
          status: "waiting",
          provenance: "projection",
        },
        {
          relationship_id: "replay-dep-ember",
          from_instance_id: "replay-flux",
          to_instance_id: "replay-ember",
          kind: "dependency",
          status: "blocked",
          provenance: "projection",
        },
      ],
      [
        {
          cue_id: "replay-message-dispatch",
          kind: "message",
          from_instance_id: "replay-nova",
          to_instance_id: "replay-pixel",
          occurred_at: at(0),
          expires_at: at(30),
          provenance: "event",
        },
      ],
    ),
    phase(
      1,
      "converge",
      "Converge",
      "Evidence and implementation meet; the blocked branch recovers.",
      [
        {
          ...common.nova,
          task: "Review the combined scene",
          expression: "deliberating",
          operation: { category: "coordinate", label: "Reviewing convergence" },
        },
        {
          ...common.atlas,
          task: "Publish the scene adapter",
          expression: "focused",
          operation: { category: "build", label: "Publishing adapter", state: "output-flow" },
          artifact: "created",
        },
        {
          ...common.pixel,
          task: "Hand off relay evidence",
          expression: "coordinating",
          operation: { category: "coordinate", label: "Sending findings" },
        },
        {
          ...common.sage,
          task: "Exercise state transitions",
          expression: "building",
          activity: "working",
          operation: { category: "test", label: "Running state checks" },
        },
        {
          ...common.ember,
          task: "Apply the visual repair",
          expression: "recovering",
          attention: "completion",
          operation: { category: "edit", label: "Applying repair" },
          artifact: "updated",
        },
        {
          ...common.flux,
          task: "Verify remote fleet rows",
          expression: "investigating",
          operation: { category: "test", label: "Checking fleet rows" },
        },
      ],
      [
        {
          relationship_id: "replay-delegate-atlas",
          from_instance_id: "replay-nova",
          to_instance_id: "replay-atlas",
          kind: "shared-coordination",
          status: "active",
          provenance: "event",
        },
        {
          relationship_id: "replay-dep-flux",
          from_instance_id: "replay-atlas",
          to_instance_id: "replay-flux",
          kind: "dependency",
          status: "waiting",
          provenance: "projection",
        },
        {
          relationship_id: "replay-dep-sage",
          from_instance_id: "replay-pixel",
          to_instance_id: "replay-sage",
          kind: "dependency",
          status: "active",
          provenance: "projection",
        },
        {
          relationship_id: "replay-dep-ember",
          from_instance_id: "replay-flux",
          to_instance_id: "replay-ember",
          kind: "dependency",
          status: "active",
          provenance: "projection",
        },
      ],
      [
        {
          cue_id: "replay-complete-fixture",
          kind: "dependency-completed",
          from_instance_id: "replay-pixel",
          to_instance_id: "replay-sage",
          occurred_at: at(18),
          expires_at: at(48),
          provenance: "projection",
        },
        {
          cue_id: "replay-message-converge",
          kind: "message",
          from_instance_id: "replay-pixel",
          to_instance_id: "replay-sage",
          occurred_at: at(18),
          expires_at: at(48),
          provenance: "event",
        },
      ],
    ),
    phase(
      2,
      "release",
      "Release",
      "Checks close and the team lands the demonstration together.",
      [
        {
          ...common.nova,
          task: "Close the synthetic release",
          expression: "celebrating",
          lifecycle: "done",
          rhythm: "wrapping-up",
          attention: "completion",
          operation: { category: "coordinate", label: "Closing release" },
          artifact: "published",
        },
        {
          ...common.atlas,
          task: "Adapter complete",
          expression: "celebrating",
          lifecycle: "done",
          rhythm: "wrapping-up",
          attention: "completion",
          operation: { category: "build", label: "Adapter complete" },
          artifact: "published",
        },
        {
          ...common.pixel,
          task: "Evidence complete",
          expression: "recovering",
          lifecycle: "done",
          rhythm: "wrapping-up",
          operation: { category: "diagnostic", label: "Evidence archived" },
        },
        {
          ...common.sage,
          task: "State checks passing",
          expression: "celebrating",
          lifecycle: "done",
          rhythm: "wrapping-up",
          attention: "completion",
          operation: { category: "test", label: "Checks passing" },
        },
        {
          ...common.ember,
          task: "Visual repair complete",
          expression: "celebrating",
          lifecycle: "done",
          rhythm: "wrapping-up",
          attention: "completion",
          operation: { category: "edit", label: "Repair complete" },
        },
        {
          ...common.flux,
          task: "Fleet checks passing",
          expression: "celebrating",
          lifecycle: "done",
          rhythm: "wrapping-up",
          attention: "completion",
          operation: { category: "test", label: "Fleet checks passing" },
        },
      ],
      [
        {
          relationship_id: "replay-delegate-atlas",
          from_instance_id: "replay-nova",
          to_instance_id: "replay-atlas",
          kind: "shared-coordination",
          status: "active",
          provenance: "event",
        },
        {
          relationship_id: "replay-dep-flux",
          from_instance_id: "replay-atlas",
          to_instance_id: "replay-flux",
          kind: "dependency",
          status: "active",
          provenance: "projection",
        },
        {
          relationship_id: "replay-dep-sage",
          from_instance_id: "replay-pixel",
          to_instance_id: "replay-sage",
          kind: "dependency",
          status: "active",
          provenance: "projection",
        },
      ],
      [
        {
          cue_id: "replay-message-release",
          kind: "message",
          from_instance_id: "replay-flux",
          to_instance_id: "replay-nova",
          occurred_at: at(36),
          expires_at: at(66),
          provenance: "event",
        },
      ],
    ),
  ];
}
