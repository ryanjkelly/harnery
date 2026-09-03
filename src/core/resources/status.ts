import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { unknownPressureAssessment } from "../diagnostics/advice.ts";
import {
  PRESSURE_ASSESSMENT_SCHEMA_VERSION,
  PRESSURE_POLICY,
  type PressureAssessment,
  type PressureHysteresisState,
} from "../diagnostics/contract.ts";
import {
  SUPERVISOR_PRESSURE_SCHEMA_VERSION,
  type SupervisorCapability,
  type SupervisorPressureRecord,
} from "../supervisor/contract.ts";
import { readSupervisorStatus } from "../supervisor/status.ts";
import { supervisorPaths } from "../supervisor/storage.ts";
import {
  RESOURCE_SNAPSHOT_SCHEMA_VERSION,
  type ResourceDiskSample,
  type ResourceHostSample,
  type ResourceIoSample,
  type ResourceMachineSample,
  type ResourceOomSample,
  type ResourcePressureSample,
  type ResourceProcessSample,
  type ResourceSnapshot,
  type ResourceSupportState,
} from "./contract.ts";
import { resourcePaths } from "./storage.ts";

export const RESOURCE_STATUS_STALE_MS = 15_000;
export const RESOURCE_STATUS_MAX_BYTES = 4 * 1024 * 1024;
export const RESOURCE_STATUS_PROCESS_LIMIT = 20;
export const RESOURCE_HOST_STATUS_STALE_MS = 30_000;
const FUTURE_TOLERANCE_MS = 1_000;

export interface ResourceStatus {
  schema_version: 2;
  state: "fresh" | "stale" | "unavailable";
  reason: string | null;
  sampled_at: string | null;
  sample_age_ms: number | null;
  stale_after_ms: number;
  platform: NodeJS.Platform | null;
  namespace: ResourceSnapshot["namespace"];
  support: ResourceSnapshot["support"] | null;
  writer: { running: boolean; stale: boolean };
  /**
   * The one published pressure assessment, read from the observer's record so
   * this surface, the prompt notice, the dashboard, and a diagnostic bundle all
   * report the same answer for the same input.
   */
  assessment: PressureAssessment;
  /** The state the sample before the published one carried forward. */
  prior_hysteresis: PressureHysteresisState | null;
  /** Where the assessment came from, and why it is missing when it is. */
  assessment_capability: SupervisorCapability;
  machine: ResourceMachineSample | null;
  disks: ResourceDiskSample[];
  pressure: ResourcePressureSample | null;
  oom: ResourceOomSample | null;
  io: ResourceIoSample | null;
  host: ResourceHostSample | null;
  processes?: Array<
    Pick<
      ResourceProcessSample,
      "pid" | "name" | "cpu_percent" | "rss_bytes" | "owner_kind" | "owner_id"
    >
  >;
  processes_omitted?: number;
}

