/**
 * Deterministic expressive layer (plan § creative presentation language).
 *
 * Derives the expression, attention, and focus-bubble channels from bounded,
 * already-sanitized evidence. Every rule is a pure function of evidence
 * timestamps against the injected clock — no model, no randomness — so the
 * whole vocabulary works with inference disabled. Values are presentation
 * interpretation and are labeled with provenance + confidence; they never
 * feed back into Harnery and never claim cognition (`deliberating` is always
 * `inferred`/low per the plan's expressive-vocabulary table).
 *
 * Channel independence: expression never overwrites activity or lifecycle,
 * and attention overlays always expire.
 */

import type {
  CodecActivity,
  CodecAttention,
  CodecExpression,
  Presented,
} from "./contracts";

export interface ExpressiveAction {
  category: "research" | "diagnostic" | "build" | "edit" | "test" | "coordinate" | "other";
  outcome: "started" | "ok" | "error" | "unknown";
  event_id: string;
  ts: string;
  /** Bounded declared intent, present only on action starts that carried one. */
  intent?: string;
}

export interface ExpressiveInputs {
  /** Authoritative activity from the heartbeat projection. */
  activity: CodecActivity;
  /** Last user_prompt.submit, if any. */
  lastPrompt?: { ts: string; event_id: string };
  /** Last turn.stop, if any. */
  lastTurnStop?: { ts: string; event_id: string };
  /** Recent actions, ascending by source order (bounded upstream). */
  actions: readonly ExpressiveAction[];
  /** Currently open subagents (starts minus stops, floored at 0). */
  openSubagents: number;
}

export interface ExpressiveChannels {
  expression: Presented<CodecExpression>;
  attention: Presented<CodecAttention>;
  focus_bubble?: Presented<{ text: string; basis: "event-backed" | "inferred" }>;
}

/* Decay windows (ms). Deterministic against the injected clock. */
const ERROR_FLASH_MS = 10_000;
const FRICTION_MS = 5 * 60_000;
const CELEBRATE_MS = 8_000;
const CURIOUS_MS = 30_000;
const BUILDING_MS = 120_000;
const COORDINATING_MS = 60_000;
const RECOVERING_MS = 60_000;
const DELIBERATING_MIN_MS = 10_000;
const DELIBERATING_MAX_MS = 60_000;
const FOCUSED_MS = 120_000;
const BUBBLE_MS = 120_000;
const INPUT_ATTENTION_MS = 60_000;
/** Repeated research/diagnostic actions in one turn that read as a sustained
 * investigation rather than a glance. */
const INVESTIGATING_THRESHOLD = 3;

