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

import { nativeInstanceIdV3 } from "../../../src/core/events/v3/live-routing";
import { projectActivityChannels, unknownActivityChannels } from "./activity";
import {
  CODEC_SCHEMA_VERSION,
  type CodecActivity,
  type CodecContextBand,
  type CodecContextUsage,
  type CodecIntentSignal,
  type CodecLifecycle,
  type CodecPanelScene,
  type CodecPresence,
  type CodecProgressRhythm,
  type CodecRecentAction,
  type CodecRuntimeValue,
  type CodecScene,
  type CodecSourceEvidence,
  type Confidence,
  FALLBACK_PACK,
  type Presented,
} from "./contracts";
import { deriveExpressiveChannels, type ExpressiveAction } from "./expression";

/** Decay windows (ms) for rhythm cues; deterministic against `now`. */
const JUST_STARTED_WINDOW_MS = 90_000;
const WRAPPING_UP_WINDOW_MS = 20_000;
const IN_MOTION_WINDOW_MS = 120_000;
const CADENCE_RECENT_MS = 30_000;
const CADENCE_BURST_MS = 20_000;
const CADENCE_STEADY_SPAN_MS = 30_000;

/** Hysteresis (percentage points) at context-band boundaries. */
const BAND_HYSTERESIS_PP = 2;

/** How long event evidence sustains a panel after its heartbeat is gone. */
const EVIDENCE_PANEL_WINDOW_MS = 30 * 60_000;
/** Fresh non-end evidence within this window reads as online (event-backed). */
const EVIDENCE_ONLINE_WINDOW_MS = 5 * 60_000;
/** Message transients expire quickly; a ping is a moment, not a state. */
const MESSAGE_TRANSIENT_TTL_MS = 8_000;

/** Context-band memory so a value hovering at a boundary does not flicker.
 * Presentation-only, per-process, rebuilt harmlessly on restart. */
const lastBandByInstance = new Map<string, { band: CodecContextBand; remaining: number }>();

interface InstanceEvidence {
  lastRuntime?: CodecSourceEvidence;
  lastSessionStarted?: CodecSourceEvidence;
  lastSessionEnded?: CodecSourceEvidence;
  lastTurnOrSessionStarted?: CodecSourceEvidence;
  lastTurnStarted?: CodecSourceEvidence;
  lastTurnCompleted?: CodecSourceEvidence;
  lastAction?: CodecSourceEvidence;
  lastTaskChanged?: CodecSourceEvidence;
  lastLifecycleChanged?: CodecSourceEvidence;
  lastContext?: CodecSourceEvidence;
  identityName?: string;
  /** Envelope parent_session_id from the newest event carrying one. */
  parentEvidence?: { parent: string; event_id: string; ts: string };
  /** V3 parent generation from the newest event that linked one. */
  parentGeneration?: { parent: string; event_id: string; ts: string };
  generationId?: string;
  childGenerationId?: string;
  /** Newest accepted event of any type, for evidence-panel recency. */
  lastEventTs?: string;
  /** Activity folded from events with the session-state reducer's table, so a
   * panel can survive a swept heartbeat without inventing state. */
  activityEvidence?: { value: CodecActivity; ts: string; event_id: string };
  recentActions: CodecRecentAction[];
  /** Newest operator-authored #intent labels, capped at the presentation limit. */
  intentHistory: CodecIntentSignal[];
  /** Full recent action list for the expressive rules, ascending, capped. */
  actionsFull: ExpressiveAction[];
  /** Successful terminal/progress evidence for bounded cadence inference. */
  successfulProgress: Array<{ ts: string; event_id: string }>;
  openSubagents: number;
  /** Newest compaction boundary, for the compacting expression. */
  lastCompaction?: { phase: "started" | "completed"; ts: string; event_id: string };
  /** Open typed wait (started without a matching end), for dormancy. */
  openWait?: { kind?: string; wake_at?: string; ts: string; event_id: string };
  /** Newest observed image artifact, for the observing expression. */
  lastImageObserved?: { ts: string; event_id: string };
}

/** Enough history for turn-scoped expressive rules without unbounded growth. */
const ACTIONS_FULL_CAP = 24;

const ACTION_TYPES = new Set([
  "tool.requested",
  "tool.completed",
  "command.started",
  "command.completed",
  "progress.observed",
]);

