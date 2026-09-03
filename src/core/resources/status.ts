import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { buildDiagnosticAdvice } from "../diagnostics/advice.ts";
import {
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  type SupervisorFinding,
} from "../supervisor/contract.ts";
import { readSupervisorStatus } from "../supervisor/status.ts";
import { supervisorPaths } from "../supervisor/storage.ts";
import {
  RESOURCE_SNAPSHOT_SCHEMA_VERSION,
  type ResourceDiskSample,
  type ResourceHostSample,
  type ResourceIoSample,
  type ResourceMachineSample,
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
  schema_version: 1;
  state: "fresh" | "stale" | "unavailable";
  reason: string | null;
  sampled_at: string | null;
  sample_age_ms: number | null;
  stale_after_ms: number;
  platform: NodeJS.Platform | null;
  namespace: ResourceSnapshot["namespace"];
  support: ResourceSnapshot["support"] | null;
  writer: { running: boolean; stale: boolean };
  assessment: "normal" | "elevated" | "critical" | "unknown";
  signals: string[];
  machine: ResourceMachineSample | null;
  disks: ResourceDiskSample[];
  pressure: ResourcePressureSample | null;
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
  const result: ResourceStatus = {
    schema_version: 1,
    state: "unavailable",
    reason: "snapshot_missing",
    sampled_at: null,
    sample_age_ms: null,
    stale_after_ms: RESOURCE_STATUS_STALE_MS,
    platform: null,
    namespace: "unknown",
    support: null,
    writer: { running: false, stale: false },
    assessment: "unknown",
    signals: [],
    machine: null,
    disks: [],
    pressure: null,
    io: null,
    host: null,
  };
  try {
    // Keep malformed service metadata from making the read expensive. The shared
    // status reader retains ownership of PID/start-token liveness checks.
    if (statSync(supervisorPaths(coordRoot).service).size <= 65_536) {
      const writer = readSupervisorStatus(coordRoot, nowMs);
      const futureHeartbeat =
        writer.record && Date.parse(writer.record.heartbeat_at) > nowMs + FUTURE_TOLERANCE_MS;
      result.writer = {
        running: writer.running && !futureHeartbeat,
        stale: writer.stale || !!futureHeartbeat,
      };
    }
  } catch {
    /* A missing writer must not break normal coordination. */
  }
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
  const assessment = assess(coordRoot, result, nowMs);
  result.assessment = assessment.assessment;
  result.signals = assessment.signals;
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
  if (status.state !== "fresh" || !status.machine) {
    const age =
      status.sample_age_ms === null ? "" : ` (${Math.round(status.sample_age_ms / 1_000)}s old)`;
    return `${status.state}${age}: ${status.reason?.replaceAll("_", " ") ?? "no measurements"}`;
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
  const condition = status.signals.length
    ? `; ${status.assessment}: ${status.signals.slice(0, 3).join(", ")}${status.signals.length > 3 ? ` (+${status.signals.length - 3})` : ""}`
    : "";
  return `${status.namespace}/${status.platform}: CPU ${cpu}, RAM ${ram}, disk ${diskText}; ${Math.round((status.sample_age_ms ?? 0) / 1_000)}s old${status.support?.state === "partial" ? "; partial" : ""}${!status.writer.running ? "; writer stopped" : ""}${condition}`;
}

export function formatResourceStatus(status: ResourceStatus, bin: string): string {
  const lines = [formatResourceSummary(status)];
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

function assess(
  coordRoot: string,
  status: ResourceStatus,
  nowMs: number,
): Pick<ResourceStatus, "assessment" | "signals"> {
  const unknown = { assessment: "unknown" as const, signals: [] };
  if (!status.writer.running) return unknown;
  try {
    const path = supervisorPaths(coordRoot).findings;
    const age = nowMs - statSync(path).mtimeMs;
    if (age > RESOURCE_STATUS_STALE_MS || age < -FUTURE_TOLERANCE_MS) return unknown;
    const report = readBoundedJson(path);
    if (
      !object(report) ||
      report.schema_version !== SUPERVISOR_FINDING_SCHEMA_VERSION ||
      !Array.isArray(report.active) ||
      report.active.length > 2000 ||
      !report.active.every(validFinding)
    )
      return unknown;
    const advice = buildDiagnosticAdvice({
      findings: report.active,
      sourceCapability: { source_kind: "supervisor-findings", state: "supported" },
      evaluatedAt: new Date(nowMs).toISOString(),
    });
    return {
      assessment: advice.pressure,
      signals: [...new Set(advice.contributing_findings.map((f) => text(f.finding_kind)))].sort(),
    };
  } catch {
    return unknown;
  }
}

function validFinding(v: unknown): v is SupervisorFinding {
  return (
    object(v) &&
    ["id", "finding_kind", "summary", "scope_kind", "scope_id", "observed_at"].every((key) =>
      string(v[key]),
    ) &&
    ["info", "warning", "critical"].includes(v.severity as string) &&
    ["opened", "resolved"].includes(v.state as string) &&
    number(v.occurrence_count) &&
    (v.attribution === undefined || object(v.attribution)) &&
    (v.workload_context === undefined || object(v.workload_context))
  );
}

function readBoundedJson(path: string): unknown {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > RESOURCE_STATUS_MAX_BYTES) throw new Error("snapshot_too_large");
    const buffer = Buffer.alloc(Math.min(RESOURCE_STATUS_MAX_BYTES + 1, size + 1));
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > RESOURCE_STATUS_MAX_BYTES) throw new Error("snapshot_too_large");
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
      (v.pressure.reason !== undefined && !string(v.pressure.reason)))
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
