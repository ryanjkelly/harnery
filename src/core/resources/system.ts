import { closeSync, openSync, readdirSync, readSync, statfsSync, statSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  ResourceDiskSample,
  ResourceIoSample,
  ResourceOomSample,
  ResourcePressureSample,
  ResourcePressureWindow,
  ResourceSupportState,
  ResourceVmstatSample,
} from "./contract.ts";

interface FileSystemCapacity {
  bsize: number | bigint;
  blocks: number | bigint;
  bavail: number | bigint;
  bfree: number | bigint;
}

export interface SystemResourceOptions {
  platform?: NodeJS.Platform;
  procRoot?: string;
  sysRoot?: string;
  nowMs?: number;
  namespace?: string;
  tmpPath?: string;
  statfs?: (path: string) => FileSystemCapacity;
  filesystemId?: (path: string) => string | number | bigint;
}

interface IoCounters {
  read: number;
  write: number;
}

interface IoBaseline {
  sampledAt: number;
  devices: Map<string, IoCounters>;
}

/** The `/proc/vmstat` counters the reclaim rates are derived from, in report order. */
const VMSTAT_COUNTERS = ["pswpin", "pswpout", "pgscan_direct", "pgmajfault"] as const;

type VmstatCounterName = (typeof VMSTAT_COUNTERS)[number];
type VmstatCounters = Record<VmstatCounterName, number | null>;

interface VmstatBaseline {
  sampledAt: number;
  counters: VmstatCounters;
}

/**
 * Linux reports `pswpin` and `pswpout` in pages, and the kernel does not
 * publish the page size in `/proc/vmstat`. Every architecture Harnery runs on
 * uses a 4096 byte base page, so that value converts pages to bytes here. A
 * platform with a different base page would need its page size supplied.
 */
const VMSTAT_PAGE_SIZE_BYTES = 4_096;

const ioBaselines = new Map<string, IoBaseline>();
const oomBaselines = new Map<
  string,
  { sampledAt: number; kills: number; lastKillAt: number | null }
>();
const vmstatBaselines = new Map<string, VmstatBaseline>();
const MAX_BASELINES = 64;
const MAX_BLOCK_DEVICES = 1_024;

/** Collect only the workspace and temporary volume; never walk their contents. */
export function collectSystemResources(
  coordRoot: string,
  options: SystemResourceOptions = {},
): {
  disks: ResourceDiskSample[];
  pressure: ResourcePressureSample;
  io: ResourceIoSample;
  oom: ResourceOomSample;
  vmstat: ResourceVmstatSample;
} {
  const currentPlatform = options.platform ?? platform();
  const procRoot = options.procRoot ?? "/proc";
  const sysRoot = options.sysRoot ?? "/sys";
  const disks = collectDisks(coordRoot, options);
  if (currentPlatform !== "linux") {
    return {
      disks,
      pressure: {
        state: "unsupported",
        cpu: null,
        memory: null,
        io: null,
        memory_full: null,
        io_full: null,
        reason: `Linux pressure stall information is unavailable on ${currentPlatform}.`,
      },
      io: unavailableIo("unsupported", `Disk I/O rates are not collected on ${currentPlatform}.`),
      oom: {
        state: "unsupported",
        total_kills: null,
        kills_since_last_sample: null,
        last_kill_age_ms: null,
        reason: `Kernel OOM kill counters are not collected on ${currentPlatform}.`,
      },
      vmstat: unavailableVmstat(
        "unsupported",
        `Kernel memory reclaim counters are not collected on ${currentPlatform}.`,
        false,
      ),
    };
  }
  const key = JSON.stringify([
    resolve(coordRoot),
    options.namespace ?? "linux",
    resolve(procRoot),
    resolve(sysRoot),
  ]);
  return {
    disks,
    pressure: collectPressure(procRoot),
    io: collectIo(procRoot, sysRoot, options.nowMs ?? performance.now(), key),
    oom: collectOom(procRoot, options.nowMs ?? performance.now(), key),
    vmstat: collectVmstat(procRoot, options.nowMs ?? performance.now(), key),
  };
}

