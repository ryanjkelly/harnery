import { expect, test } from "bun:test";

import type { CodecPanelScene } from "./contracts";
import { stableCodecPanelOrder } from "./panel-order";

const shown = <T>(value: T) => ({
  value,
  provenance: "projection" as const,
  confidence: "high" as const,
  observed_at: "2026-08-21T15:00:00.000Z",
});

function panel(name: string, id: string, updatedAt: string, machine?: string): CodecPanelScene {
  return {
    instance_id: id,
    identity: { display_name: name },
    ...(machine ? { machine } : {}),
    presence: shown("online"),
    activity: shown("working"),
    lifecycle: shown("active"),
    expression: shown("building"),
    attention: shown("none"),
    context_band: shown("unknown"),
    progress_rhythm: shown("steady"),
    recent_actions: [],
    character: { pack_id: "fallback-neutral", pack_version: "0" },
    updated_at: updatedAt,
  };
}

test("stable panel order ignores activity timestamps and keeps remote panels grouped", () => {
  const first = panel("Zoe", "inst-z", "2026-08-21T15:00:09.000Z");
  const second = panel("Ada", "inst-a", "2026-08-21T15:00:01.000Z");
  const remote = panel("Ben", "inst-r", "2026-08-21T15:00:20.000Z", "peer-b");
  expect(stableCodecPanelOrder([first, remote, second]).map((item) => item.instance_id)).toEqual([
    "inst-a",
    "inst-z",
    "inst-r",
  ]);
  first.updated_at = "2026-08-21T15:01:00.000Z";
  expect(stableCodecPanelOrder([remote, first, second]).map((item) => item.instance_id)).toEqual([
    "inst-a",
    "inst-z",
    "inst-r",
  ]);
});
