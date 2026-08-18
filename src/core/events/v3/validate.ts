import { Value } from "@sinclair/typebox/value";
import { canonicalJsonV2 } from "../v2/canonical.ts";
import { type EventV3, EventV3Schema } from "./contract.ts";

export interface EventV3ValidationResult {
  ok: boolean;
  event?: EventV3;
  issues: string[];
}

export function validateEventV3(value: unknown): EventV3ValidationResult {
  if (!Value.Check(EventV3Schema, value)) {
    return {
      ok: false,
      issues: [...Value.Errors(EventV3Schema, value)]
        .slice(0, 12)
        .map((error) => `${error.path || "/"}:${error.type}`),
    };
  }
  const event = value as EventV3 & ValidatedEventShape;
  const issues = validateTerminalSemantics(event);
  return issues.length === 0
    ? { ok: true, event: value as EventV3, issues: [] }
    : { ok: false, issues };
}

interface ValidatedEventShape {
  event_id: string;
  event_type: string;
  links?: { span_id?: string; parent_span_id?: string };
  provenance: { attestation: string };
  payload?: {
    span?: {
      span_id: string;
      parent_span_id?: string;
      open_event_id?: string;
      duration_ms: { state: string };
    };
    duration_ms?: unknown & { state?: string };
    recovery?: unknown;
    outcome?: string;
    exit_code?: unknown;
  };
}

function validateTerminalSemantics(event: ValidatedEventShape): string[] {
  const issues: string[] = [];
  const payload = event.payload;
  const span = payload?.span;
  if (!span) return issues;
  if (span.span_id === span.parent_span_id) {
    issues.push("/payload/span/parent_span_id:self_reference");
  }
  if (span.open_event_id === event.event_id) {
    issues.push("/payload/span/open_event_id:self_reference");
  }
  if (event.links?.span_id !== undefined && event.links.span_id !== span.span_id) {
    issues.push("/payload/span/span_id:must_match_links");
  }
  if (
    event.links?.parent_span_id !== undefined &&
    event.links.parent_span_id !== span.parent_span_id
  ) {
    issues.push("/payload/span/parent_span_id:must_match_links");
  }
  if (
    payload.duration_ms !== undefined &&
    canonicalJsonV2(payload.duration_ms) !== canonicalJsonV2(span.duration_ms)
  ) {
    issues.push("/payload/duration_ms:must_match_span_duration");
  }
  const recovery = payload.recovery;
  if (!recovery) return issues;
  if (event.provenance.attestation !== "derived") {
    issues.push("/payload/recovery:requires_derived_attestation");
  }
  if (payload.outcome !== "unknown") {
    issues.push("/payload/outcome:recovery_requires_unknown_outcome");
  }
  if (span.duration_ms.state !== "unknown") {
    issues.push("/payload/span/duration_ms:recovery_requires_unknown_duration");
  }
  if (payload.duration_ms?.state !== "unknown") {
    issues.push("/payload/duration_ms:recovery_requires_unknown_duration");
  }
  if (event.event_type === "command.completed" && payload.exit_code !== undefined) {
    issues.push("/payload/exit_code:forbidden_on_recovered_command");
  }
  return issues;
}

export function assertEventV3(value: unknown): asserts value is EventV3 {
  const result = validateEventV3(value);
  if (!result.ok) {
    throw new Error(`event failed V3 contract validation (${result.issues.join(", ")})`);
  }
}
