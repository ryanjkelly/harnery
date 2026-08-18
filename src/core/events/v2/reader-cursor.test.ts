import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEventV2 } from "./builder.ts";
import { recoverEventV2Catalog, rotateEventLedgerV2 } from "./catalog.ts";
import type { EventV2 } from "./contract.ts";
import { attestationIdV2, eventIdV2, generationIdV2 } from "./ids.ts";
import { readActiveLedgerV2, readLedgerV2Since } from "./reader.ts";
import { writeEventV2 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 rotation-aware cursor", () => {
  test("resumes from the same event after the active tail becomes a sealed segment", () => {
    const root = temporaryRoot();
    const fixture = fixtureEvents();
    writeEventV2(root, fixture.genesis);
    writeEventV2(root, fixture.started);
    recoverEventV2Catalog(root);

    const first = readLedgerV2Since(root);
    expect(first.complete).toBe(true);
    expect(first.reset_required).toBe(false);
    expect(first.events.map(({ event }) => event.event_type)).toEqual([
      "ledger.genesis",
      "session.started",
    ]);
    expect(first.cursor?.segment_ordinal).toBe(1);

    rotateEventLedgerV2(root);
    writeEventV2(root, fixture.ended);

    const resumed = readLedgerV2Since(root, first.cursor);
    expect(resumed.complete).toBe(true);
    expect(resumed.reset_required).toBe(false);
    expect(resumed.events.map(({ event }) => event.event_type)).toEqual(["session.ended"]);
    expect(resumed.cursor).toMatchObject({
      genesis_id: fixture.genesis.payload.genesis_id,
      segment_ordinal: 2,
      event_id: fixture.ended.event_id,
    });
  });

  test("requires a reset for a foreign genesis or an unverifiable physical position", () => {
    const root = temporaryRoot();
    const fixture = fixtureEvents();
    writeEventV2(root, fixture.genesis);
    recoverEventV2Catalog(root);
    const first = readLedgerV2Since(root);
    const cursor = first.cursor!;

    const foreign = readLedgerV2Since(root, { ...cursor, genesis_id: "gex_foreign" });
    expect(foreign.reset_required).toBe(true);
    expect(foreign.events).toEqual([]);
    expect(foreign.diagnostics.at(-1)?.code).toBe("cursor_genesis_mismatch");

    const missing = readLedgerV2Since(root, { ...cursor, byte_offset: cursor.byte_offset + 1 });
    expect(missing.reset_required).toBe(true);
    expect(missing.events).toEqual([]);
    expect(missing.diagnostics.at(-1)?.code).toBe("cursor_position_missing");
  });
});

describe("event ledger V2 ordering diagnostics", () => {
  test("reports missing causal parents and unmarked wall/monotonic regressions", () => {
    const root = temporaryRoot();
    const fixture = fixtureEvents();
    const clockId =
      `clk_${"1".repeat(8)}-${"1".repeat(4)}-7${"1".repeat(3)}-8${"1".repeat(3)}-${"1".repeat(12)}` as const;
    const started = {
      ...fixture.started,
      links: { caused_by: [] },
      time: {
        ...fixture.started.time,
        observed_at: "2026-08-16T15:00:00.000Z",
        recorded_at: "2026-08-16T15:00:00.000Z",
        monotonic_ns: "100",
        clock_id: clockId,
        skew: "normal" as const,
      },
    } as EventV2;
    const ended = {
      ...fixture.ended,
      time: {
        ...fixture.ended.time,
        observed_at: "2026-08-16T14:59:59.000Z",
        recorded_at: "2026-08-16T15:00:01.000Z",
        monotonic_ns: "99",
        clock_id: clockId,
        skew: "normal" as const,
      },
      links: {
        caused_by: [
          `evt_${"f".repeat(8)}-${"f".repeat(4)}-7${"f".repeat(3)}-8${"f".repeat(3)}-${"f".repeat(12)}`,
        ],
      },
    } as EventV2;
    writeEventV2(root, started);
    writeEventV2(root, ended);

    const read = readActiveLedgerV2(root);
    expect(read.complete).toBe(false);
    expect(read.diagnostics.map(({ code }) => code)).toEqual([
      "causal_parent_missing",
      "wall_clock_regression_unmarked",
      "monotonic_clock_regression",
    ]);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "event-v2-cursor-"));
  roots.push(root);
  return root;
}

function fixtureEvents(): {
  genesis: Extract<EventV2, { event_type: "ledger.genesis" }>;
  started: Extract<EventV2, { event_type: "session.started" }>;
  ended: Extract<EventV2, { event_type: "session.ended" }>;
} {
  const generationId = generationIdV2();
  const attestationId = attestationIdV2();
  const startedId = eventIdV2();
  const rootScope = { root_id: "root_fixture", instance_id: "inst_control" };
  const scope = {
    root_id: "root_fixture",
    instance_id: "inst_fixture",
    session_id: `sid_${"b".repeat(64)}` as const,
    generation_id: generationId,
  };
  const provenance = {
    source_event: "fixture",
    attestation: "native" as const,
    confidence: "exact" as const,
    attribution: { method: "native_payload" as const, state: "verified" as const },
  };
  const genesis = buildEventV2("ledger.genesis", {
    producer: {
      producer_id: "prd_control",
      boot_id: "boot_fixture",
      sequence: 1,
      component: "recovery",
      build_id: "build_fixture",
      platform: "linux",
    },
    scope: rootScope,
    links: { caused_by: [] },
    provenance,
    payload: {
      genesis_id: "gex_11111111-1111-7111-8111-111111111111",
      genesis_profile_digest: `sha256:${"1".repeat(64)}`,
      contract_digest: `sha256:${"2".repeat(64)}`,
      generated_schema_digest: `sha256:${"3".repeat(64)}`,
      canonicalizer: "harnery-jcs-nfc-v1",
      privacy_epoch_id: "pep_fixture",
      candidate_created_at: "2026-08-16T15:00:00.000Z",
    },
  });
  const started = buildEventV2("session.started", {
    event_id: startedId,
    producer: {
      producer_id: "prd_fixture",
      boot_id: "boot_fixture",
      sequence: 1,
      component: "agent-hook",
      build_id: "build_fixture",
      platform: "linux",
    },
    scope,
    attestation_id: attestationId,
    links: { caused_by: [genesis.event_id] },
    provenance,
    payload: {
      runtime_attestation: {
        attestation_id: attestationId,
        generation_id: generationId,
        adapter: { state: "unsupported", capability: "adapter_identity" },
        harness: { state: "unsupported", capability: "harness_identity" },
        model: { state: "unsupported", capability: "model_identity" },
        capability_profile: `cap_${"c".repeat(64)}`,
        declared_by_event_id: startedId,
      },
      resume: { state: "not_applicable" },
    },
  });
  const ended = buildEventV2("session.ended", {
    producer: {
      producer_id: "prd_fixture",
      boot_id: "boot_fixture",
      sequence: 2,
      component: "agent-hook",
      build_id: "build_fixture",
      platform: "linux",
    },
    scope,
    attestation_id: attestationId,
    links: { caused_by: [started.event_id] },
    provenance,
    payload: {
      outcome: "succeeded",
      authority: "native",
      reason: "native_clean_exit",
      completeness: { state: "not_applicable" },
    },
  });
  return { genesis, started, ended };
}
