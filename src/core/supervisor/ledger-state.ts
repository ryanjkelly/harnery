import { createHash } from "node:crypto";
import { resolveBinName } from "../config.ts";
import { type EventV3ControlState, readEventV3ControlState } from "../events/v3/control.ts";
import {
  EPOCH_SCHEMA_UNKNOWN_REASON_V3,
  GENESIS_SCHEMA_DIGEST_INCOMPATIBLE_REASON_V3,
} from "../events/v3/schema-lineage.ts";
import {
  SUPERVISOR_DIAGNOSTIC_LIMITS,
  type SupervisorCapability,
  type SupervisorFindingClass,
  type SupervisorFindingEvidence,
  type SupervisorFindingSeverity,
  type SupervisorSourceReference,
} from "./contract.ts";

/**
 * Event ledger control drift, as a supervisor finding.
 *
 * A root whose control state is not `active` still coordinates, so nothing
 * fails loudly: the write gate narrows, every reader validates the whole epoch,
 * and the only surface that said so was `init --check`. One root sat in
 * `candidate` for twenty hours that way. This module turns that drift into a
 * `coordination.ledger-diagnostic` finding so `agents health`, the resources
 * page, and diagnostic bundles carry it.
 *
 * It is a `diagnostic` finding by construction: it reports that an observation
 * and recording path is degraded, never that a machine resource is contended,
 * so it can never raise machine pressure or throttle anyone's work.
 */
export type LedgerControlStateNameV1 = EventV3ControlState["state"];

export interface LedgerControlStateObservationV1 {
  state: LedgerControlStateNameV1;
  /** The control reader's reason code, when the state carries one. */
  reason?: string;
  observed_at: string;
}

/**
 * The finding shape `evaluateSupervisorFindings` consumes, before identity,
 * fingerprinting, and transition bookkeeping are applied to it.
 */
export interface SupervisorFindingCandidateV1 {
  source_kind: string;
  finding_kind: string;
  finding_class: SupervisorFindingClass;
  severity: SupervisorFindingSeverity;
  scope_kind: string;
  scope_id: string;
  summary: string;
  primary_source: SupervisorSourceReference;
  evidence: SupervisorFindingEvidence[];
  capabilities: SupervisorCapability[];
}

export interface LedgerControlStateFindingInputV1 {
  /** The control state observed for the current supervisor history point. */
  current: LedgerControlStateObservationV1;
  /** Earlier observations, most recent first. Only the leading run is read. */
  previous?: readonly LedgerControlStateObservationV1[];
  capability: SupervisorCapability;
}

/**
 * Open a finding once the drift has outlived one supervisor history point.
 *
 * Rotation and activation legitimately pass through `candidate` between two
 * appends, so a single non-active sample is not drift. Two consecutive ones
 * are: no correct boundary spans a supervisor cycle.
 */
export function ledgerControlStateFindingCandidateV1(
  input: LedgerControlStateFindingInputV1,
): SupervisorFindingCandidateV1 | undefined {
  const { current, capability } = input;
  const incompatibleObserver = schemaReasonDescribesObserver(current.state, current.reason);
  if (current.state === "active") return undefined;
  const priorDrift = leadingDriftRun(input.previous ?? []);
  if (priorDrift.length === 0) return undefined;

  const points = priorDrift.length + 1;
  const since = priorDrift[priorDrift.length - 1]?.observed_at ?? current.observed_at;
  const detail = current.reason ? `${current.state} (${current.reason})` : current.state;
  const source = ledgerControlStateSource(current, capability);
  const summary = boundSummary(
    incompatibleObserver
      ? `Supervisor cannot validate the event ledger with its loaded schema (${current.reason}) across ${points} observations since ${since}. ` +
          `Ledger authority and writer availability are unverified by this observer. ` +
          `To load the installed build, run ${resolveBinName()} supervisor stop, then ${resolveBinName()} supervisor start; recheck before ledger recovery.`
      : `Event ledger control state is ${detail}, not active, across ${points} supervisor observations since ${since}. ` +
          `Writes are gated to that state and every reader validates the epoch in full until it is active.`,
  );
  return {
    source_kind: source.source_kind,
    finding_kind: "coordination.ledger-diagnostic",
    finding_class: "diagnostic",
    severity: incompatibleObserver ? "warning" : ledgerControlStateSeverity(current.state),
    scope_kind: "ledger",
    scope_id: incompatibleObserver
      ? "control-reader:schema-incompatible"
      : `control-state:${current.state}`,
    summary,
    primary_source: source,
    evidence: [
      {
        id: deterministicId(
          "ev",
          `coordination.ledger-diagnostic\0ledger\0control-state:${current.state}\0${source.id}`,
        ),
        source,
        summary,
        observed_value: points,
        unit: "count",
      },
    ],
    capabilities: [capability],
  };
}

