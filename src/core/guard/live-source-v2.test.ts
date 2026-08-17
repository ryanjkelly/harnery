import { describe, expect, test } from "bun:test";
import {
  buildEventV2,
  eventIdV2,
  generationIdV2,
  type PositionedEventV2,
  type ReadLedgerV2Result,
} from "../events/v2/index.ts";
import { projectRunQualityLiveSourceV2, RunQualityLiveSourceV2Error } from "./live-source-v2.ts";

describe("V2 live run-quality source", () => {
  test("projects validated live generations through the shared evidence adapter", () => {
    const fixture = generationFixture("claude-code");
    const source = projectRunQualityLiveSourceV2(
      completeRead(fixture.events),
      "gex_fixture",
      "candidate",
      new Date("2026-08-16T20:00:00.000Z"),
    );

    expect(source).toMatchObject({
      contract_major: 2,
      genesis_id: "gex_fixture",
      epoch_state: "candidate",
    });
    expect(source.generations).toHaveLength(1);
    expect(source.generations[0]).toMatchObject({
      generation_id: fixture.generationId,
      adapter: "claude-code",
      sufficient_history: true,
      role_wait: { wait_kind: "approval", fresh: true, record_id: "wait_fixture" },
      evidence: { segment: "v2:1", truncated: false },
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
    const source = projectRunQualityLiveSourceV2(
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
    const source = projectRunQualityLiveSourceV2(
      completeRead(fixture.events),
      "gex_fixture",
      "active",
      new Date("2026-08-16T20:00:00.000Z"),
    );
    expect(source.generations[0]?.adapter).toBe("unknown");
  });

  test("excludes authoritative terminal generations", () => {
    const fixture = generationFixture("codex", true);
    const source = projectRunQualityLiveSourceV2(
      completeRead(fixture.events),
      "gex_fixture",
      "active",
      new Date("2026-08-16T20:00:00.000Z"),
    );
    expect(source.generations).toEqual([]);
  });

  test("fails closed on an incomplete validating read", () => {
    const read: ReadLedgerV2Result = {
      events: [],
      diagnostics: [{ code: "partial_final_frame", byte_offset: 4, segment_ordinal: 1 }],
      complete: false,
      bytes: 4,
    };
    try {
      projectRunQualityLiveSourceV2(
        read,
        "gex_fixture",
        "candidate",
        new Date("2026-08-16T20:00:00.000Z"),
      );
      throw new Error("expected live source failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RunQualityLiveSourceV2Error);
      expect((error as RunQualityLiveSourceV2Error).code).toBe("ledger_integrity_failure");
    }
  });
});

function generationFixture(adapter: "claude-code" | "codex" | undefined, ended = false) {
  const generationId = generationIdV2();
  const attestationId = "att_fixture" as const;
  const startId = eventIdV2();
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
  const started = buildEventV2("session.started", {
    ...common(1),
    event_id: startId,
    payload: {
      runtime_attestation: {
        attestation_id: attestationId,
        generation_id: generationId,
        adapter: adapterObservation,
        harness: adapterObservation,
        model: { state: "unknown", reason: "not_reported" },
        capability_profile: `cap_${"a".repeat(64)}` as const,
        declared_by_event_id: startId,
      },
      resume: { state: "not_applicable" },
    },
  });
  const turn = buildEventV2("turn.started", {
    ...common(2),
    scope: { ...scope, turn_id: turnId },
    links: { caused_by: [started.event_id] },
    payload: {
      input: { storage: "omitted", media_type: "text/plain", bytes: 20 },
      intent_kind: "build",
    },
  });
  const requested = buildEventV2("tool.requested", {
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
  const completed = buildEventV2("tool.completed", {
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
      result: { storage: "omitted", media_type: "application/json", bytes: 4 },
    },
  });
  const wait = buildEventV2("interaction.wait_started", {
    ...common(5),
    links: { caused_by: [completed.event_id] },
    payload: { wait_id: "wait_fixture", kind: "approval", authority_reference: "approval_fixture" },
  });
  const events = [started, turn, requested, completed, wait];
  if (ended) {
    events.push(
      buildEventV2("session.ended", {
        ...common(6),
        links: { caused_by: [wait.event_id] },
        payload: {
          outcome: "succeeded",
          authority: "native",
          reason: "native_clean_exit",
          completeness: { state: "not_applicable" },
        },
      }) as never,
    );
  }
  return { generationId, events };
}

function completeRead(events: readonly { event_id: string }[]): ReadLedgerV2Result {
  return {
    events: events.map(
      (event, index): PositionedEventV2 => ({
        event: event as PositionedEventV2["event"],
        position: { segment_ordinal: 1, byte_offset: index * 100 },
      }),
    ),
    diagnostics: [],
    complete: true,
    bytes: events.length * 100,
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
