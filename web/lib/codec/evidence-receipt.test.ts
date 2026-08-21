import { expect, test } from "bun:test";

import type { CodecPanelScene } from "./contracts";
import { codecEvidenceReceiptRows } from "./evidence-receipt";

const shown = <T>(value: T, event = "evt_receipt") => ({
  value,
  provenance: "event" as const,
  confidence: "high" as const,
  observed_at: "2026-08-21T15:00:00.000Z",
  evidence_event_ids: [event, "evt_two", "evt_three", "evt_four"],
});

test("evidence receipt exposes bounded provenance without raw source content", () => {
  const panel = {
    instance_id: "inst-a",
    identity: { display_name: "Carlos" },
    presence: shown("online"),
    activity: shown("working"),
    lifecycle: shown("active"),
    expression: shown("building"),
    attention: shown("none"),
    context_band: shown("reduced"),
    progress_rhythm: shown("steady"),
    operation: shown({ category: "edit", label: "Editing files", state: "active" }),
    recent_actions: [
      {
        category: "test",
        outcome: "ok",
        event_id: "evt_action",
        observed_at: "2026-08-21T15:00:01.000Z",
      },
    ],
    character: { pack_id: "fallback-neutral", pack_version: "0" },
    updated_at: "2026-08-21T15:00:01.000Z",
  } satisfies CodecPanelScene;
  const rows = codecEvidenceReceiptRows(panel);
  expect(rows.find((row) => row.channel === "operation")?.value).toBe("Editing files · active");
  expect(rows[0]?.evidence_event_ids).toEqual(["evt_two", "evt_three", "evt_four"]);
  expect(JSON.stringify(rows)).not.toContain("tool_input");
});