function collectDisks(coordRoot: string, options: SystemResourceOptions): ResourceDiskSample[] {
  const inspect = options.statfs ?? statfsSync;
  const filesystemId = options.filesystemId ?? ((path: string) => statSync(path).dev);
  const seen = new Set<string | number | bigint>();
  const results: ResourceDiskSample[] = [];
  for (const path of new Set([resolve(coordRoot), resolve(options.tmpPath ?? tmpdir())])) {
    try {
      const stat = inspect(path);
      const blockSize = Number(stat.bsize);
      const total = blockSize * Number(stat.blocks);
      const available = blockSize * Number(stat.bavail);
      const free = blockSize * Number(stat.bfree);
      if (
        ![blockSize, total, available, free].every(Number.isFinite) ||
        blockSize <= 0 ||
        total <= 0 ||
        free < 0 ||
        free > total ||
        available > total
      ) {
        throw new Error("Invalid filesystem capacity counters.");
      }
      // st_dev identifies the mounted filesystem, unlike coincidentally equal capacity values.
      try {
        const id = filesystemId(path);
        if (seen.has(id)) continue;
        seen.add(id);
      } catch {
        // Capacity is still useful when stat cannot identify the filesystem.
      }
      results.push({
        path,
        state: "supported",
        total_bytes: total,
        available_bytes: Math.max(0, available),
        used_percent: round(((total - free) / total) * 100),
      });
    } catch (error) {
      results.push({
        path,
        state: unsupportedError(error) ? "unsupported" : "error",
        total_bytes: null,
        available_bytes: null,
        used_percent: null,
        reason: errorReason(error),
      });
    }
  }
  return results;
}

function collectPressure(procRoot: string): ResourcePressureSample {
  const sample: ResourcePressureSample = {
    state: "supported",
    cpu: null,
    memory: null,
    io: null,
    memory_full: null,
    io_full: null,
  };
  const reasons: string[] = [];
  let supported = 0;
  let failures = 0;
  for (const resource of ["cpu", "memory", "io"] as const) {
    try {
      const raw = readBounded(join(procRoot, "pressure", resource), 4_096);
      const some = parsePressure(raw, "some");
      // System-wide CPU full is undefined. Memory and I/O full measure all non-idle tasks stalled.
      if (resource !== "cpu") sample[`${resource}_full`] = parsePressure(raw, "full");
      sample[resource] = some;
      supported++;
    } catch (error) {
      if (!missingError(error) && !unsupportedError(error)) failures++;
      reasons.push(`${resource}: ${errorReason(error)}`);
    }
  }
  sample.state =
    supported === 3
      ? "supported"
      : supported > 0
        ? "partial"
        : failures > 0
          ? "error"
          : "unsupported";
  if (reasons.length > 0) sample.reason = reasons.join("; ");
  return sample;
}

function parsePressure(source: string, kind: "some" | "full"): ResourcePressureWindow {
  const lines = source
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.startsWith(`${kind} `));
  if (lines.length !== 1) throw new Error(`Malformed PSI: expected one ${kind} row.`);
  const fields = new Map<string, string>();
  for (const token of lines[0]!.trim().split(/\s+/).slice(1)) {
    const [name, value, extra] = token.split("=");
    if (!name || !value || extra !== undefined || fields.has(name))
      throw new Error("Malformed PSI fields.");
    fields.set(name, value);
  }
  const values = ["avg10", "avg60", "avg300"].map((name) => {
    const raw = fields.get(name);
    const value = Number(raw);
    if (!raw || !/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(value) || value > 100) {
      throw new Error(`Malformed PSI ${name}.`);
    }
    return value;
  });
  if (!/^\d+$/.test(fields.get("total") ?? "")) throw new Error("Malformed PSI total.");
  return { avg10: values[0]!, avg60: values[1]!, avg300: values[2]! };
}

function collectOom(procRoot: string, now: number, key: string): ResourceOomSample {
  try {
    const rows = readBounded(join(procRoot, "vmstat"), 65_536)
      .split(/\r?\n/)
      .filter((line) => /^oom_kill\s/.test(line));
    if (rows.length === 0) {
      oomBaselines.delete(key);
      return {
        state: "unsupported",
        total_kills: null,
        kills_since_last_sample: null,
        last_kill_age_ms: null,
        reason: "Kernel does not expose oom_kill.",
      };
    }
    const match = rows.length === 1 ? /^oom_kill\s+(\d+)\s*$/.exec(rows[0]!) : null;
    const kills = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(kills) || kills < 0 || !Number.isFinite(now))
      throw new Error("Malformed OOM kill counter or sample time.");
    const previous = oomBaselines.get(key);
    const consecutive = previous && now > previous.sampledAt && kills >= previous.kills;
    const delta = consecutive ? kills - previous.kills : null;
    const lastKillAt = delta !== null && delta > 0 ? now : consecutive ? previous.lastKillAt : null;
    oomBaselines.delete(key);
    oomBaselines.set(key, { sampledAt: now, kills, lastKillAt });
    if (oomBaselines.size > MAX_BASELINES) oomBaselines.delete(oomBaselines.keys().next().value!);
    return {
      state: "supported",
      total_kills: kills,
      kills_since_last_sample: delta,
      last_kill_age_ms: lastKillAt === null ? null : now - lastKillAt,
      ...(delta === null
        ? { reason: "Recent OOM kills need two consecutive counters; baseline started." }
        : {}),
    };
  } catch (error) {
    oomBaselines.delete(key);
    return {
      state: missingError(error) || unsupportedError(error) ? "unsupported" : "error",
      total_kills: null,
      kills_since_last_sample: null,
      last_kill_age_ms: null,
      reason: errorReason(error),
    };
  }
}

