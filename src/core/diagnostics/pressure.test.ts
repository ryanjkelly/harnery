import { describe, expect, test } from "bun:test";
import type { ResourceSnapshot } from "../resources/contract.ts";
import { assessPressure } from "./pressure.ts";
import {
  type AssessPressureInput,
  PRESSURE_POLICY,
  type PressureAssessment,
  type PressureDimension,
  type PressureFindingInput,
  type PressureHysteresisState,
} from "./pressure-contract.ts";

const MIB = 1_024 * 1_024;
const GIB = 1_024 * MIB;
const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const AT = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

/** A healthy Linux snapshot with every contention dimension measurable. */
function snapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return {
    schema_version: 2,
    sampled_at: AT(),
    interval_ms: 2_000,
    sample_duration_ms: 5,
    collector_cpu_ms: 4,
    platform: "linux",
    namespace: "host",
    support: { state: "supported", sampler: "procfs" },
    machine: {
      cpu_percent: 20,
      cpu_logical_count: 8,
      load_average: [1, 1, 1],
      memory_total_bytes: 24 * GIB,
      memory_available_bytes: 12 * GIB,
      memory_used_bytes: 12 * GIB,
      memory_percent: 50,
      swap_total_bytes: 8 * GIB,
      swap_used_bytes: 0,
      process_count: 120,
    },
    disks: [
      {
        path: "/workspace",
        state: "supported",
        total_bytes: 200 * GIB,
        available_bytes: 100 * GIB,
        used_percent: 50,
      },
    ],
    pressure: {
      state: "supported",
      cpu: { avg10: 1, avg60: 1, avg300: 1 },
      memory: { avg10: 0, avg60: 0, avg300: 0 },
      io: { avg10: 0, avg60: 0, avg300: 0 },
      memory_full: { avg10: 0, avg60: 0, avg300: 0 },
      io_full: { avg10: 0, avg60: 0, avg300: 0 },
    },
    oom: {
      state: "supported",
      total_kills: 0,
      kills_since_last_sample: 0,
      last_kill_age_ms: null,
    },
    vmstat: {
      state: "supported",
      swap_in_bytes_per_second: 0,
      swap_out_bytes_per_second: 0,
      direct_reclaim_pages_per_second: 0,
      major_faults_per_second: 1,
      counters_reset: false,
    },
    io: { state: "supported", read_bytes_per_second: 0, write_bytes_per_second: 0 },
    groups: [],
    processes: [],
    visible_process_count: 0,
    omitted_process_count: 0,
    unattributed_process_count: 0,
    ...overrides,
  };
}

function hysteresis(overrides: Partial<PressureHysteresisState> = {}): PressureHysteresisState {
  return {
    state: "normal",
    state_since: AT(-60_000),
    consecutive_clear_samples: 0,
    dimension_streaks: {},
    oom_baseline_total_kills: null,
    oom_hold_until: null,
    observer_generation: "gen-1",
    ...overrides,
  };
}

function finding(overrides: Partial<PressureFindingInput> = {}): PressureFindingInput {
  return {
    id: "find_process",
    finding_kind: "process.memory-pressure",
    finding_class: "attribution",
    severity: "critical",
    state: "opened",
    summary: "Process 4242 uses 1288490188 resident bytes.",
    scope_kind: "process",
    scope_id: "4242:100",
    observed_at: AT(),
    occurrence_count: 3,
    attribution: { state: "attributed", owner_kind: "agent", owner_id: "agent-Builder" },
    ...overrides,
  };
}

function assess(overrides: Partial<AssessPressureInput> = {}): PressureAssessment {
  return assessPressure({
    snapshot: snapshot(),
    history: [],
    findings: [],
    findings_capability: { source_kind: "supervisor-findings", state: "supported" },
    prior: null,
    observer_generation: "gen-1",
    now_ms: NOW,
    ...overrides,
  });
}

function dimension(
  assessment: PressureAssessment,
  name: PressureDimension,
): PressureAssessment["evidence"][number] | undefined {
  return assessment.evidence.find((entry) => entry.dimension === name);
}

function codes(assessment: PressureAssessment): string[] {
  return assessment.reasons.map((reason) => reason.code);
}

