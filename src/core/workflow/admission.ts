import { buildDiagnosticAdvice, unknownPressureAssessment } from "../diagnostics/advice.ts";
import type { DiagnosticAdvice } from "../diagnostics/contract.ts";
import { type PublishedPressure, readPublishedPressure } from "../resources/status.ts";
import {
  type EnsureSupervisorResult,
  ensureSupervisorRunning,
  readSupervisorFindings,
  readSupervisorStatus,
  registerSupervisorConsumer,
  type SupervisorCapability,
  type SupervisorFinding,
  type SupervisorFindings,
  type SupervisorStatus,
  unregisterSupervisorConsumer,
} from "../supervisor/index.ts";
import type { WorkflowDiagnosticAdmissionObservation } from "./types.ts";

const DEFAULT_FRESH_CYCLE_WAIT_MS = 4_000;
const POLL_INTERVAL_MS = 50;

export interface WorkflowDiagnosticAdmissionRuntime {
  now: () => Date;
  wait: (milliseconds: number) => Promise<void>;
  registerConsumer: (coordRoot: string, input: { id: string; pid?: number }) => unknown;
  unregisterConsumer: (coordRoot: string, id: string) => void;
  ensureSupervisor: (coordRoot: string) => Promise<EnsureSupervisorResult>;
  readStatus: (coordRoot: string, nowMs?: number) => SupervisorStatus;
  readFindings: (coordRoot: string) => SupervisorFindings | undefined;
  /** The observer's published assessment. Admission never computes one itself. */
  readPressure: (coordRoot: string, nowMs?: number) => PublishedPressure;
}

export interface ObserveWorkflowDiagnosticAdmissionInput {
  coordRoot: string;
  runId: string;
  freshCycleWaitMs?: number;
  runtime?: Partial<WorkflowDiagnosticAdmissionRuntime>;
}

export async function observeWorkflowDiagnosticAdmission(
  input: ObserveWorkflowDiagnosticAdmissionInput,
): Promise<WorkflowDiagnosticAdmissionObservation> {
  const runtime = admissionRuntime(input.runtime);
  const requested = runtime.now();
  const requestedAt = requested.toISOString();
  const startedMs = requested.getTime();
  const consumerId = `workflow-${input.runId}`;
  let serviceState: WorkflowDiagnosticAdmissionObservation["service_state"] = "unavailable";

  try {
    runtime.registerConsumer(input.coordRoot, { id: consumerId });
    const ensured = await runtime.ensureSupervisor(input.coordRoot);
    serviceState = ensured.state;
    if (ensured.state === "unavailable") {
      return unavailableObservation(
        runtime,
        requestedAt,
        startedMs,
        serviceState,
        "error",
        "supervisor_unavailable",
        ensured.error,
      );
    }

    const deadlineMs = runtime.now().getTime() + normalizeWait(input.freshCycleWaitMs);
    while (runtime.now().getTime() <= deadlineMs) {
      const status = runtime.readStatus(input.coordRoot, runtime.now().getTime());
      const sampledAt = status.record?.last_cycle_at;
      if (status.running && sampledAt && Date.parse(sampledAt) >= requested.getTime()) {
        const report = runtime.readFindings(input.coordRoot);
        if (!report) {
          return unavailableObservation(
            runtime,
            requestedAt,
            startedMs,
            serviceState,
            "unsupported",
            "source_missing",
          );
        }
        const observedAt = runtime.now().toISOString();
        const published = runtime.readPressure(input.coordRoot, runtime.now().getTime());
        return {
          requested_at: requestedAt,
          observed_at: observedAt,
          wait_ms: elapsedMs(runtime, startedMs),
          service_state: serviceState,
          freshness: "fresh",
          sampled_at: sampledAt,
          advice: buildDiagnosticAdvice({
            assessment: published.assessment,
            priorHysteresis: published.prior_hysteresis,
            sourceCapability: published.capability,
            activeFindingCount: mergeFindings(report).filter(
              (finding) => finding.state === "opened",
            ).length,
            evaluatedAt: observedAt,
          }),
        };
      }
      const remainingMs = deadlineMs - runtime.now().getTime();
      if (remainingMs <= 0) break;
      await runtime.wait(Math.min(POLL_INTERVAL_MS, remainingMs));
    }
    return unavailableObservation(
      runtime,
      requestedAt,
      startedMs,
      serviceState,
      "expired",
      "fresh_cycle_timeout",
    );
  } catch (error) {
    return unavailableObservation(
      runtime,
      requestedAt,
      startedMs,
      serviceState,
      "error",
      "observation_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    try {
      runtime.unregisterConsumer(input.coordRoot, consumerId);
    } catch {
      // Admission is observer-only. Cleanup failure cannot affect dispatch.
    }
  }
}