/**
 * Read the kernel reclaim counters and turn them into per-second rates. Only a
 * pair of consecutive reads can express a rate, so the first read after a
 * start, a restart, a stalled clock, or a counter reset reports
 * `counters_reset` with null rates instead of inventing a baseline.
 */
function collectVmstat(procRoot: string, now: number, key: string): ResourceVmstatSample {
  try {
    if (!Number.isFinite(now)) throw new Error("Malformed reclaim sample time.");
    const counters = parseVmstatCounters(readBounded(join(procRoot, "vmstat"), 65_536));
    const missing = VMSTAT_COUNTERS.filter((name) => counters[name] === null);
    if (missing.length === VMSTAT_COUNTERS.length) {
      vmstatBaselines.delete(key);
      return unavailableVmstat(
        "unsupported",
        "Kernel does not expose the memory reclaim counters.",
        false,
      );
    }
    const state: ResourceSupportState = missing.length > 0 ? "partial" : "supported";
    const partialReason =
      missing.length > 0 ? `Kernel does not expose ${missing.join(", ")}.` : undefined;
    const previous = vmstatBaselines.get(key);
    vmstatBaselines.delete(key);
    vmstatBaselines.set(key, { sampledAt: now, counters });
    if (vmstatBaselines.size > MAX_BASELINES)
      vmstatBaselines.delete(vmstatBaselines.keys().next().value!);
    const elapsedSeconds = previous ? (now - previous.sampledAt) / 1_000 : 0;
    if (!previous || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
      return unavailableVmstat(
        state,
        joinReasons(
          partialReason,
          previous
            ? "The reclaim sample interval did not advance, so a new baseline started."
            : "Reclaim rates need two consecutive counters, so a baseline started.",
        ),
      );
    }
    const decreased = VMSTAT_COUNTERS.some((name) => {
      const current = counters[name];
      const last = previous.counters[name];
      return current !== null && last !== null && current < last;
    });
    if (decreased) {
      return unavailableVmstat(
        state,
        joinReasons(partialReason, "Kernel reclaim counters decreased, so a new baseline started."),
      );
    }
    const perSecond = (name: VmstatCounterName): number | null => {
      const current = counters[name];
      const last = previous.counters[name];
      if (current === null || last === null) return null;
      return (current - last) / elapsedSeconds;
    };
    const swapIn = perSecond("pswpin");
    const swapOut = perSecond("pswpout");
    return {
      state,
      swap_in_bytes_per_second: swapIn === null ? null : round(swapIn * VMSTAT_PAGE_SIZE_BYTES),
      swap_out_bytes_per_second: swapOut === null ? null : round(swapOut * VMSTAT_PAGE_SIZE_BYTES),
      direct_reclaim_pages_per_second: nullableRound(perSecond("pgscan_direct")),
      major_faults_per_second: nullableRound(perSecond("pgmajfault")),
      counters_reset: false,
      ...(partialReason ? { reason: partialReason } : {}),
    };
  } catch (error) {
    vmstatBaselines.delete(key);
    return unavailableVmstat(
      missingError(error) || unsupportedError(error) ? "unsupported" : "error",
      errorReason(error),
      false,
    );
  }
}