describe("pressure assessment: attribution never sets machine state", () => {
  test("a 1.2 GiB process with 9 GiB available and no stalls is a contributor, not a state", () => {
    const machine = snapshot();
    machine.machine.memory_available_bytes = 9 * GIB;
    machine.machine.memory_percent = 62.5;
    machine.processes = [];
    const assessment = assess({
      snapshot: machine,
      findings: [finding({ summary: "Process 4242 uses 1.2 GiB of resident memory." })],
    });
    expect(assessment.state).toBe("normal");
    expect(assessment.recommended_action).toBe("proceed");
    expect(assessment.limiting_resource).toBe("none");
    expect(codes(assessment)).toContain("no_contention_evidence");
    expect(assessment.contributors).toHaveLength(1);
    expect(assessment.contributors[0]).toMatchObject({
      finding_kind: "process.memory-pressure",
      finding_class: "attribution",
      attribution_confidence: "exact",
      owner_kind: "agent",
      owner_id: "agent-Builder",
    });
  });

  test("a critical contention-class finding is carried but the snapshot still decides the state", () => {
    const assessment = assess({
      findings: [
        finding({
          id: "find_stall",
          finding_kind: "machine.memory-full-stall",
          finding_class: "contention",
          severity: "critical",
          scope_kind: "machine",
          scope_id: "local",
          attribution: undefined,
        }),
      ],
    });
    expect(assessment.state).toBe("normal");
    expect(assessment.contributors[0]).toMatchObject({
      finding_class: "contention",
      attribution_state: "unknown",
      attribution_confidence: "none",
    });
    expect(assessment.contributors[0]).not.toHaveProperty("owner_id");
  });

  test("an unattributed finding names no owner", () => {
    const assessment = assess({
      findings: [finding({ attribution: { state: "unattributed" } })],
    });
    expect(assessment.contributors[0]).toMatchObject({
      attribution_state: "unattributed",
      attribution_confidence: "none",
    });
    expect(assessment.contributors[0]).not.toHaveProperty("owner_kind");
  });

  test("resolved findings are excluded and the contributor limit is reported", () => {
    const findings = Array.from({ length: 12 }, (_, index) =>
      finding({ id: `find_${index}`, scope_id: `pid-${index}` }),
    );
    findings.push(finding({ id: "find_closed", state: "resolved" }));
    const assessment = assess({ findings });
    expect(assessment.contributors).toHaveLength(PRESSURE_POLICY.limits.max_contributors);
    expect(assessment.omitted_contributor_count).toBe(12 - PRESSURE_POLICY.limits.max_contributors);
    expect(assessment.contributors.some((entry) => entry.finding_id === "find_closed")).toBe(false);
  });

  test("reports the unattributed share of machine memory", () => {
    const machine = snapshot();
    machine.groups = [
      {
        kind: "unattributed",
        id: "unattributed",
        process_count: 9,
        cpu_percent: 1,
        rss_bytes: 2.4 * GIB,
        root_pids: [],
      },
      {
        kind: "agent",
        id: "agent-A",
        process_count: 1,
        cpu_percent: 1,
        rss_bytes: 1 * GIB,
        root_pids: [7],
      },
    ];
    expect(assess({ snapshot: machine }).unattributed_memory_percent).toBe(10);
  });
});

