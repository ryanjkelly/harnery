import { describe, expect, test } from "bun:test";
import {
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  SUPERVISOR_TIMELINE_SCHEMA_VERSION,
  type SupervisorFinding,
  type SupervisorSourceReference,
} from "./contract.ts";
import { buildSupervisorTimeline } from "./timeline.ts";

describe("supervisor timeline", () => {
  test("clusters repeated related sources and preserves their time span", () => {
    const sources = [
      related("evt-3", "tool_use", "2026-08-31T09:03:00.000Z"),
      related("evt-1", "tool_use", "2026-08-31T09:01:00.000Z"),
      related("evt-4", "turn_end", "2026-08-31T09:04:00.000Z"),
      related("evt-2", "tool_use", "2026-08-31T09:02:00.000Z"),
    ];
    const timeline = buildSupervisorTimeline(finding(), sources);
    const relatedEntries = timeline.entries.filter((entry) => entry.relation === "related");
    expect(timeline.schema_version).toBe(SUPERVISOR_TIMELINE_SCHEMA_VERSION);
    expect(timeline.compacted_entries).toBe(2);
    expect(relatedEntries).toHaveLength(2);
    expect(relatedEntries.find((entry) => entry.source.source_id === "tool_use")).toMatchObject({
      first_occurred_at: "2026-08-31T09:01:00.000Z",
      last_occurred_at: "2026-08-31T09:03:00.000Z",
      occurred_at: "2026-08-31T09:03:00.000Z",
      occurrence_count: 3,
      source: { id: "evt-3" },
    });
  });

  test("produces stable clustered entries regardless of input order", () => {
    const sources = [
      related("evt-1", "tool_use", "2026-08-31T09:01:00.000Z"),
      related("evt-2", "tool_use", "2026-08-31T09:02:00.000Z"),
    ];
    const forward = buildSupervisorTimeline(finding(), sources);
    const reverse = buildSupervisorTimeline(finding(), [...sources].reverse());
    expect(forward).toEqual(reverse);
  });
});

function related(id: string, sourceId: string, observedAt: string): SupervisorSourceReference {
  return {
    id,
    source_kind: "coordination.event-v3",
    source_id: sourceId,
    observed_at: observedAt,
    record_id: id,
    capability: "supported",
  };
}

function finding(): SupervisorFinding {
  return {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    id: "finding-1",
    fingerprint: "fingerprint-1",
    source_kind: "resources.machine",
    finding_kind: "memory-pressure",
    severity: "warning",
    state: "opened",
    scope_kind: "machine",
    scope_id: "local",
    summary: "Memory pressure is elevated.",
    opened_at: "2026-08-31T09:00:00.000Z",
    observed_at: "2026-08-31T09:05:00.000Z",
    occurrence_count: 1,
    primary_source: {
      id: "resource-1",
      source_kind: "resources.snapshot",
      source_id: "machine",
      observed_at: "2026-08-31T09:00:00.000Z",
      capability: "supported",
    },
    evidence: [],
    capabilities: [{ source_kind: "resources.snapshot", state: "supported" }],
  };
}
