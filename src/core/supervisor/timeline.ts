import { createHash } from "node:crypto";
import {
  SUPERVISOR_DIAGNOSTIC_LIMITS,
  SUPERVISOR_TIMELINE_SCHEMA_VERSION,
  type SupervisorFinding,
  type SupervisorSourceReference,
  type SupervisorTimeline,
  type SupervisorTimelineEntry,
} from "./contract.ts";

export function buildSupervisorTimeline(
  finding: SupervisorFinding,
  relatedSources: readonly SupervisorSourceReference[] = [],
): SupervisorTimeline {
  const relatedEntries = clusterRelatedSources(relatedSources);
  const entries: SupervisorTimelineEntry[] = [
    entry("opened", finding.opened_at, finding.summary, finding.primary_source),
    ...finding.evidence.map((evidence) => ({
      ...entry("observed", evidence.source.observed_at, evidence.summary, evidence.source),
      evidence_id: evidence.id,
    })),
    ...relatedEntries,
    ...finding.capabilities
      .filter((capability) => capability.state !== "supported")
      .map((capability) =>
        entry(
          "capability",
          finding.observed_at,
          `${capability.source_kind} capability is ${capability.state}${capability.reason_code ? ` (${capability.reason_code})` : ""}.`,
          {
            id: stableId("src", `${finding.id}:${capability.source_kind}:${capability.state}`),
            source_kind: capability.source_kind,
            source_id: capability.reason_code ?? capability.state,
            observed_at: finding.observed_at,
            capability: capability.state,
          },
        ),
      ),
    ...(finding.state === "resolved" && finding.resolved_at
      ? [
          entry(
            "resolved",
            finding.resolved_at,
            "The observed condition returned below its threshold.",
            finding.primary_source,
          ),
        ]
      : []),
  ].sort(
    (left, right) =>
      left.occurred_at.localeCompare(right.occurred_at) || left.id.localeCompare(right.id),
  );
  const maxEntries = SUPERVISOR_DIAGNOSTIC_LIMITS.max_timeline_entries;
  const bounded = entries.slice(-maxEntries);
  return {
    schema_version: SUPERVISOR_TIMELINE_SCHEMA_VERSION,
    finding_id: finding.id,
    start_at: bounded[0]?.occurred_at ?? finding.opened_at,
    end_at: bounded[bounded.length - 1]?.occurred_at ?? finding.observed_at,
    max_entries: maxEntries,
    omitted_entries: Math.max(0, entries.length - bounded.length),
    compacted_entries: Math.max(0, relatedSources.length - relatedEntries.length),
    entries: bounded,
    capabilities: finding.capabilities.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_capabilities),
  };
}

function entry(
  relation: SupervisorTimelineEntry["relation"],
  occurredAt: string,
  summary: string,
  source: SupervisorSourceReference,
): SupervisorTimelineEntry {
  return {
    id: stableId("tl", `${relation}\u0000${occurredAt}\u0000${source.id}\u0000${summary}`),
    occurred_at: occurredAt,
    first_occurred_at: occurredAt,
    last_occurred_at: occurredAt,
    occurrence_count: 1,
    relation,
    summary: summary.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_summary_chars),
    source,
  };
}

function clusterRelatedSources(
  sources: readonly SupervisorSourceReference[],
): SupervisorTimelineEntry[] {
  const groups = new Map<
    string,
    {
      first: SupervisorSourceReference;
      last: SupervisorSourceReference;
      count: number;
    }
  >();
  const ordered = [...sources].sort(
    (left, right) =>
      left.observed_at.localeCompare(right.observed_at) || left.id.localeCompare(right.id),
  );
  for (const source of ordered) {
    const key = `${source.source_kind}\u0000${source.source_id}\u0000${source.capability}`;
    const group = groups.get(key);
    if (group) {
      group.last = source;
      group.count += 1;
    } else {
      groups.set(key, { first: source, last: source, count: 1 });
    }
  }
  return [...groups.entries()].map(([key, group]) => {
    const firstAt = group.first.observed_at;
    const lastAt = group.last.observed_at;
    const summary =
      group.count === 1
        ? `Related ${group.last.source_kind} activity was observed in the same time range.`
        : `${group.count} related ${group.last.source_kind} ${group.last.source_id} observations were recorded in the same time range.`;
    return {
      id: stableId("tl", `related\u0000${key}\u0000${firstAt}\u0000${lastAt}\u0000${group.count}`),
      occurred_at: lastAt,
      first_occurred_at: firstAt,
      last_occurred_at: lastAt,
      occurrence_count: group.count,
      relation: "related",
      summary: summary.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_summary_chars),
      source: group.last,
    };
  });
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