describe("pressure assessment: contention decision table", () => {
  test("swap that is 90 percent occupied with no swap-out reads normal and reports the residue", () => {
    const machine = snapshot();
    machine.machine.swap_used_bytes = 0.9 * 8 * GIB;
    const assessment = assess({
      snapshot: machine,
      prior: hysteresis({ dimension_streaks: {} }),
    });
    expect(assessment.state).toBe("normal");
    expect(assessment.summary).toContain("Swap still holds 90 percent");
    expect(dimension(assessment, "swap_activity")).toMatchObject({
      state: "supported",
      observed_value: 0,
      sample_count: 0,
    });
  });

  test("a 95 percent memory full stall in the guest is critical on one sample", () => {
    const machine = snapshot();
    machine.namespace = "wsl";
    machine.machine.memory_total_bytes = 23.5 * GIB;
    machine.machine.memory_available_bytes = 7.3 * GIB;
    machine.machine.swap_total_bytes = 8 * GIB;
    machine.machine.swap_used_bytes = 8 * GIB - 64 * 1_024;
    machine.pressure!.memory_full = { avg10: 95, avg60: 60, avg300: 20 };
    machine.host = {
      platform: "win32",
      sampled_at: AT(-1_000),
      state: "supported",
      machine: {
        cpu_percent: 20,
        cpu_logical_count: 16,
        load_average: null,
        memory_total_bytes: 64 * GIB,
        memory_available_bytes: 32 * GIB,
        memory_used_bytes: 32 * GIB,
        memory_percent: 50,
        swap_total_bytes: 16 * GIB,
        swap_used_bytes: 0,
        process_count: 300,
      },
      disks: [],
    };
    const assessment = assess({ snapshot: machine });
    expect(assessment.state).toBe("critical");
    expect(assessment.scope).toBe("guest");
    expect(assessment.limiting_resource).toBe("memory");
    expect(assessment.recommended_action).toBe("avoid-new-heavy-work");
    expect(codes(assessment)).toContain("memory_full_stall_critical");
    expect(assessment.reasons[0]).toMatchObject({
      code: "memory_full_stall_critical",
      observed_value: 95,
      threshold_value: PRESSURE_POLICY.memory_stall.critical_avg10,
      unit: "percent",
    });
  });

  test("sustained swap-out combined with a rising stall is critical", () => {
    const machine = snapshot();
    machine.vmstat!.swap_out_bytes_per_second = 173 * MIB;
    machine.pressure!.memory_full = { avg10: 30, avg60: 12, avg300: 4 };
    const assessment = assess({
      snapshot: machine,
      prior: hysteresis({ dimension_streaks: { swap_activity: 2, memory_stall: 1 } }),
    });
    expect(assessment.state).toBe("critical");
    expect(codes(assessment)).toEqual(
      expect.arrayContaining(["swap_out_rate_critical", "memory_full_stall_elevated"]),
    );
    expect(assessment.limiting_resource).toBe("memory");
    expect(dimension(assessment, "swap_activity")?.sample_count).toBe(3);
  });

  test("swap-out below the critical rate is only elevated after its dwell", () => {
    const machine = snapshot();
    machine.vmstat!.swap_out_bytes_per_second = 6 * MIB;
    expect(assess({ snapshot: machine, prior: hysteresis() }).state).toBe("normal");
    expect(
      assess({
        snapshot: machine,
        prior: hysteresis({ dimension_streaks: { swap_activity: 2 } }),
      }).state,
    ).toBe("elevated");
  });

  test("direct reclaim alone is elevated and turns critical beside another memory signal", () => {
    const machine = snapshot();
    machine.vmstat!.direct_reclaim_pages_per_second = 120_000;
    const alone = assess({
      snapshot: machine,
      prior: hysteresis({ dimension_streaks: { direct_reclaim: 2 } }),
    });
    expect(alone.state).toBe("elevated");
    expect(codes(alone)).toContain("direct_reclaim_elevated");
    machine.pressure!.memory_full = { avg10: 25, avg60: 10, avg300: 2 };
    const combined = assess({
      snapshot: machine,
      prior: hysteresis({ dimension_streaks: { direct_reclaim: 2, memory_stall: 1 } }),
    });
    expect(combined.state).toBe("critical");
    expect(codes(combined)).toContain("direct_reclaim_with_memory_signal");
  });

  test("memory percent used alone is never state-bearing, but exhausted memory and swap are", () => {
    const machine = snapshot();
    machine.machine.memory_available_bytes = 2 * GIB;
    machine.machine.memory_percent = 91.7;
    expect(assess({ snapshot: machine, prior: hysteresis() }).state).toBe("normal");
    expect(
      assess({
        snapshot: machine,
        prior: hysteresis({ dimension_streaks: { memory_available: 2 } }),
      }).state,
    ).toBe("elevated");
    machine.machine.memory_available_bytes = 0.5 * GIB;
    machine.machine.swap_used_bytes = 7.6 * GIB;
    const exhausted = assess({ snapshot: machine });
    expect(exhausted.state).toBe("critical");
    expect(codes(exhausted)).toContain("memory_and_swap_exhausted");
  });

  test("a processor stall is elevated only, never critical", () => {
    const machine = snapshot();
    machine.pressure!.cpu = { avg10: 60, avg60: 55, avg300: 40 };
    const assessment = assess({
      snapshot: machine,
      prior: hysteresis({ dimension_streaks: { cpu_stall: 2 } }),
    });
    expect(assessment.state).toBe("elevated");
    expect(assessment.limiting_resource).toBe("cpu");
    expect(codes(assessment)).toContain("cpu_stall_elevated");
    expect(assessment.guidance.find((entry) => entry.workload_class === "cpu-heavy")).toMatchObject(
      { recommendation: "avoid-new-heavy-work" },
    );
  });

  test("900 MiB of free disk space is critical and limits storage", () => {
    const machine = snapshot();
    machine.disks = [
      {
        path: "/workspace",
        state: "supported",
        total_bytes: 200 * GIB,
        available_bytes: 900 * MIB,
        used_percent: 99.6,
      },
    ];
    const assessment = assess({ snapshot: machine });
    expect(assessment.state).toBe("critical");
    expect(assessment.limiting_resource).toBe("storage");
    expect(assessment.scope).toBe("native");
    expect(codes(assessment)).toContain("disk_space_critical");
    expect(
      assessment.guidance.find((entry) => entry.workload_class === "storage-heavy"),
    ).toMatchObject({ recommendation: "avoid-new-heavy-work" });
  });

  test("an input and output stall is reported on its own dimension", () => {
    const machine = snapshot();
    machine.pressure!.io_full = { avg10: 70, avg60: 30, avg300: 10 };
    const assessment = assess({ snapshot: machine });
    expect(assessment.state).toBe("critical");
    expect(assessment.limiting_resource).toBe("io");
    expect(codes(assessment)).toContain("io_full_stall_critical");
  });
});