/** A bounded cache-only read. Never samples the OS or starts the writer. */
export function readResourceStatus(
  coordRoot: string,
  options: { nowMs?: number; includeProcesses?: boolean } = {},
): ResourceStatus {
  const nowMs = options.nowMs ?? Date.now();
  const writerState = readWriterState(coordRoot, nowMs);
  const published = readPublishedPressure(coordRoot, nowMs, writerState);
  const result: ResourceStatus = {
    schema_version: 2,
    state: "unavailable",
    reason: "snapshot_missing",
    sampled_at: null,
    sample_age_ms: null,
    stale_after_ms: RESOURCE_STATUS_STALE_MS,
    platform: null,
    namespace: "unknown",
    support: null,
    writer: writerState,
    assessment: published.assessment,
    prior_hysteresis: published.prior_hysteresis,
    assessment_capability: published.capability,
    machine: null,
    disks: [],
    pressure: null,
    oom: null,
    io: null,
    host: null,
  };
  let value: unknown;
  try {
    value = readBoundedJson(resourcePaths(coordRoot).snapshot);
  } catch (error) {
    result.reason =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "snapshot_missing"
        : error instanceof Error && error.message === "snapshot_too_large"
          ? "snapshot_too_large"
          : "snapshot_invalid";
    return result;
  }
  if (!validSnapshot(value)) return { ...result, reason: "snapshot_invalid" };
  const sampleMs = Date.parse(value.sampled_at);
  if (!Number.isFinite(sampleMs) || sampleMs - nowMs > FUTURE_TOLERANCE_MS) {
    return { ...result, reason: "snapshot_clock_invalid" };
  }
  result.sampled_at = value.sampled_at;
  result.sample_age_ms = Math.max(0, nowMs - sampleMs);
  result.platform = value.platform;
  result.namespace = value.namespace;
  result.support = {
    state: value.support.state,
    sampler: value.support.sampler,
    ...reason(value.support.reason),
  };
  if (result.sample_age_ms > RESOURCE_STATUS_STALE_MS) {
    return { ...result, state: "stale", reason: "snapshot_stale" };
  }
  if (value.support.state === "error" || value.support.state === "unsupported") {
    return { ...result, reason: `sampler_${value.support.state}` };
  }
  result.state = "fresh";
  result.reason = null;
  result.machine = projectMachine(value.machine);
  result.disks = (value.disks ?? []).map(projectDisk);
  result.pressure = value.pressure
    ? {
        state: value.pressure.state,
        ...reason(value.pressure.reason),
        cpu: projectWindow(value.pressure.cpu),
        memory: projectWindow(value.pressure.memory),
        io: projectWindow(value.pressure.io),
        memory_full: projectWindow(value.pressure.memory_full),
        io_full: projectWindow(value.pressure.io_full),
      }
    : null;
  result.oom = value.oom
    ? {
        state: value.oom.state,
        total_kills: value.oom.total_kills,
        kills_since_last_sample: value.oom.kills_since_last_sample,
        last_kill_age_ms: value.oom.last_kill_age_ms,
        ...reason(value.oom.reason),
      }
    : null;
  result.io = value.io
    ? {
        state: value.io.state,
        read_bytes_per_second: value.io.read_bytes_per_second,
        write_bytes_per_second: value.io.write_bytes_per_second,
        ...reason(value.io.reason),
      }
    : null;
  if (value.host) {
    const hostAge = nowMs - Date.parse(value.host.sampled_at);
    result.host =
      hostAge > RESOURCE_HOST_STATUS_STALE_MS || hostAge < -FUTURE_TOLERANCE_MS
        ? {
            platform: "win32",
            sampled_at: value.host.sampled_at,
            state: "error",
            machine: null,
            disks: [],
            reason: "host_snapshot_stale",
          }
        : {
            platform: "win32",
            sampled_at: value.host.sampled_at,
            state: value.host.state,
            machine: value.host.machine ? projectMachine(value.host.machine) : null,
            disks: value.host.disks.map(projectDisk),
            ...reason(value.host.reason),
          };
  }
  if (options.includeProcesses) {
    result.processes = [...value.processes]
      .sort((a, b) => b.rss_bytes - a.rss_bytes)
      .slice(0, RESOURCE_STATUS_PROCESS_LIMIT)
      .map((p) => ({
        pid: p.pid,
        name: text(p.name),
        cpu_percent: p.cpu_percent,
        rss_bytes: p.rss_bytes,
        owner_kind: p.owner_kind,
        owner_id: p.owner_id === null ? null : text(p.owner_id),
      }));
    result.processes_omitted =
      value.omitted_process_count + value.processes.length - result.processes.length;
  }
  return result;
}

