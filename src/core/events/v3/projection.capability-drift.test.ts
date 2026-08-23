import { describe, expect, test } from "bun:test";
import {
  buildEventV3,
  eventIdV3,
  generationIdV3,
  type PositionedEventV3,
  type ReadLedgerV3Result,
} from "./index.ts";
import { reduceSafetyProjectionV3 } from "./projection.ts";

describe("capability drift after terminal", () => {
  test("does not fail-close the ledger when drift is recorded after session.ended", () => {
    const generationId = generationIdV3();
    const attestationId = "att_fixture" as const;
    const startId = eventIdV3();
    const scope = {
      root_id: "root_fixture" as const,
      instance_id: "inst_fixture" as const,
      session_id: "sid_fixture" as const,
      generation_id: generationId,
    };
    const common = (sequence: number) => ({
      producer: {
        producer_id: "prd_fixture",
        boot_id: "boot_fixture",
        sequence,
        component: "agent-hook" as const,
        build_id: "build_fixture",
        platform: "linux" as const,
      },
      scope,
      attestation_id: attestationId,
      links: { caused_by: [] as string[] },
      provenance: {
        source_event: "fixture",
        attestation: "native" as const,
        confidence: "exact" as const,
        attribution: { method: "native_payload" as const, state: "verified" as const },
      },
    });
    const adapterObservation = {
      state: "observed" as const,
      value: { id: "claude-code" },
      attestation: "native" as const,
      confidence: "exact" as const,
    };
    const started = buildEventV3("session.started", {
      ...common(1),
      event_id: startId,
      payload: {
        runtime_attestation: {
          attestation_id: attestationId,
          generation_id: generationId,
          adapter: adapterObservation,
          harness: adapterObservation,
          model: { state: "unknown", reason: "not_reported" },
          tuning: { state: "unknown" as const, reason: "not_reported" },
          telemetry: unknownTelemetry(),
          capability_profile: `cap_${"a".repeat(64)}` as const,
          declared_by_event_id: startId,
        },
        resume: { state: "not_applicable" },
      },
    });
    const ended = buildEventV3("session.ended", {
      ...common(2),
      links: { caused_by: [started.event_id] },
      payload: {
        outcome: "succeeded",
        authority: "native",
        reason: "native_clean_exit",
        span: {
          span_id: "span_session_fixture",
          opened_at: "2026-08-16T19:59:58.000Z",
          duration_ms: {
            state: "observed",
            value: 2_000,
            attestation: "derived",
            confidence: "high",
          },
          open_event_id: started.event_id,
        },
        completeness: { state: "not_applicable" },
      },
    });
    const drift = buildEventV3("health.capability_drift", {
      ...common(3),
      links: { caused_by: [ended.event_id] },
      payload: {
        signal: "context_usage",
        promised: "native",
        expected_count: 1,
        observed_count: 0,
        generation_ended: true,
      },
    });
    const events: PositionedEventV3[] = [started, ended, drift].map((event, index) => ({
      event,
      position: { segment_ordinal: 1, byte_offset: index * 100 },
    }));
    const read: ReadLedgerV3Result = {
      events,
      diagnostics: [],
      complete: true,
      advances: [],
      bytes: 300,
    };
    const projection = reduceSafetyProjectionV3(read);
    expect(projection.authority_safe).toBe(true);
    expect(projection.diagnostics.map((item) => item.code)).not.toContain("event_after_terminal");
    expect(projection.health["capability:context_usage"]?.event_id).toBe(drift.event_id);
  });
});

function unknownTelemetry() {
  const missing = { state: "unknown" as const, reason: "not_reported" };
  return {
    context_usage: missing,
    wait_spans: missing,
    wait_completeness: missing,
    response_latency: missing,
    inference_timing: missing,
  };
}