function parseVmstatCounters(source: string): VmstatCounters {
  const counters: VmstatCounters = {
    pswpin: null,
    pswpout: null,
    pgscan_direct: null,
    pgmajfault: null,
  };
  for (const name of VMSTAT_COUNTERS) {
    // Anchor on whitespace so pgscan_direct never absorbs pgscan_direct_throttle.
    const rows = source.split(/\r?\n/).filter((line) => line.startsWith(`${name} `));
    if (rows.length === 0) continue;
    if (rows.length > 1) throw new Error(`Duplicate vmstat row for ${name}.`);
    const match = new RegExp(`^${name}\\s+(\\d+)\\s*$`).exec(rows[0]!);
    const value = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Malformed vmstat counter for ${name}.`);
    counters[name] = value;
  }
  return counters;
}

function unavailableVmstat(
  state: ResourceSupportState,
  reason: string,
  countersReset = true,
): ResourceVmstatSample {
  return {
    state,
    swap_in_bytes_per_second: null,
    swap_out_bytes_per_second: null,
    direct_reclaim_pages_per_second: null,
    major_faults_per_second: null,
    counters_reset: countersReset,
    reason,
  };
}

function joinReasons(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function collectIo(procRoot: string, sysRoot: string, now: number, key: string): ResourceIoSample {
  try {
    const devices = readIoCounters(procRoot, sysRoot);
    const previous = ioBaselines.get(key);
    ioBaselines.delete(key);
    ioBaselines.set(key, { sampledAt: now, devices });
    if (ioBaselines.size > MAX_BASELINES) ioBaselines.delete(ioBaselines.keys().next().value!);
    if (!previous) return unavailableIo("supported", "Disk I/O rates need two samples.");
    const elapsed = (now - previous.sampledAt) / 1_000;
    if (!Number.isFinite(elapsed) || elapsed <= 0)
      return unavailableIo("supported", "Disk I/O sample interval did not advance.");
    if (devices.size !== previous.devices.size)
      return unavailableIo("supported", "Block devices changed; disk I/O baseline restarted.");
    let read = 0;
    let write = 0;
    for (const [id, current] of devices) {
      const last = previous.devices.get(id);
      if (!last || current.read < last.read || current.write < last.write) {
        return unavailableIo(
          "supported",
          "Block device counters reset or devices changed; disk I/O baseline restarted.",
        );
      }
      read += current.read - last.read;
      write += current.write - last.write;
    }
    // Linux diskstats sectors are always 512 bytes, independent of device block size.
    return {
      state: "supported",
      read_bytes_per_second: round((read * 512) / elapsed),
      write_bytes_per_second: round((write * 512) / elapsed),
    };
  } catch (error) {
    ioBaselines.delete(key);
    return unavailableIo(
      missingError(error) || unsupportedError(error) ? "unsupported" : "error",
      errorReason(error),
    );
  }
}

function readIoCounters(procRoot: string, sysRoot: string): Map<string, IoCounters> {
  const entries = readdirSync(join(sysRoot, "block"));
  if (entries.length > MAX_BLOCK_DEVICES)
    throw new Error("Block device inventory exceeds the collector limit.");
  const selected = new Set<string>();
  for (const device of entries) {
    // Whole devices only. Exclude memory-backed disks and stacked devices so
    // device-mapper/RAID activity is counted once, at the underlying disks.
    if (/^(?:loop|ram|zram)\d+$/.test(device)) continue;
    if (readdirSync(join(sysRoot, "block", device, "slaves")).length > 0) continue;
    selected.add(device);
  }
  if (selected.size === 0)
    throw Object.assign(new Error("No underlying block devices are visible."), { code: "ENOTSUP" });
  const results = new Map<string, IoCounters>();
  for (const line of readBounded(join(procRoot, "diskstats"), 1_048_576).trim().split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const device = fields[2];
    if (!device || !selected.has(device)) continue;
    if (
      fields.length < 14 ||
      ![...fields.slice(0, 2), ...fields.slice(3)].every((value) => /^\d+$/.test(value))
    ) {
      throw new Error(`Malformed diskstats for ${device}.`);
    }
    const read = Number(fields[5]);
    const write = Number(fields[9]);
    if (![read, write].every(Number.isSafeInteger))
      throw new Error(`Invalid diskstats counters for ${device}.`);
    const id = `${fields[0]}:${fields[1]}:${device}`;
    if (results.has(id)) throw new Error(`Duplicate diskstats for ${device}.`);
    results.set(id, { read, write });
  }
  if (results.size !== selected.size)
    throw new Error("Block device inventory changed while collecting diskstats.");
  return results;
}

function readBounded(path: string, limit: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > limit) throw new Error("Resource counter file exceeds the collector limit.");
    return buffer.toString("utf8", 0, offset);
  } finally {
    closeSync(fd);
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function missingError(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "");
}

function unsupportedError(error: unknown): boolean {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error) ?? "");
}

function errorReason(error: unknown): string {
  return (
    errorCode(error) ?? (error instanceof Error ? error.message : "Resource collection failed.")
  );
}

function unavailableIo(state: ResourceSupportState, reason: string): ResourceIoSample {
  return { state, read_bytes_per_second: null, write_bytes_per_second: null, reason };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : round(value);
}
