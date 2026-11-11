import { describe, expect, test } from "bun:test";
import {
  eventV3Fixture as fixture,
  fixtureObject as object,
} from "../../../../tests/helpers/event-v3.ts";
import { canonicalJsonV3 } from "./canonical.ts";
import type { EventV3 } from "./contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import type { EventV3AppendValidationCheckpointV3 } from "./reader.ts";
import {
  applyRowV3,
  checkRowV3,
  createRowValidationStateV3,
  type RowV3,
  type RowValidationStateV3,
  rowIdentityV3,
  rowValidationStateFromCheckpointV3,
} from "./row-validation.ts";

const SESSION_ATTESTATION = "att_00000000-0000-7000-8000-000000000001";

function row(event: Record<string, unknown>): RowV3 {
  return { raw: canonicalJsonV3(event), event: event as unknown as EventV3 };
}

function at(event: Record<string, unknown>, observedAt: string, monotonicNs?: string) {
  const time = object(event.time);
  time.observed_at = observedAt;
  if (monotonicNs !== undefined) time.monotonic_ns = monotonicNs;
  return event;
}

function freshState(): RowValidationStateV3 {
  return {
    ...createRowValidationStateV3([EVENT_V3_SCHEMA_DIGEST]),
    active_schema_digest: EVENT_V3_SCHEMA_DIGEST,
  };
}

/** Admit rows in order, failing the test when any row would raise a diagnostic. */
function admit(state: RowValidationStateV3, rows: readonly RowV3[]): void {
  for (const candidate of rows) {
    expect(checkRowV3(state, candidate)).toEqual([]);
    applyRowV3(state, candidate);
  }
}

function snapshot(state: RowValidationStateV3): string {
  return JSON.stringify({
    accepted: [...state.accepted],
    seen_ids: [...state.seen_ids],
    producer_sequences: [...state.producer_sequences],
    attestations: [...state.attestations],
    clocks: [...state.clocks].map(([id, clock]) => [
      id,
      clock.observed_at_ms,
      clock.monotonic_ns?.toString(),
    ]),
    active_schema_digest: state.active_schema_digest,
  });
}

/** Genesis, then a session start that resolves the fixture attestation. */
function openedSession(): { state: RowValidationStateV3; rows: RowV3[] } {
  const state = freshState();
  const rows = [
    row(at(fixture("ledger.genesis", 1), "2026-08-18T14:00:00.000Z", "10")),
    row(at(fixture("session.started", 2), "2026-08-18T14:00:01.000Z", "20")),
  ];
  admit(state, rows);
  return { state, rows };
}

