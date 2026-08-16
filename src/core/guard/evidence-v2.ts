import { createHash } from "node:crypto";
import { canonicalJsonV2, type EventV2 } from "../events/v2/index.ts";
import type { RunQualityEvidenceEvent } from "./types.ts";

interface GenerationScope {
  root_id: string;
  instance_id: string;
  session_id: string;
  generation_id: string;
  workflow_id?: string;
}

interface GenerationLinks {
  caused_by: string[];
  parent_generation_id?: string;
}

/**
 * Convert one validated V2 row into the evaluator's privacy-safe evidence.
 * Both the live guard and offline corpus use this exact adapter.
 */
export function normalizeRunQualityEventV2(
  event: EventV2,
  priorEvents: ReadonlyMap<string, EventV2> = new Map(),
): RunQualityEvidenceEvent[] {
  const base = { event_id: event.event_id, ts: event.time.observed_at };
  switch (event.event_type) {
    case "tool.requested":
      return [
        {
          ...base,
          kind: "tool_call",
          input_hash: bareDigest(event.payload.exact_input.digest),
          target_hash: combinedTargetHash(
            event.payload.targets.map(({ fingerprint }) => fingerprint.digest),
          ),
        },
      ];
    case "tool.completed":
      return [
        {
          ...base,
          kind: event.payload.outcome === "succeeded" ? "tool_success" : "tool_failure",
        },
      ];
    case "turn.started":
      return [{ ...base, kind: "progress" }];
    case "progress.observed":
      return trustedProgress(event, priorEvents) ? [{ ...base, kind: "progress" }] : [];
    case "context.observed": {
      const measurement = event.payload.measurement;
      if (measurement.state !== "observed") return [];
      return [
        {
          ...base,
          kind: "context_sample",
          used_tokens: measurement.value.used_tokens,
          confidence: evidenceConfidence(measurement.attestation, measurement.confidence),
          telemetry_source: telemetrySource(measurement.value.method),
        },
      ];
    }
    case "context.compaction_started":
      return [{ ...base, kind: "compaction_started" }];
    case "context.compaction_completed":
      return [{ ...base, kind: "compaction_completed" }];
    default:
      return [];
  }
}

function trustedProgress(
  event: Extract<EventV2, { event_type: "progress.observed" }>,
  priorEvents: ReadonlyMap<string, EventV2>,
): boolean {
  const links = event.links as GenerationLinks;
  const scope = event.scope as GenerationScope;
  if (!event.payload.evidence_event_ids.every((eventId) => links.caused_by.includes(eventId))) {
    return false;
  }
  return event.payload.evidence_event_ids.every((eventId) => {
    const evidence = priorEvents.get(eventId);
    if (!evidence || !("generation_id" in evidence.scope)) return false;
    if (evidence.scope.generation_id !== scope.generation_id) return false;
    switch (evidence.event_type) {
      case "tool.completed":
      case "turn.completed":
      case "run.completed":
      case "command.completed":
      case "agent.completed":
        return evidence.payload.outcome === "succeeded";
      case "artifact.observed":
        return evidence.payload.operation !== "viewed";
      default:
        return false;
    }
  });
}

function combinedTargetHash(digests: string[]): string | undefined {
  const unique = [...new Set(digests.map(bareDigest))].sort();
  if (unique.length === 0) return undefined;
  if (unique.length === 1) return unique[0];
  return createHash("sha256").update(canonicalJsonV2(unique)).digest("hex");
}

function bareDigest(digest: string): string {
  return digest.slice("sha256:".length);
}

function evidenceConfidence(
  attestation: "native" | "derived" | "inferred",
  confidence: "exact" | "high" | "medium" | "low",
): NonNullable<RunQualityEvidenceEvent["confidence"]> {
  if (attestation === "native" && confidence === "exact") return "exact";
  if (attestation === "inferred") return "estimated";
  return "reported";
}

function telemetrySource(method: string): string {
  if (method.endsWith("_hook")) return "hook";
  if (method.includes("transcript")) return "transcript";
  if (method.includes("result")) return "result";
  if (method.includes("estimate")) return "estimate";
  return "native_event";
}
