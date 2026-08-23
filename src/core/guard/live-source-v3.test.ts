import { describe, expect, test } from "bun:test";
import {
  buildEventV3,
  eventIdV3,
  generationIdV3,
  type PositionedEventV3,
  type ReadLedgerV3Result,
} from "../events/v3/index.ts";
import { projectRunQualityLiveSourceV3, RunQualityLiveSourceV3Error } from "./live-source-v3.ts";

describe("V3 live run-quality source", () => {
  test("projects validated live generations through the shared evidence adapter", () => {
    const fixture = generationFixture("claude-code");
    const source = projectRunQualityLiveSourceV3(
      completeRead(fixture.events),
      "gex_fixture",
      "candidate",
      new Date("2026-08-16T20:00:00.000Z"),
    );

    expect(source).toMatchObject({
      contract_major: 3,
      genesis_id: "gex_fixture",
      epoch_state: "candidate",
    });
    expect(source.generations).toHaveLength(1);
    expect(source.generations[0]).toMatchObject({
      generation_id: fixture.generationId,
      adapter: "claude-code",
      sufficient_history: true,
      role_wait: { wait_kind: "approval", fresh: true, record_id: "wait_fixture" },
      evidence: { segment: "v3:1", truncated: false },
    });
    expect(source.generations[0]?.events.map(({ kind }) => kind)).toEqual([
      "progress",
      "tool_call",
      "tool_success",
    ]);
    expect(source.generations[0]?.corpus_categories).toEqual([]);
  });

  test("keeps pairing categories separate from behavioral evidence", () => {
    const fixture = generationFixture("codex");
    const incomplete = fixture.events.filter((event) => event.event_type !== "tool.completed");
    const source = projectRunQualityLiveSourceV3(
      completeRead(incomplete),
      "gex_fixture",
      "active",
      new Date("2026-08-16T20:00:00.000Z"),
    );

    expect(source.generations[0]?.corpus_categories).toEqual(["tool_pairing_incomplete"]);
    expect(source.generations[0]?.events.map(({ kind }) => kind)).toEqual([
      "progress",
      "tool_call",
    ]);
  });

  test("preserves unresolved adapter identity instead of coercing it", () => {
    const fixture = generationFixture(undefined);
    const source = projectRunQualityLiveSourceV3(
      completeRead(fixture.events),
      "gex_fixture",
      "active",
      new Date("2026-08-16T20:00:00.000Z"),
    );
    expect(source.generations[0]?.adapter).toBe("unknown");
  });

  test("excludes authoritative terminal generations", () => {
    const fixture = generationFixture("codex", true);
    const source = projectRunQualityLiveSourceV3(
      completeRead(fixture.events),
      "gex_fixture",
      "active",
      new Date("2026-08-16T20:00:00.000Z"),
    );
    expect(source.generations).toEqual([]);
  });

  test("fails closed on an incomplete validating read", () => {
    const read: ReadLedgerV3Result = {
      events: [],
      diagnostics: [{ code: "partial_final_frame", byte_offset: 4, segment_ordinal: 1 }],
      complete: false,
      bytes: 4,
      advances: [],
    };
    try {
      projectRunQualityLiveSourceV3(
        read,
        "gex_fixture",
        "candidate",
        new Date("2026-08-16T20:00:00.000Z"),
      );
      throw new Error("expected live source failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RunQualityLiveSourceV3Error);
      expect((error as RunQualityLiveSourceV3Error).code).toBe("ledger_integrity_failure");
    }
  });
});

function generationFixture(adapter: "claude-code" | "codex" | undefined, ended = false) {
  const generationId = generationIdV3();
  const attestationId = "att_fixture" as const;
  const startId = eventIdV3();
  const turnId = `hid_${"d".repeat(64)}` as const;
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
    links: { caused_by: [] },
    provenance: {
      source_event: "fixture",
      attestation: "native" as const,
      confidence: "exact" as const,
      attribution: { method: "native_payload" as const, state: "verified" as const },
    },
  });
  const adapterObservation = adapter
    ? {
        state: "observed" as const,
        value: { id: adapter },
        attestation: "native" as const,
        confidence: "exact" as const,
      }
    : { state: "unknown" as const, reason: "not_reported" };
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
  const turn = buildEventV3("turn.started", {
    ...common(2),
    scope: { ...scope, turn_id: turnId },
    links: { caused_by: [started.event_id] },
    payload: {
      input: { storage: "omitted", media_type: "text/plain", bytes: 20 },
      intent_kind: "build",
    },
  });
  const requested = buildEventV3("tool.requested", {
    ...common(3),
    scope: { ...scope, turn_id: turnId },
    links: { caused_by: [turn.event_id], span_id: "spn_fixture" },
    payload: {
      tool: { namespace: "claude", name: "Write" },
      input: { storage: "omitted", media_type: "application/json", bytes: 30 },
      exact_input: fingerprint("b"),
      targets: [],
    },
  });
  const completed = buildEventV3("tool.completed", {
    ...common(4),
    scope: { ...scope, turn_id: turnId },
    links: { caused_by: [requested.event_id], span_id: "spn_fixture" },
    payload: {
      tool: { namespace: "claude", name: "Write" },
      outcome: "succeeded",
      duration_ms: {
        state: "observed",
        value: 10,
        attestation: "native",
        confidence: "exact",
      },
      span: {
        span_id: "spn_fixture",
        opened_at: "2026-08-16T19:59:59.000Z",
        duration_ms: {
          state: "observed",
          value: 10,
          attestation: "native",
          confidence: "exact",
        },
        open_event_id: requested.event_id,
      },
      result: { storage: "omitted", media_type: "application/json", bytes: 4 },
    },
  });
  const wait = buildEventV3("wait.started", {
    ...common(5),
    scope: { ...scope, turn_id: turnId },
    links: { caused_by: [completed.event_id] },
    payload: { wait_id: "wait_fixture", kind: "approval", authority_reference: "approval_fixture" },
  });
  const events = [started, turn, requested, completed, wait];
  if (ended) {
    events.push(
      buildEventV3("session.ended", {
        ...common(6),
        links: { caused_by: [wait.event_id] },
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
      }) as never,
    );
  }
  return { generationId, events };
}

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

function completeRead(events: readonly { event_id: string }[]): ReadLedgerV3Result {
  return {
    events: events.map(
      (event, index): PositionedEventV3 => ({
        event: event as PositionedEventV3["event"],
        position: { segment_ordinal: 1, byte_offset: index * 100 },
      }),
    ),
    diagnostics: [],
    complete: true,
    bytes: events.length * 100,
    advances: [],
  };
}

function fingerprint(hexCharacter: string) {
  return {
    algorithm: "hmac-sha256" as const,
    canonicalizer: "harnery-jcs-nfc-v1" as const,
    key_epoch: "pep_fixture" as const,
    scope: "generation" as const,
    digest: `sha256:${hexCharacter.repeat(64)}` as `sha256:${string}`,
  };
}
