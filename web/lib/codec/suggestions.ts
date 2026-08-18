/**
 * Read-and-merge path for optional styler suggestions.
 *
 * The director never runs inference and never launches a process. An optional
 * detached worker (web/scripts/codec-styler.ts) may write suggestions to the
 * Codec-owned file `.harnery/codec/suggestions.json`; this module reads that
 * file, re-validates every entry against the panel's current evidence through
 * the output validator, and merges only what survives. No file, a stale file,
 * or a malformed file means no styling — the deterministic scene is complete
 * without it.
 *
 * Merge policy (plan: "deterministic event/projection precedence wins;
 * inferred styling is discarded"): a suggestion may fill a channel only where
 * the deterministic projector produced the low-information fallback — an
 * expression of `neutral`, or an absent focus bubble. It can never overwrite
 * an event- or projection-backed value, and it can never touch identity,
 * presence, activity, lifecycle, context band, rhythm, or freshness.
 */

import fs from "node:fs";
import path from "node:path";

import { harneryDir } from "@/lib/coord-reader";

import type { CodecScene, CodecSourceEvidence } from "./contracts";
import { codecDir } from "./packs";
import { buildCodecEvidence, type DirectorSuggestion, validateSuggestion } from "./validator";

export function suggestionsPath(root = harneryDir()): string {
  return path.join(codecDir(root), "suggestions.json");
}

function readSuggestionFile(root: string): unknown[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(suggestionsPath(root), "utf8"));
    if (parsed?.schema_version === 1 && Array.isArray(parsed.suggestions)) {
      return parsed.suggestions as unknown[];
    }
  } catch {
    // absent or malformed: inference is simply off
  }
  return [];
}

/** Apply surviving suggestions to the scene in place; returns how many merged. */
export function applySuggestions(
  scene: CodecScene,
  sourceEvents: readonly CodecSourceEvidence[],
  root = harneryDir(),
): number {
  const raw = readSuggestionFile(root);
  if (raw.length === 0) return 0;

  const byInstance = new Map<string, unknown[]>();
  for (const entry of raw) {
    const id = (entry as { instance_id?: unknown })?.instance_id;
    if (typeof id !== "string") continue;
    const list = byInstance.get(id) ?? [];
    list.push(entry);
    byInstance.set(id, list);
  }

  let merged = 0;
  for (const panel of scene.panels) {
    const candidates = byInstance.get(panel.instance_id);
    if (!candidates) continue;
    const evidence = buildCodecEvidence(panel, sourceEvents, scene.generated_at);
    let accepted: DirectorSuggestion | undefined;
    for (const candidate of candidates) {
      const verdict = validateSuggestion(candidate, evidence, scene.generated_at);
      if (verdict.ok) {
        accepted = verdict.suggestion;
        break;
      }
    }
    if (!accepted) continue;

    if (
      accepted.expression &&
      accepted.expression !== "neutral" && // suggesting the fallback is a no-op
      panel.expression.value === "neutral"
    ) {
      panel.expression = {
        value: accepted.expression,
        provenance: "inferred",
        confidence: "low", // inferred styling is capped regardless of claim
        observed_at: scene.generated_at,
        evidence_event_ids: accepted.evidence_event_ids,
        expires_at: accepted.expires_at,
      };
      merged += 1;
    }
    if (accepted.focus_bubble && !panel.focus_bubble) {
      panel.focus_bubble = {
        value: { text: accepted.focus_bubble.text, basis: "inferred" },
        provenance: "inferred",
        confidence: "low",
        observed_at: scene.generated_at,
        evidence_event_ids: accepted.evidence_event_ids,
        expires_at: accepted.expires_at,
      };
      merged += 1;
    }
  }
  return merged;
}
