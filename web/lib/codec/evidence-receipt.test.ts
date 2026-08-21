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
    operation: shown({
      category: "edit",
      label: "Editing files",
      state: "active",
      elapsed_ms: 12_000,
      duration_sample_count: 8,
      long_running_threshold_ms: 30_000,
    }),
    telemetry: {
      ...shown("degraded", "evt_telemetry"),
      expires_at: "2026-08-21T15:05:00.000Z",
    },
    telemetry_reason: shown("clock-regressed", "evt_telemetry"),
    remote_source: {
      relay: shown({ state: "fresh", age_ms: 20_000 }, "evt_relay"),
      digest: shown({ state: "aging", age_ms: 180_000 }, "evt_digest"),
    },
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
  expect(rows.find((row) => row.channel === "operation")?.detail).toBe(
    "elapsed 12s · 8 baseline samples · long-running after 30s",
  );
  expect(rows.find((row) => row.channel === "telemetry")?.expires_at).toBe(
    "2026-08-21T15:05:00.000Z",
  );
  expect(rows.find((row) => row.channel === "observer reason")?.value).toBe("clock-regressed");
  expect(rows.find((row) => row.channel === "relay")?.detail).toBe("age 20s");
  expect(rows.find((row) => row.channel === "remote digest")?.detail).toBe("age 3m");
  expect(rows.find((row) => row.channel === "presence")?.group).toBe("state");
  expect(rows[0]?.evidence_event_ids).toEqual(["evt_two", "evt_three", "evt_four"]);
  expect(JSON.stringify(rows)).not.toContain("tool_input");
});