export function formatResourceSummary(status: ResourceStatus): string {
  const lead = status.assessment.summary;
  if (status.state !== "fresh" || !status.machine) {
    const age =
      status.sample_age_ms === null ? "" : ` (${Math.round(status.sample_age_ms / 1_000)}s old)`;
    return `${lead} Measurements are ${status.state}${age}: ${status.reason?.replaceAll("_", " ") ?? "no measurements"}.`;
  }
  const m = status.machine;
  const disk = status.disks
    .filter((d) => d.available_bytes !== null)
    .reduce<ResourceDiskSample | null>(
      (least, d) =>
        !least || (d.available_bytes ?? Infinity) < (least.available_bytes ?? Infinity) ? d : least,
      null,
    );
  const cpu = m.cpu_percent === null ? "warming up" : `${Math.round(m.cpu_percent)}%`;
  const ram =
    m.memory_available_bytes === null
      ? "unknown"
      : `${formatBytes(m.memory_available_bytes)} available`;
  const diskText = disk ? `${formatBytes(disk.available_bytes as number)} available` : "unknown";
  return `${lead} ${status.namespace}/${status.platform}: CPU ${cpu}, RAM ${ram}, disk ${diskText}; ${Math.round((status.sample_age_ms ?? 0) / 1_000)}s old${status.support?.state === "partial" ? "; partial" : ""}${!status.writer.running ? "; writer stopped" : ""}.`;
}

export function formatResourceStatus(status: ResourceStatus, bin: string): string {
  const a = status.assessment;
  const lines = [formatResourceSummary(status)];
  lines.push(
    `Assessment: ${a.state} at ${a.scope} scope; limiting resource ${a.limiting_resource}; trend ${a.trend}; evidence ${a.evidence_state}; recommended action ${a.recommended_action}.`,
  );
  lines.push(
    `Evidence age: ${a.sample_age_ms === null ? "unknown" : `${Math.round(a.sample_age_ms / 1_000)}s`}; assessment source ${status.assessment_capability.state}${status.assessment_capability.reason_code ? ` (${status.assessment_capability.reason_code})` : ""}.`,
  );
  for (const item of a.reasons) lines.push(`Reason ${item.code}: ${item.summary}`);
  for (const item of a.guidance)
    lines.push(`Guidance for ${item.workload_class} work: ${item.summary}`);
  if (a.contributors.length) {
    lines.push("Contributors (who is using the resource, never the machine state):");
    for (const item of a.contributors) lines.push(`  ${formatContributor(item)}`);
    if (a.omitted_contributor_count)
      lines.push(`  ${a.omitted_contributor_count} other contributors omitted.`);
  }
  if (a.unattributed_memory_percent !== null)
    lines.push(
      `Unattributed memory: ${Math.round(a.unattributed_memory_percent)}% of machine memory has no validated owner.`,
    );
  if (status.state !== "fresh" || !status.writer.running)
    lines.push(
      `Start or inspect the writer with ${bin} supervisor start --keep-alive and ${bin} supervisor status.`,
    );
  if (status.host)
    lines.push(
      `Windows host: ${status.host.state}${status.host.machine ? `; CPU ${status.host.machine.cpu_percent === null ? "warming up" : `${Math.round(status.host.machine.cpu_percent)}%`}, RAM ${status.host.machine.memory_available_bytes === null ? "unknown" : `${formatBytes(status.host.machine.memory_available_bytes)} available`}` : `; ${status.host.reason ?? "unavailable"}`}`,
    );
  for (const disk of status.disks)
    lines.push(
      `Disk ${disk.path}: ${disk.available_bytes === null ? (disk.reason ?? disk.state) : `${formatBytes(disk.available_bytes)} available (${disk.used_percent === null ? "unknown" : `${Math.round(disk.used_percent)}%`} used)`}`,
    );
  if (status.pressure)
    lines.push(
      `Pressure: ${status.pressure.state}${status.pressure.reason ? ` (${status.pressure.reason})` : ""}`,
    );
  for (const [name, window] of [
    ["memory", status.pressure?.memory_full],
    ["I/O", status.pressure?.io_full],
  ] as const) {
    if (!window) continue;
    const direction =
      window.avg10 > window.avg60 ? "rising" : window.avg10 < window.avg60 ? "falling" : "steady";
    lines.push(
      `Full ${name} stalls: ${window.avg10}% / ${window.avg60}% / ${window.avg300}% (10s / 60s / 300s; ${direction}).`,
    );
  }
  if (status.oom) {
    const oom = status.oom;
    lines.push(
      `OOM kills: ${oom.total_kills ?? "unknown"} total; ${oom.kills_since_last_sample ?? "unknown"} since previous sample${oom.last_kill_age_ms === null ? "" : `; last increase ${Math.round(oom.last_kill_age_ms / 1000)}s ago`}${oom.reason ? ` (${oom.reason})` : ""}.`,
    );
  }
  if (status.io)
    lines.push(
      `Disk I/O: ${status.io.state}; read ${status.io.read_bytes_per_second === null ? "unknown" : `${formatBytes(status.io.read_bytes_per_second)}/s`}, write ${status.io.write_bytes_per_second === null ? "unknown" : `${formatBytes(status.io.write_bytes_per_second)}/s`}`,
    );
  if (status.processes) {
    lines.push("Processes (largest memory first):");
    for (const p of status.processes)
      lines.push(
        `  ${p.pid} ${p.name}: ${formatBytes(p.rss_bytes)}, CPU ${p.cpu_percent === null ? "unknown" : `${Math.round(p.cpu_percent)}%`}, ${p.owner_kind}${p.owner_id ? ` ${p.owner_id}` : ""}`,
      );
    if (status.processes_omitted)
      lines.push(`  ${status.processes_omitted} other processes omitted.`);
  }
  return lines.join("\n");
}