describe("pressure assessment: kernel kills", () => {
  test("only an increase over the carried baseline opens critical, and a reset re-baselines", () => {
    const machine = snapshot();
    machine.oom = {
      state: "supported",
      total_kills: 6,
      kills_since_last_sample: 0,
      last_kill_age_ms: 3_600_000,
    };
    const historical = assess({ snapshot: machine, prior: null, now_ms: NOW });
    expect(historical.state).toBe("normal");
    expect(historical.hysteresis.oom_baseline_total_kills).toBe(6);
    expect(codes(historical)).not.toContain("new_oom_kill");

    machine.oom.total_kills = 7;
    machine.sampled_at = AT(2_000);
    const killed = assess({
      snapshot: machine,
      prior: historical.hysteresis,
      now_ms: NOW + 2_000,
    });
    expect(killed.state).toBe("critical");
    expect(killed.limiting_resource).toBe("memory");
    const killReason = killed.reasons.find((reason) => reason.code === "new_oom_kill");
    expect(killReason).toMatchObject({ observed_value: 1, unit: "count", threshold_value: 0 });
    expect(killed.hysteresis.oom_baseline_total_kills).toBe(7);
    expect(Date.parse(killed.hysteresis.oom_hold_until!)).toBe(
      NOW + 2_000 + PRESSURE_POLICY.oom.critical_hold_ms,
    );

    // A counter reset starts a new baseline and opens nothing of its own.
    machine.oom.total_kills = 2;
    machine.sampled_at = AT(4_000);
    const reset = assess({ snapshot: machine, prior: killed.hysteresis, now_ms: NOW + 4_000 });
    expect(reset.hysteresis.oom_baseline_total_kills).toBe(2);
    expect(reset.reasons.find((reason) => reason.code === "new_oom_kill")?.unit).toBe(
      "milliseconds",
    );
    expect(reset.state).toBe("critical");
  });

  test("the hold expires, then critical drops to elevated and elevated drops to normal on their dwells", () => {
    const machine = snapshot();
    let carried = hysteresis({
      state: "critical",
      oom_baseline_total_kills: 7,
      oom_hold_until: AT(1_000),
    });
    const states: string[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const at = 60_000 + index * 2_000;
      machine.sampled_at = AT(at);
      const assessment = assess({ snapshot: machine, prior: carried, now_ms: NOW + at });
      carried = assessment.hysteresis;
      states.push(assessment.state);
    }
    // Three clear samples to leave critical, then five more to leave elevated.
    expect(states).toEqual([
      "critical",
      "critical",
      "elevated",
      "elevated",
      "elevated",
      "elevated",
      "elevated",
      "normal",
      "normal",
      "normal",
    ]);
  });

  test("a dwelling state explains itself with the clear-sample count", () => {
    const assessment = assess({
      prior: hysteresis({ state: "critical", consecutive_clear_samples: 1 }),
    });
    expect(assessment.state).toBe("critical");
    const dwell = assessment.reasons.find((reason) => reason.code === "recovering_within_dwell");
    expect(dwell).toMatchObject({
      observed_value: 2,
      threshold_value: PRESSURE_POLICY.recovery.critical_exit_samples,
    });
  });
});

