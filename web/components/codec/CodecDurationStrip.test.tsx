import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { CodecPanelScene } from "@/lib/codec/contracts";

import { CodecDurationStrip, formatCodecDuration, liveDurationValues } from "./CodecDurationStrip";

const TIMING: NonNullable<CodecPanelScene["timing"]> = {
  value: {
    session_duration_ms: 300_000,
    last_turn_duration_ms: 180_000,
    working_duration_ms: 180_000,
    idle_duration_ms: 120_000,
    boundary_source: "event",
    session_active: true,
    last_turn_active: true,
    current_bucket: "working",
  },
  provenance: "event",
  confidence: "high",
  observed_at: "2026-09-04T10:05:00.000Z",
};

const PARTIAL_TIMING: NonNullable<CodecPanelScene["timing"]> = {
  ...TIMING,
  value: {
    ...TIMING.value,
    boundary_source: "heartbeat",
    observed_from: "2026-09-04T10:02:00.000Z",
  },
};

test("live duration values advance only the open clocks and current activity bucket", () => {
  expect(liveDurationValues(TIMING, Date.parse("2026-09-04T10:05:10.000Z"))).toEqual({
    session: 310_000,
    "last-turn": 190_000,
    working: 190_000,
    idle: 120_000,
  });
});

test("renders all four duration labels and precise short values", () => {
  const panel = { timing: TIMING } as CodecPanelScene;
  const html = renderToStaticMarkup(<CodecDurationStrip panel={panel} nowMs={null} />);
  expect(html).toContain("data-codec-durations");
  expect(html).toContain("session");
  expect(html).toContain("last turn");
  expect(html).toContain("working");
  expect(html).toContain("idle");
  expect(html).toContain("5m 0s");
  expect(html).toContain('aria-label="working duration: 3m 0s"');
  expect(html).not.toContain("≥");
});

test("marks partial working and idle durations as lower bounds", () => {
  const panel = { timing: PARTIAL_TIMING } as CodecPanelScene;
  const html = renderToStaticMarkup(<CodecDurationStrip panel={panel} nowMs={null} />);

  expect(html).toContain('aria-label="working duration: at least 3m 0s"');
  expect(html).toContain('aria-label="idle duration: at least 2m 0s"');
  expect(html).toContain("≥ 3m 0s");
  expect(html).toContain("≥ 2m 0s");
  expect(html).toContain('aria-label="session duration: 5m 0s"');
  expect(html).toContain('aria-label="last turn duration: 3m 0s"');
});

test("explains partial lifecycle coverage and its measurement start in the tooltip", () => {
  const panel = { timing: PARTIAL_TIMING } as CodecPanelScene;
  const tooltipHtml = durationTooltipMarkup(panel, "working");

  expect(tooltipHtml).toContain("This is a lower bound");
  expect(tooltipHtml).toContain("only lifecycle time observed since");
  expect(tooltipHtml).toContain('dateTime="2026-09-04T10:02:00.000Z"');
  expect(tooltipHtml).toContain("Earlier working and idle time is not included.");
});

test("formats longer durations without noisy seconds", () => {
  expect(formatCodecDuration(7_384_000)).toBe("2h 3m");
  expect(formatCodecDuration(93_600_000)).toBe("1d 2h");
});

function durationTooltipMarkup(panel: CodecPanelScene, field: string): string {
  const strip = CodecDurationStrip({ panel, nowMs: null });
  if (!strip || !isValidElement<{ children: ReactNode }>(strip)) {
    throw new Error("duration strip did not render");
  }

  for (const itemNode of Children.toArray(strip.props.children)) {
    if (!isValidElement<{ children: ReactNode }>(itemNode)) continue;
    const tooltip = itemNode.props.children;
    if (
      !isValidElement<{
        children: ReactNode;
        content: ReactNode;
      }>(tooltip)
    ) {
      continue;
    }
    const trigger = tooltip.props.children;
    if (!isValidElement<{ "data-duration-field"?: string }>(trigger)) continue;
    if (trigger.props["data-duration-field"] !== field) continue;
    return renderToStaticMarkup(tooltip.props.content);
  }

  throw new Error(`duration tooltip not found for ${field}`);
}
