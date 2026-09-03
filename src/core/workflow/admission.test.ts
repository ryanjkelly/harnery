import { describe, expect, test } from "bun:test";
import {
  hysteresisFixture,
  pressureAssessmentFixture,
} from "../../../tests/helpers/resource-status.ts";
import type { PublishedPressure } from "../resources/status.ts";
import {
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  type SupervisorFinding,
  type SupervisorServiceStatusRecord,
  type SupervisorStatus,
} from "../supervisor/index.ts";
import {
  observeWorkflowDiagnosticAdmission,
  type WorkflowDiagnosticAdmissionRuntime,
} from "./admission.ts";

const requestedAt = Date.parse("2026-08-31T12:00:00.000Z");

describe("observeWorkflowDiagnosticAdmission", () => {
  test("waits for a fresh cycle, reads advice, and unregisters its consumer", async () => {
    let nowMs = requestedAt;
    const events: string[] = [];
    const runtime = fakeRuntime({
      now: () => new Date(nowMs),
      wait: async (milliseconds) => {
        nowMs += milliseconds;
      },
      registerConsumer: () => events.push("registered"),
      unregisterConsumer: () => events.push("unregistered"),
      readStatus: () => status(nowMs >= requestedAt + 50 ? nowMs : requestedAt - 1_000),
      readFindings: () => ({
        schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
        max_findings: 100,
        active: [finding("warning", "warning")],
        transitions: [],
      }),
      readPressure: () => published("elevated"),
    });

    const observation = await observeWorkflowDiagnosticAdmission({
      coordRoot: "/repo",
      runId: "wf-test",
      runtime,
    });

    expect(observation.freshness).toBe("fresh");
    expect(observation.service_state).toBe("running");
    expect(observation.wait_ms).toBe(50);
    expect(observation.advice.assessment.state).toBe("elevated");
    expect(observation.advice.assessment.observer_only).toBe(true);
    expect(observation.advice.prior_hysteresis?.state).toBe("normal");
    expect(observation.advice.active_finding_count).toBe(1);
    expect(events).toEqual(["registered", "unregistered"]);
  });

  test("turns supervisor startup failure into unknown advice and still unregisters", async () => {
    const events: string[] = [];
    const runtime = fakeRuntime({
      registerConsumer: () => events.push("registered"),
      unregisterConsumer: () => events.push("unregistered"),
      ensureSupervisor: async () => ({
        state: "unavailable",
        status: status(),
        error: "cannot start",
      }),
    });

    const observation = await observeWorkflowDiagnosticAdmission({
      coordRoot: "/repo",
      runId: "wf-test",
      runtime,
    });

    expect(observation.freshness).toBe("unavailable");
    expect(observation.service_state).toBe("unavailable");
    expect(observation.advice.assessment.state).toBe("unknown");
    expect(observation.advice.source_capability.reason_code).toBe("supervisor_unavailable");
    expect(events).toEqual(["registered", "unregistered"]);
  });

  test("turns a fresh-cycle timeout into unknown advice", async () => {
    let nowMs = requestedAt;
    const runtime = fakeRuntime({
      now: () => new Date(nowMs),
      wait: async (milliseconds) => {
        nowMs += milliseconds;
      },
      readStatus: () => status(requestedAt - 1_000),
    });

    const observation = await observeWorkflowDiagnosticAdmission({
      coordRoot: "/repo",
      runId: "wf-test",
      freshCycleWaitMs: 100,
      runtime,
    });

    expect(observation.freshness).toBe("unavailable");
    expect(observation.wait_ms).toBe(100);
    expect(observation.advice.assessment.state).toBe("unknown");
    expect(observation.advice.source_capability.reason_code).toBe("fresh_cycle_timeout");
  });
});

function fakeRuntime(
  overrides: Partial<WorkflowDiagnosticAdmissionRuntime> = {},
): WorkflowDiagnosticAdmissionRuntime {
  return {
    now: () => new Date(requestedAt),
    wait: async () => {},
    registerConsumer: () => {},
    unregisterConsumer: () => {},
    ensureSupervisor: async () => ({ state: "running", status: status() }),
    readStatus: () => status(requestedAt),
    readFindings: () => ({
      schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
      max_findings: 100,
      active: [],
      transitions: [],
    }),
    readPressure: () => published("normal"),
    ...overrides,
  };
}

function published(state: "normal" | "elevated"): PublishedPressure {
  return {
    assessment: pressureAssessmentFixture({
      state,
      observed_at: "2026-08-31T12:00:00.050Z",
    }),
    prior_hysteresis: hysteresisFixture(),
    capability: { source_kind: "supervisor.pressure", state: "supported" },
    record: null,
  };
}

function status(lastCycleAt?: number): SupervisorStatus {
  const record: SupervisorServiceStatusRecord = {
    schema_version: 1,
    pid: process.pid,
    host: "test",
    nonce: "test",
    state: "running",
    started_at: "2026-08-31T11:59:00.000Z",
    heartbeat_at: "2026-08-31T12:00:00.000Z",
    interval_ms: 2_000,
    keep_alive: false,
    idle_exit_ms: 120_000,
    cycle_count: lastCycleAt === undefined ? 0 : 1,
    ...(lastCycleAt === undefined ? {} : { last_cycle_at: new Date(lastCycleAt).toISOString() }),
  };
  return {
    running: true,
    stale: false,
    record,
    status_path: "/repo/.harnery/supervisor/service.json",
    snapshot_path: "/repo/.harnery/supervisor/snapshot.json",
  };
}

function finding(id: string, severity: SupervisorFinding["severity"]): SupervisorFinding {
  return {
    schema_version: SUPERVISOR_FINDING_SCHEMA_VERSION,
    id,
    fingerprint: `fingerprint-${id}`,
    source_kind: "resources.process-group",
    finding_kind: "memory-growth",
    finding_class: "attribution",
    severity,
    state: "opened",
    scope_kind: "agent",
    scope_id: id,
    summary: `${severity} pressure for ${id}`,
    opened_at: "2026-08-31T11:59:00.000Z",
    observed_at: "2026-08-31T12:00:00.050Z",
    occurrence_count: 1,
    primary_source: {
      id: `source-${id}`,
      source_kind: "resources.snapshot",
      source_id: id,
      observed_at: "2026-08-31T12:00:00.050Z",
      capability: "supported",
    },
    evidence: [],
    capabilities: [{ source_kind: "resources.snapshot", state: "supported" }],
  };
}
