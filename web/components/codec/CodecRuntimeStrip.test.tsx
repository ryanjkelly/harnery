import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { CodecPanelScene, CodecRuntimeValue } from "@/lib/codec/contracts";

import { CodecRuntimeStrip } from "./CodecRuntimeStrip";

function panel(runtime?: Partial<CodecRuntimeValue>): CodecPanelScene {
  return {
    ...(runtime
      ? {
          runtime: {
            value: runtime,
            provenance: "event",
            confidence: "high",
            observed_at: "2026-10-26T18:00:00.000Z",
          },
        }
      : {}),
  } as CodecPanelScene;
}

test("reported adapter effort and speed tooltips agree with the visible values", () => {
  const current = panel({ harness: "codex", effort: "xhigh", speed: "fast" });
  const html = renderToStaticMarkup(<CodecRuntimeStrip panel={current} />);
  expect(html).toContain('aria-label="effort: xhigh"');
  expect(html).toContain('aria-label="speed: fast"');
  for (const field of ["effort", "speed"]) {
    const tooltip = runtimeTooltipMarkup(current, field);
    expect(tooltip).toContain(`The adapter reported this ${field} setting.`);
    expect(tooltip).toContain("event · high confidence");
    expect(tooltip).not.toContain("was not reported");
  }
});

test("Cursor tuning retains its explicit canonical-model source", () => {
  const current = panel({ harness: "cursor", model: "model-high-fast", effort: "high", speed: "fast" });
  for (const field of ["effort", "speed"]) {
    expect(runtimeTooltipMarkup(current, field)).toContain(
      "Explicitly encoded in the canonical Cursor model id model-high-fast.",
    );
  }
});

test("missing or blank tuning stays unreported without inventing a default", () => {
  const current = panel({ harness: "codex", effort: "  " });
  const html = renderToStaticMarkup(<CodecRuntimeStrip panel={current} />);
  expect(html).toContain('aria-label="effort: not reported"');
  expect(html).toContain('aria-label="speed: not reported"');
  expect(runtimeTooltipMarkup(current, "effort")).toContain(
    "The effort setting was not reported by this adapter.",
  );
  expect(runtimeTooltipMarkup(panel(), "speed")).toContain(
    "No runtime attestation reached this panel.",
  );
});

function runtimeTooltipMarkup(current: CodecPanelScene, field: string): string {
  const strip = CodecRuntimeStrip({ panel: current });
  for (const item of Children.toArray(strip.props.children)) {
    if (!isValidElement<{ children: ReactNode }>(item)) continue;
    const tooltip = item.props.children;
    if (!isValidElement<{ children: ReactNode; content: ReactNode }>(tooltip)) continue;
    const trigger = tooltip.props.children;
    if (!isValidElement<{ "data-runtime-field"?: string }>(trigger)) continue;
    if (trigger.props["data-runtime-field"] === field) {
      return renderToStaticMarkup(tooltip.props.content);
    }
  }
  throw new Error(`runtime tooltip not found for ${field}`);
}
