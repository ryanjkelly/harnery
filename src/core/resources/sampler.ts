import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { cpus, loadavg, platform, release } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { parsePidmapRow } from "../agents/state/pidmap.ts";
import { checkPidToken } from "../agents/state/proc-start.ts";
import {
  RESOURCE_SNAPSHOT_SCHEMA_VERSION,
  type ResourceProcessGroup,
  type ResourceProcessSample,
  type ResourceSampleResult,
  type ResourceSamplerState,
  type ResourceSnapshot,
} from "./contract.ts";

const DEFAULT_CLOCK_TICKS = 100;
const DEFAULT_PAGE_SIZE = 4_096;
const DEFAULT_UNATTRIBUTED_CPU_FLOOR = 0.5;
const DEFAULT_UNATTRIBUTED_RSS_FLOOR = 64 * 1_024 * 1_024;
const DEFAULT_MAX_PROCESSES = 500;
const MAX_COMMAND_CHARS = 240;

interface LinuxProcessReading {
  pid: number;
  ppid: number;
  state: string;
  name: string;
  command: string;
  ticks: number;
  startTicks: number;
  rssBytes: number;
  ageSeconds: number;
}

interface LinuxCpuReading {
  total: number;
  idle: number;
}

interface ResourceSamplerOptions {
  procRoot?: string;
  nowMs?: number;
  clockTicks?: number;
  pageSize?: number;
  services?: readonly { pid: number; id: string }[];
  unattributedCpuFloor?: number;
  unattributedRssFloor?: number;
  maxProcesses?: number;
}

let cachedClockTicks: number | undefined;
let cachedPageSize: number | undefined;

