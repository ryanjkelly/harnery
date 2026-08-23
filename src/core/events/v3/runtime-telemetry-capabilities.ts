import type { Adapter } from "../../adapter.ts";
import {
  adapterSignalSupportV3,
  type CapabilitySupportV3,
  type CursorExecutionModeV3,
} from "./capabilities.ts";

export type RuntimeTelemetryChannelV3 =
  | "context_usage"
  | "wait_spans"
  | "wait_completeness"
  | "response_latency"
  | "inference_timing";

export type RuntimeTelemetryCompletenessV3 = "exact" | "lower_bound" | "unknown";

export interface RuntimeTelemetryCapabilityValueV3 {
  support: Exclude<CapabilitySupportV3, "unsupported">;
  source: string;
  completeness: RuntimeTelemetryCompletenessV3;
}

export type RuntimeTelemetryCapabilityObservationV3 =
  | {
      state: "observed";
      value: RuntimeTelemetryCapabilityValueV3;
      attestation: "native" | "derived";
      confidence: "exact" | "high";
    }
  | { state: "expected_but_missing"; capability: string; reason: string }
  | { state: "unsupported"; capability: string };

export type RuntimeContextCapabilityEvidenceV3 =
  | {
      state: "observed";
      source: string;
      attestation: "native" | "derived";
      confidence: "exact" | "high";
    }
  | { state: "partial"; reason: string }
  | { state: "unsupported" };

export interface RuntimeTelemetryCapabilityEvidenceV3 {
  adapter: Adapter;
  cursor_mode?: CursorExecutionModeV3;
  context: RuntimeContextCapabilityEvidenceV3;
  canonical_turn_boundaries: boolean;
  independent_wait_completeness?: boolean;
}

export type RuntimeTelemetryCapabilitiesV3 = Record<
  RuntimeTelemetryChannelV3,
  RuntimeTelemetryCapabilityObservationV3
>;

/**
 * Resolve the telemetry support that one runtime session can actually prove.
 *
 * This is deliberately separate from AdapterCapabilityProfileV3. The static
 * profile gates the event contract; this projection describes effective
 * session evidence without moving a genesis-approved digest when a local
 * source is missing, late, or unreadable.
 */
export function effectiveRuntimeTelemetryCapabilitiesV3(
  evidence: RuntimeTelemetryCapabilityEvidenceV3,
): RuntimeTelemetryCapabilitiesV3 {
  return {
    context_usage: contextCapability(evidence.context),
    wait_spans: waitSpanCapability(evidence.adapter, evidence.cursor_mode),
    wait_completeness: evidence.independent_wait_completeness
      ? observed("native", "runtime.wait_aggregate", "exact", "native", "exact")
      : unsupported("wait_turn_completeness"),
    response_latency: evidence.canonical_turn_boundaries
      ? observed("derived", "canonical.event_clocks", "exact", "derived", "exact")
      : missing("response_latency", "turn_boundaries_not_delivered"),
    inference_timing: unsupported("provider_inference_timing"),
  };
}

function contextCapability(
  evidence: RuntimeContextCapabilityEvidenceV3,
): RuntimeTelemetryCapabilityObservationV3 {
  if (evidence.state === "observed") {
    return observed(
      evidence.attestation === "native" ? "native" : "derived",
      evidence.source,
      "exact",
      evidence.attestation,
      evidence.confidence,
    );
  }
  if (evidence.state === "partial") {
    return missing("context_usage", evidence.reason);
  }
  return unsupported("context_usage");
}

function waitSpanCapability(
  adapter: Adapter,
  cursorMode: CursorExecutionModeV3 | undefined,
): RuntimeTelemetryCapabilityObservationV3 {
  if (adapter === "cursor" && cursorMode === "cloud") {
    return unsupported("wait_span_delivery");
  }
  const support = adapterSignalSupportV3(adapter, "permission");
  if (support === "unsupported") return unsupported("wait_span_delivery");
  return observed(
    support,
    adapter === "cursor" ? "cursor.permission_hooks" : `${adapter}.permission_hooks`,
    "lower_bound",
    support === "native" ? "native" : "derived",
    support === "native" ? "exact" : "high",
  );
}

function observed(
  support: Exclude<CapabilitySupportV3, "unsupported">,
  source: string,
  completeness: RuntimeTelemetryCompletenessV3,
  attestation: "native" | "derived",
  confidence: "exact" | "high",
): RuntimeTelemetryCapabilityObservationV3 {
  return {
    state: "observed",
    value: { support, source, completeness },
    attestation,
    confidence,
  };
}

function missing(capability: string, reason: string): RuntimeTelemetryCapabilityObservationV3 {
  return { state: "expected_but_missing", capability, reason };
}

function unsupported(capability: string): RuntimeTelemetryCapabilityObservationV3 {
  return { state: "unsupported", capability };
}
