import { describe, expect, test } from "bun:test";

import type { CodecPanelScene } from "./contracts";
import { type DependencySourceItem, deriveRelationships } from "./relationships";

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

function item(overrides: Partial<DependencySourceItem> & { id: string }): DependencySourceItem {
  return { state: "running", dependencies: [], unresolved_dependencies: [], ...overrides };
}

describe("deriveRelationships", () => {
  test("parentage between rendered panels becomes a shared-coordination edge", () => {
    const edges = deriveRelationships([panel("p"), panel("c", "p")], [], () => []);
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

  test("a dependency draws only when both items map to rendered panels", () => {
    const items = [
      item({
        id: "w-a",
        dependencies: ["w-b"],
        unresolved_dependencies: ["w-b"],
        latest_run_id: "run-a",
      }),
      item({ id: "w-b", latest_run_id: "run-b" }),
    ];
    const sessions: Record<string, string[]> = { "run-a": ["s-a"], "run-b": ["s-b"] };
    const both = deriveRelationships(
      [panel("s-a"), panel("s-b")],
      items,
      (run) => sessions[run] ?? [],
    );
    expect(both).toEqual([
      expect.objectContaining({
        kind: "dependency",
        from_instance_id: "s-b",
        to_instance_id: "s-a",
        status: "waiting",
      }),
    ]);

    // Prerequisite's panel missing: no edge, never guessed.
    const oneSided = deriveRelationships([panel("s-a")], items, (run) => sessions[run] ?? []);
    expect(oneSided).toEqual([]);
  });

  test("status maps from prerequisite/dependent state", () => {
    const items = [
      item({ id: "w-a", dependencies: ["w-b"], latest_run_id: "run-a" }),
      item({ id: "w-b", state: "blocked", latest_run_id: "run-b" }),
    ];
    const edges = deriveRelationships([panel("s-a"), panel("s-b")], items, (run) =>
      run === "run-a" ? ["s-a"] : ["s-b"],
    );
    expect(edges[0]?.status).toBe("blocked");

    const resolved = deriveRelationships(
      [panel("s-a"), panel("s-b")],
      [
        item({ id: "w-a", dependencies: ["w-b"], latest_run_id: "run-a" }),
        item({ id: "w-b", state: "succeeded", latest_run_id: "run-b" }),
      ],
      (run) => (run === "run-a" ? ["s-a"] : ["s-b"]),
    );
    expect(resolved[0]?.status).toBe("active");
  });

  test("a throwing session resolver suppresses the edge", () => {
    const items = [
      item({ id: "w-a", dependencies: ["w-b"], latest_run_id: "run-a" }),
      item({ id: "w-b", latest_run_id: "run-b" }),
    ];
    expect(
      deriveRelationships([panel("s-a"), panel("s-b")], items, () => {
        throw new Error("transcript gone");
      }),
    ).toEqual([]);
  });
});