export function sampleResources(
  coordRoot: string,
  previous?: ResourceSamplerState,
  options: ResourceSamplerOptions = {},
): ResourceSampleResult {
  const started = performance.now();
  const cpuBefore = process.cpuUsage();
  const nowMs = options.nowMs ?? Date.now();
  const currentPlatform = platform();
  if (currentPlatform !== "linux") {
    return {
      snapshot: unsupportedSnapshot(currentPlatform, nowMs, started, cpuBefore),
    };
  }

  const procRoot = options.procRoot ?? "/proc";
  if (!existsSync(join(procRoot, "stat"))) {
    return {
      snapshot: unsupportedSnapshot(
        currentPlatform,
        nowMs,
        started,
        cpuBefore,
        "procfs_unavailable",
      ),
    };
  }

  const clockTicks = options.clockTicks ?? systemClockTicks();
  const pageSize = options.pageSize ?? systemPageSize();
  const uptimeSeconds = parseUptime(readFileSync(join(procRoot, "uptime"), "utf8"));
  const cpu = parseLinuxCpu(readFileSync(join(procRoot, "stat"), "utf8"));
  const memory = parseMeminfo(readFileSync(join(procRoot, "meminfo"), "utf8"));
  const readings = readLinuxProcesses(procRoot, clockTicks, pageSize, uptimeSeconds);
  const anchors = readOwnershipAnchors(coordRoot, readings, options.services ?? []);
  const byPid = new Map(readings.map((reading) => [reading.pid, reading]));
  const processTicks = new Map<string, number>();
  const intervalMs = previous ? Math.max(0, nowMs - previous.sampled_at_ms) : null;
  const totalTickDelta = previous ? Math.max(0, cpu.total - previous.cpu_total_ticks) : 0;
  const logicalCpus = Math.max(1, cpus().length);
  const processes = readings.map((reading): ResourceProcessSample => {
    const identity = `${reading.pid}:${reading.startTicks}`;
    processTicks.set(identity, reading.ticks);
    const priorTicks = previous?.process_ticks.get(identity);
    const processDelta =
      priorTicks === undefined ? undefined : Math.max(0, reading.ticks - priorTicks);
    const cpuPercent =
      processDelta === undefined || totalTickDelta <= 0
        ? null
        : round1((processDelta / totalTickDelta) * logicalCpus * 100);
    const ownership = resolveOwnership(reading.pid, byPid, anchors);
    return {
      pid: reading.pid,
      ppid: reading.ppid,
      start_id: identity,
      state: reading.state,
      name: reading.name,
      command: reading.command,
      cpu_percent: cpuPercent,
      rss_bytes: reading.rssBytes,
      age_seconds: round1(reading.ageSeconds),
      owner_kind: ownership?.kind ?? "unattributed",
      owner_id: ownership?.id ?? null,
      owner_root_pid: ownership?.rootPid ?? null,
    };
  });
  const visible = processes
    .filter(
      (row) =>
        row.owner_kind !== "unattributed" ||
        (row.cpu_percent ?? 0) >=
          (options.unattributedCpuFloor ?? DEFAULT_UNATTRIBUTED_CPU_FLOOR) ||
        row.rss_bytes >= (options.unattributedRssFloor ?? DEFAULT_UNATTRIBUTED_RSS_FLOOR),
    )
    .sort(processSort)
    .slice(0, options.maxProcesses ?? DEFAULT_MAX_PROCESSES);
  const groups = aggregateGroups(visible);
  const cpuPercent =
    previous && totalTickDelta > 0
      ? round1(
          ((totalTickDelta - Math.max(0, cpu.idle - previous.cpu_idle_ticks)) / totalTickDelta) *
            100,
        )
      : null;
  const memoryTotal = memory.MemTotal ?? null;
  const memoryAvailable = memory.MemAvailable ?? memory.MemFree ?? null;
  const memoryUsed =
    memoryTotal !== null && memoryAvailable !== null
      ? Math.max(0, memoryTotal - memoryAvailable)
      : null;
  const swapTotal = memory.SwapTotal ?? null;
  const swapFree = memory.SwapFree ?? null;
  const swapUsed =
    swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null;
  const collectorCpu = process.cpuUsage(cpuBefore);
  const snapshot: ResourceSnapshot = {
    schema_version: RESOURCE_SNAPSHOT_SCHEMA_VERSION,
    sampled_at: new Date(nowMs).toISOString(),
    interval_ms: intervalMs,
    sample_duration_ms: round1(performance.now() - started),
    collector_cpu_ms: round1((collectorCpu.user + collectorCpu.system) / 1_000),
    platform: currentPlatform,
    namespace: /microsoft|wsl/i.test(release()) ? "wsl" : "host",
    support: { state: "supported", sampler: "procfs" },
    machine: {
      cpu_percent: cpuPercent,
      cpu_logical_count: logicalCpus,
      load_average: loadavg() as [number, number, number],
      memory_total_bytes: memoryTotal,
      memory_available_bytes: memoryAvailable,
      memory_used_bytes: memoryUsed,
      memory_percent:
        memoryUsed !== null && memoryTotal ? round1((memoryUsed / memoryTotal) * 100) : null,
      swap_total_bytes: swapTotal,
      swap_used_bytes: swapUsed,
      process_count: readings.length,
    },
    groups,
    processes: visible,
    visible_process_count: visible.length,
    omitted_process_count: Math.max(0, readings.length - visible.length),
    unattributed_process_count: visible.filter((row) => row.owner_kind === "unattributed").length,
  };
  return {
    snapshot,
    state: {
      sampled_at_ms: nowMs,
      cpu_total_ticks: cpu.total,
      cpu_idle_ticks: cpu.idle,
      process_ticks: processTicks,
    },
  };
}

export function parseLinuxProcessStat(line: string): {
  pid: number;
  name: string;
  state: string;
  ppid: number;
  ticks: number;
  startTicks: number;
  rssPages: number;
} | null {
  const open = line.indexOf("(");
  const close = line.lastIndexOf(")");
  if (open <= 0 || close <= open) return null;
  const pid = Number(line.slice(0, open).trim());
  const fields = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0] ?? "?";
  const ppid = Number(fields[1]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const startTicks = Number(fields[19]);
  const rssPages = Number(fields[21]);
  if (![pid, ppid, userTicks, systemTicks, startTicks, rssPages].every(Number.isFinite))
    return null;
  return {
    pid,
    name: line.slice(open + 1, close),
    state,
    ppid,
    ticks: userTicks + systemTicks,
    startTicks,
    rssPages: Math.max(0, rssPages),
  };
}