/** Ownership is stated only when attribution is exact. */
function formatContributor(item: PressureAssessment["contributors"][number]): string {
  const owner =
    item.attribution_confidence === "exact" && item.owner_id
      ? `${item.owner_kind ?? "owner"} ${item.owner_id}`
      : item.attribution_state === "unattributed"
        ? "no validated owner"
        : "owner not confirmed";
  return `${item.finding_kind} ${item.scope_kind}:${item.scope_id} (${owner}): ${item.summary}`;
}

export const PRESSURE_RECORD_MAX_BYTES = 256 * 1024;

export interface PublishedPressure {
  assessment: PressureAssessment;
  prior_hysteresis: PressureHysteresisState | null;
  capability: SupervisorCapability;
  record: SupervisorPressureRecord | null;
}

/**
 * Read the assessment the observer published. Bounded, cache only, and never a
 * computation: a missing, stale, or malformed record yields `unknown` with the
 * reason stated, because a gap in the evidence is not a measurement of health.
 */
export function readPublishedPressure(
  coordRoot: string,
  nowMs = Date.now(),
  writer?: ResourceStatus["writer"],
): PublishedPressure {
  const sourceKind = "supervisor.pressure";
  const observedAt = new Date(nowMs).toISOString();
  const gap = (
    state: Exclude<SupervisorCapability["state"], "supported">,
    reasonCode: string,
    summary: string,
    stale = false,
  ): PublishedPressure => ({
    assessment: unknownPressureAssessment({
      observedAt,
      reasonCode: stale ? "snapshot_stale" : "evidence_unavailable",
      summary,
    }),
    prior_hysteresis: null,
    capability: { source_kind: sourceKind, state, reason_code: reasonCode },
    record: null,
  });
  // A record can only be trusted while its writer is alive. Every surface makes
  // the same check here so none of them reports a state the others do not.
  if (!(writer ?? readWriterState(coordRoot, nowMs)).running) {
    return gap(
      "expired",
      "pressure_observer_not_running",
      "Local resource pressure cannot be determined because the resource observer is not running.",
    );
  }
  const path = supervisorPaths(coordRoot).pressure;
  let record: unknown;
  try {
    const age = nowMs - statSync(path).mtimeMs;
    if (age > PRESSURE_POLICY.sample_staleness_ms || age < -FUTURE_TOLERANCE_MS) {
      return gap(
        "expired",
        "pressure_record_stale",
        `Local resource pressure cannot be determined because the published assessment is ${Math.round(Math.abs(age) / 1_000)} seconds old.`,
        true,
      );
    }
    record = readBoundedJson(path, PRESSURE_RECORD_MAX_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return gap(
        "unsupported",
        "pressure_record_missing",
        "Local resource pressure cannot be determined because the observer has not published an assessment yet.",
      );
    }
    if (error instanceof Error && error.message === "snapshot_too_large") {
      return gap(
        "error",
        "pressure_record_too_large",
        "Local resource pressure cannot be determined because the published assessment is larger than the read limit.",
      );
    }
    return gap(
      "malformed",
      "pressure_record_malformed",
      "Local resource pressure cannot be determined because the published assessment could not be parsed.",
    );
  }
  if (!validPressureRecord(record)) {
    return gap(
      "malformed",
      "pressure_record_malformed",
      "Local resource pressure cannot be determined because the published assessment did not match the expected shape.",
    );
  }
  return {
    assessment: record.assessment,
    prior_hysteresis: record.prior_hysteresis,
    capability: { source_kind: sourceKind, state: "supported" },
    record,
  };
}