function foldEvidence(events: readonly CodecSourceEvidence[]): Map<string, InstanceEvidence> {
  const byInstance = new Map<string, InstanceEvidence>();
  const seenEventIds = new Set<string>();
  for (const ev of events) {
    if (seenEventIds.has(ev.event_id)) continue;
    seenEventIds.add(ev.event_id);
    let slot = byInstance.get(ev.instance_id);
    if (!slot) {
      slot = {
        recentActions: [],
        intentHistory: [],
        actionsFull: [],
        successfulProgress: [],
        openSubagents: 0,
      };
      byInstance.set(ev.instance_id, slot);
    }
    if (ev.parent_session_id) {
      slot.parentEvidence = { parent: ev.parent_session_id, event_id: ev.event_id, ts: ev.ts };
    }
    if (ev.parent_generation_id) {
      slot.parentGeneration = {
        parent: ev.parent_generation_id,
        event_id: ev.event_id,
        ts: ev.ts,
      };
    }
    if (ev.generation_id) slot.generationId = ev.generation_id;
    if (ev.child_generation_id) slot.childGenerationId = ev.child_generation_id;
    slot.lastEventTs = ev.ts;
    // V3 activity evidence: session boundaries are idle, turns and tools are
    // working, waits need input, and commands preserve an already-open turn.
    const setActivity = (value: CodecActivity) => {
      slot.activityEvidence = { value, ts: ev.ts, event_id: ev.event_id };
    };
    switch (ev.event_type) {
      case "session.started":
      case "session.resumed":
      case "agent.delegated":
      case "agent.started":
        setActivity("idle");
        break;
      case "turn.started":
      case "tool.requested":
        setActivity("working");
        break;
      case "wait.started":
        setActivity(
          ev.wait_kind === "permission" ||
            ev.wait_kind === "needs_input" ||
            ev.wait_kind === "decision" ||
            ev.wait_kind === "approval"
            ? "needs-input"
            : "idle",
        );
        break;
      case "wait.ended":
        setActivity("working");
        break;
      case "command.started":
        if (
          slot.activityEvidence?.value === "working" ||
          slot.activityEvidence?.value === "needs-input"
        ) {
          setActivity("working");
        }
        break;
      case "turn.completed":
      case "session.ended":
      case "agent.completed":
        setActivity("idle");
        break;
      default:
        break;
    }
    switch (ev.event_type) {
      case "session.started":
      case "session.resumed":
        slot.lastSessionStarted = ev;
        slot.lastTurnOrSessionStarted = ev;
        if (ev.runtime_harness || ev.runtime_model || ev.runtime_effort) slot.lastRuntime = ev;
        break;
      case "session.attestation_changed":
        if (ev.runtime_harness || ev.runtime_model || ev.runtime_effort) slot.lastRuntime = ev;
        break;
      case "agent.delegated":
      case "agent.started":
        // A child-agent event lands on the parent instance: it seeds rhythm
        // and opens coordination
        // evidence, but it is NOT the parent's session lifecycle.
        slot.lastTurnOrSessionStarted = ev;
        slot.openSubagents += 1;
        break;
      case "session.ended":
        slot.lastSessionEnded = ev;
        break;
      case "agent.completed":
        slot.openSubagents = Math.max(0, slot.openSubagents - 1);
        break;
      case "turn.started":
        slot.lastTurnOrSessionStarted = ev;
        slot.lastTurnStarted = ev;
        break;
      case "turn.completed":
        slot.lastTurnCompleted = ev;
        break;
      case "coord.task_changed":
        slot.lastTaskChanged = ev;
        break;
      case "coord.lifecycle_changed":
        if (ev.task_state) slot.lastLifecycleChanged = ev;
        break;
      case "context.observed":
        if (ev.used_percent !== undefined) slot.lastContext = ev;
        break;
      case "context.compaction_started":
      case "context.compaction_completed":
        if (ev.used_percent !== undefined) slot.lastContext = ev;
        slot.lastCompaction = {
          phase: ev.event_type === "context.compaction_started" ? "started" : "completed",
          ts: ev.ts,
          event_id: ev.event_id,
        };
        break;
      case "wait.started":
        slot.openWait = {
          ...(ev.wait_kind ? { kind: ev.wait_kind } : {}),
          ...(ev.wake_at ? { wake_at: ev.wake_at } : {}),
          ts: ev.ts,
          event_id: ev.event_id,
        };
        break;
      case "wait.ended":
        slot.openWait = undefined;
        break;
      case "artifact.observed":
        if (ev.artifact_kind === "image") {
          slot.lastImageObserved = { ts: ev.ts, event_id: ev.event_id };
        }
        break;
      case "coord.identity_attested":
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
        ...(ev.live_overlay ? { live_overlay: true } : {}),
      });
      if (slot.actionsFull.length > ACTIONS_FULL_CAP) slot.actionsFull.shift();
      if (ev.intent) {
        slot.intentHistory.unshift({
          text: ev.intent,
          event_id: ev.event_id,
          observed_at: ev.ts,
          event_type: ev.event_type,
          category: ev.category ?? "other",
          ...(ev.tool_name ? { tool_name: ev.tool_name } : {}),
          ...(ev.adapter ? { adapter: ev.adapter } : {}),
          ...(ev.live_overlay ? { live_overlay: true } : {}),
        });
        if (slot.intentHistory.length > 3) slot.intentHistory.length = 3;
      }
      // `tool.requested` opens an action and its completion closes it; the trail
      // wants completed-or-started glyphs, newest first, capped at three.
      if (ev.event_type !== "tool.requested" && ev.event_type !== "command.started") {
        slot.recentActions.unshift({
          category: ev.category ?? "other",
          outcome: ev.outcome ?? "unknown",
          event_id: ev.event_id,
          observed_at: ev.ts,
        });
        if (slot.recentActions.length > 3) slot.recentActions.length = 3;
      }
      if (
        ev.outcome === "ok" &&
        ev.telemetry_issue === undefined &&
        (ev.event_type === "tool.completed" ||
          ev.event_type === "command.completed" ||
          ev.event_type === "progress.observed")
      ) {
        slot.successfulProgress.push({ ts: ev.ts, event_id: ev.event_id });
        if (slot.successfulProgress.length > ACTIONS_FULL_CAP) slot.successfulProgress.shift();
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

const RUNTIME_EFFORT_TOKENS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/** Cursor makes tuning part of its canonical model id. Other adapters carry
 * observed tuning on their runtime attestation instead; this derivation is
 * the fallback for Cursor evidence that predates observed tuning. Absent
 * values remain null instead of being guessed. */
function tuningFromModel(
  harness: string | null,
  model: string | null,
): Pick<CodecRuntimeValue, "effort" | "speed"> {
  if (harness !== "cursor" || !model) return { effort: null, speed: null };
  const tokens = model.toLowerCase().split("-");
  let effort: string | null = null;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token && RUNTIME_EFFORT_TOKENS.has(token)) {
      effort = token;
      break;
    }
  }
  return { effort, speed: tokens.includes("fast") ? "fast" : null };
}

