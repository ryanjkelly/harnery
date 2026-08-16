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
  return issues;
}

export function assertEventV2(value: unknown): asserts value is EventV2 {
  const result = validateEventV2(value);
  if (!result.ok) {
    throw new Error(`event failed V2 contract validation (${result.issues.join(", ")})`);
  }
}