export function failedWorkflowDiagnosticAdmissionObservation(
  error: unknown,
  requestedAt: Date,
  observedAt = new Date(),
): WorkflowDiagnosticAdmissionObservation {
  const capability: SupervisorCapability = {
    source_kind: "supervisor.findings",
    state: "error",
    reason_code: "observation_failed",
    detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
  return {
    requested_at: requestedAt.toISOString(),
    observed_at: observedAt.toISOString(),
    wait_ms: Math.max(0, observedAt.getTime() - requestedAt.getTime()),
    service_state: "unavailable",
    freshness: "unavailable",
    advice: unavailableAdvice(capability, observedAt.toISOString()),
  };
}

/**
 * Shadow admission records what the observer published. When it published
 * nothing, the record carries `unknown` with the gap stated, never a state the
 * observer did not measure. Either way no value reaches a dispatch decision.
 */
function unavailableAdvice(capability: SupervisorCapability, observedAt: string): DiagnosticAdvice {
  return buildDiagnosticAdvice({
    assessment: unknownPressureAssessment({
      observedAt,
      reasonCode: "evidence_unavailable",
      summary: `Local resource pressure cannot be determined because the assessment source is ${capability.state}${capability.reason_code ? ` (${capability.reason_code})` : ""}.`,
    }),
    priorHysteresis: null,
    sourceCapability: capability,
    activeFindingCount: 0,
    evaluatedAt: observedAt,
  });
}

function unavailableObservation(
  runtime: WorkflowDiagnosticAdmissionRuntime,
  requestedAt: string,
  startedMs: number,
  serviceState: WorkflowDiagnosticAdmissionObservation["service_state"],
  state: Exclude<SupervisorCapability["state"], "supported">,
  reasonCode: string,
  detail?: string,
): WorkflowDiagnosticAdmissionObservation {
  const observedAt = runtime.now().toISOString();
  const capability: SupervisorCapability = {
    source_kind: "supervisor.findings",
    state,
    reason_code: reasonCode,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  };
  const advice: DiagnosticAdvice = unavailableAdvice(capability, observedAt);
  return {
    requested_at: requestedAt,
    observed_at: observedAt,
    wait_ms: elapsedMs(runtime, startedMs),
    service_state: serviceState,
    freshness: "unavailable",
    advice,
  };
}

function mergeFindings(report: SupervisorFindings): SupervisorFinding[] {
  const byId = new Map<string, SupervisorFinding>();
  for (const finding of report.transitions) byId.set(finding.id, finding);
  for (const finding of report.active) byId.set(finding.id, finding);
  return [...byId.values()];
}

function normalizeWait(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FRESH_CYCLE_WAIT_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_FRESH_CYCLE_WAIT_MS;
  return Math.min(Math.floor(value), 30_000);
}

function elapsedMs(runtime: WorkflowDiagnosticAdmissionRuntime, startedMs: number): number {
  return Math.max(0, runtime.now().getTime() - startedMs);
}

function admissionRuntime(
  overrides: Partial<WorkflowDiagnosticAdmissionRuntime> | undefined,
): WorkflowDiagnosticAdmissionRuntime {
  return {
    now: () => new Date(),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    registerConsumer: registerSupervisorConsumer,
    unregisterConsumer: unregisterSupervisorConsumer,
    ensureSupervisor: ensureSupervisorRunning,
    readStatus: readSupervisorStatus,
    readFindings: readSupervisorFindings,
    readPressure: readPublishedPressure,
    ...overrides,
  };
}