function ms(ts: string | undefined): number {
  if (!ts) return Number.NaN;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function iso(msValue: number): string {
  return new Date(msValue).toISOString();
}

export function deriveExpressiveChannels(
  inputs: ExpressiveInputs,
  now: string,
): ExpressiveChannels {
  const nowMs = ms(now);
  const promptTs = ms(inputs.lastPrompt?.ts);
  const stopTs = ms(inputs.lastTurnStop?.ts);
  const lastActionEvidenceTs = inputs.actions.length
    ? ms(inputs.actions[inputs.actions.length - 1]?.ts)
    : Number.NaN;
  // A turn is open on either signal: a prompt newer than the last stop, or —
  // for adapters that emit no user_prompt.submit rows at all (observed on
  // this stream) — action evidence newer than the last stop. Silence after a
  // stop is a closed turn; no signal at all is no turn.
  const promptOpens =
    Number.isFinite(promptTs) && (!Number.isFinite(stopTs) || promptTs > stopTs);
  const actionOpens =
    Number.isFinite(lastActionEvidenceTs) &&
    (!Number.isFinite(stopTs) || lastActionEvidenceTs > stopTs);
  const inOpenTurn = promptOpens || actionOpens;

  // Actions inside the current open turn: after the prompt when we have one,
  // otherwise strictly after the last stop (or everything, absent any stop).
  const turnStartMs = promptOpens ? promptTs : Number.isFinite(stopTs) ? stopTs : Number.NEGATIVE_INFINITY;
  const turnActions = inOpenTurn
    ? inputs.actions.filter((a) => {
        const t = ms(a.ts);
        return promptOpens ? t >= turnStartMs : t > turnStartMs;
      })
    : [];
  const last = inputs.actions.length
    ? inputs.actions[inputs.actions.length - 1]
    : undefined;
  const lastTs = ms(last?.ts);
  const age = (t: number) => nowMs - t;

  const errors = inputs.actions.filter(
    (a) => a.outcome === "error" && Number.isFinite(ms(a.ts)) && age(ms(a.ts)) <= FRICTION_MS,
  );
  const lastError = errors.length ? errors[errors.length - 1] : undefined;
  const lastErrorTs = ms(lastError?.ts);

  /* ── attention (short-lived overlays; all non-none values expire) ───── */
  let attention: Presented<CodecAttention>;
  const completionAction =
    last &&
    (last.category === "build" || last.category === "test") &&
    last.outcome === "ok" &&
    Number.isFinite(lastTs) &&
    age(lastTs) <= CELEBRATE_MS
      ? last
      : undefined;

  if (inputs.activity === "needs-input") {
    attention = {
      value: "input",
      provenance: "projection",
      confidence: "high",
      observed_at: now,
      expires_at: iso(nowMs + INPUT_ATTENTION_MS),
    };
  } else if (lastError && Number.isFinite(lastErrorTs) && age(lastErrorTs) <= ERROR_FLASH_MS) {
    attention = {
      value: "error",
      provenance: "event",
      confidence: "high",
      observed_at: lastError.ts,
      evidence_event_ids: [lastError.event_id],
      expires_at: iso(lastErrorTs + ERROR_FLASH_MS),
    };
  } else if (completionAction) {
    attention = {
      value: "completion",
      provenance: "event",
      confidence: "high",
      observed_at: completionAction.ts,
      evidence_event_ids: [completionAction.event_id],
      expires_at: iso(ms(completionAction.ts) + CELEBRATE_MS),
    };
  } else if (lastError) {
    // The flash decays into a friction meter, not a permanent alert.
    attention = {
      value: "friction",
      provenance: "event",
      confidence: "medium",
      observed_at: lastError.ts,
      evidence_event_ids: errors.slice(-3).map((e) => e.event_id),
      expires_at: iso(lastErrorTs + FRICTION_MS),
    };
  } else {
    attention = { value: "none", provenance: "projection", confidence: "high", observed_at: now };
  }

  /* ── expression (single value by deterministic precedence) ──────────── */
  const expression = ((): Presented<CodecExpression> => {
    const from = (
      value: CodecExpression,
      provenance: Presented<CodecExpression>["provenance"],
      confidence: Presented<CodecExpression>["confidence"],
      observedAt: string,
      ids?: string[],
    ): Presented<CodecExpression> => ({
      value,
      provenance,
      confidence,
      observed_at: observedAt,
      ...(ids && ids.length ? { evidence_event_ids: ids } : {}),
    });

    // waiting: authoritative needs-input holds until forward progress.
    if (inputs.activity === "needs-input") return from("waiting", "projection", "high", now);

    // alert: companion to a fresh failure, not a severity claim.
    if (attention.value === "error" && lastError) {
      return from("alert", "event", "high", lastError.ts, [lastError.event_id]);
    }

    // recovering: a failed action followed by a newer action in the same turn.
    if (inOpenTurn && lastError) {
      const errTs = ms(lastError.ts);
      const retry = turnActions.find((a) => ms(a.ts) > errTs && a.outcome !== "error");
      if (retry && age(ms(retry.ts)) <= RECOVERING_MS) {
        return from("recovering", "event", "medium", retry.ts, [lastError.event_id, retry.event_id]);
      }
    }

    // celebrating: brief flourish on a successful build/test, never proof.
    if (completionAction) {
      return from("celebrating", "event", "low", completionAction.ts, [completionAction.event_id]);
    }

    // coordinating: only while coordination evidence is current.
    if (inputs.openSubagents > 0) return from("coordinating", "projection", "high", now);
    if (
      last?.category === "coordinate" &&
      Number.isFinite(lastTs) &&
      age(lastTs) <= COORDINATING_MS
    ) {
      return from("coordinating", "event", "high", last.ts, [last.event_id]);
    }

    // investigating: sustained research/diagnostic inside one turn.
    const researchInTurn = turnActions.filter(
      (a) => a.category === "research" || a.category === "diagnostic",
    );
    if (
      researchInTurn.length >= INVESTIGATING_THRESHOLD &&
      last &&
      Number.isFinite(lastTs) &&
      age(lastTs) <= BUILDING_MS
    ) {
      return from(
        "investigating",
        "event",
        "high",
        last.ts,
        researchInTurn.slice(-3).map((a) => a.event_id),
      );
    }

    // building / curious: category-backed, high confidence only when the
    // category normalization succeeded (an `other` action triggers neither).
    if (
      last &&
      (last.category === "build" || last.category === "edit" || last.category === "test") &&
      Number.isFinite(lastTs) &&
      age(lastTs) <= BUILDING_MS
    ) {
      return from("building", "event", "high", last.ts, [last.event_id]);
    }
    if (
      last?.category === "research" &&
      Number.isFinite(lastTs) &&
      age(lastTs) <= CURIOUS_MS
    ) {
      return from("curious", "event", "high", last.ts, [last.event_id]);
    }

    // deliberating: research completed, short quiet interval, same open turn.
    // Always inferred and low confidence; never presented as cognition.
    if (
      inOpenTurn &&
      last &&
      (last.category === "research" || last.category === "diagnostic") &&
      last.outcome === "ok" &&
      Number.isFinite(lastTs) &&
      age(lastTs) >= DELIBERATING_MIN_MS &&
      age(lastTs) <= DELIBERATING_MAX_MS
    ) {
      return from("deliberating", "inferred", "low", last.ts, [last.event_id]);
    }

    // focused: open turn with recent activity.
    if (
      inOpenTurn &&
      ((last && Number.isFinite(lastTs) && age(lastTs) <= FOCUSED_MS) ||
        inputs.activity === "working")
    ) {
      return from("focused", "projection", "high", inputs.lastPrompt?.ts ?? now);
    }

    return from("neutral", "projection", "high", now);
  })();

  /* ── focus bubble (event-backed only in this phase) ─────────────────── */
  let focusBubble: ExpressiveChannels["focus_bubble"];
  if (inOpenTurn) {
    const withIntent = [...turnActions].reverse().find((a) => a.intent);
    const intentTs = ms(withIntent?.ts);
    if (withIntent?.intent && Number.isFinite(intentTs) && age(intentTs) <= BUBBLE_MS) {
      const words = withIntent.intent.split(/\s+/).filter(Boolean).slice(0, 4);
      if (words.length > 0) {
        focusBubble = {
          value: { text: words.join(" "), basis: "event-backed" },
          provenance: "event",
          confidence: "high",
          observed_at: withIntent.ts,
          evidence_event_ids: [withIntent.event_id],
          expires_at: iso(intentTs + BUBBLE_MS),
        };
      }
    }
  }

  return { expression, attention, ...(focusBubble ? { focus_bubble: focusBubble } : {}) };
}
