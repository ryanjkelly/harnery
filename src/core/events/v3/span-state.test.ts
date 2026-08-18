import { describe, expect, test } from "bun:test";
import { eventV3Fixture, fixtureObject } from "../../../../tests/helpers/event-v3.ts";
import {
  captureSpanClockV3,
  closeSpanStateV3,
  linuxUptimeNanosecondsV3,
  openSpanStateV3,
} from "./span-state.ts";
import { validateEventV3 } from "./validate.ts";

const spanId = "span_00000000-0000-7000-8000-000000000001" as const;
const parentSpanId = "span_00000000-0000-7000-8000-000000000002" as const;
const eventId = "evt_00000000-0000-7000-8000-000000000003" as const;
const bootId = "boot_fixture" as const;

describe("event ledger V3 span state", () => {
  test("captures Linux boot-relative monotonic time without float drift", () => {
    expect(linuxUptimeNanosecondsV3("123.456789012 42.00\n")).toBe("123456789012");
    expect(
      captureSpanClockV3({
        now: new Date("2026-08-18T14:00:00.000Z"),
        platform: "linux",
        linux_uptime: "123.45 42.00",
      }),
    ).toEqual({
      observed_at: "2026-08-18T14:00:00.000Z",
      monotonic_ns: "123450000000",
    });
    expect(
      captureSpanClockV3({
        now: new Date("2026-08-18T14:00:00.000Z"),
        platform: "win32",
      }),
    ).toEqual({ observed_at: "2026-08-18T14:00:00.000Z" });
  });

  test("uses same-boot monotonic time for an exact self-contained terminal", () => {
    const span = openSpanStateV3({
      span_id: spanId,
      parent_span_id: parentSpanId,
      open_event_id: eventId,
      boot_id: bootId,
      clock: { observed_at: "2026-08-18T14:00:00.000Z", monotonic_ns: "1000000000" },
    });
    const summary = closeSpanStateV3(span, {
      boot_id: bootId,
      clock: { observed_at: "2026-08-18T14:00:01.500Z", monotonic_ns: "2250000000" },
    });
    expect(summary).toEqual({
      span_id: spanId,
      parent_span_id: parentSpanId,
      opened_at: "2026-08-18T14:00:00.000Z",
      duration_ms: {
        state: "observed",
        value: 1250,
        attestation: "native",
        confidence: "exact",
      },
      open_event_id: eventId,
    });
    const terminal = eventV3Fixture("tool.completed", 1);
    const payload = fixtureObject(terminal.payload);
    payload.span = summary;
    payload.duration_ms = structuredClone(summary.duration_ms);
    const links = fixtureObject(terminal.links);
    links.span_id = spanId;
    links.parent_span_id = parentSpanId;
    links.caused_by = [eventId];
    fixtureObject(terminal.time).observed_at = "2026-08-18T14:00:01.500Z";
    expect(validateEventV3(terminal)).toMatchObject({ ok: true, issues: [] });
  });

  test("derives a high-confidence wall delta across boots or unsupported clocks", () => {
    const span = openSpanStateV3({
      span_id: spanId,
      boot_id: bootId,
      clock: { observed_at: "2026-08-18T14:00:00.000Z" },
    });
    expect(
      closeSpanStateV3(span, {
        boot_id: "boot_restarted",
        clock: { observed_at: "2026-08-18T14:00:01.250Z", monotonic_ns: "100" },
      }).duration_ms,
    ).toEqual({ state: "observed", value: 1250, attestation: "derived", confidence: "high" });
  });

  test("reports clock regressions and recovery without inventing zero duration", () => {
    const span = openSpanStateV3({
      span_id: spanId,
      boot_id: bootId,
      clock: { observed_at: "2026-08-18T14:00:01.000Z", monotonic_ns: "200" },
    });
    expect(
      closeSpanStateV3(span, {
        boot_id: bootId,
        clock: { observed_at: "2026-08-18T14:00:00.000Z", monotonic_ns: "300" },
      }).duration_ms,
    ).toEqual({
      state: "expected_but_missing",
      capability: "span_duration",
      reason: "clock_regressed",
    });
    expect(
      closeSpanStateV3(span, {
        boot_id: bootId,
        clock: { observed_at: "2026-08-18T14:00:02.000Z", monotonic_ns: "100" },
      }).duration_ms,
    ).toEqual({
      state: "expected_but_missing",
      capability: "span_duration",
      reason: "monotonic_clock_regressed",
    });
    expect(
      closeSpanStateV3(span, {
        boot_id: bootId,
        clock: { observed_at: "2026-08-18T14:00:02.000Z", monotonic_ns: "300" },
        recovery_reason: "completion_not_observed_before_turn_end",
      }).duration_ms,
    ).toEqual({ state: "unknown", reason: "completion_not_observed_before_turn_end" });
  });
});
