import { Value } from "@sinclair/typebox/value";
import { canonicalJsonV3 } from "./canonical.ts";
import { type EventV3, EventV3Schema } from "./contract.ts";

export interface EventV3ValidationResult {
  ok: boolean;
  event?: EventV3;
  issues: string[];
}

interface EventShape {
  event_id: string;
  event_type: string;
  time: { observed_at: string };
  producer: { platform: string; bridge?: string };
  scope: Record<string, unknown>;
  attestation_id?: string;
  links: { caused_by: string[]; span_id?: string; parent_span_id?: string };
  provenance: {
    attestation: string;
    attribution: { state: string; method: string };
  };
  payload: Record<string, unknown>;
}

interface ObservationShape {
  state: string;
  value?: unknown;
  reason?: string;
}

interface SpanShape {
  span_id: string;
  parent_span_id?: string;
  opened_at: string;
  open_event_id?: string;
  duration_ms: ObservationShape;
}

interface RecoveryShape {
  reason: string;
  requested_event_id?: string;
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
  const event = value as unknown as EventShape;
  const issues = [
    ...validateBaseSemantics(event),
    ...validateSpanSemantics(event),
    ...validateRecoverySemantics(event),
  ];
  return issues.length === 0
    ? { ok: true, event: value as EventV3, issues: [] }
    : { ok: false, issues };
}

function validateBaseSemantics(event: EventShape): string[] {
  const issues: string[] = [];
  const targets =
    event.event_type === "tool.requested"
      ? arrayOfRecords(event.payload.targets)
      : event.event_type === "coord.claim_changed"
        ? [record(event.payload.target)]
        : [];
  for (const [index, target] of targets.entries()) {
    if (target.display === undefined) continue;
    const prefix =
      event.event_type === "tool.requested" ? `/payload/targets/${index}` : "/payload/target";
    if (target.kind !== "workspace_path") {
      issues.push(`${prefix}/display:forbidden_for_target_kind`);
    } else if (typeof target.display !== "string" || !safeWorkspaceDisplay(target.display)) {
      issues.push(`${prefix}/display:workspace_path_invalid`);
    }
  }
  if (event.producer.bridge === "codex-wsl" && event.producer.platform !== "linux") {
    issues.push("/producer/platform:codex-wsl_requires_linux_writer");
  }
  if (
    event.provenance.attribution.state === "verified" &&
    event.provenance.attribution.method === "unattributed"
  ) {
    issues.push("/provenance/attribution:verified_unattributed");
  }
  if (event.event_type === "session.started") {
    validateAttestationDeclaration(event, issues);
  }
  if (event.event_type === "session.attestation_changed") {
    const declaration = validateAttestationDeclaration(event, issues);
    if (event.payload.prior_attestation_id === declaration.attestation_id) {
      issues.push("/payload/prior_attestation_id:must_change");
    }
  }
  if (event.event_type === "turn.completed") {
    const harnessObservation = record(event.payload.harness);
    if (harnessObservation.state === "observed") {
      const harness = record(harnessObservation.value);
      const slowestHookMs = harness.slowest_hook_ms;
      if (slowestHookMs !== undefined && typeof harness.slowest_hook !== "string") {
        issues.push("/payload/harness/value/slowest_hook:required_with_duration");
      }
      if (
        typeof slowestHookMs === "number" &&
        typeof harness.hook_time_ms === "number" &&
        slowestHookMs > harness.hook_time_ms
      ) {
        issues.push("/payload/harness/value/slowest_hook_ms:must_not_exceed_hook_time");
      }
    }
  }
  if (event.links.caused_by.includes(event.event_id)) {
    issues.push("/links/caused_by:self_reference");
  }
  if (event.links.span_id !== undefined && event.links.span_id === event.links.parent_span_id) {
    issues.push("/links/parent_span_id:self_reference");
  }
  if (
    event.event_type === "session.termination_observed" &&
    event.payload.observer_instance_id === event.payload.subject_instance_id
  ) {
    issues.push("/payload/observer_instance_id:observer_must_differ_from_subject");
  }
  if (event.event_type === "progress.observed") {
    const evidenceIds = Array.isArray(event.payload.evidence_event_ids)
      ? event.payload.evidence_event_ids
      : [];
    if (evidenceIds.includes(event.event_id)) {
      issues.push("/payload/evidence_event_ids:self_reference");
    }
  }
  if (
    (event.event_type === "coord.task_changed" ||
      event.event_type === "coord.lifecycle_changed" ||
      event.event_type === "coord.identity_attested") &&
    !record(event.payload.authority).transaction_id
  ) {
    issues.push("/payload/authority/transaction_id:required_for_authority_transition");
  }
  if (event.event_type === "decision.state_changed") {
    const authority = record(event.payload.authority);
    if (!authority.transaction_id && !authority.record_id) {
      issues.push("/payload/authority:durable_reference_required");
    }
  }
  if (
    event.event_type === "coord.claim_changed" &&
    event.payload.operation !== "denied" &&
    !record(event.payload.authority).transaction_id
  ) {
    issues.push("/payload/authority/transaction_id:required_for_authority_transition");
  }
  if (
    event.event_type === "coord.claim_changed" &&
    record(event.payload.target).access !== event.payload.access
  ) {
    issues.push("/payload/target/access:must_match_claim_access");
  }
  if (
    event.event_type === "ledger.activated" &&
    event.payload.eligible_after_event_id !== event.event_id
  ) {
    issues.push("/payload/eligible_after_event_id:must_reference_activation_event");
  }
  return issues;
}