describe("pressure assessment: gaps are never health", () => {
  test("a stale snapshot is unknown, names no owner, and keeps a live kill hold", () => {
    const machine = snapshot();
    machine.sampled_at = AT(-41_000);
    const assessment = assess({
      snapshot: machine,
      findings: [finding()],
      prior: hysteresis({ state: "critical", oom_hold_until: AT(30_000) }),
    });
    expect(assessment.state).toBe("unknown");
    expect(assessment.recommended_action).toBe("unknown");
    expect(assessment.limiting_resource).toBe("unknown");
    expect(codes(assessment)).toEqual(["snapshot_stale"]);
    expect(assessment.contributors).toEqual([]);
    expect(assessment.omitted_contributor_count).toBe(0);
    expect(assessment.unattributed_memory_percent).toBeNull();
    expect(assessment.sample_age_ms).toBe(41_000);
    expect(assessment.evidence_state).toBe("unavailable");
    expect(assessment.evidence.every((entry) => entry.state === "unavailable")).toBe(true);
    expect(assessment.hysteresis.oom_hold_until).toBe(AT(30_000));
    expect(assessment.guidance.every((entry) => entry.recommendation === "unknown")).toBe(true);
    expect(codes(assessment)).not.toContain("recovering_within_dwell");
  });

  test("a missing snapshot is unknown and repeats the reason it is missing", () => {
    const assessment = assess({
      snapshot: null,
      snapshot_reason: "the snapshot file exceeded the read limit",
    });
    expect(assessment.state).toBe("unknown");
    expect(codes(assessment)).toEqual(["evidence_unavailable"]);
    expect(assessment.summary).toContain("the snapshot file exceeded the read limit");
    expect(assessment.sample_age_ms).toBeNull();
  });

  test("an unreadable sample time is unknown rather than fresh", () => {
    const machine = snapshot();
    machine.sampled_at = "not-a-timestamp";
    const assessment = assess({ snapshot: machine });
    expect(assessment.state).toBe("unknown");
    expect(assessment.sample_age_ms).toBeNull();
    expect(codes(assessment)).toEqual(["snapshot_stale"]);
  });

  test("a snapshot that measures nothing is unknown, not normal", () => {
    const machine = snapshot();
    machine.platform = "win32";
    machine.support = { state: "unsupported", sampler: "unsupported", reason: "platform" };
    machine.machine.memory_total_bytes = null;
    machine.machine.memory_available_bytes = null;
    machine.disks = [];
    machine.pressure = {
      state: "unsupported",
      cpu: null,
      memory: null,
      io: null,
      memory_full: null,
      io_full: null,
    };
    machine.oom = {
      state: "unsupported",
      total_kills: null,
      kills_since_last_sample: null,
      last_kill_age_ms: null,
    };
    machine.vmstat = {
      state: "unsupported",
      swap_in_bytes_per_second: null,
      swap_out_bytes_per_second: null,
      direct_reclaim_pages_per_second: null,
      major_faults_per_second: null,
      counters_reset: false,
    };
    const assessment = assess({ snapshot: machine });
    expect(assessment.state).toBe("unknown");
    expect(assessment.evidence_state).toBe("unavailable");
    expect(codes(assessment)).toEqual(["evidence_unavailable"]);
  });

  test("an unavailable dimension never lowers a known critical signal", () => {
    const machine = snapshot();
    machine.pressure!.memory_full = { avg10: 95, avg60: 80, avg300: 40 };
    machine.vmstat = {
      state: "unsupported",
      swap_in_bytes_per_second: null,
      swap_out_bytes_per_second: null,
      direct_reclaim_pages_per_second: null,
      major_faults_per_second: null,
      counters_reset: false,
    };
    const assessment = assess({ snapshot: machine });
    expect(assessment.state).toBe("critical");
    expect(assessment.evidence_state).toBe("partial");
    expect(dimension(assessment, "swap_activity")).toMatchObject({
      state: "unavailable",
      observed_value: null,
      reason_code: "vmstat_unavailable",
    });
    expect(codes(assessment)).toContain("evidence_unavailable");
  });

  test("a restarted reclaim baseline is unavailable rather than zero activity", () => {
    const machine = snapshot();
    machine.vmstat = {
      state: "supported",
      swap_in_bytes_per_second: null,
      swap_out_bytes_per_second: null,
      direct_reclaim_pages_per_second: null,
      major_faults_per_second: null,
      counters_reset: true,
      reason: "Reclaim rates need two consecutive counters, so a baseline started.",
    };
    const assessment = assess({ snapshot: machine });
    expect(assessment.state).toBe("normal");
    expect(dimension(assessment, "swap_activity")?.reason_code).toBe("reclaim_baseline_restarted");
    expect(dimension(assessment, "direct_reclaim")?.reason_code).toBe("reclaim_baseline_restarted");
  });
});

