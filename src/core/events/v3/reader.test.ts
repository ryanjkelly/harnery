import { describe, expect, test } from "bun:test";
import {
  eventV3Fixture as fixture,
  eventV3Frame as frame,
  fixtureObject as object,
} from "../../../../tests/helpers/event-v3.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { readLedgerFramesV3, readLedgerFramesV3Since } from "./reader.ts";

const nextDigest = `sha256:${"b".repeat(64)}`;

describe("event ledger V3 canonical stream reader", () => {
  test("honors an additive schema advance at its exact physical boundary", () => {
    const genesis = fixture("ledger.genesis", 1);
    const advance = fixture("ledger.schema_advanced", 2);
    const postAdvance = fixture("ledger.comparability_advanced", 3);
    const advancePayload = object(advance.payload);
    advancePayload.prior_schema_digest = EVENT_V3_SCHEMA_DIGEST;
    advancePayload.next_schema_digest = nextDigest;
    advancePayload.compatible_reader_builds = ["build_fixture"];
    advancePayload.effective_segment_ordinal = 2;
    advancePayload.effective_byte_offset = 0;
    object(postAdvance.contract).schema_digest = nextDigest;

    const result = readLedgerFramesV3(
      [frame(genesis, 1, 0), frame(advance, 1, 1000), frame(postAdvance, 2, 0)],
      {
        reader_build: "build_fixture",
        accepted_schema_digests: [EVENT_V3_SCHEMA_DIGEST, nextDigest],
      },
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.active_schema_digest).toBe(nextDigest);
    expect(result.advances).toEqual([
      expect.objectContaining({
        prior_schema_digest: EVENT_V3_SCHEMA_DIGEST,
        next_schema_digest: nextDigest,
        effective_position: { segment_ordinal: 2, byte_offset: 0 },
      }),
    ]);
  });

  test("fails closed for unsupported, incompatible, or skipped advances", () => {
    const genesis = fixture("ledger.genesis", 1);
    const advance = fixture("ledger.schema_advanced", 2);
    const postAdvance = fixture("ledger.comparability_advanced", 3);
    const payload = object(advance.payload);
    payload.prior_schema_digest = EVENT_V3_SCHEMA_DIGEST;
    payload.next_schema_digest = nextDigest;
    payload.compatible_reader_builds = ["build_other"];
    payload.effective_segment_ordinal = 1;
    payload.effective_byte_offset = 2000;
    object(postAdvance.contract).schema_digest = nextDigest;

    const result = readLedgerFramesV3(
      [frame(genesis, 1, 0), frame(advance, 1, 1000), frame(postAdvance, 1, 3000)],
      { reader_build: "build_fixture" },
    );

    expect(result.complete).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "advance_digest_unsupported",
        "advance_reader_incompatible",
        "advance_boundary_missed",
        "unsupported_schema_digest",
        "unexpected_schema_digest",
      ]),
    );
  });

  test("requires matching activation authority when reading as active", () => {
    const genesis = fixture("ledger.genesis", 1);
    const missing = readLedgerFramesV3([frame(genesis, 1, 0)], { authority: "active" });
    expect(missing.diagnostics.map(({ code }) => code)).toContain("missing_activation");

    const activation = fixture("ledger.activated", 2);
    object(activation.payload).genesis_id = object(genesis.payload).genesis_id;
    const active = readLedgerFramesV3([frame(genesis, 1, 0), frame(activation, 1, 1000)], {
      authority: "active",
    });
    expect(active.diagnostics).toEqual([]);

    const foreign = structuredClone(activation);
    object(foreign.payload).genesis_id = "gex_00000000-0000-7000-8000-000000000999";
    expect(
      readLedgerFramesV3([frame(genesis, 1, 0), frame(foreign, 1, 1000)], {
        authority: "active",
      }).diagnostics.map(({ code }) => code),
    ).toContain("activation_genesis_mismatch");
  });

  test("resumes only from an exact cursor in the same genesis", () => {
    const genesis = fixture("ledger.genesis", 1);
    const second = fixture("ledger.comparability_advanced", 2);
    const frames = [frame(genesis, 1, 0), frame(second, 1, 1000)];
    const first = readLedgerFramesV3Since(frames);
    expect(first.complete).toBe(true);
    expect(first.cursor?.event_id).toBe(second.event_id as string);

    const third = fixture("ledger.comparability_advanced", 3);
    const resumed = readLedgerFramesV3Since([...frames, frame(third, 2, 0)], first.cursor);
    expect(resumed.events.map(({ event }) => object(event).event_type)).toEqual([
      "ledger.comparability_advanced",
    ]);

    const foreign = readLedgerFramesV3Since(frames, {
      ...first.cursor!,
      genesis_id: "gex_foreign",
    });
    expect(foreign.reset_required).toBe(true);
    expect(foreign.diagnostics.at(-1)?.code).toBe("cursor_genesis_mismatch");

    const missing = readLedgerFramesV3Since(frames, {
      ...first.cursor!,
      byte_offset: 1001,
    });
    expect(missing.reset_required).toBe(true);
    expect(missing.diagnostics.at(-1)?.code).toBe("cursor_position_missing");
  });

  test("rejects noncanonical frames and digest changes without an advance", () => {
    const genesis = fixture("ledger.genesis", 1);
    const changed = fixture("ledger.comparability_advanced", 2);
    object(changed.contract).schema_digest = nextDigest;
    const digestResult = readLedgerFramesV3([frame(genesis, 1, 0), frame(changed, 1, 1000)], {
      accepted_schema_digests: [EVENT_V3_SCHEMA_DIGEST, nextDigest],
    });
    expect(digestResult.diagnostics.map(({ code }) => code)).toContain("unexpected_schema_digest");

    const pretty = frame(genesis, 1, 0);
    pretty.raw = JSON.stringify(genesis, null, 2);
    expect(readLedgerFramesV3([pretty]).diagnostics.map(({ code }) => code)).toContain(
      "noncanonical_frame",
    );
  });

  test("preserves causal, clock, and producer-order diagnostics", () => {
    const genesis = fixture("ledger.genesis", 1);
    const second = fixture("ledger.comparability_advanced", 3);
    object(second.links).caused_by = ["evt_00000000-0000-7000-8000-000000000999"];
    const genesisTime = object(genesis.time);
    genesisTime.observed_at = "2026-08-18T14:00:01.000Z";
    genesisTime.monotonic_ns = "2";
    const secondTime = object(second.time);
    secondTime.observed_at = "2026-08-18T14:00:00.000Z";
    secondTime.monotonic_ns = "1";

    expect(
      readLedgerFramesV3([frame(genesis, 1, 0), frame(second, 1, 1000)]).diagnostics.map(
        ({ code }) => code,
      ),
    ).toEqual([
      "causal_parent_missing",
      "wall_clock_regression_unmarked",
      "monotonic_clock_regression",
      "producer_sequence_gap",
    ]);
  });
});
