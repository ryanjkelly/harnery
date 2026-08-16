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
      event.event_type === "coord.identity_attested" ||
      event.event_type === "decision.state_changed") &&
    !event.payload.authority.transaction_id
  ) {
    issues.push("/payload/authority/transaction_id:required_for_authority_transition");
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