describe("pressure assessment: scope", () => {
  function withHost(hostMemoryPercent: number, hostSwapUsedBytes: number, sampledAt = AT(-1_000)) {
    const machine = snapshot();
    machine.namespace = "wsl";
    machine.host = {
      platform: "win32",
      sampled_at: sampledAt,
      state: "supported",
      machine: {
        cpu_percent: 10,
        cpu_logical_count: 16,
        load_average: null,
        memory_total_bytes: 64 * GIB,
        memory_available_bytes: Math.round((64 * GIB * (100 - hostMemoryPercent)) / 100),
        memory_used_bytes: Math.round((64 * GIB * hostMemoryPercent) / 100),
        memory_percent: hostMemoryPercent,
        swap_total_bytes: 16 * GIB,
        swap_used_bytes: hostSwapUsedBytes,
        process_count: 300,
      },
      disks: [],
    };
    return machine;
  }

  test("a healthy host leaves the guest scope in place", () => {
    const assessment = assess({ snapshot: withHost(50, 0) });
    expect(assessment.scope).toBe("guest");
    expect(assessment.state).toBe("normal");
    expect(dimension(assessment, "host_memory")).toMatchObject({
      state: "supported",
      observed_value: 50,
    });
  });

  test("a strained host raises the combined state and takes the limiting scope", () => {
    const assessment = assess({ snapshot: withHost(95, 0) });
    expect(assessment.state).toBe("elevated");
    expect(assessment.scope).toBe("windows-host");
    expect(codes(assessment)).toContain("host_memory_pressure");
    expect(assessment.summary).toContain("Windows host");
  });

  test("a host under pressure never masks a critical guest", () => {
    const machine = withHost(96, 15.5 * GIB);
    machine.pressure!.memory_full = { avg10: 95, avg60: 80, avg300: 30 };
    const assessment = assess({ snapshot: machine });
    expect(assessment.state).toBe("critical");
    // The guest is critical too, so the guest keeps the scope.
    expect(assessment.scope).toBe("guest");
    expect(codes(assessment)).toEqual(
      expect.arrayContaining(["memory_full_stall_critical", "host_memory_pressure"]),
    );
  });

  test("a stale host reading cannot raise the state", () => {
    const assessment = assess({ snapshot: withHost(97, 0, AT(-120_000)) });
    expect(assessment.state).toBe("normal");
    expect(assessment.scope).toBe("guest");
    expect(dimension(assessment, "host_memory")).toMatchObject({
      state: "unavailable",
      reason_code: "host_sample_stale",
    });
  });
});

