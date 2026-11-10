import { describe, expect, test } from "bun:test";

import type { CodecPanelScene } from "./contracts";
import { deriveRelationships } from "./relationships";

const NOW = "2026-08-16T12:00:00.000Z";

function panel(id: string, parent?: string): CodecPanelScene {
  return {
    instance_id: id,
    identity: { display_name: id },
    ...(parent
      ? {
          parent_instance_id: {
            value: parent,
            provenance: "event",
            confidence: "high",
            observed_at: NOW,
            evidence_event_ids: ["ev-p"],
          },
        }
      : {}),
    presence: { value: "online", provenance: "projection", confidence: "high", observed_at: NOW },
    activity: { value: "working", provenance: "projection", confidence: "high", observed_at: NOW },
    lifecycle: { value: "active", provenance: "projection", confidence: "high", observed_at: NOW },
    expression: {
      value: "neutral",
      provenance: "projection",
      confidence: "high",
      observed_at: NOW,
    },
    attention: { value: "none", provenance: "projection", confidence: "high", observed_at: NOW },
    context_band: { value: "unknown", provenance: "unknown", confidence: "low", observed_at: NOW },
    progress_rhythm: {
      value: "unknown",
      provenance: "unknown",
      confidence: "low",
      observed_at: NOW,
    },
    recent_actions: [],
    character: { pack_id: "fallback-neutral", pack_version: "0" },
    updated_at: NOW,
  };
}

describe("deriveRelationships", () => {
  test("parentage between rendered panels becomes a shared-coordination edge", () => {
    const edges = deriveRelationships([panel("p"), panel("c", "p")]);
    expect(edges).toEqual([
      expect.objectContaining({
        kind: "shared-coordination",
        from_instance_id: "p",
        to_instance_id: "c",
        status: "active",
        provenance: "event",
      }),
    ]);
  });

  test("a parent that is not rendered draws no edge", () => {
    expect(deriveRelationships([panel("c", "missing")])).toEqual([]);
  });
});
