/**
 * Director evidence + suggestion contract (plan § director evidence and
 * suggestion contract).
 *
 * `buildCodecEvidence` is the ONLY view an optional model-backed styler may
 * ever see: bounded, already-sanitized scalars. `validateSuggestion` is the
 * output validator that rejects stale, unsupported, overlong, or weakly
 * evidenced suggestions before anything merges into a scene. Both exist and
 * are tested ahead of any styler so the contract is frozen while inference
 * remains disabled; the deterministic view is complete without it.
 */

import type {
  CodecExpression,
  CodecPanelScene,
  CodecRecentAction,
  CodecSourceEvidence,
  Presented,
} from "./contracts";

export interface CodecEvidence {
  schema_version: 1;
  instance_id: string;
  observed_at: string;
  task_label?: Presented<string>;
  presence: CodecPanelScene["presence"];
  activity: CodecPanelScene["activity"];
  lifecycle: CodecPanelScene["lifecycle"];
  context_band: CodecPanelScene["context_band"];
  /** Bounded declared intent only; never a prompt or command body. */
  current_intent?: { text: string; event_id: string; observed_at: string };
  /** Newest three at most. */
  recent_actions: CodecRecentAction[];
}

export interface DirectorSuggestion {
  schema_version: 1;
  instance_id: string;
  expression?: CodecExpression;
  focus_bubble?: {
    /** At most four words, normally three or four. */
    text: string;
    basis: "event-backed" | "inferred";
  };
  confidence: "high" | "medium" | "low";
  evidence_event_ids: string[];
  expires_at: string;
}

export type SuggestionVerdict =
  | { ok: true; suggestion: DirectorSuggestion }
  | { ok: false; reason: string };

const EXPRESSIONS: ReadonlySet<string> = new Set([
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
]);

const MAX_BUBBLE_WORDS = 4;
/** A suggestion may not outlive its usefulness; ten minutes is generous. */
const MAX_TTL_MS = 10 * 60_000;

/** Assemble the bounded evidence view for one panel from projector outputs.
 * Everything here is already sanitized; this only selects and caps. */
export function buildCodecEvidence(
  panel: CodecPanelScene,
  sourceEvents: readonly CodecSourceEvidence[],
  now: string,
): CodecEvidence {
  const intentEvent = [...sourceEvents]
    .reverse()
    .find((ev) => ev.instance_id === panel.instance_id && ev.intent);
  return {
    schema_version: 1,
    instance_id: panel.instance_id,
    observed_at: now,
    ...(panel.identity.task ? { task_label: panel.identity.task } : {}),
    presence: panel.presence,
    activity: panel.activity,
    lifecycle: panel.lifecycle,
    context_band: panel.context_band,
    ...(intentEvent?.intent
      ? {
          current_intent: {
            text: intentEvent.intent,
            event_id: intentEvent.event_id,
            observed_at: intentEvent.ts,
          },
        }
      : {}),
    recent_actions: panel.recent_actions.slice(0, 3),
  };
}

/** Every event id a suggestion may legally cite for this evidence. */
export function evidenceEventIds(evidence: CodecEvidence): Set<string> {
  const ids = new Set<string>();
  for (const action of evidence.recent_actions) ids.add(action.event_id);
  if (evidence.current_intent) ids.add(evidence.current_intent.event_id);
  for (const field of [
    evidence.task_label,
    evidence.presence,
    evidence.activity,
    evidence.lifecycle,
    evidence.context_band,
  ]) {
    for (const id of field?.evidence_event_ids ?? []) ids.add(id);
  }
  return ids;
}

/**
 * Accept or reject one suggestion against the evidence it claims to explain.
 * Rules (all from the plan): cited IDs must be a subset of the supplied
 * evidence; every suggestion must expire, soon; inferred content is capped at
 * low confidence; bubbles are at most four words; unknown expressions and
 * schema versions fail closed.
 */
export function validateSuggestion(
  raw: unknown,
  evidence: CodecEvidence,
  now: string,
): SuggestionVerdict {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not an object" };
  const s = raw as Record<string, unknown>;
  if (s.schema_version !== 1) return { ok: false, reason: "unsupported schema_version" };
  if (s.instance_id !== evidence.instance_id) return { ok: false, reason: "instance mismatch" };

  const confidence = s.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    return { ok: false, reason: "invalid confidence" };
  }

  const expiresAt = typeof s.expires_at === "string" ? Date.parse(s.expires_at) : Number.NaN;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "missing expires_at" };
  if (expiresAt <= nowMs) return { ok: false, reason: "already expired" };
  if (expiresAt > nowMs + MAX_TTL_MS) return { ok: false, reason: "expiry too far out" };

  if (!Array.isArray(s.evidence_event_ids) || s.evidence_event_ids.length === 0) {
    return { ok: false, reason: "no cited evidence" };
  }
  const legal = evidenceEventIds(evidence);
  for (const id of s.evidence_event_ids) {
    if (typeof id !== "string" || !legal.has(id)) {
      return { ok: false, reason: `cites unknown evidence: ${String(id).slice(0, 40)}` };
    }
  }

  let expression: CodecExpression | undefined;
  if (s.expression !== undefined) {
    if (typeof s.expression !== "string" || !EXPRESSIONS.has(s.expression)) {
      return { ok: false, reason: "unknown expression" };
    }
    expression = s.expression as CodecExpression;
  }

  let bubble: DirectorSuggestion["focus_bubble"];
  if (s.focus_bubble !== undefined) {
    const b = s.focus_bubble as Record<string, unknown>;
    if (typeof b !== "object" || b === null) return { ok: false, reason: "invalid bubble" };
    if (b.basis !== "event-backed" && b.basis !== "inferred") {
      return { ok: false, reason: "invalid bubble basis" };
    }
    if (typeof b.text !== "string" || !b.text.trim()) {
      return { ok: false, reason: "empty bubble text" };
    }
    const words = b.text.trim().split(/\s+/);
    if (words.length > MAX_BUBBLE_WORDS) return { ok: false, reason: "bubble too long" };
    // Synthesis across signals is inferred by definition; inferred content is
    // capped at low confidence.
    if (b.basis === "inferred" && confidence !== "low") {
      return { ok: false, reason: "inferred content must be low confidence" };
    }
    bubble = { text: words.join(" "), basis: b.basis };
  }

  if (!expression && !bubble) return { ok: false, reason: "suggests nothing" };

  return {
    ok: true,
    suggestion: {
      schema_version: 1,
      instance_id: evidence.instance_id,
      ...(expression ? { expression } : {}),
      ...(bubble ? { focus_bubble: bubble } : {}),
      confidence,
      evidence_event_ids: s.evidence_event_ids as string[],
      expires_at: new Date(expiresAt).toISOString(),
    },
  };
}