describe("pressure assessment: oscillation and observer restarts", () => {
  test("a signal hovering at the elevated threshold does not flap and a restart is deterministic", () => {
    const machine = snapshot();
    let carried: PressureHysteresisState | null = null;
    const states: string[] = [];
    const series = [21, 21, 19, 21, 19, 21];
    for (const [index, avg10] of series.entries()) {
      machine.pressure!.memory_full = { avg10, avg60: 10, avg300: 5 };
      machine.sampled_at = AT(index * 2_000);
      const assessment = assess({
        snapshot: machine,
        prior: carried,
        now_ms: NOW + index * 2_000,
      });
      carried = assessment.hysteresis;
      states.push(assessment.state);
    }
    // One transition into elevated, and no return while the signal stays above
    // the exit threshold, so a consumer sees one notice rather than six.
    expect(states).toEqual(["normal", "elevated", "elevated", "elevated", "elevated", "elevated"]);
    expect(new Set(states).size).toBe(2);

    const restarted = assess({
      snapshot: machine,
      prior: carried,
      observer_generation: "gen-2",
      now_ms: NOW + 12_000,
    });
    expect(restarted.hysteresis.observer_generation).toBe("gen-2");
    expect(restarted.hysteresis.dimension_streaks).toEqual({ memory_stall: 1 });
    expect(restarted.hysteresis.oom_baseline_total_kills).toBe(0);
    // A restart resets streaks but must not read a known elevated machine as normal.
    expect(restarted.state).toBe("elevated");

    machine.pressure!.memory_full = { avg10: 2, avg60: 2, avg300: 2 };
    let recovering = restarted.hysteresis;
    const recovery: string[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const at = 12_000 + index * 2_000;
      machine.sampled_at = AT(at);
      const assessment = assess({
        snapshot: machine,
        prior: recovering,
        observer_generation: "gen-2",
        now_ms: NOW + at,
      });
      recovering = assessment.hysteresis;
      recovery.push(assessment.state);
    }
    expect(recovery).toEqual(["elevated", "elevated", "elevated", "elevated", "normal", "normal"]);
  });

  test("state_since only moves when the state changes", () => {
    const first = assess({ prior: hysteresis({ state: "normal", state_since: AT(-600_000) }) });
    expect(first.hysteresis.state_since).toBe(AT(-600_000));
    const machine = snapshot();
    machine.pressure!.memory_full = { avg10: 95, avg60: 10, avg300: 1 };
    const changed = assess({
      snapshot: machine,
      prior: hysteresis({ state: "normal", state_since: AT(-600_000) }),
    });
    expect(changed.hysteresis.state_since).toBe(AT());
  });
});

describe("pressure assessment: platforms other than Linux", () => {
  function nativeSnapshot(platform: NodeJS.Platform): ResourceSnapshot {
    const machine = snapshot();
    machine.platform = platform;
    machine.namespace = "host";
    machine.support = {
      state: "partial",
      sampler: platform === "darwin" ? "darwin" : "win32",
      reason: "Linux pressure stall information is unavailable.",
    };
    machine.pressure = {
      state: "unsupported",
      cpu: null,
      memory: null,
      io: null,
      memory_full: null,
      io_full: null,
      reason: `Linux pressure stall information is unavailable on ${platform}.`,
    };
    machine.oom = {
      state: "unsupported",
      total_kills: null,
      kills_since_last_sample: null,
      last_kill_age_ms: null,
      reason: `Kernel OOM kill counters are not collected on ${platform}.`,
    };
    machine.vmstat = {
      state: "unsupported",
      swap_in_bytes_per_second: null,
      swap_out_bytes_per_second: null,
      direct_reclaim_pages_per_second: null,
      major_faults_per_second: null,
      counters_reset: false,
      reason: `Kernel memory reclaim counters are not collected on ${platform}.`,
    };
    return machine;
  }

  test.each([
    "darwin",
    "win32",
  ] as const)("%s keeps its native fields and reports the Linux-only dimensions unavailable", (platform) => {
    const assessment = assess({ snapshot: nativeSnapshot(platform) });
    expect(assessment.state).toBe("normal");
    expect(assessment.scope).toBe("native");
    expect(assessment.evidence_state).toBe("partial");
    expect(dimension(assessment, "memory_available")).toMatchObject({
      state: "supported",
      observed_value: 50,
      unit: "percent",
    });
    expect(dimension(assessment, "disk_available")).toMatchObject({
      state: "supported",
      unit: "bytes",
    });
    for (const name of [
      "memory_stall",
      "io_stall",
      "cpu_stall",
      "oom_kills",
      "swap_activity",
      "direct_reclaim",
    ] as const) {
      expect(dimension(assessment, name)?.state).toBe("unavailable");
    }
    expect(assessment.evidence.some((entry) => entry.dimension === "host_memory")).toBe(false);
    expect(codes(assessment)).toContain("evidence_unavailable");
  });

  test("a native platform still reaches critical from the dimensions it does expose", () => {
    const machine = nativeSnapshot("darwin");
    machine.disks = [
      {
        path: "/",
        state: "supported",
        total_bytes: 500 * GIB,
        available_bytes: 512 * MIB,
        used_percent: 99.9,
      },
    ];
    const assessment = assess({ snapshot: machine });
    expect(assessment.state).toBe("critical");
    expect(assessment.limiting_resource).toBe("storage");
  });
});

