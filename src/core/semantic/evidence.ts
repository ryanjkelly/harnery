import type { V3HeartbeatMaterialization } from "../agents/state/live-coordination-view.ts";
import { readLiveCoordinationRows } from "../agents/state/live-coordination-view.ts";
import type { EventV3 } from "../events/v3/contract.ts";
import {
  type CoordinationGenerationViewV3,
  type CoordinationViewV3,
  projectCoordinationViewV3,
} from "../events/v3/coordination-view.ts";
import { canonicalJsonV3, sha256V3 } from "../events/v3/index.ts";
import { type ReadLedgerV3Result, readLedgerV3 } from "../events/v3/reader.ts";
import { type PresenceCodecDigest, projectPresenceCodecDigests } from "../presence/codec-digest.ts";
import {
  SEMANTIC_EVIDENCE_CONTRACT_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA_VERSION,
  type SemanticEvidenceObservationV1,
  type SemanticEvidenceV1,
  type SemanticHarness,
} from "./contract.ts";
import { isSemanticPrivacySafe, validateSemanticEvidencePrivacy } from "./validate.ts";

const MAX_RECENT = 8;
export const SEMANTIC_RECENTLY_ENDED_WINDOW_MS = 30 * 60_000;

/** Read canonical V3 authority and project one privacy-safe envelope per active generation. */
export function buildSemanticEvidenceV1(
  coordRoot: string,
  nowMs = Date.now(),
): SemanticEvidenceV1[] {
  const read = readLedgerV3(coordRoot, { authority: "active" });
  if (!read.complete || !read.genesis_id) return [];
  return projectSemanticEvidenceV1(read, readLiveCoordinationRows(coordRoot), nowMs);
}

/** Pure projection seam used by replay and contract tests. */
export function projectSemanticEvidenceV1(
  read: ReadLedgerV3Result,
  liveRows: readonly V3HeartbeatMaterialization[] = [],
  nowMs = Date.now(),
): SemanticEvidenceV1[] {
  if (!read.complete || !read.genesis_id) return [];
  const view = projectCoordinationViewV3(read);
  if (!view.authority_safe) return [];
  return projectSemanticEvidenceFromViewV1(read, view, liveRows, nowMs);
}

export function projectSemanticEvidenceFromViewV1(
  read: ReadLedgerV3Result,
  view: CoordinationViewV3,
  liveRows: readonly V3HeartbeatMaterialization[] = [],
  nowMs = Date.now(),
): SemanticEvidenceV1[] {
  if (!read.complete || !read.genesis_id || !view.authority_safe) return [];
  const events = read.events.map(({ event }) => event);
  const codec = projectPresenceCodecDigests(events);
  const rows = new Map(liveRows.map((row) => [row.v3_generation_id, row]));
  const recentTerminal = Object.values(view.terminal_generations).filter((generation) => {
    const endedAt = Date.parse(generation.terminal?.observed_at ?? "");
    return (
      generation.evidence_complete &&
      Number.isFinite(endedAt) &&
      nowMs - endedAt >= 0 &&
      nowMs - endedAt <= SEMANTIC_RECENTLY_ENDED_WINDOW_MS
    );
  });
  return [...Object.values(view.instances), ...recentTerminal]
    .filter((generation) => generation.authority_eligible || generation.phase === "terminal")
    .sort((left, right) => left.generation_id.localeCompare(right.generation_id))
    .flatMap((generation) => {
      const evidence = projectGeneration(
        read.genesis_id!,
        generation,
        events.filter((event) => eventGenerationId(event) === generation.generation_id),
        rows.get(generation.generation_id as `gen_${string}`),
        codec.get(generation.instance_id),
      );
      return evidence ? [evidence] : [];
    });
}

