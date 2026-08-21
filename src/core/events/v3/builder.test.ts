import { describe, expect, test } from "bun:test";
import { eventV3Fixture, fixtureObject } from "../../../../tests/helpers/event-v3.ts";
import { buildEventV3 } from "./builder.ts";
import type { EventOfTypeV3 } from "./contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { validateEventV3 } from "./validate.ts";

describe("event ledger V3 builder", () => {
  test("builds a validated terminal with the V3 identity and supplied clock", () => {
    const fixture = eventV3Fixture(
      "tool.completed",
      1,
    ) as unknown as EventOfTypeV3<"tool.completed">;
    const event = buildEventV3("tool.completed", {
      producer: fixture.producer,
      scope: fixture.scope,
      attestation_id: fixture.attestation_id as `att_${string}`,
      links: fixture.links,
      provenance: fixture.provenance,
      payload: fixture.payload,
      event_id: fixture.event_id as `evt_${string}`,
      observed_at: "2026-08-18T14:00:01.000Z",
      recorded_at: "2026-08-18T14:00:01.001Z",
      monotonic_ns: "123456789",
      clock_id: fixtureObject(fixture.time).clock_id as `clk_${string}`,
      skew: "normal",
    });
    fixtureObject(fixtureObject(event.payload).span).opened_at = "2026-08-18T14:00:00.000Z";

    expect(event.contract).toEqual({
      name: "harnery.event",
      major: 3,
      schema_digest: EVENT_V3_SCHEMA_DIGEST,
    });
    expect(event.time).toMatchObject({
      observed_at: "2026-08-18T14:00:01.000Z",
      recorded_at: "2026-08-18T14:00:01.001Z",
      monotonic_ns: "123456789",
      skew: "normal",
    });
    expect(validateEventV3(event)).toMatchObject({ ok: true, issues: [] });
  });
});
