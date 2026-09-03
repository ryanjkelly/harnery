import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import {
  RESOURCE_SNAPSHOT_SCHEMA_VERSION,
  type ResourceDiskSample,
  type ResourceHostSample,
  type ResourceMachineSample,
  type ResourceSampleResult,
  type ResourceSamplerState,
} from "./contract.ts";

export type NativeResourceCommand = (file: string, args: readonly string[]) => string | null;

export interface NativeResourceSamplerOptions {
  nowMs?: number;
  platform?: "darwin" | "win32";
  os?: Partial<
    Pick<typeof os, "cpus" | "totalmem" | "freemem" | "availableParallelism" | "loadavg">
  >;
  command?: NativeResourceCommand;
  backgroundHost?: boolean;
  /** Supervisors use the background collector to keep native CPU sampling on cadence. */
  hostCollector?: () => ResourceHostSample;
}

const WINDOWS_CACHE_MS = 15_000;
const COMMAND_TIMEOUT_MS = 4_000;

// Queries are static and read-only. Individual optional providers may be absent.
const WINDOWS_QUERY = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$osInfo = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory,NumberOfProcesses
$processors = $null; $pagefiles = $null; $disks = $null
try { $processors = @(Get-CimInstance Win32_Processor -Property NumberOfLogicalProcessors,LoadPercentage | Select-Object NumberOfLogicalProcessors,LoadPercentage) } catch {}
try { $pagefiles = @(Get-CimInstance Win32_PageFileUsage -Property AllocatedBaseSize,CurrentUsage | Select-Object AllocatedBaseSize,CurrentUsage) } catch {}
try { $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' -Property DeviceID,Size,FreeSpace | Select-Object DeviceID,Size,FreeSpace) } catch {}
[pscustomobject]@{
  sampled_at = [DateTime]::UtcNow.ToString('o')
  memory_total_kib = $osInfo.TotalVisibleMemorySize
  memory_available_kib = $osInfo.FreePhysicalMemory
  process_count = $osInfo.NumberOfProcesses
  processors = $processors
  pagefiles = $pagefiles
  disks = $disks
} | ConvertTo-Json -Depth 4 -Compress
`;

function runNativeCommand(file: string, args: readonly string[]): string | null {
  const macTools: Record<string, string> = {
    vm_stat: "/usr/bin/vm_stat",
    sysctl: "/usr/sbin/sysctl",
    ps: "/bin/ps",
  };
  const executable = os.platform() === "darwin" ? (macTools[file] ?? file) : file;
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1_048_576,
    windowsHide: true,
    env: os.platform() === "darwin" ? { ...process.env, LC_ALL: "C" } : undefined,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && !result.error ? result.stdout : null;
}

function readCommand(
  command: NativeResourceCommand,
  file: string,
  args: readonly string[],
): string | null {
  try {
    return command(file, args);
  } catch {
    return null;
  }
}

export function sampleNativeResources(
  _coordRoot: string,
  previous?: ResourceSamplerState,
  options: NativeResourceSamplerOptions = {},
): ResourceSampleResult {
  const started = performance.now();
  const cpuBefore = process.cpuUsage();
  const nowMs = options.nowMs ?? Date.now();
  const platform = options.platform ?? os.platform();
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("native_resource_platform_invalid");
  }
  const nativeOs = { ...os, ...options.os };
  const command = options.command ?? runNativeCommand;
  const cpuRows = nativeOs.cpus();
  const cpu = sumCpuCounters(cpuRows);
  const reasons = ["native_process_attribution_unavailable"];
  let available = nonnegative(nativeOs.freemem());
  const total = positive(nativeOs.totalmem());
  let swap: { total: number; used: number } | null = null;
  let processCount: number | null = null;
  if (platform === "darwin") {
    const vm = parseMacVmStat(readCommand(command, "vm_stat", []) ?? "");
    if (vm) {
      available = vm.available_bytes;
      reasons.push("memory_available_estimated_from_free_inactive_speculative_pages");
    } else {
      reasons.push("vm_stat_unavailable_using_free_memory");
    }
    swap = parseMacSwapUsage(readCommand(command, "sysctl", ["-n", "vm.swapusage"]) ?? "");
    processCount = parseProcessCount(readCommand(command, "ps", ["-axo", "pid="]));
  } else {
    const host =
      options.hostCollector?.() ??
      (options.backgroundHost
        ? collectWindowsHostInBackground({ nowMs })
        : collectWindowsHost({ nowMs, command }));
    if (host.machine) {
      swap =
        host.machine.swap_total_bytes !== null && host.machine.swap_used_bytes !== null
          ? { total: host.machine.swap_total_bytes, used: host.machine.swap_used_bytes }
          : null;
      processCount = host.machine.process_count;
    } else {
      reasons.push(host.reason ?? "windows_auxiliary_metrics_unavailable");
    }
  }
  if (total !== null && available !== null && available > total) available = null;
  const used = total !== null && available !== null ? total - available : null;
  const cpuPercent = cpu ? cpuDeltaPercent(cpu, previous, nowMs) : null;
  if (!cpu) reasons.push("cpu_counters_unavailable");
  if (!swap) reasons.push("swap_unavailable");
  if (processCount === null) reasons.push("process_count_unavailable");
  const collectorCpu = process.cpuUsage(cpuBefore);
  return {
    snapshot: {
      schema_version: RESOURCE_SNAPSHOT_SCHEMA_VERSION,
      sampled_at: new Date(nowMs).toISOString(),
      interval_ms: previous ? Math.max(0, nowMs - previous.sampled_at_ms) : null,
      sample_duration_ms: round1(performance.now() - started),
      collector_cpu_ms: round1((collectorCpu.user + collectorCpu.system) / 1_000),
      platform,
      namespace: "host",
      support: { state: "partial", sampler: platform, reason: reasons.join("; ") },
      machine: {
        cpu_percent: cpuPercent,
        cpu_logical_count: cpuRows.length,
        cpu_available_parallelism: nativeOs.availableParallelism(),
        load_average:
          platform === "darwin" ? (nativeOs.loadavg() as [number, number, number]) : null,
        memory_total_bytes: total,
        memory_available_bytes: available,
        memory_used_bytes: used,
        memory_percent: used !== null && total !== null ? round1((used / total) * 100) : null,
        swap_total_bytes: swap?.total ?? null,
        swap_used_bytes: swap?.used ?? null,
        process_count: processCount,
      },
      groups: [],
      processes: [],
      visible_process_count: 0,
      omitted_process_count: processCount ?? 0,
      unattributed_process_count: 0,
    },
    ...(cpu
      ? {
          state: {
            sampled_at_ms: nowMs,
            cpu_total_ticks: cpu.total,
            cpu_idle_ticks: cpu.idle,
            process_ticks: new Map(),
            process_owners: new Map(),
          },
        }
      : {}),
  };
}

export function parseMacVmStat(output: string): { available_bytes: number } | null {
  const pageSize = positive(output.match(/page size of (\d+) bytes/)?.[1]);
  if (pageSize === null) return null;
  const fields = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^Pages (free|inactive|speculative):\s*(\d+)\.?\s*$/.exec(line.trim());
    if (match) fields.set(match[1]!, Number(match[2]));
    else if (/^Pages (free|inactive|speculative):/.test(line.trim())) return null;
  }
  const free = fields.get("free");
  const inactive = fields.get("inactive");
  if (free === undefined || inactive === undefined) return null;
  // Purgeable pages overlap other queues; adding them again would double count.
  const available = (free + inactive + (fields.get("speculative") ?? 0)) * pageSize;
  return Number.isSafeInteger(available) ? { available_bytes: available } : null;
}

export function parseMacSwapUsage(output: string): { total: number; used: number } | null {
  const values = new Map<string, number>();
  for (const match of output.matchAll(/\b(total|used)\s*=\s*([\d.]+)([KMGT]?)\b/g)) {
    const multiplier = 1_024 ** (match[3] ? "KMGT".indexOf(match[3]) + 1 : 0);
    const value = nonnegative(Number(match[2]) * multiplier);
    if (value !== null) values.set(match[1]!, Math.round(value));
  }
  const total = values.get("total");
  const used = values.get("used");
  return total !== undefined && used !== undefined && used <= total ? { total, used } : null;
}

function parseProcessCount(output: string | null): number | null {
  if (!output?.trim()) return null;
  const rows = output.trim().split(/\r?\n/);
  return rows.every((row) => /^\s*\d+\s*$/.test(row)) ? rows.length : null;
}

function sumCpuCounters(rows: readonly os.CpuInfo[]): { total: number; idle: number } | null {
  let total = 0;
  let idle = 0;
  if (rows.length === 0) return null;
  for (const row of rows) {
    const times = [row.times.user, row.times.nice, row.times.sys, row.times.idle, row.times.irq];
    if (times.some((time) => nonnegative(time) === null)) return null;
    total += times.reduce((sum, value) => sum + value, 0);
    idle += row.times.idle;
  }
  return Number.isSafeInteger(total) && total > 0 ? { total, idle } : null;
}

function cpuDeltaPercent(
  cpu: { total: number; idle: number },
  previous: ResourceSamplerState | undefined,
  nowMs: number,
): number | null {
  if (!previous || nowMs <= previous.sampled_at_ms) return null;
  const totalDelta = cpu.total - previous.cpu_total_ticks;
  const idleDelta = cpu.idle - previous.cpu_idle_ticks;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  return round1(((totalDelta - idleDelta) / totalDelta) * 100);
}

export interface WindowsHostOptions {
  nowMs?: number;
  command?: NativeResourceCommand;
}

export function createWindowsHostCollector(): (options?: WindowsHostOptions) => ResourceHostSample {
  const cache = new WeakMap<NativeResourceCommand, { at: number; sample: ResourceHostSample }>();
  return (options = {}) => {
    const nowMs = options.nowMs ?? Date.now();
    const command = options.command ?? runNativeCommand;
    const cached = cache.get(command);
    if (cached && nowMs >= cached.at && nowMs - cached.at < WINDOWS_CACHE_MS) return cached.sample;
    let sample: ResourceHostSample;
    try {
      const executable =
        command === runNativeCommand ? windowsPowerShellExecutable() : "powershell.exe";
      const output = command(executable, windowsPowerShellArgs());
      sample =
        output === null
          ? unavailableWindowsHost(nowMs, "windows_host_query_failed")
          : parseWindowsResourceOutput(output, nowMs);
    } catch {
      sample = unavailableWindowsHost(nowMs, "windows_host_query_failed");
    }
    // Cache failures too: missing interop/CIM must not launch PowerShell every tick.
    cache.set(command, { at: nowMs, sample });
    return sample;
  };
}

export const collectWindowsHost = createWindowsHostCollector();

export type NativeResourceAsyncCommand = (
  file: string,
  args: readonly string[],
) => Promise<string | null>;

export interface WindowsHostBackgroundOptions {
  nowMs?: number;
  command?: NativeResourceAsyncCommand;
}

function runWindowsCommandAsync(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1_048_576,
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/** Return immediately; one process-wide probe refreshes all callers' cached host reading. */
export function createWindowsHostBackgroundCollector(): (
  options?: WindowsHostBackgroundOptions,
) => ResourceHostSample {
  const cache = new WeakMap<
    NativeResourceAsyncCommand,
    { at: number; sample: ResourceHostSample; pending: boolean }
  >();
  return (options = {}) => {
    const nowMs = options.nowMs ?? Date.now();
    const command = options.command ?? runWindowsCommandAsync;
    let entry = cache.get(command);
    if (entry?.pending || (entry && nowMs >= entry.at && nowMs - entry.at < WINDOWS_CACHE_MS))
      return entry.sample;
    entry ??= {
      at: nowMs,
      sample: { ...unavailableWindowsHost(nowMs, "windows_host_query_pending"), state: "partial" },
      pending: false,
    };
    entry.at = nowMs;
    entry.pending = true;
    cache.set(command, entry);
    const current = entry;
    const executable =
      command === runWindowsCommandAsync ? windowsPowerShellExecutable() : "powershell.exe";
    // Resolve on a microtask so even an injected synchronous throw cannot interrupt a tick.
    void Promise.resolve()
      .then(() => command(executable, windowsPowerShellArgs()))
      .then((output) => {
        current.sample =
          output === null
            ? unavailableWindowsHost(nowMs, "windows_host_query_failed")
            : parseWindowsResourceOutput(output, nowMs);
      })
      .catch(() => {
        current.sample = unavailableWindowsHost(nowMs, "windows_host_query_failed");
      })
      .finally(() => {
        current.pending = false;
      });
    return current.sample;
  };
}

export const collectWindowsHostInBackground = createWindowsHostBackgroundCollector();

function windowsPowerShellExecutable(): string {
  // A WSL toolchain may deliberately exclude Windows executables from PATH.
  const wslPowerShell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  return os.platform() === "linux" && existsSync(wslPowerShell) ? wslPowerShell : "powershell.exe";
}

function windowsPowerShellArgs(): string[] {
  // Preserve the static multiline program across both Win32 and WSL argument transports.
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(WINDOWS_QUERY, "utf16le").toString("base64"),
  ];
}

export function parseWindowsResourceOutput(output: string, nowMs = Date.now()): ResourceHostSample {
  let row: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, "").trim());
    if (!isRecord(parsed)) throw new Error("invalid");
    row = parsed;
  } catch {
    return unavailableWindowsHost(nowMs, "windows_host_output_invalid");
  }
  const totalKiB = positive(row.memory_total_kib);
  const availableKiB = nonnegative(row.memory_available_kib);
  if (totalKiB === null || availableKiB === null || availableKiB > totalKiB) {
    return unavailableWindowsHost(nowMs, "windows_host_memory_invalid");
  }
  const processors = records(row.processors);
  let logical = 0;
  let weightedCpu = 0;
  let cpuValid = processors !== null && processors.length > 0;
  for (const processor of processors ?? []) {
    const count = positive(processor.NumberOfLogicalProcessors);
    const percent = nonnegative(processor.LoadPercentage);
    if (count === null || !Number.isInteger(count)) cpuValid = false;
    else logical += count;
    if (count === null || percent === null || percent > 100) cpuValid = false;
    else weightedCpu += count * percent;
  }
  const pagefiles = records(row.pagefiles);
  let swapTotal = 0;
  let swapUsed = 0;
  let swapValid = pagefiles !== null;
  for (const file of pagefiles ?? []) {
    const total = nonnegative(file.AllocatedBaseSize);
    const used = nonnegative(file.CurrentUsage);
    if (total === null || used === null || used > total) swapValid = false;
    else {
      swapTotal += total * 1_048_576;
      swapUsed += used * 1_048_576;
    }
  }
  const disks = (records(row.disks) ?? []).map(parseWindowsDisk);
  const processCount = nonnegative(row.process_count);
  const machine: ResourceMachineSample = {
    cpu_percent: cpuValid && logical > 0 ? round1(weightedCpu / logical) : null,
    cpu_logical_count: logical,
    load_average: null,
    memory_total_bytes: totalKiB * 1_024,
    memory_available_bytes: availableKiB * 1_024,
    memory_used_bytes: (totalKiB - availableKiB) * 1_024,
    memory_percent: round1(((totalKiB - availableKiB) / totalKiB) * 100),
    swap_total_bytes: swapValid ? swapTotal : null,
    swap_used_bytes: swapValid ? swapUsed : null,
    process_count: processCount !== null && Number.isInteger(processCount) ? processCount : null,
  };
  const complete =
    cpuValid &&
    swapValid &&
    machine.process_count !== null &&
    disks.length > 0 &&
    disks.every((disk) => disk.state === "supported");
  return {
    platform: "win32",
    sampled_at:
      typeof row.sampled_at === "string" && Number.isFinite(Date.parse(row.sampled_at))
        ? new Date(row.sampled_at).toISOString()
        : new Date(nowMs).toISOString(),
    state: complete ? "supported" : "partial",
    machine,
    disks,
    ...(!complete ? { reason: "windows_host_optional_metrics_unavailable" } : {}),
  };
}

function parseWindowsDisk(row: Record<string, unknown>): ResourceDiskSample {
  const total = positive(row.Size);
  const available = nonnegative(row.FreeSpace);
  const valid =
    typeof row.DeviceID === "string" && total !== null && available !== null && available <= total;
  return {
    path: typeof row.DeviceID === "string" ? `${row.DeviceID}\\` : "unknown",
    state: valid ? "supported" : "error",
    total_bytes: valid ? total : null,
    available_bytes: valid ? available : null,
    used_percent: valid ? round1(((total - available) / total) * 100) : null,
    ...(!valid ? { reason: "windows_disk_counters_invalid" } : {}),
  };
}

function unavailableWindowsHost(nowMs: number, reason: string): ResourceHostSample {
  return {
    platform: "win32",
    sampled_at: new Date(nowMs).toISOString(),
    state: "error",
    machine: null,
    disks: [],
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every(isRecord) ? value : null;
}

function nonnegative(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(\.\d+)?$/.test(value)))
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER
    ? number
    : null;
}

function positive(value: unknown): number | null {
  const number = nonnegative(value);
  return number !== null && number > 0 ? number : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