/** Whether the observer that writes both the snapshot and the record is alive. */
function readWriterState(coordRoot: string, nowMs: number): ResourceStatus["writer"] {
  try {
    // Keep malformed service metadata from making the read expensive. The shared
    // status reader retains ownership of PID/start-token liveness checks.
    if (statSync(supervisorPaths(coordRoot).service).size > 65_536) {
      return { running: false, stale: false };
    }
    const writer = readSupervisorStatus(coordRoot, nowMs);
    const futureHeartbeat =
      writer.record && Date.parse(writer.record.heartbeat_at) > nowMs + FUTURE_TOLERANCE_MS;
    return {
      running: writer.running && !futureHeartbeat,
      stale: writer.stale || !!futureHeartbeat,
    };
  } catch {
    // A missing writer must not break normal coordination.
    return { running: false, stale: false };
  }
}

function validPressureRecord(v: unknown): v is SupervisorPressureRecord {
  if (
    !object(v) ||
    v.schema_version !== SUPERVISOR_PRESSURE_SCHEMA_VERSION ||
    !string(v.published_at) ||
    !string(v.observer_generation) ||
    !validAssessment(v.assessment) ||
    !(v.prior_hysteresis === null || validHysteresis(v.prior_hysteresis))
  )
    return false;
  return true;
}

function validAssessment(v: unknown): v is PressureAssessment {
  if (
    !object(v) ||
    v.schema_version !== PRESSURE_ASSESSMENT_SCHEMA_VERSION ||
    v.observer_only !== true ||
    !["normal", "elevated", "critical", "unknown"].includes(v.state as string) ||
    !["guest", "native", "windows-host"].includes(v.scope as string) ||
    !["memory", "cpu", "io", "storage", "none", "unknown"].includes(
      v.limiting_resource as string,
    ) ||
    !["rising", "steady", "falling", "unknown"].includes(v.trend as string) ||
    !string(v.observed_at) ||
    !nullable(v.sample_age_ms) ||
    !["complete", "partial", "unavailable"].includes(v.evidence_state as string) ||
    !boundedArray(v.evidence, PRESSURE_POLICY.limits.max_evidence) ||
    !boundedArray(v.reasons, PRESSURE_POLICY.limits.max_reasons) ||
    !boundedArray(v.contributors, PRESSURE_POLICY.limits.max_contributors) ||
    !number(v.omitted_contributor_count) ||
    !percent(v.unattributed_memory_percent) ||
    !["proceed", "limit-heavy-work", "avoid-new-heavy-work", "unknown"].includes(
      v.recommended_action as string,
    ) ||
    !string(v.summary) ||
    !boundedArray(v.guidance, 8) ||
    !validHysteresis(v.hysteresis) ||
    !number(v.policy_version)
  )
    return false;
  return (
    (v.reasons as unknown[]).every(
      (row) => object(row) && string(row.code) && string(row.summary),
    ) &&
    (v.guidance as unknown[]).every(
      (row) => object(row) && string(row.workload_class) && string(row.summary),
    ) &&
    (v.contributors as unknown[]).every(
      (row) =>
        object(row) &&
        string(row.finding_id) &&
        string(row.finding_kind) &&
        string(row.summary) &&
        ["exact", "none"].includes(row.attribution_confidence as string),
    )
  );
}