export function redactCommand(args: readonly string[]): string {
  const secretName =
    /(?:^|[-_])(token|secret|password|passwd|api[-_]?key|authorization)(?:$|[-_])/i;
  const output: string[] = [];
  let redactNext = false;
  for (const raw of args) {
    let value = raw;
    if (redactNext) {
      output.push("<redacted>");
      redactNext = false;
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 0 && secretName.test(value.slice(0, equals))) {
      value = `${value.slice(0, equals + 1)}<redacted>`;
    } else if (secretName.test(value.replace(/^--?/, ""))) {
      redactNext = true;
    }
    value = value.replace(/(https?:\/\/)[^:@\s/]+:[^@\s/]+@/gi, "$1<redacted>@");
    output.push(value.replace(/[\r\n\t]+/g, " "));
  }
  const joined = output.join(" ").trim();
  return joined.length <= MAX_COMMAND_CHARS ? joined : `${joined.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

function readLinuxProcesses(
  procRoot: string,
  clockTicks: number,
  pageSize: number,
  uptimeSeconds: number,
): LinuxProcessReading[] {
  const rows: LinuxProcessReading[] = [];
  for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pidRoot = join(procRoot, entry.name);
    try {
      const parsed = parseLinuxProcessStat(readFileSync(join(pidRoot, "stat"), "utf8"));
      if (!parsed) continue;
      const args = readFileSync(join(pidRoot, "cmdline"), "utf8").split("\0").filter(Boolean);
      let name = parsed.name;
      try {
        name = basename(readlinkSync(join(pidRoot, "exe"))) || name;
      } catch {
        // Kernel threads and racing processes may have no readable executable.
      }
      rows.push({
        pid: parsed.pid,
        ppid: parsed.ppid,
        state: parsed.state,
        name,
        command: redactCommand(args.length > 0 ? args : [parsed.name]),
        ticks: parsed.ticks,
        startTicks: parsed.startTicks,
        rssBytes: parsed.rssPages * pageSize,
        ageSeconds: Math.max(0, uptimeSeconds - parsed.startTicks / clockTicks),
      });
    } catch {
      // Process exits and permission boundaries are normal during a table scan.
    }
  }
  return rows;
}

interface OwnershipAnchor {
  kind: "agent" | "service";
  id: string;
}

function readOwnershipAnchors(
  coordRoot: string,
  readings: readonly LinuxProcessReading[],
  services: readonly { pid: number; id: string }[],
): Map<number, OwnershipAnchor> {
  const byPid = new Set(readings.map((row) => row.pid));
  const directory = join(coordRoot, ".harnery", "pid-map");
  const anchors = new Map<number, OwnershipAnchor>();
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory)) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!byPid.has(pid)) continue;
      try {
        const row = parsePidmapRow(readFileSync(join(directory, entry), "utf8"));
        if (!row.instanceId || checkPidToken(pid, row.startToken) === "mismatch") continue;
        anchors.set(pid, { kind: "agent", id: row.instanceId });
      } catch {
        // An unreadable or racing row cannot prove ownership.
      }
    }
  }
  for (const service of services) {
    if (byPid.has(service.pid) && service.id.trim()) {
      anchors.set(service.pid, { kind: "service", id: service.id.trim() });
    }
  }
  return anchors;
}

function resolveOwnership(
  pid: number,
  byPid: ReadonlyMap<number, LinuxProcessReading>,
  anchors: ReadonlyMap<number, OwnershipAnchor>,
): { kind: "agent" | "service"; id: string; rootPid: number } | undefined {
  const seen = new Set<number>();
  let cursor = pid;
  for (let hops = 0; hops < 64 && cursor > 0 && !seen.has(cursor); hops++) {
    seen.add(cursor);
    const owner = anchors.get(cursor);
    if (owner) return { ...owner, rootPid: cursor };
    cursor = byPid.get(cursor)?.ppid ?? 0;
  }
  return undefined;
}

function aggregateGroups(processes: readonly ResourceProcessSample[]): ResourceProcessGroup[] {
  const groups = new Map<string, ResourceProcessGroup>();
  for (const row of processes) {
    const id = row.owner_id ?? "unattributed";
    const key = `${row.owner_kind}:${id}`;
    const group = groups.get(key) ?? {
      kind: row.owner_kind,
      id,
      process_count: 0,
      cpu_percent: null,
      rss_bytes: 0,
      root_pids: [],
    };
    group.process_count += 1;
    group.rss_bytes += row.rss_bytes;
    if (row.cpu_percent !== null)
      group.cpu_percent = round1((group.cpu_percent ?? 0) + row.cpu_percent);
    if (row.owner_root_pid !== null && !group.root_pids.includes(row.owner_root_pid)) {
      group.root_pids.push(row.owner_root_pid);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      (right.cpu_percent ?? -1) - (left.cpu_percent ?? -1) ||
      right.rss_bytes - left.rss_bytes ||
      left.id.localeCompare(right.id),
  );
}

function processSort(left: ResourceProcessSample, right: ResourceProcessSample): number {
  return (
    (right.cpu_percent ?? -1) - (left.cpu_percent ?? -1) ||
    right.rss_bytes - left.rss_bytes ||
    left.pid - right.pid
  );
}

function parseLinuxCpu(content: string): LinuxCpuReading {
  const fields = content.split("\n")[0]?.trim().split(/\s+/).slice(1).map(Number) ?? [];
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) {
    throw new Error("procfs_cpu_invalid");
  }
  return {
    total: fields.reduce((sum, value) => sum + value, 0),
    idle: (fields[3] ?? 0) + (fields[4] ?? 0),
  };
}

function parseMeminfo(content: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of content.split("\n")) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (match) result[match[1]!] = Number(match[2]) * 1_024;
  }
  return result;
}

function parseUptime(content: string): number {
  const value = Number(content.trim().split(/\s+/, 1)[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error("procfs_uptime_invalid");
  return value;
}

function systemClockTicks(): number {
  cachedClockTicks ??= positiveGetconf("CLK_TCK", DEFAULT_CLOCK_TICKS);
  return cachedClockTicks;
}

function systemPageSize(): number {
  cachedPageSize ??= positiveGetconf("PAGESIZE", DEFAULT_PAGE_SIZE);
  return cachedPageSize;
}

function positiveGetconf(key: string, fallback: number): number {
  const result = spawnSync("getconf", [key], { encoding: "utf8", timeout: 1_000 });
  const value = result.status === 0 ? Number(result.stdout.trim()) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function unsupportedSnapshot(
  currentPlatform: NodeJS.Platform,
  nowMs: number,
  started: number,
  cpuBefore: NodeJS.CpuUsage,
  reason = "platform_unsupported",
): ResourceSnapshot {
  const collectorCpu = process.cpuUsage(cpuBefore);
  return {
    schema_version: RESOURCE_SNAPSHOT_SCHEMA_VERSION,
    sampled_at: new Date(nowMs).toISOString(),
    interval_ms: null,
    sample_duration_ms: round1(performance.now() - started),
    collector_cpu_ms: round1((collectorCpu.user + collectorCpu.system) / 1_000),
    platform: currentPlatform,
    namespace: "unknown",
    support: { state: "unsupported", sampler: "unsupported", reason },
    machine: {
      cpu_percent: null,
      cpu_logical_count: cpus().length,
      load_average: null,
      memory_total_bytes: null,
      memory_available_bytes: null,
      memory_used_bytes: null,
      memory_percent: null,
      swap_total_bytes: null,
      swap_used_bytes: null,
      process_count: 0,
    },
    groups: [],
    processes: [],
    visible_process_count: 0,
    omitted_process_count: 0,
    unattributed_process_count: 0,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