function projectGeneration(
  genesisId: string,
  generation: CoordinationGenerationViewV3,
  events: readonly EventV3[],
  row: V3HeartbeatMaterialization | undefined,
  codec: PresenceCodecDigest | undefined,
): SemanticEvidenceV1 | undefined {
  const start = events.find((event) => event.event_type === "session.started");
  if (!start || start.event_type !== "session.started") return undefined;
  const harness = observedHarness(start.payload.runtime_attestation.adapter);
  if (!harness) return undefined;

  const latestTask = latest(events, "coord.task_changed");
  const latestLifecycle = latest(events, "coord.lifecycle_changed");
  const latestIntent = latest(events, "turn.started");
  const task =
    latestTask && row?.task && row.v3_task_state === "set" && isSemanticPrivacySafe(row.task)
      ? { value: row.task.slice(0, 200), event_id: latestTask.event_id }
      : undefined;
  const lifecycle = latestLifecycle
    ? { state: latestLifecycle.payload.new_state, event_id: latestLifecycle.event_id }
    : undefined;
  const intent = latestIntent
    ? { kind: latestIntent.payload.intent_kind, event_id: latestIntent.event_id }
    : undefined;
  const operation =
    codec?.operation && isSemanticPrivacySafe(codec.operation.label)
      ? {
          category: codec.operation.category,
          label: codec.operation.label,
          event_id: codec.operation.event_id,
        }
      : undefined;
  const waits = generation.waits.slice(0, 8).map((wait) => ({
    kind: wait.kind,
    event_id: wait.started_event_id,
    started_at: wait.started_at,
  }));
  const recent = events.flatMap(toRecentObservation).slice(-MAX_RECENT);
  const attention = attentionObservation(generation, events, recent);
  const dependencyIds = generation.waits
    .map((wait) => wait.authority_reference)
    .filter((value): value is string => Boolean(value))
    .filter((value) => /^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$/.test(value))
    .slice(0, 16);
  const relationships =
    generation.parent_generation_id || dependencyIds.length
      ? {
          ...(generation.parent_generation_id
            ? { parent_generation_id: generation.parent_generation_id }
            : {}),
          dependency_ids: [...new Set(dependencyIds)],
        }
      : undefined;
  const evidenceEventIds = unique([
    start.event_id,
    task?.event_id,
    lifecycle?.event_id,
    intent?.event_id,
    operation?.event_id,
    ...waits.map((wait) => wait.event_id),
    ...recent.map((item) => item.event_id),
    attention?.event_id,
  ]).slice(0, 64);
  const observedThrough = newestEvidenceEvent(events, evidenceEventIds) ?? start;
  const unsigned = {
    schema_version: SEMANTIC_EVIDENCE_SCHEMA_VERSION,
    evidence_contract_version: SEMANTIC_EVIDENCE_CONTRACT_VERSION,
    instance_id: generation.instance_id,
    generation_id: generation.generation_id,
    source_harness: harness,
    source: {
      ledger_genesis_id: genesisId,
      observed_through_event_id: observedThrough.event_id,
      observed_through_ts: observedThrough.time.observed_at,
    },
    ...(task ? { task } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(intent ? { intent } : {}),
    ...(operation ? { operation } : {}),
    waits,
    recent,
    ...(attention ? { attention } : {}),
    ...(relationships ? { relationships } : {}),
    evidence_event_ids: evidenceEventIds,
  } as const;
  const evidence: SemanticEvidenceV1 = {
    ...unsigned,
    evidence_digest: sha256V3(canonicalJsonV3(unsigned)),
  };
  return validateSemanticEvidencePrivacy(evidence).ok ? evidence : undefined;
}

function toRecentObservation(event: EventV3): SemanticEvidenceObservationV1[] {
  const base = { event_id: event.event_id, observed_at: event.time.observed_at };
  switch (event.event_type) {
    case "progress.observed":
      return [
        {
          ...base,
          kind: "progress",
          label: progressLabel(event.payload.kind),
          outcome: "succeeded",
        },
      ];
    case "artifact.observed":
      return [
        {
          ...base,
          kind: "artifact",
          label: artifactLabel(event.payload.operation),
          outcome: "succeeded",
        },
      ];
    case "tool.completed":
      return [
        {
          ...base,
          kind: event.payload.outcome === "failed" ? "error" : "action",
          label:
            event.payload.outcome === "succeeded" ? "Tool action succeeded" : "Tool action ended",
          outcome: event.payload.outcome,
          ...(event.payload.error?.class ? { error_class: event.payload.error.class } : {}),
        },
      ];
    case "command.completed":
      return [
        {
          ...base,
          kind: event.payload.outcome === "failed" ? "error" : "action",
          label: event.payload.outcome === "succeeded" ? "Command succeeded" : "Command ended",
          outcome: event.payload.outcome,
          ...(event.payload.error_class ? { error_class: event.payload.error_class } : {}),
        },
      ];
    case "turn.completed":
      return [{ ...base, kind: "action", label: "Turn completed", outcome: event.payload.outcome }];
    case "session.ended":
      return [
        { ...base, kind: "terminal", label: "Session ended", outcome: event.payload.outcome },
      ];
    case "session.resumed":
    case "lifecycle.recovered":
      return [{ ...base, kind: "recovery", label: "Work recovered", outcome: "succeeded" }];
    case "coord.claim_changed":
      return event.payload.operation === "denied"
        ? [{ ...base, kind: "claim-conflict", label: "Write claim conflicted", outcome: "denied" }]
        : [];
    default:
      return [];
  }
}

function attentionObservation(
  generation: CoordinationGenerationViewV3,
  events: readonly EventV3[],
  recent: readonly SemanticEvidenceObservationV1[],
): SemanticEvidenceObservationV1 | undefined {
  const activeWait = generation.waits.at(-1);
  if (activeWait) {
    return {
      kind: "wait",
      event_id: activeWait.started_event_id,
      observed_at: activeWait.started_at,
      label: `Waiting for ${waitLabel(activeWait.kind)}`,
    };
  }
  const lifecycle = latest(events, "coord.lifecycle_changed");
  if (lifecycle?.payload.new_state === "blocked") {
    return {
      kind: "lifecycle",
      event_id: lifecycle.event_id,
      observed_at: lifecycle.time.observed_at,
      label: "Work is explicitly blocked",
    };
  }
  return [...recent]
    .reverse()
    .find((item) => item.kind === "error" || item.kind === "claim-conflict");
}

function observedHarness(
  observation: Extract<
    EventV3,
    { event_type: "session.started" }
  >["payload"]["runtime_attestation"]["adapter"],
): SemanticHarness | undefined {
  if (observation.state !== "observed") return undefined;
  const id = observation.value.id;
  return id === "claude-code" || id === "codex" || id === "cursor" ? id : undefined;
}

function latest<T extends EventV3["event_type"]>(
  events: readonly EventV3[],
  eventType: T,
): Extract<EventV3, { event_type: T }> | undefined {
  return [...events].reverse().find((event) => event.event_type === eventType) as
    | Extract<EventV3, { event_type: T }>
    | undefined;
}

function eventGenerationId(event: EventV3): string | undefined {
  return "generation_id" in event.scope ? event.scope.generation_id : undefined;
}

function newestEvidenceEvent(
  events: readonly EventV3[],
  ids: readonly string[],
): EventV3 | undefined {
  const allowed = new Set(ids);
  return [...events].reverse().find((event) => allowed.has(event.event_id));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function progressLabel(kind: string): string {
  return (
    {
      write: "Files changed",
      test: "Tests observed",
      commit: "Commit observed",
      deploy: "Deployment observed",
      publication: "Publication observed",
      review: "Review observed",
      artifact: "Artifact observed",
    }[kind] ?? "Progress observed"
  );
}

function artifactLabel(operation: string): string {
  return (
    {
      created: "Artifact created",
      updated: "Artifact updated",
      viewed: "Artifact viewed",
      published: "Artifact published",
    }[operation] ?? "Artifact observed"
  );
}

function waitLabel(kind: string): string {
  return (
    {
      permission: "permission",
      needs_input: "input",
      operator_input: "operator input",
      approval: "approval",
      decision: "a decision",
      dependency: "a dependency",
      scheduled: "a scheduled time",
      rate_limit: "a rate limit",
      unknown: "attention",
    }[kind] ?? "attention"
  );
}