/**
 * The two schema verdicts the control reader returns describe the runtime that
 * read the epoch, not the epoch: an older-group genesis this runtime would
 * refresh, or a schema this runtime's lineage does not hold (ADR 0245). The
 * reader compares no digests here; it trusts the control reason.
 */
function schemaReasonDescribesObserver(state: string, reason: string | undefined): boolean {
  return (
    state === "invalid" &&
    (reason === GENESIS_SCHEMA_DIGEST_INCOMPATIBLE_REASON_V3 ||
      reason === EPOCH_SCHEMA_UNKNOWN_REASON_V3)
  );
}

/** `invalid` and `closed` stop recording outright; the rest degrade it. */
function ledgerControlStateSeverity(state: LedgerControlStateNameV1): SupervisorFindingSeverity {
  return state === "invalid" || state === "closed" ? "critical" : "warning";
}

function leadingDriftRun(
  previous: readonly LedgerControlStateObservationV1[],
): LedgerControlStateObservationV1[] {
  const run: LedgerControlStateObservationV1[] = [];
  for (const observation of previous) {
    if (observation.state === "active") break;
    run.push(observation);
  }
  return run;
}

function ledgerControlStateSource(
  current: LedgerControlStateObservationV1,
  capability: SupervisorCapability,
): SupervisorSourceReference {
  const sourceId = `control-state:${current.state}${current.reason ? `:${current.reason}` : ""}`;
  return {
    id: deterministicId("src", `coordination.v3\0${sourceId}\0\0${current.observed_at}`),
    source_kind: "coordination.v3",
    source_id: sourceId,
    observed_at: current.observed_at,
    capability: capability.state,
  };
}

function boundSummary(summary: string): string {
  return summary.slice(0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_summary_chars);
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

/** Read-only observation: a schema mismatch describes this reader, not every producer. */
export function observeLedgerControlState(
  coordRoot: string,
  now: Date,
): { observation: LedgerControlStateObservationV1; capability: SupervisorCapability } {
  const observedAt = now.toISOString();
  try {
    const control = readEventV3ControlState(coordRoot);
    const reason = "reason" in control ? control.reason : undefined;
    const incompatible = schemaReasonDescribesObserver(control.state, reason);
    return {
      observation: {
        state: control.state,
        ...("reason" in control && control.reason ? { reason: control.reason } : {}),
        observed_at: observedAt,
      },
      capability: incompatible
        ? {
            source_kind: "event-ledger.control-state",
            state: "unsupported",
            reason_code:
              reason === EPOCH_SCHEMA_UNKNOWN_REASON_V3
                ? "schema-digest-unknown"
                : "schema-digest-incompatible",
          }
        : { source_kind: "event-ledger.control-state", state: "supported" },
    };
  } catch (error) {
    return {
      observation: {
        state: "invalid",
        reason: "control_state_unreadable",
        observed_at: observedAt,
      },
      capability: {
        source_kind: "event-ledger.control-state",
        state: "error",
        reason_code: "control-state-unreadable",
        detail: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
      },
    };
  }
}