describe("pressure assessment: reported shape", () => {
  test("trend follows one field across the bounded window", () => {
    const machine = snapshot();
    machine.pressure!.memory_full = { avg10: 40, avg60: 10, avg300: 2 };
    const history = [10, 20, 30].map((value, index) => ({
      sampled_at: AT(-6_000 + index * 2_000),
      memory_full_avg10: value,
      io_full_avg10: 0,
      cpu_some_avg60: 1,
      memory_available_percent: 50,
      swap_out_bytes_per_second: 0,
    }));
    expect(
      assess({
        snapshot: machine,
        history,
        prior: hysteresis({ dimension_streaks: { memory_stall: 1 } }),
      }).trend,
    ).toBe("rising");
    const recovered = snapshot();
    recovered.pressure!.memory_full = { avg10: 5, avg60: 20, avg300: 30 };
    expect(assess({ snapshot: recovered, history }).trend).toBe("falling");
    expect(assess({ snapshot: machine, history: [] }).trend).toBe("unknown");
  });

  test("the assessment is observer only, versioned, and bounded", () => {
    const assessment = assess();
    expect(assessment.observer_only).toBe(true);
    expect(assessment.schema_version).toBe(1);
    expect(assessment.policy_version).toBe(PRESSURE_POLICY.policy_version);
    expect(assessment.reasons.length).toBeLessThanOrEqual(PRESSURE_POLICY.limits.max_reasons);
    expect(assessment.evidence.length).toBeLessThanOrEqual(PRESSURE_POLICY.limits.max_evidence);
    expect(assessment.observed_at).toBe(AT());
    expect(assessment.sample_age_ms).toBe(0);
  });

  test("the same input always produces the same output", () => {
    const machine = snapshot();
    machine.pressure!.memory_full = { avg10: 60, avg60: 30, avg300: 10 };
    const input = {
      snapshot: machine,
      findings: [finding()],
      prior: hysteresis({ state: "elevated", dimension_streaks: { memory_stall: 2 } }),
    };
    expect(JSON.stringify(assess(input))).toBe(JSON.stringify(assess(input)));
  });

  test("guidance covers every workload class and promises no agent count", () => {
    for (const state of ["normal", "elevated", "critical"] as const) {
      const machine = snapshot();
      if (state === "elevated") machine.pressure!.cpu = { avg10: 50, avg60: 50, avg300: 50 };
      if (state === "critical")
        machine.pressure!.memory_full = { avg10: 95, avg60: 90, avg300: 50 };
      const assessment = assess({
        snapshot: machine,
        prior: hysteresis({ dimension_streaks: { cpu_stall: 5 } }),
      });
      expect(assessment.state).toBe(state);
      expect(assessment.guidance.map((entry) => entry.workload_class)).toEqual([
        "lightweight",
        "cpu-heavy",
        "memory-heavy",
        "storage-heavy",
      ]);
      for (const entry of assessment.guidance) {
        expect(entry.summary).not.toMatch(/\b\d+\s+agents?\b/);
        expect(entry.summary.endsWith(".")).toBe(true);
      }
    }
  });

  test("a degraded findings source is stated rather than hidden", () => {
    const assessment = assess({
      findings: [],
      findings_capability: {
        source_kind: "supervisor-findings",
        state: "error",
        reason_code: "unreadable",
      },
    });
    expect(assessment.summary).toContain("Contributor evidence is incomplete");
  });

  test("every string is plain English without em-dashes", () => {
    const machine = snapshot();
    machine.namespace = "wsl";
    machine.pressure!.memory_full = { avg10: 95, avg60: 80, avg300: 20 };
    machine.vmstat!.swap_out_bytes_per_second = 173 * MIB;
    machine.vmstat!.direct_reclaim_pages_per_second = 150_000;
    const assessment = assess({
      snapshot: machine,
      findings: [finding()],
      prior: hysteresis({
        state: "critical",
        dimension_streaks: { memory_stall: 3, swap_activity: 3, direct_reclaim: 3 },
        oom_baseline_total_kills: 0,
      }),
    });
    const text = JSON.stringify(assessment);
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
    for (const reason of assessment.reasons) {
      expect(reason.summary.endsWith(".")).toBe(true);
      expect(reason.summary[0]).toBe(reason.summary[0]!.toUpperCase());
    }
    expect(assessment.summary.endsWith(".")).toBe(true);
  });
});