function validateAttestationDeclaration(
  event: EventShape,
  issues: string[],
): Record<string, unknown> {
  const declaration = record(event.payload.runtime_attestation);
  if (declaration.attestation_id !== event.attestation_id) {
    issues.push("/payload/runtime_attestation/attestation_id:mismatch");
  }
  if (declaration.generation_id !== event.scope.generation_id) {
    issues.push("/payload/runtime_attestation/generation_id:mismatch");
  }
  if (declaration.declared_by_event_id !== event.event_id) {
    issues.push("/payload/runtime_attestation/declared_by_event_id:mismatch");
  }
  return declaration;
}

function validateSpanSemantics(event: EventShape): string[] {
  const span = spanFrom(event.payload.span);
  if (!span) return [];
  const issues: string[] = [];
  if (span.span_id === span.parent_span_id) {
    issues.push("/payload/span/parent_span_id:self_reference");
  }
  if (span.open_event_id === event.event_id) {
    issues.push("/payload/span/open_event_id:self_reference");
  }
  if (event.links.span_id !== undefined && event.links.span_id !== span.span_id) {
    issues.push("/payload/span/span_id:must_match_links");
  }
  if (
    event.links.parent_span_id !== undefined &&
    event.links.parent_span_id !== span.parent_span_id
  ) {
    issues.push("/payload/span/parent_span_id:must_match_links");
  }
  if (span.open_event_id !== undefined && !event.links.caused_by.includes(span.open_event_id)) {
    issues.push("/payload/span/open_event_id:must_be_causal_parent");
  }
  const duration = observationFrom(event.payload.duration_ms);
  if (duration && canonicalJsonV3(duration) !== canonicalJsonV3(span.duration_ms)) {
    issues.push("/payload/duration_ms:must_match_span_duration");
  }
  const openedAt = Date.parse(span.opened_at);
  const completedAt = Date.parse(event.time.observed_at);
  if (
    openedAt > completedAt &&
    (span.duration_ms.state !== "expected_but_missing" ||
      span.duration_ms.reason !== "clock_regressed")
  ) {
    issues.push("/payload/span/duration_ms:clock_regression_must_be_missing");
  }
  return issues;
}

function validateRecoverySemantics(event: EventShape): string[] {
  if (
    event.event_type !== "tool.requested" &&
    event.event_type !== "tool.completed" &&
    event.event_type !== "command.completed"
  ) {
    return [];
  }
  const issues: string[] = [];
  const recovery = recoveryFrom(event.payload.recovery);
  if (!recovery) {
    if (event.event_type !== "command.completed" && event.provenance.attestation === "derived") {
      issues.push("/payload/recovery:required_for_derived_tool_event");
    }
    return issues;
  }
  if (event.provenance.attestation !== "derived") {
    issues.push("/payload/recovery:requires_derived_attestation");
  }
  if (recovery.requested_event_id === event.event_id) {
    issues.push("/payload/recovery/requested_event_id:self_reference");
  }
  if (event.event_type === "tool.requested") {
    if (recovery.reason !== "request_not_observed") {
      issues.push("/payload/recovery/reason:invalid_for_tool_requested");
    }
    if (recovery.requested_event_id !== undefined) {
      issues.push("/payload/recovery/requested_event_id:forbidden_on_derived_request");
    }
    return issues;
  }
  if (event.payload.outcome !== "unknown") {
    issues.push("/payload/outcome:recovery_requires_unknown_outcome");
  }
  const span = spanFrom(event.payload.span);
  const duration = observationFrom(event.payload.duration_ms);
  if (span?.duration_ms.state !== "unknown") {
    issues.push("/payload/span/duration_ms:recovery_requires_unknown_duration");
  }
  if (duration?.state !== "unknown") {
    issues.push("/payload/duration_ms:recovery_requires_unknown_duration");
  }
  if (span && span.duration_ms.reason !== recovery.reason) {
    issues.push("/payload/span/duration_ms:recovery_reason_mismatch");
  }
  if (duration && duration.reason !== recovery.reason) {
    issues.push("/payload/duration_ms:recovery_reason_mismatch");
  }
  if (event.event_type === "command.completed") {
    if (recovery.reason !== "command_completion_not_observed") {
      issues.push("/payload/recovery/reason:invalid_for_command_completed");
    }
    if (event.payload.exit_code !== undefined) {
      issues.push("/payload/exit_code:forbidden_on_recovered_command");
    }
    return issues;
  }
  if (
    recovery.reason === "request_not_observed" ||
    recovery.reason === "command_completion_not_observed"
  ) {
    issues.push("/payload/recovery/reason:invalid_for_tool_completed");
  }
  return issues;
}

function safeWorkspaceDisplay(value: string): boolean {
  return (
    value === "." ||
    (!value.startsWith("/") &&
      !/^[a-zA-Z]:/.test(value) &&
      !value.includes("\\") &&
      !value.split("/").includes(".."))
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function observationFrom(value: unknown): ObservationShape | undefined {
  const candidate = record(value);
  return typeof candidate.state === "string"
    ? (candidate as unknown as ObservationShape)
    : undefined;
}

function spanFrom(value: unknown): SpanShape | undefined {
  const candidate = record(value);
  return typeof candidate.span_id === "string" && observationFrom(candidate.duration_ms)
    ? (candidate as unknown as SpanShape)
    : undefined;
}

function recoveryFrom(value: unknown): RecoveryShape | undefined {
  const candidate = record(value);
  return typeof candidate.reason === "string" ? (candidate as unknown as RecoveryShape) : undefined;
}

export function assertEventV3(value: unknown): asserts value is EventV3 {
  const result = validateEventV3(value);
  if (!result.ok) {
    throw new Error(`event failed V3 contract validation (${result.issues.join(", ")})`);
  }
}