function validHysteresis(v: unknown): v is PressureHysteresisState {
  return (
    object(v) &&
    ["normal", "elevated", "critical", "unknown"].includes(v.state as string) &&
    string(v.state_since) &&
    number(v.consecutive_clear_samples) &&
    object(v.dimension_streaks) &&
    (v.oom_baseline_total_kills === null || number(v.oom_baseline_total_kills)) &&
    (v.oom_hold_until === null || string(v.oom_hold_until)) &&
    (v.observer_generation === null || string(v.observer_generation))
  );
}

function boundedArray(v: unknown, max: number): v is unknown[] {
  return Array.isArray(v) && v.length <= max;
}

function readBoundedJson(path: string, maxBytes = RESOURCE_STATUS_MAX_BYTES): unknown {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > maxBytes) throw new Error("snapshot_too_large");
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, size + 1));
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > maxBytes) throw new Error("snapshot_too_large");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function number(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
function nullable(v: unknown): boolean {
  return v === null || number(v);
}
function percent(v: unknown): boolean {
  return v === null || (number(v) && v <= 100);
}
function support(v: unknown): v is ResourceSupportState {
  return ["supported", "partial", "unsupported", "error"].includes(v as string);
}
function string(v: unknown): v is string {
  return typeof v === "string" && v.length <= 4096;
}
function validMachine(v: unknown): v is ResourceMachineSample {
  return (
    object(v) &&
    percent(v.cpu_percent) &&
    number(v.cpu_logical_count) &&
    (v.cpu_available_parallelism === undefined || number(v.cpu_available_parallelism)) &&
    (v.load_average === null ||
      (Array.isArray(v.load_average) &&
        v.load_average.length === 3 &&
        v.load_average.every(number))) &&
    [
      "memory_total_bytes",
      "memory_available_bytes",
      "memory_used_bytes",
      "swap_total_bytes",
      "swap_used_bytes",
    ].every((k) => nullable(v[k])) &&
    percent(v.memory_percent) &&
    nullable(v.process_count) &&
    !(
      number(v.memory_total_bytes) &&
      number(v.memory_available_bytes) &&
      v.memory_available_bytes > v.memory_total_bytes
    )
  );
}
function validDisk(v: unknown): v is ResourceDiskSample {
  return (
    object(v) &&
    string(v.path) &&
    support(v.state) &&
    nullable(v.total_bytes) &&
    nullable(v.available_bytes) &&
    percent(v.used_percent) &&
    (v.reason === undefined || string(v.reason)) &&
    !(number(v.total_bytes) && number(v.available_bytes) && v.available_bytes > v.total_bytes)
  );
}
function validWindow(v: unknown): boolean {
  return (
    v === null ||
    (object(v) && ["avg10", "avg60", "avg300"].every((k) => number(v[k]) && v[k] <= 100))
  );
}
function validSnapshot(v: unknown): v is ResourceSnapshot {
  if (
    !object(v) ||
    v.schema_version !== RESOURCE_SNAPSHOT_SCHEMA_VERSION ||
    !string(v.sampled_at) ||
    ![
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
      "netbsd",
    ].includes(v.platform as string) ||
    !["host", "wsl", "unknown"].includes(v.namespace as string) ||
    !object(v.support) ||
    !support(v.support.state) ||
    !["procfs", "darwin", "win32", "unsupported"].includes(v.support.sampler as string) ||
    (v.support.reason !== undefined && !string(v.support.reason)) ||
    !validMachine(v.machine) ||
    !nullable(v.interval_ms) ||
    !number(v.sample_duration_ms) ||
    !number(v.collector_cpu_ms) ||
    !number(v.omitted_process_count) ||
    !Array.isArray(v.processes) ||
    v.processes.length > 10000
  )
    return false;
  if (
    v.disks !== undefined &&
    (!Array.isArray(v.disks) || v.disks.length > 64 || !v.disks.every(validDisk))
  )
    return false;
  if (
    v.pressure !== undefined &&
    (!object(v.pressure) ||
      !support(v.pressure.state) ||
      !validWindow(v.pressure.cpu) ||
      !validWindow(v.pressure.memory) ||
      !validWindow(v.pressure.io) ||
      !validWindow(v.pressure.memory_full) ||
      !validWindow(v.pressure.io_full) ||
      (v.pressure.reason !== undefined && !string(v.pressure.reason)))
  )
    return false;
  if (
    v.oom !== undefined &&
    (!object(v.oom) ||
      !support(v.oom.state) ||
      !["total_kills", "kills_since_last_sample"].every(
        (key) =>
          v.oom !== null &&
          object(v.oom) &&
          (v.oom[key] === null || (number(v.oom[key]) && Number.isSafeInteger(v.oom[key]))),
      ) ||
      !nullable(v.oom.last_kill_age_ms) ||
      (v.oom.reason !== undefined && !string(v.oom.reason)))
  )
    return false;
  if (
    v.io !== undefined &&
    (!object(v.io) ||
      !support(v.io.state) ||
      !nullable(v.io.read_bytes_per_second) ||
      !nullable(v.io.write_bytes_per_second) ||
      (v.io.reason !== undefined && !string(v.io.reason)))
  )
    return false;
  if (
    v.host !== undefined &&
    (!object(v.host) ||
      v.host.platform !== "win32" ||
      !support(v.host.state) ||
      !string(v.host.sampled_at) ||
      !Number.isFinite(Date.parse(v.host.sampled_at)) ||
      (v.host.machine !== null && !validMachine(v.host.machine)) ||
      !Array.isArray(v.host.disks) ||
      v.host.disks.length > 64 ||
      !v.host.disks.every(validDisk) ||
      (v.host.reason !== undefined && !string(v.host.reason)))
  )
    return false;
  return v.processes.every(
    (p) =>
      object(p) &&
      Number.isSafeInteger(p.pid) &&
      number(p.pid) &&
      string(p.name) &&
      nullable(p.cpu_percent) &&
      number(p.rss_bytes) &&
      ["agent", "service", "unattributed"].includes(p.owner_kind as string) &&
      (p.owner_id === null || string(p.owner_id)),
  );
}

function projectMachine(m: ResourceMachineSample): ResourceMachineSample {
  return {
    cpu_percent: m.cpu_percent,
    cpu_logical_count: m.cpu_logical_count,
    ...(m.cpu_available_parallelism === undefined
      ? {}
      : { cpu_available_parallelism: m.cpu_available_parallelism }),
    load_average: m.load_average,
    memory_total_bytes: m.memory_total_bytes,
    memory_available_bytes: m.memory_available_bytes,
    memory_used_bytes: m.memory_used_bytes,
    memory_percent: m.memory_percent,
    swap_total_bytes: m.swap_total_bytes,
    swap_used_bytes: m.swap_used_bytes,
    process_count: m.process_count,
  };
}
function projectDisk(d: ResourceDiskSample): ResourceDiskSample {
  return {
    path: text(d.path),
    state: d.state,
    total_bytes: d.total_bytes,
    available_bytes: d.available_bytes,
    used_percent: d.used_percent,
    ...reason(d.reason),
  };
}
function projectWindow(v: ResourcePressureSample["cpu"]): ResourcePressureSample["cpu"] {
  return v ? { avg10: v.avg10, avg60: v.avg60, avg300: v.avg300 } : null;
}
function text(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Cache strings must not inject terminal control sequences.
  return s.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240);
}
function reason(s: string | undefined): { reason?: string } {
  return s === undefined ? {} : { reason: text(s) };
}
function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`;
}
