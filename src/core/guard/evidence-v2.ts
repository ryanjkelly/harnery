import { createHash } from "node:crypto";
import { canonicalJsonV2, type EventV2 } from "../events/v2/index.ts";
import type { RunQualityCorpusCategoryV2, RunQualityEvidenceEvent } from "./types.ts";

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
  const recovery = recoveryCategory(event, base);
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
        ...recovery,
      ];
    case "tool.completed":
      return [
        {
          ...base,
          kind: event.payload.outcome === "succeeded" ? "tool_success" : "tool_failure",
        },
        ...recovery,
      ];
    case "command.completed":
      return recovery;
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

/**
 * Derive generation-level pairing markers from validated events. The markers
 * are audit metadata, not behavioral guard evidence: callers keep them in a
 * separate corpus-category dimension.
 */
export function normalizeRunQualityPairingV2(
  events: readonly EventV2[],
): RunQualityEvidenceEvent[] {
  const spans = new Map<
    string,
    {
      tool_requested: EventV2[];
      tool_completed: EventV2[];
      started_commands: EventV2[];
      completed_commands: EventV2[];
    }
  >();
  for (const event of events) {
    if (
      event.event_type !== "tool.requested" &&
      event.event_type !== "tool.completed" &&
      event.event_type !== "command.started" &&
      event.event_type !== "command.completed"
    ) {
      continue;
    }
    const spanId = (event.links as { span_id?: string }).span_id;
    if (!spanId) continue;
    const span = spans.get(spanId) ?? {
      tool_requested: [],
      tool_completed: [],
      started_commands: [],
      completed_commands: [],
    };
    if (event.event_type === "tool.requested") span.tool_requested.push(event);
    else if (event.event_type === "tool.completed") span.tool_completed.push(event);
    else if (event.event_type === "command.started") span.started_commands.push(event);
    else span.completed_commands.push(event);
    spans.set(spanId, span);
  }

  const markers: RunQualityEvidenceEvent[] = [];
  for (const span of spans.values()) {
    if (
      (span.tool_requested.length > 0 || span.tool_completed.length > 0) &&
      (span.tool_requested.length !== 1 || span.tool_completed.length !== 1)
    ) {
      markers.push(
        pairingMarker("tool_pairing_incomplete", span.tool_requested, span.tool_completed),
      );
    }
    if (
      (span.started_commands.length > 0 || span.completed_commands.length > 0) &&
      (span.started_commands.length !== 1 || span.completed_commands.length !== 1)
    ) {
      markers.push(
        pairingMarker("command_pairing_incomplete", span.started_commands, span.completed_commands),
      );
    }
  }
  return markers;
}

export function isRunQualityCorpusCategoryV2(
  kind: RunQualityEvidenceEvent["kind"],
): kind is RunQualityCorpusCategoryV2 {
  return (
    kind === "tool_pairing_incomplete" ||
    kind === "command_pairing_incomplete" ||
    kind === "recovered_terminal"
  );
}

function recoveryCategory(
  event: EventV2,
  base: Pick<RunQualityEvidenceEvent, "event_id" | "ts">,
): RunQualityEvidenceEvent[] {
  if (!("recovery" in event.payload) || event.payload.recovery === undefined) return [];
  return [{ ...base, kind: "recovered_terminal" }];
}

function pairingMarker(
  kind: Extract<
    RunQualityCorpusCategoryV2,
    "tool_pairing_incomplete" | "command_pairing_incomplete"
  >,
  left: EventV2[],
  right: EventV2[],
): RunQualityEvidenceEvent {
  const witness = [...left, ...right].sort(
    (a, b) =>
      a.time.observed_at.localeCompare(b.time.observed_at) || a.event_id.localeCompare(b.event_id),
  )[0]!;
  return { event_id: witness.event_id, ts: witness.time.observed_at, kind };
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
