import {
  type EventV2,
  type ReadLedgerV2Result,
  readEventV2ControlState,
  readLedgerV2,
  reduceSafetyProjectionV2,
} from "../events/v2/index.ts";
import {
  isRunQualityCorpusCategoryV2,
  normalizeRunQualityEventV2,
  normalizeRunQualityPairingV2,
} from "./evidence-v2.ts";
import type {
  RunQualityCorpusCategoryV2,
  RunQualityEvidenceEvent,
  RunQualityRoleWait,
} from "./types.ts";

export type RunQualityLiveEpochStateV2 = "candidate" | "active";

export interface RunQualityLiveGenerationV2 {
  instance_id: string;
  session_id: string;
  generation_id: string;
  adapter: string;
  events: RunQualityEvidenceEvent[];
  corpus_categories: RunQualityCorpusCategoryV2[];
  role_wait: RunQualityRoleWait;
  evidence: {
    first_event_id?: string;
    last_event_id?: string;
    window_started_at?: string;
    window_ended_at?: string;
    segment: string;
    truncated: boolean;
  };
  sufficient_history: boolean;
}

export interface RunQualityLiveSourceV2 {
  contract_major: 2;
  genesis_id: string;
  epoch_state: RunQualityLiveEpochStateV2;
  generations: RunQualityLiveGenerationV2[];
}

export class RunQualityLiveSourceV2Error extends Error {
  constructor(
    public readonly code: "control_not_ready" | "ledger_integrity_failure",
    public readonly details: string[],
  ) {
    super(`run_quality_live_v2:${code}:${details.join(",")}`);
    this.name = "RunQualityLiveSourceV2Error";
  }
}

/**
 * Read live advisory inputs from the validated V2 ledger. Candidate epochs are
 * observable here for rehearsal, but corpus eligibility remains active-only.
 */
export function readRunQualityLiveSourceV2(
  coordRoot: string,
  now: Date = new Date(),
): RunQualityLiveSourceV2 {
  const control = readEventV2ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") {
    throw new RunQualityLiveSourceV2Error("control_not_ready", [
      control.state,
      "reason" in control ? control.reason : "unknown",
    ]);
  }
  return projectRunQualityLiveSourceV2(
    readLedgerV2(coordRoot),
    control.genesis.event.payload.genesis_id,
    control.state,
    now,
  );
}

/** Pure projection used by the live coordinator and replay-equivalence tests. */
export function projectRunQualityLiveSourceV2(
  read: ReadLedgerV2Result,
  genesisId: string,
  epochState: RunQualityLiveEpochStateV2,
  now: Date,
): RunQualityLiveSourceV2 {
  if (!read.complete) {
    throw new RunQualityLiveSourceV2Error("ledger_integrity_failure", [
      ...new Set(read.diagnostics.map(({ code }) => code)),
    ]);
  }
  const safety = reduceSafetyProjectionV2(read);
  const generations: RunQualityLiveGenerationV2[] = [];
  for (const state of Object.values(safety.generations)) {
    if (state.phase !== "live") continue;
    const positioned = read.events.filter(
      ({ event }) =>
        "generation_id" in event.scope && event.scope.generation_id === state.generation_id,
    );
    const started = positioned.find(({ event }) => event.event_type === "session.started")?.event;
    if (started?.event_type !== "session.started") continue;
    const prior = new Map<string, EventV2>();
    const evidenceEvents: RunQualityEvidenceEvent[] = [];
    const corpusCategories = new Set<RunQualityCorpusCategoryV2>();
    for (const { event } of positioned) {
      for (const normalized of normalizeRunQualityEventV2(event, prior)) {
        if (isRunQualityCorpusCategoryV2(normalized.kind)) corpusCategories.add(normalized.kind);
        else evidenceEvents.push(normalized);
      }
      prior.set(event.event_id, event);
    }
    for (const marker of normalizeRunQualityPairingV2(positioned.map(({ event }) => event))) {
      if (isRunQualityCorpusCategoryV2(marker.kind)) corpusCategories.add(marker.kind);
    }
    const first = evidenceEvents[0];
    const last = evidenceEvents.at(-1);
    const lastPosition = positioned.at(-1)?.position;
    const diagnostic = safety.diagnostics.some(
      (entry) => entry.generation_id === state.generation_id && entry.authority_blocking,
    );
    generations.push({
      instance_id: state.instance_id,
      session_id: state.session_id,
      generation_id: state.generation_id,
      adapter: observedAdapter(started),
      events: evidenceEvents,
      corpus_categories: [...corpusCategories].sort(),
      role_wait: roleWait(state.waits, state.started_at, now),
      evidence: {
        first_event_id: first?.event_id,
        last_event_id: last?.event_id,
        window_started_at: first?.ts,
        window_ended_at: last?.ts,
        segment: `v2:${lastPosition?.segment_ordinal ?? 0}`,
        truncated: diagnostic,
      },
      sufficient_history: !diagnostic,
    });
  }
  generations.sort((left, right) => left.generation_id.localeCompare(right.generation_id));
  return { contract_major: 2, genesis_id: genesisId, epoch_state: epochState, generations };
}

function observedAdapter(event: Extract<EventV2, { event_type: "session.started" }>): string {
  const adapter = event.payload.runtime_attestation.adapter;
  return adapter.state === "observed" ? adapter.value.id : "unknown";
}

function roleWait(
  waits: Record<
    string,
    {
      wait_id: string;
      kind: string;
      started_at: string;
      wake_at?: string;
    }
  >,
  generationStartedAt: string,
  now: Date,
): RunQualityRoleWait {
  const current = Object.values(waits).sort((left, right) =>
    left.started_at.localeCompare(right.started_at),
  );
  if (current.length === 0) {
    return {
      role: "agent",
      wait_kind: "none",
      source: "event_v2",
      observed_at: generationStartedAt,
      fresh: false,
    };
  }
  const latest = current.at(-1)!;
  const scheduledExpired =
    latest.kind === "scheduled" &&
    latest.wake_at !== undefined &&
    Date.parse(latest.wake_at) <= now.getTime();
  return {
    role: "agent",
    wait_kind: current.length > 1 ? "unknown" : waitKind(latest.kind),
    source: "event_v2",
    observed_at: latest.started_at,
    fresh: !scheduledExpired,
    record_id: latest.wait_id,
    wake_at: latest.wake_at,
  };
}

function waitKind(kind: string): RunQualityRoleWait["wait_kind"] {
  switch (kind) {
    case "operator_input":
      return "needs_input";
    case "decision":
      return "decision";
    case "permission":
    case "approval":
      return "approval";
    case "scheduled":
      return "scheduled";
    default:
      return "unknown";
  }
}