describe("shared event ledger V3 row check", () => {
  test("reports nothing for a valid sequence checked and applied in order", () => {
    const { state } = openedSession();
    const task = at(fixture("coord.task_changed", 3), "2026-08-18T14:00:02.000Z", "30");
    object(task.links).caused_by = [
      "evt_00000000-0000-7000-8000-000000000001",
      "evt_00000000-0000-7000-8000-000000000002",
    ];
    const claim = at(fixture("coord.claim_changed", 4), "2026-08-18T14:00:03.000Z", "40");
    admit(state, [row(task), row(claim)]);
    expect(state.producer_sequences.get("prd_fixture\0boot_fixture")).toBe(4);
    expect(state.seen_ids.size).toBe(4);
  });

  test("checking a row never changes the state", () => {
    const { state } = openedSession();
    const before = snapshot(state);
    const bad = at(fixture("coord.task_changed", 9), "2026-08-18T13:00:00.000Z", "1");
    object(bad.links).caused_by = ["evt_00000000-0000-7000-8000-000000000999"];
    bad.attestation_id = "att_00000000-0000-7000-8000-000000000999";
    expect(checkRowV3(state, row(bad)).length).toBeGreaterThan(0);
    const good = at(fixture("coord.task_changed", 3), "2026-08-18T14:00:02.000Z", "30");
    expect(checkRowV3(state, row(good))).toEqual([]);
    expect(snapshot(state)).toBe(before);
  });

  test("reports a producer sequence gap", () => {
    const { state } = openedSession();
    const skipped = at(fixture("coord.task_changed", 4), "2026-08-18T14:00:02.000Z", "30");
    expect(checkRowV3(state, row(skipped))).toEqual(["producer_sequence_gap"]);
  });

  test("reports an unmarked wall-clock regression and a monotonic regression", () => {
    const { state } = openedSession();
    const wall = at(fixture("coord.task_changed", 3), "2026-08-18T13:59:00.000Z", "30");
    expect(checkRowV3(state, row(wall))).toEqual(["wall_clock_regression_unmarked"]);

    const marked = structuredClone(wall);
    object(marked.time).skew = "regressed";
    expect(checkRowV3(state, row(marked))).toEqual([]);

    const monotonic = at(fixture("coord.task_changed", 3), "2026-08-18T14:00:02.000Z", "5");
    expect(checkRowV3(state, row(monotonic))).toEqual(["monotonic_clock_regression"]);
  });

  test("reports a missing causal parent, but not a row naming itself", () => {
    const { state } = openedSession();
    const orphan = at(fixture("coord.task_changed", 3), "2026-08-18T14:00:02.000Z", "30");
    object(orphan.links).caused_by = ["evt_00000000-0000-7000-8000-000000000999"];
    expect(checkRowV3(state, row(orphan))).toEqual(["causal_parent_missing"]);

    const selfCited = at(fixture("coord.task_changed", 3), "2026-08-18T14:00:02.000Z", "30");
    object(selfCited.links).caused_by = [selfCited.event_id as string];
    expect(checkRowV3(state, row(selfCited))).toEqual([]);
  });

  test("reports an unresolved attestation", () => {
    const state = freshState();
    admit(state, [row(at(fixture("ledger.genesis", 1), "2026-08-18T14:00:00.000Z", "10"))]);
    const unattested = at(fixture("coord.task_changed", 2), "2026-08-18T14:00:01.000Z", "20");
    expect(checkRowV3(state, row(unattested))).toEqual(["unresolved_attestation"]);

    const changed = at(fixture("session.attestation_changed", 2), "2026-08-18T14:00:01.000Z", "20");
    object(changed.payload).prior_attestation_id = "att_00000000-0000-7000-8000-000000000999";
    expect(checkRowV3(state, row(changed))).toEqual(["unresolved_attestation"]);
  });

  test("reports schema digests outside the accepted set or unlike the active digest", () => {
    const { state } = openedSession();
    const foreign = at(fixture("coord.task_changed", 3), "2026-08-18T14:00:02.000Z", "30");
    object(foreign.contract).schema_digest = `sha256:${"b".repeat(64)}`;
    expect(checkRowV3(state, row(foreign))).toEqual([
      "unsupported_schema_digest",
      "unexpected_schema_digest",
    ]);
  });

  test("passes a replayed committed row and changes nothing when it is applied", () => {
    const { state, rows } = openedSession();
    const before = snapshot(state);
    expect(rowIdentityV3(state, rows[1]!)).toBe("committed");
    expect(checkRowV3(state, rows[1]!)).toEqual([]);
    applyRowV3(state, rows[1]!);
    expect(snapshot(state)).toBe(before);

    const conflicting = structuredClone(rows[1]!.event) as unknown as Record<string, unknown>;
    object(conflicting.time).observed_at = "2026-08-18T15:00:00.000Z";
    expect(rowIdentityV3(state, row(conflicting))).toBe("conflicting");
    expect(checkRowV3(state, row(conflicting))).toEqual(["conflicting_event_id"]);
    applyRowV3(state, row(conflicting));
    expect(snapshot(state)).toBe(before);
  });

  test("applies a reported row's clock, attestation and sequence, as the reader does", () => {
    const { state } = openedSession();
    const late = at(fixture("coord.task_changed", 7), "2026-08-18T13:00:00.000Z", "1");
    expect(checkRowV3(state, row(late))).toEqual([
      "wall_clock_regression_unmarked",
      "monotonic_clock_regression",
      "producer_sequence_gap",
    ]);
    applyRowV3(state, row(late));
    expect(state.producer_sequences.get("prd_fixture\0boot_fixture")).toBe(7);
    expect(state.clocks.get(object(late.time).clock_id as string)?.monotonic_ns).toBe(1n);
    expect(state.seen_ids.has(late.event_id as string)).toBe(true);
    expect(state.attestations.has(SESSION_ATTESTATION)).toBe(true);
  });

  test("rebuilds the row state an append validation checkpoint records", () => {
    const checkpoint: EventV3AppendValidationCheckpointV3 = {
      format: "harnery-event-v3-append-validation-checkpoint",
      format_version: 1,
      reader_build: "build_fixture",
      accepted_schema_digests: [EVENT_V3_SCHEMA_DIGEST],
      seen_event_ids: [
        "evt_00000000-0000-7000-8000-000000000001",
        "evt_00000000-0000-7000-8000-000000000002",
      ],
      producer_sequences: [["prd_fixture\0boot_fixture", 2]],
      attestation_ids: [SESSION_ATTESTATION],
      clocks: [
        ["clk_00000000-0000-7000-8000-000000000001", Date.parse("2026-08-18T14:00:01Z"), "20"],
      ],
      event_count: 2,
      genesis_id: "gex_00000000-0000-7000-8000-000000000001",
      active_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      active_segment_ordinal: 1,
      validated_active_bytes: 2000,
    };
    const state = rowValidationStateFromCheckpointV3(checkpoint);
    expect(state.active_schema_digest).toBe(EVENT_V3_SCHEMA_DIGEST);
    expect(state.clocks.get("clk_00000000-0000-7000-8000-000000000001")?.monotonic_ns).toBe(20n);

    const next = at(fixture("coord.task_changed", 3), "2026-08-18T14:00:02.000Z", "30");
    object(next.links).caused_by = ["evt_00000000-0000-7000-8000-000000000002"];
    admit(state, [row(next)]);
    expect(checkRowV3(state, row(fixture("coord.task_changed", 3)))).toEqual([
      "conflicting_event_id",
    ]);
  });
});
