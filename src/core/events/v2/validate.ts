import { Value } from "@sinclair/typebox/value";
import { type EventV2, EventV2Schema } from "./contract.ts";

export interface EventV2ValidationResult {
  ok: boolean;
  event?: EventV2;
  issues: string[];
}

export function validateEventV2(value: unknown): EventV2ValidationResult {
  if (Value.Check(EventV2Schema, value)) {
    const event = value as EventV2;
    const semanticIssues = validateSemantics(event);
    return semanticIssues.length === 0
      ? { ok: true, event, issues: [] }
      : { ok: false, issues: semanticIssues };
  }
  const issues = [...Value.Errors(EventV2Schema, value)]
    .slice(0, 12)
    .map((error) => `${error.path || "/"}:${error.type}`);
  return { ok: false, issues };
}

function validateSemantics(event: EventV2): string[] {
  const issues: string[] = [];
  const targets =
    event.event_type === "tool.requested"
      ? event.payload.targets
      : event.event_type === "coord.claim_changed"
        ? [event.payload.target]
        : [];
  for (const [index, target] of targets.entries()) {
    if (target.display === undefined) continue;
    const prefix =
      event.event_type === "tool.requested" ? `/payload/targets/${index}` : "/payload/target";
    if (target.kind !== "workspace_path") {
      issues.push(`${prefix}/display:forbidden_for_target_kind`);
    } else if (!safeWorkspaceDisplay(target.display)) {
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
    const declaration = event.payload.runtime_attestation;
    if (declaration.attestation_id !== event.attestation_id) {
      issues.push("/payload/runtime_attestation/attestation_id:mismatch");
    }
    if (declaration.generation_id !== (event.scope as { generation_id: string }).generation_id) {
      issues.push("/payload/runtime_attestation/generation_id:mismatch");
    }
    if (declaration.declared_by_event_id !== event.event_id) {
      issues.push("/payload/runtime_attestation/declared_by_event_id:mismatch");
    }
  }
  if (event.event_type === "session.attestation_changed") {
    const declaration = event.payload.runtime_attestation;
    if (declaration.attestation_id !== event.attestation_id) {
      issues.push("/payload/runtime_attestation/attestation_id:mismatch");
    }
    if (declaration.generation_id !== (event.scope as { generation_id: string }).generation_id) {
      issues.push("/payload/runtime_attestation/generation_id:mismatch");
    }
    if (declaration.declared_by_event_id !== event.event_id) {
      issues.push("/payload/runtime_attestation/declared_by_event_id:mismatch");
    }
    if (event.payload.prior_attestation_id === declaration.attestation_id) {
      issues.push("/payload/prior_attestation_id:must_change");
    }
  }
  if ((event.links as { caused_by: string[] }).caused_by.includes(event.event_id)) {
    issues.push("/links/caused_by:self_reference");
  }
  if (
    event.event_type === "session.termination_observed" &&
    event.payload.observer_instance_id === event.payload.subject_instance_id
  ) {
    issues.push("/payload/observer_instance_id:observer_must_differ_from_subject");
  }
  if (
    event.event_type === "progress.observed" &&
    event.payload.evidence_event_ids.includes(event.event_id)
  ) {
    issues.push("/payload/evidence_event_ids:self_reference");
  }
  if (
    (event.event_type === "coord.task_changed" ||
      event.event_type === "coord.lifecycle_changed" ||
      event.event_type === "coord.identity_attested") &&
    !event.payload.authority.transaction_id
  ) {
    issues.push("/payload/authority/transaction_id:required_for_authority_transition");
  }
  if (
    event.event_type === "decision.state_changed" &&
    !event.payload.authority.transaction_id &&
    !event.payload.authority.record_id
  ) {
    issues.push("/payload/authority:durable_reference_required");
  }
  if (
    event.event_type === "coord.claim_changed" &&
    event.payload.operation !== "denied" &&
    !event.payload.authority.transaction_id
  ) {
    issues.push("/payload/authority/transaction_id:required_for_authority_transition");
  }
  if (
    event.event_type === "coord.claim_changed" &&
    event.payload.target.access !== event.payload.access
  ) {
    issues.push("/payload/target/access:must_match_claim_access");
  }
  if (
    event.event_type === "ledger.activated" &&
    event.payload.eligible_after_event_id !== event.event_id
  ) {
    issues.push("/payload/eligible_after_event_id:must_reference_activation_event");
  }
  issues.push(...validateRecoverySemantics(event));
  return issues;
}

/**
 * ADR 0078: the `recovery` block marks a machinery-minted recovery event.
 * Presence requires derived attestation and (on completions) an unknown
 * outcome; reason codes bind to event types. Tool events are bidirectional
 * (derived requires recovery); command events are exempt from the forward
 * direction because CLI-teed command telemetry is attested derived in normal
 * operation.
 */
function validateRecoverySemantics(event: EventV2): string[] {
  if (
    event.event_type !== "tool.requested" &&
    event.event_type !== "tool.completed" &&
    event.event_type !== "command.completed"
  ) {
    return [];
  }
  const issues: string[] = [];
  const recovery = event.payload.recovery;
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
  if (event.event_type === "command.completed") {
    if (recovery.reason !== "command_completion_not_observed") {
      issues.push("/payload/recovery/reason:invalid_for_command_completed");
    }
    if (event.payload.duration_ms !== 0) {
      issues.push("/payload/duration_ms:recovery_requires_zero_duration");
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

export function assertEventV2(value: unknown): asserts value is EventV2 {
  const result = validateEventV2(value);
  if (!result.ok) {
    throw new Error(`event failed V2 contract validation (${result.issues.join(", ")})`);
  }
}
