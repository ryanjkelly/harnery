/**
 * Deterministic Codec scene projector.
 *
 * Bootstraps operational truth from the existing heartbeat read model
 * (`readAgents`) and folds ordered, already-sanitized evidence on top. It owns
 * provenance, confidence, freshness, decay windows, and fallbacks. It never
 * invents state: a signal without evidence renders `unknown`, and a missing
 * source suppresses its feature rather than guessing.
 *
 * Phase 1 scope: identity, task, presence, activity, lifecycle, context band,
 * progress rhythm, recent actions, freshness. Expression is always `neutral`
 * and attention `none`; relationships and transients stay empty until their
 * read-only source adapters exist (plan § source-of-truth matrix).
 *
 * This module is read-only by contract: no imports from coord writers,
 * process launchers, or lifecycle/workflow controls (boundary.test.ts).
 */

import type { AgentsSnapshot, Heartbeat } from "@/lib/coord-reader";

import {
  CODEC_SCHEMA_VERSION,
  FALLBACK_PACK,
  type CodecActivity,
  type CodecContextBand,
  type CodecLifecycle,
  type CodecPanelScene,
  type CodecPresence,
  type CodecProgressRhythm,
  type CodecRecentAction,
  type CodecScene,
  type CodecSourceEvidence,
  type Confidence,
  type Presented,
} from "./contracts";
import { deriveExpressiveChannels, type ExpressiveAction } from "./expression";

/** Decay windows (ms) for rhythm cues; deterministic against `now`. */
const JUST_STARTED_WINDOW_MS = 90_000;
const WRAPPING_UP_WINDOW_MS = 20_000;
const IN_MOTION_WINDOW_MS = 120_000;

/** Hysteresis (percentage points) at context-band boundaries. */
const BAND_HYSTERESIS_PP = 2;

/** Context-band memory so a value hovering at a boundary does not flicker.
 * Presentation-only, per-process, rebuilt harmlessly on restart. */
const lastBandByInstance = new Map<string, { band: CodecContextBand; remaining: number }>();

interface InstanceEvidence {
  lastSessionStart?: CodecSourceEvidence;
  lastSessionEnd?: CodecSourceEvidence;
  lastPromptOrStart?: CodecSourceEvidence;
  lastPrompt?: CodecSourceEvidence;
  lastTurnStop?: CodecSourceEvidence;
  lastAction?: CodecSourceEvidence;
  lastTaskSet?: CodecSourceEvidence;
  lastTaskState?: CodecSourceEvidence;
  lastContext?: CodecSourceEvidence;
  identityName?: string;
  recentActions: CodecRecentAction[];
  /** Full recent action list for the expressive rules, ascending, capped. */
  actionsFull: ExpressiveAction[];
  openSubagents: number;
}

/** Enough history for turn-scoped expressive rules without unbounded growth. */
const ACTIONS_FULL_CAP = 24;

const ACTION_TYPES = new Set([
  "tool.pre_use",
  "tool.post_use",
  "tool.post_use_failure",
  "command.start",
  "command.end",
]);

function foldEvidence(events: readonly CodecSourceEvidence[]): Map<string, InstanceEvidence> {
  const byInstance = new Map<string, InstanceEvidence>();
  for (const ev of events) {
    let slot = byInstance.get(ev.instance_id);
    if (!slot) {
      slot = { recentActions: [], actionsFull: [], openSubagents: 0 };
      byInstance.set(ev.instance_id, slot);
    }
    switch (ev.event_type) {
      case "session.start":
        slot.lastSessionStart = ev;
        slot.lastPromptOrStart = ev;
        break;
      case "subagent.start":
        // A subagent event lands on the parent instance: it seeds the rhythm
        // (plan: just-started follows subagent.start) and opens coordination
        // evidence, but it is NOT the parent's session lifecycle.
        slot.lastPromptOrStart = ev;
        slot.openSubagents += 1;
        break;
      case "session.end":
        slot.lastSessionEnd = ev;
        break;
      case "subagent.stop":
        slot.openSubagents = Math.max(0, slot.openSubagents - 1);
        break;
      case "user_prompt.submit":
        slot.lastPromptOrStart = ev;
        slot.lastPrompt = ev;
        break;
      case "turn.stop":
        slot.lastTurnStop = ev;
        break;
      case "state.task_set":
        slot.lastTaskSet = ev;
        break;
      case "state.task_state":
        if (ev.task_state) slot.lastTaskState = ev;
        break;
      case "context.sampled":
        if (ev.used_percent !== undefined) slot.lastContext = ev;
        break;
      case "identity.assumed":
        if (ev.identity_name) slot.identityName = ev.identity_name;
        break;
      default:
        break;
    }
    if (ACTION_TYPES.has(ev.event_type)) {
      slot.lastAction = ev;
      slot.actionsFull.push({
        category: ev.category ?? "other",
        outcome: ev.outcome ?? "unknown",
        event_id: ev.event_id,
        ts: ev.ts,
        ...(ev.intent ? { intent: ev.intent } : {}),
      });
      if (slot.actionsFull.length > ACTIONS_FULL_CAP) slot.actionsFull.shift();
      // `tool.pre_use` opens an action and its post event closes it; the trail
      // wants completed-or-started glyphs, newest first, capped at three.
      if (ev.event_type !== "tool.pre_use" && ev.event_type !== "command.start") {
        slot.recentActions.unshift({
          category: ev.category ?? "other",
          outcome: ev.outcome ?? "unknown",
          event_id: ev.event_id,
          observed_at: ev.ts,
        });
        if (slot.recentActions.length > 3) slot.recentActions.length = 3;
      }
    }
  }
  return byInstance;
}