function runtimeInfo(
  hb: Heartbeat | undefined,
  ev: InstanceEvidence | undefined,
  fallbackObservedAt: string,
): Presented<CodecRuntimeValue> {
  const observed = ev?.lastRuntime;
  const harness = cleanRuntimeToken(observed?.runtime_harness ?? hb?.platform);
  const model = cleanRuntimeToken(observed?.runtime_model ?? hb?.model);
  // Observed tuning (attested by the runtime) outranks the model-id parse.
  const derived = tuningFromModel(harness, model);
  const tuning = {
    effort: cleanRuntimeToken(observed?.runtime_effort) ?? derived.effort,
    speed: cleanRuntimeToken(observed?.runtime_speed) ?? derived.speed,
  };
  const value: CodecRuntimeValue = {
    harness,
    ...(observed?.runtime_harness_version
      ? { harness_version: observed.runtime_harness_version }
      : {}),
    model,
    ...(observed?.runtime_model_provider
      ? { model_provider: observed.runtime_model_provider }
      : {}),
    ...tuning,
  };
  if (observed) {
    return present(value, "event", "high", observed.ts, [observed.event_id]);
  }
  if (harness || model) {
    return present(value, "projection", "medium", hb?.last_heartbeat ?? fallbackObservedAt);
  }
  return present(value, "unknown", "low", fallbackObservedAt);
}

function cleanRuntimeToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function presence(
  hb: Heartbeat,
  isActive: boolean,
  ev: InstanceEvidence | undefined,
  now: string,
): Presented<CodecPresence> {
  // A fresh heartbeat is live evidence and outranks any recorded end: an
  // adapter that restarts without a new session.started row must not render a
  // living agent offline. Terminal ledger state is the exception: the
  // generation has already ended even if a leftover file is still "fresh."
  if (hb.ledger_state === "terminal") {
    return present("offline", "projection", "high", hb.last_heartbeat);
  }
  if (isActive) return present("online", "projection", "high", hb.last_heartbeat);
  const endTs = ms(ev?.lastSessionEnded?.ts);
  const startTs = ms(ev?.lastSessionStarted?.ts);
  const endedAfterLastStart =
    Number.isFinite(endTs) && (!Number.isFinite(startTs) || endTs > startTs);
  if (ev?.lastSessionEnded && endedAfterLastStart) {
    return present("offline", "event", "high", ev.lastSessionEnded.ts, [
      ev.lastSessionEnded.event_id,
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
  if (ev?.lastLifecycleChanged?.task_state) {
    return present(
      ev.lastLifecycleChanged.task_state,
      "event",
      "high",
      ev.lastLifecycleChanged.ts,
      [ev.lastLifecycleChanged.event_id],
    );
  }
  return present("unknown", "unknown", "low", hb.last_heartbeat);
}

function taskLabel(hb: Heartbeat, ev: InstanceEvidence | undefined): Presented<string> | undefined {
  if (hb.task?.trim()) {
    return present(hb.task.trim(), "projection", "high", hb.task_updated_at ?? hb.last_heartbeat);
  }
  if (ev?.lastTaskChanged?.task && !ev.lastTaskChanged.task_cleared) {
    return present(ev.lastTaskChanged.task, "event", "high", ev.lastTaskChanged.ts, [
      ev.lastTaskChanged.event_id,
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

function contextUsage(ev: InstanceEvidence | undefined): Presented<CodecContextUsage> | undefined {
  const sample = ev?.lastContext;
  if (!sample || sample.used_percent === undefined) return undefined;
  const usedPercent = Math.max(0, Math.min(100, sample.used_percent));
  const confidence: Confidence = sample.context_confidence === "estimated" ? "medium" : "high";
  return present(
    {
      used_percent: usedPercent,
      remaining_percent: Math.max(0, 100 - usedPercent),
      ...(sample.context_used_tokens !== undefined
        ? { used_tokens: sample.context_used_tokens }
        : {}),
      ...(sample.context_limit_tokens !== undefined
        ? { limit_tokens: sample.context_limit_tokens }
        : {}),
      ...(sample.context_remaining_tokens !== undefined
        ? { remaining_tokens: sample.context_remaining_tokens }
        : {}),
    },
    "event",
    confidence,
    sample.ts,
    [sample.event_id],
  );
}

function progressRhythm(
  ev: InstanceEvidence | undefined,
  nowMs: number,
  hbTs: string,
): Presented<CodecProgressRhythm> {
  if (!ev) return present("unknown", "unknown", "low", hbTs);
  const stopTs = ms(ev.lastTurnCompleted?.ts);
  const actionTs = ms(ev.lastAction?.ts);
  const startTs = ms(ev.lastTurnOrSessionStarted?.ts);
  const successful = ev.successfulProgress.filter((item) => {
    const itemTs = ms(item.ts);
    return Number.isFinite(itemTs) && nowMs >= itemTs && nowMs - itemTs <= IN_MOTION_WINDOW_MS;
  });

  // wrapping-up: a just-observed turn stop with nothing newer.
  if (
    ev.lastTurnCompleted &&
    Number.isFinite(stopTs) &&
    nowMs - stopTs <= WRAPPING_UP_WINDOW_MS &&
    (!Number.isFinite(actionTs) || actionTs <= stopTs)
  ) {
    return present("wrapping-up", "event", "high", ev.lastTurnCompleted.ts, [
      ev.lastTurnCompleted.event_id,
    ]);
  }
  // just-started: a fresh session/prompt with no action evidence yet.
  if (
    ev.lastTurnOrSessionStarted &&
    Number.isFinite(startTs) &&
    nowMs - startTs <= JUST_STARTED_WINDOW_MS &&
    (!Number.isFinite(actionTs) || actionTs < startTs)
  ) {
    return present("just-started", "event", "high", ev.lastTurnOrSessionStarted.ts, [
      ev.lastTurnOrSessionStarted.event_id,
    ]);
  }
  const latestSuccess = successful.at(-1);
  const latestSuccessTs = ms(latestSuccess?.ts);
  const burst = successful.filter((item) => nowMs - ms(item.ts) <= CADENCE_BURST_MS);
  if (burst.length >= 4 && latestSuccess) {
    return present("bursty", "inferred", "medium", latestSuccess.ts, [
      ...burst.slice(-3).map((item) => item.event_id),
    ]);
  }
  const firstSuccessTs = ms(successful[0]?.ts);
  if (
    successful.length >= 3 &&
    latestSuccess &&
    Number.isFinite(latestSuccessTs) &&
    nowMs - latestSuccessTs <= CADENCE_RECENT_MS &&
    Number.isFinite(firstSuccessTs) &&
    latestSuccessTs - firstSuccessTs >= CADENCE_STEADY_SPAN_MS
  ) {
    return present("steady", "inferred", "medium", latestSuccess.ts, [
      ...successful.slice(-3).map((item) => item.event_id),
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

function staleHeartbeatIsRecentlyEnded(ev: InstanceEvidence | undefined, nowMs: number): boolean {
  const endTs = ms(ev?.lastSessionEnded?.ts);
  const startTs = ms(ev?.lastSessionStarted?.ts);
  if (!ev?.lastSessionEnded || !Number.isFinite(endTs)) return false;
  if (Number.isFinite(startTs) && endTs <= startTs) return false;
  return nowMs - endTs <= EVIDENCE_PANEL_WINDOW_MS;
}

/**
 * Re-key sanitized evidence into the id space the panels use.
 *
 * The two sources disagree on how they name a session. Ledger evidence is
 * always keyed by the canonical `inst_*` id. A heartbeat row keyed by an
 * adapter-native owner id reports that id as `instance_id` and carries the
 * canonical one alongside in `v3_instance_id`; a projection-only row has no
 * native alias and reports the canonical id directly. Left unaligned, every
 * session with a native alias folds under a second key: its heartbeat panel
 * loses all event evidence and a duplicate panel appears beside it under a
 * truncated id, and parentage and ping edges never join.
 *
 * Only an alias the coordination view itself attested is honored, so an
 * `inst_*` id with no matching row keeps its own key and still earns an
 * evidence-backed panel. Idempotent: aligning aligned events is a no-op.
 */
export function alignEventInstanceIds(
  events: readonly CodecSourceEvidence[],
  snapshot: AgentsSnapshot,
): readonly CodecSourceEvidence[] {
  const nativeByCanonical = new Map<string, string>();
  for (const hb of [...snapshot.active, ...snapshot.stale, ...snapshot.terminal]) {
    if (hb.v3_instance_id && hb.v3_instance_id !== hb.instance_id) {
      nativeByCanonical.set(hb.v3_instance_id, hb.instance_id);
    }
  }
  if (nativeByCanonical.size === 0) return events;
  return events.map((event) => {
    const instanceId = nativeByCanonical.get(event.instance_id);
    const pingTo = event.ping_to ? nativeByCanonical.get(event.ping_to) : undefined;
    if (!instanceId && !pingTo) return event;
    return {
      ...event,
      ...(instanceId ? { instance_id: instanceId } : {}),
      ...(pingTo ? { ping_to: pingTo } : {}),
    };
  });
}

export function projectScene(inputs: ProjectSceneInputs): CodecScene {
  const now = inputs.now ?? new Date().toISOString();
  const nowMs = ms(now);
  const events = alignEventInstanceIds(inputs.events, inputs.snapshot);
  const evidence = foldEvidence(events);
  const activityChannels = projectActivityChannels(events, now);
  const heartbeatName = new Map<string, string>();
  const generationToInstance = new Map<string, string>();
  const childOf = new Map<string, { parent: string; event_id: string; ts: string }>();
  for (const hb of [
    ...inputs.snapshot.active,
    ...inputs.snapshot.stale,
    ...inputs.snapshot.terminal,
  ]) {
    heartbeatName.set(hb.instance_id, hb.name);
    if (hb.generation_id) generationToInstance.set(hb.generation_id, hb.instance_id);
  }
  for (const [instanceId, slot] of evidence) {
    if (slot.generationId) generationToInstance.set(slot.generationId, instanceId);
    if (slot.childGenerationId) {
      const announced = slot.actionsFull[slot.actionsFull.length - 1];
      childOf.set(slot.childGenerationId, {
        parent: instanceId,
        event_id: announced?.event_id ?? `${instanceId}:child`,
        ts: announced?.ts ?? slot.lastEventTs ?? now,
      });
    }
  }
  // Prefer the event that carried child_generation_id as the parentage proof.
  for (const ev of events) {
    if (!ev.child_generation_id) continue;
    childOf.set(ev.child_generation_id, {
      parent: ev.instance_id,
      event_id: ev.event_id,
      ts: ev.ts,
    });
  }

  const panels: CodecPanelScene[] = [];
  // Live heartbeats always render. A V3 authority-live generation remains an
  // authoritative session when its observation grows stale. Keep it as presence
  // unknown instead of making the panel disappear. Unbound stale cache files
  // are leftovers unless a recent session.ended puts them in Recently ended.
  // Recent work without a fresh heartbeat still surfaces through the
  // evidence-backed path below.
  const rows: Array<{ hb: Heartbeat; isActive: boolean }> = [
    ...inputs.snapshot.active.map((hb) => ({ hb, isActive: true })),
    ...inputs.snapshot.stale
      .filter(
        (hb) =>
          hb.ledger_state === "live" ||
          hb.ledger_state === "ending" ||
          hb.ledger_state === "recovery-required" ||
          staleHeartbeatIsRecentlyEnded(evidence.get(hb.instance_id), nowMs),
      )
      .map((hb) => ({ hb, isActive: false })),
    ...inputs.snapshot.terminal
      .filter((hb) => {
        const lastTs = ms(hb.last_heartbeat);
        return Number.isFinite(lastTs) && nowMs - lastTs <= EVIDENCE_PANEL_WINDOW_MS;
      })
      .map((hb) => ({ hb, isActive: false })),
  ];

  const paneledFromRows = new Set<string>();
  for (const { hb, isActive } of rows) {
    if (paneledFromRows.has(hb.instance_id)) continue;
    paneledFromRows.add(hb.instance_id);
    const ev = evidence.get(hb.instance_id);
    const task = taskLabel(hb, ev);
    const usage = contextUsage(ev);
    const panelActivity = activity(hb);
    const panelContextBand = contextBand(hb.instance_id, ev, hb.last_heartbeat);
    const panelLifecycle = lifecycle(hb, ev);
    const channels = deriveExpressiveChannels(
      {
        activity: panelActivity.value,
        ...(ev?.lastLifecycleChanged?.task_state
          ? {
              lifecycleState: {
                value: ev.lastLifecycleChanged.task_state,
                ts: ev.lastLifecycleChanged.ts,
                event_id: ev.lastLifecycleChanged.event_id,
              },
            }
          : {}),
        contextBand: panelContextBand.value,
        ...(ev?.lastCompaction ? { lastCompaction: ev.lastCompaction } : {}),
        ...(ev?.openWait ? { openWait: ev.openWait } : {}),
        ...(ev?.lastImageObserved ? { lastImageObserved: ev.lastImageObserved } : {}),
        ...(ev?.lastTurnStarted
          ? {
              lastTurnStarted: { ts: ev.lastTurnStarted.ts, event_id: ev.lastTurnStarted.event_id },
            }
          : {}),
        ...(ev?.lastTurnCompleted
          ? {
              lastTurnCompleted: {
                ts: ev.lastTurnCompleted.ts,
                event_id: ev.lastTurnCompleted.event_id,
              },
            }
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
      lifecycle: panelLifecycle,
      expression: channels.expression,
      attention: channels.attention,
      context_band: panelContextBand,
      runtime: runtimeInfo(hb, ev, hb.last_heartbeat),
      ...(usage ? { context_usage: usage } : {}),
      progress_rhythm: progressRhythm(ev, nowMs, hb.last_heartbeat),
      recent_actions: ev?.recentActions ?? [],
      intent_history: ev?.intentHistory ?? [],
      ...(channels.focus_bubble ? { focus_bubble: channels.focus_bubble } : {}),
      ...(activityChannels.get(hb.instance_id) ?? unknownActivityChannels(now)),
      character: { ...FALLBACK_PACK },
      updated_at: hb.last_heartbeat,
    };
    applyLedgerPresentation(panel, hb);
    panels.push(panel);
  }

  // Evidence-backed panels: a session whose heartbeat was stale-swept (or
  // never registered) but whose canonical events are still live must not
  // vanish mid-work. Leftover named sessions without recent work are noise.
  const paneled = new Set(panels.map((p) => p.instance_id));
  for (const [instanceId, ev] of evidence) {
    if (paneled.has(instanceId)) continue;
    const lastTs = ms(ev.lastEventTs);
    if (!Number.isFinite(lastTs) || nowMs - lastTs > EVIDENCE_PANEL_WINDOW_MS) continue;
    const hasWork = Boolean(ev.lastTaskChanged || ev.lastTurnStarted || ev.actionsFull.length > 0);
    const endTs = ms(ev.lastSessionEnded?.ts);
    const ended = ev.lastSessionEnded !== undefined && Number.isFinite(endTs) && endTs >= lastTs;
    if (!hasWork && !ended) continue;
    // Quiet leftovers are not live Codec tiles. Non-ended evidence older than
    // the online window used to render as presence=unknown and refill the grid.
    if (!ended && nowMs - lastTs > EVIDENCE_ONLINE_WINDOW_MS) continue;
    const evPresence: Presented<CodecPresence> = ended
      ? present("offline", "event", "high", ev.lastSessionEnded?.ts ?? now, [
          ev.lastSessionEnded?.event_id ?? "",
        ])
      : nowMs - lastTs <= EVIDENCE_ONLINE_WINDOW_MS
        ? present("online", "event", "medium", ev.lastEventTs ?? now)
        : present("unknown", "unknown", "low", ev.lastEventTs ?? now);
    const evActivity: Presented<CodecActivity> = ev.activityEvidence
      ? present(ev.activityEvidence.value, "event", "high", ev.activityEvidence.ts, [
          ev.activityEvidence.event_id,
        ])
      : present("unknown", "unknown", "low", ev.lastEventTs ?? now);
    const fallbackTs = ev.lastEventTs ?? now;
    const evContextBand = contextBand(instanceId, ev, fallbackTs);
    const channels = deriveExpressiveChannels(
      {
        activity: evActivity.value,
        ...(ev.lastTurnStarted
          ? {
              lastTurnStarted: {
                ts: ev.lastTurnStarted.ts,
                event_id: ev.lastTurnStarted.event_id,
              },
            }
          : {}),
        ...(ev.lastTurnCompleted
          ? {
              lastTurnCompleted: {
                ts: ev.lastTurnCompleted.ts,
                event_id: ev.lastTurnCompleted.event_id,
              },
            }
          : {}),
        actions: ev.actionsFull,
        openSubagents: ev.openSubagents,
        ...(ev.lastLifecycleChanged?.task_state
          ? {
              lifecycleState: {
                value: ev.lastLifecycleChanged.task_state,
                ts: ev.lastLifecycleChanged.ts,
                event_id: ev.lastLifecycleChanged.event_id,
              },
            }
          : {}),
        contextBand: evContextBand.value,
        ...(ev.lastCompaction ? { lastCompaction: ev.lastCompaction } : {}),
        ...(ev.openWait ? { openWait: ev.openWait } : {}),
        ...(ev.lastImageObserved ? { lastImageObserved: ev.lastImageObserved } : {}),
      },
      now,
    );
    const task =
      ev.lastTaskChanged?.task && !ev.lastTaskChanged.task_cleared
        ? present(
            ev.lastTaskChanged.task,
            "event" as const,
            "high" as const,
            ev.lastTaskChanged.ts,
            [ev.lastTaskChanged.event_id],
          )
        : undefined;
    const usage = contextUsage(ev);
    const evidencePanel: CodecPanelScene = {
      instance_id: instanceId,
      identity: {
        display_name:
          ev.identityName ??
          heartbeatName.get(instanceId) ??
          nativeInstanceIdV3(instanceId).slice(0, 8),
        ...(task ? { task } : {}),
      },
      presence: evPresence,
      activity: evActivity,
      lifecycle: ev.lastLifecycleChanged?.task_state
        ? present(ev.lastLifecycleChanged.task_state, "event", "high", ev.lastLifecycleChanged.ts, [
            ev.lastLifecycleChanged.event_id,
          ])
        : present("unknown", "unknown", "low", fallbackTs),
      expression: channels.expression,
      attention: channels.attention,
      context_band: evContextBand,
      runtime: runtimeInfo(undefined, ev, fallbackTs),
      ...(usage ? { context_usage: usage } : {}),
      progress_rhythm: progressRhythm(ev, nowMs, fallbackTs),
      recent_actions: ev.recentActions,
      intent_history: ev.intentHistory,
      ...(channels.focus_bubble ? { focus_bubble: channels.focus_bubble } : {}),
      ...(activityChannels.get(instanceId) ?? unknownActivityChannels(now)),
      character: { ...FALLBACK_PACK },
      updated_at: fallbackTs,
    };
    applyLedgerPresentation(evidencePanel, undefined);
    panels.push(evidencePanel);
    paneled.add(instanceId);
  }

  // Parentage: join V3 generation ids first. A child's parent_generation_id
  // or a parent's child_generation_id maps onto another rendered panel's
  // instance. parent_session_id remains a bounded adapter hint when no
  // generation link exists.
  // A parent outside the scene is omitted, never guessed.
  const panelIds = new Set(panels.map((p) => p.instance_id));
  for (const panel of panels) {
    const slot = evidence.get(panel.instance_id);
    const resolved = resolveParentInstance(panel.instance_id, slot, generationToInstance, childOf);
    if (resolved && panelIds.has(resolved.parent) && resolved.parent !== panel.instance_id) {
      panel.parent_instance_id = present(resolved.parent, "event", "high", resolved.ts, [
        resolved.event_id,
      ]);
    }
  }

  // Message transients: coord.message_observed identifies sender and recipient
  // without retaining message content. A cue renders only while unexpired and
  // only when both endpoints are rendered panels — a particle to nowhere is
  // suppressed, never guessed.
  const transients: CodecScene["transients"] = [];
  const paneledIds = new Set(panels.map((p) => p.instance_id));
  for (const ev of events) {
    if (ev.event_type !== "coord.message_observed" || !ev.ping_to) continue;
    const occurredMs = ms(ev.ts);
    if (!Number.isFinite(occurredMs)) continue;
    const expiresMs = occurredMs + MESSAGE_TRANSIENT_TTL_MS;
    if (expiresMs <= nowMs) continue;
    if (!paneledIds.has(ev.instance_id) || !paneledIds.has(ev.ping_to)) continue;
    transients.push({
      cue_id: ev.event_id,
      kind: "message",
      from_instance_id: ev.instance_id,
      to_instance_id: ev.ping_to,
      occurred_at: ev.ts,
      expires_at: new Date(expiresMs).toISOString(),
      provenance: "event",
    });
  }

  const livePanels = panels.filter((p) => p.presence.value === "online");
  const workingCount = livePanels.filter((p) => p.activity.value === "working").length;
  const needsInput = livePanels.some((p) => p.activity.value === "needs-input");
  const ambience =
    livePanels.length === 0
      ? panels.length === 0
        ? "unknown"
        : "calm"
      : needsInput
        ? "alert"
        : workingCount >= 2
          ? "busy"
          : "calm";

  const lastEvent = events.length ? events[events.length - 1] : undefined;

  return {
    schema_version: CODEC_SCHEMA_VERSION,
    ...(lastEvent ? { source_event_id: lastEvent.event_id } : {}),
    freshness: present("live", "projection", "high", now),
    panels,
    remote_machines: [],
    relationships: [], // still requires proved work/governor adapters
    transients,
    team_ambience: present(ambience, "projection", panels.length ? "high" : "low", now),
    generated_at: now,
  };
}

/** Test seam: clear the presentation-only band memory between cases. */
export function __resetContextBandMemory(): void {
  lastBandByInstance.clear();
}

function applyLedgerPresentation(panel: CodecPanelScene, hb: Heartbeat | undefined): void {
  const state = hb?.ledger_state;
  if (state) {
    panel.ledger_state = present(state, "projection", "high", hb.last_heartbeat);
  }
  if (state === "recovery-required") {
    panel.expression = present(
      "recovering",
      "projection",
      "high",
      hb?.last_heartbeat ?? panel.updated_at,
    );
  }
}

function resolveParentInstance(
  instanceId: string,
  slot: InstanceEvidence | undefined,
  generationToInstance: Map<string, string>,
  childOf: Map<string, { parent: string; event_id: string; ts: string }>,
): { parent: string; event_id: string; ts: string } | undefined {
  if (slot?.parentGeneration) {
    const parent = generationToInstance.get(slot.parentGeneration.parent);
    if (parent && parent !== instanceId) {
      return {
        parent,
        event_id: slot.parentGeneration.event_id,
        ts: slot.parentGeneration.ts,
      };
    }
  }
  if (slot?.generationId) {
    const fromChild = childOf.get(slot.generationId);
    if (fromChild && fromChild.parent !== instanceId) return fromChild;
  }
  if (slot?.parentEvidence && slot.parentEvidence.parent !== instanceId) {
    return slot.parentEvidence;
  }
  return undefined;
}