function ms(ts: string | undefined): number {
  if (!ts) return Number.NaN;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function present<T>(
  value: T,
  provenance: Presented<T>["provenance"],
  confidence: Confidence,
  observedAt: string,
  evidenceIds?: string[],
): Presented<T> {
  const out: Presented<T> = { value, provenance, confidence, observed_at: observedAt };
  if (evidenceIds && evidenceIds.length > 0) out.evidence_event_ids = evidenceIds;
  return out;
}

function presence(
  hb: Heartbeat,
  isActive: boolean,
  ev: InstanceEvidence | undefined,
  now: string,
): Presented<CodecPresence> {
  // A fresh heartbeat is live evidence and outranks any recorded end: an
  // adapter that restarts without a new session.start row must not render a
  // living agent offline.
  if (isActive) return present("online", "projection", "high", hb.last_heartbeat);
  const endTs = ms(ev?.lastSessionEnd?.ts);
  const startTs = ms(ev?.lastSessionStart?.ts);
  const endedAfterLastStart =
    Number.isFinite(endTs) && (!Number.isFinite(startTs) || endTs > startTs);
  if (ev?.lastSessionEnd && endedAfterLastStart) {
    return present("offline", "event", "high", ev.lastSessionEnd.ts, [
      ev.lastSessionEnd.event_id,
    ]);
  }
  // A stale heartbeat is absence of evidence, not evidence of absence.
  return present("unknown", "projection", "low", hb.last_heartbeat ?? now);
}

function activity(hb: Heartbeat): Presented<CodecActivity> {
  const map: Record<string, CodecActivity> = {
    working: "working",
    needs_input: "needs-input",
    idle: "idle",
    unknown: "unknown",
  };
  const value = map[hb.activity] ?? "unknown";
  return present(
    value,
    value === "unknown" ? "unknown" : "projection",
    value === "unknown" ? "low" : "high",
    hb.activity_updated_at ?? hb.last_heartbeat,
  );
}

function lifecycle(hb: Heartbeat, ev: InstanceEvidence | undefined): Presented<CodecLifecycle> {
  // The heartbeat defaults task_state to "active" even with no declaration, so
  // only a stamped update time makes the projection evidence-backed.
  if (hb.task_state_updated_at) {
    return present(hb.task_state, "projection", "high", hb.task_state_updated_at);
  }
  if (ev?.lastTaskState?.task_state) {
    return present(ev.lastTaskState.task_state, "event", "high", ev.lastTaskState.ts, [
      ev.lastTaskState.event_id,
    ]);
  }
  return present("unknown", "unknown", "low", hb.last_heartbeat);
}

function taskLabel(hb: Heartbeat, ev: InstanceEvidence | undefined): Presented<string> | undefined {
  if (hb.task && hb.task.trim()) {
    return present(hb.task.trim(), "projection", "high", hb.task_updated_at ?? hb.last_heartbeat);
  }
  if (ev?.lastTaskSet?.task && !ev.lastTaskSet.task_cleared) {
    return present(ev.lastTaskSet.task, "event", "high", ev.lastTaskSet.ts, [
      ev.lastTaskSet.event_id,
    ]);
  }
  return undefined;
}

function contextBand(
  instanceId: string,
  ev: InstanceEvidence | undefined,
  hbTs: string,
): Presented<CodecContextBand> {
  const sample = ev?.lastContext;
  if (!sample || sample.used_percent === undefined) {
    return present("unknown", "unknown", "low", hbTs);
  }
  const remaining = Math.max(0, Math.min(100, 100 - sample.used_percent));
  let band: CodecContextBand = remaining > 50 ? "ample" : remaining >= 20 ? "reduced" : "low";
  const prior = lastBandByInstance.get(instanceId);
  if (prior && prior.band !== band && Math.abs(remaining - prior.remaining) <= BAND_HYSTERESIS_PP) {
    band = prior.band; // hold the previous band inside the hysteresis window
  }
  lastBandByInstance.set(instanceId, { band, remaining });
  const confidence: Confidence = sample.context_confidence === "estimated" ? "medium" : "high";
  return present(band, "event", confidence, sample.ts, [sample.event_id]);
}

function progressRhythm(
  ev: InstanceEvidence | undefined,
  nowMs: number,
  hbTs: string,
): Presented<CodecProgressRhythm> {
  if (!ev) return present("unknown", "unknown", "low", hbTs);
  const stopTs = ms(ev.lastTurnStop?.ts);
  const actionTs = ms(ev.lastAction?.ts);
  const startTs = ms(ev.lastPromptOrStart?.ts);

  // wrapping-up: a just-observed turn stop with nothing newer.
  if (
    ev.lastTurnStop &&
    Number.isFinite(stopTs) &&
    nowMs - stopTs <= WRAPPING_UP_WINDOW_MS &&
    (!Number.isFinite(actionTs) || actionTs <= stopTs)
  ) {
    return present("wrapping-up", "event", "high", ev.lastTurnStop.ts, [
      ev.lastTurnStop.event_id,
    ]);
  }
  // just-started: a fresh session/prompt with no action evidence yet.
  if (
    ev.lastPromptOrStart &&
    Number.isFinite(startTs) &&
    nowMs - startTs <= JUST_STARTED_WINDOW_MS &&
    (!Number.isFinite(actionTs) || actionTs < startTs)
  ) {
    return present("just-started", "event", "high", ev.lastPromptOrStart.ts, [
      ev.lastPromptOrStart.event_id,
    ]);
  }
  // in-motion: current action evidence.
  if (ev.lastAction && Number.isFinite(actionTs) && nowMs - actionTs <= IN_MOTION_WINDOW_MS) {
    return present("in-motion", "event", "high", ev.lastAction.ts, [ev.lastAction.event_id]);
  }
  return present("unknown", "unknown", "low", hbTs);
}

export interface ProjectSceneInputs {
  snapshot: AgentsSnapshot;
  /** Sanitized evidence, ascending source order. */
  events: readonly CodecSourceEvidence[];
  /** Injectable clock for deterministic tests; ISO-8601. */
  now?: string;
}

export function projectScene(inputs: ProjectSceneInputs): CodecScene {
  const now = inputs.now ?? new Date().toISOString();
  const nowMs = ms(now);
  const evidence = foldEvidence(inputs.events);

  const panels: CodecPanelScene[] = [];
  const rows: Array<{ hb: Heartbeat; isActive: boolean }> = [
    ...inputs.snapshot.active.map((hb) => ({ hb, isActive: true })),
    ...inputs.snapshot.stale.map((hb) => ({ hb, isActive: false })),
  ];

  for (const { hb, isActive } of rows) {
    const ev = evidence.get(hb.instance_id);
    const task = taskLabel(hb, ev);
    const panelActivity = activity(hb);
    const channels = deriveExpressiveChannels(
      {
        activity: panelActivity.value,
        ...(ev?.lastPrompt
          ? { lastPrompt: { ts: ev.lastPrompt.ts, event_id: ev.lastPrompt.event_id } }
          : {}),
        ...(ev?.lastTurnStop
          ? { lastTurnStop: { ts: ev.lastTurnStop.ts, event_id: ev.lastTurnStop.event_id } }
          : {}),
        actions: ev?.actionsFull ?? [],
        openSubagents: ev?.openSubagents ?? 0,
      },
      now,
    );
    const panel: CodecPanelScene = {
      instance_id: hb.instance_id,
      identity: {
        display_name: ev?.identityName ?? hb.name,
        ...(task ? { task } : {}),
      },
      presence: presence(hb, isActive, ev, now),
      activity: panelActivity,
      lifecycle: lifecycle(hb, ev),
      expression: channels.expression,
      attention: channels.attention,
      context_band: contextBand(hb.instance_id, ev, hb.last_heartbeat),
      progress_rhythm: progressRhythm(ev, nowMs, hb.last_heartbeat),
      recent_actions: ev?.recentActions ?? [],
      ...(channels.focus_bubble ? { focus_bubble: channels.focus_bubble } : {}),
      character: { ...FALLBACK_PACK },
      updated_at: hb.last_heartbeat,
    };
    panels.push(panel);
  }

  const workingCount = panels.filter((p) => p.activity.value === "working").length;
  const needsInput = panels.some((p) => p.activity.value === "needs-input");
  const ambience =
    panels.length === 0 ? "unknown" : needsInput ? "alert" : workingCount >= 2 ? "busy" : "calm";

  const lastEvent = inputs.events.length
    ? inputs.events[inputs.events.length - 1]
    : undefined;

  return {
    schema_version: CODEC_SCHEMA_VERSION,
    ...(lastEvent ? { source_event_id: lastEvent.event_id } : {}),
    freshness: present("live", "projection", "high", now),
    panels,
    relationships: [], // Phase 3: requires proved work/governor adapters
    transients: [], // Phase 3: requires a delivery-record adapter
    team_ambience: present(ambience, "projection", panels.length ? "high" : "low", now),
    generated_at: now,
  };
}

/** Test seam: clear the presentation-only band memory between cases. */
export function __resetContextBandMemory(): void {
  lastBandByInstance.clear();
}
