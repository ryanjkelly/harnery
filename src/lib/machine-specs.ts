/**
 * Machine specs record (ADR 0252).
 *
 * Describes the slow-changing hardware and system of this machine: OS, CPU,
 * memory, GPUs, disks, displays and runtimes. The record is stored once per
 * machine beside the user config and refreshed when a reader finds it stale
 * (another boot, another Harnery version, another schema, or older than the
 * reader's limit). Live load stays with `resources`; this module only adds a
 * cheap `live` block (memory available, disk free) that is measured on each
 * read and never stored.
 *
 * Every section is probed independently and best effort: a section that
 * cannot be read adds one short entry to `errors` and never fails the probe.
 * The record never holds serial numbers, MAC addresses, user names, home
 * paths or the hostname; the machine label is the only machine name.
 *
 * Internal module: not exported from package.json.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import * as nodeOs from "node:os";
import { dirname, join } from "node:path";
import { computerPreferencesPath } from "../core/config.ts";
import { harneryVersion } from "../core/hooks/adapter/wiring.ts";
import { isWSL } from "./browser/launch-args.ts";
import { probeDisplays } from "./computer/displays.ts";
import { defaultSpawnSync, normalize, type SpawnSyncFn } from "./computer/driver-support.ts";
import { detectHost } from "./computer/host.ts";
import type { DisplayInfo, HostInfo } from "./computer/types.ts";
import { resolveMachineLabel } from "./machine.ts";
import { windowsExecutable } from "./windows-executable.ts";

export const MACHINE_SPECS_SCHEMA_VERSION = 1;
export const MACHINE_SPECS_FILE = "machine-specs.json";
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type SpecsHostKind = "windows" | "wsl" | "macos" | "linux" | "unknown";
export type DiskKind = "ssd" | "hdd" | "unknown";

export interface OsSpecs {
  platform: string;
  name: string;
  version: string;
  build?: string;
  kernel?: string;
  arch: string;
}

export interface CpuSpecs {
  model: string;
  vendor?: string;
  physical_cores?: number;
  logical_cores: number;
  arch: string;
}

export interface GpuSpecs {
  name: string;
  vendor?: string;
  vram_bytes?: number;
}

export interface DiskSpecs {
  mount: string;
  device?: string;
  filesystem?: string;
  total_bytes: number;
  kind?: DiskKind;
}

export interface WindowsHostSpecs {
  os?: OsSpecs;
  cpu?: CpuSpecs;
  memory?: { total_bytes: number };
  gpus?: GpuSpecs[];
  wsl: { distro?: string; kernel?: string };
}

export interface MachineSpecs {
  schema_version: number;
  probed_at: string;
  boot_id?: string;
  harnery_version: string;
  machine_label: string;
  host_kind: SpecsHostKind;
  os: OsSpecs;
  cpu: CpuSpecs;
  memory: { total_bytes: number };
  gpus: GpuSpecs[];
  disks: DiskSpecs[];
  displays?: DisplayInfo[];
  runtimes: { bun?: string; node?: string };
  windows_host?: WindowsHostSpecs;
  errors?: string[];
}

export interface MachineLive {
  measured_at: string;
  memory_available_bytes?: number;
  disks: { mount: string; free_bytes: number }[];
}

export type RefreshReason = "missing" | "schema" | "version" | "boot" | "age" | "forced";

export interface MachineSpecsRead {
  specs: MachineSpecs;
  live: MachineLive;
  refreshed: boolean;
  reason?: RefreshReason;
}

/** The display probe's answer, as far as this module needs it. */
export interface DisplayReading {
  displays: DisplayInfo[];
  error?: string;
}

export interface MachineSpecsDeps {
  platform?: NodeJS.Platform;
  /** `os.arch()` form: "x64", "arm64", … */
  arch?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  isWsl?: () => boolean;
  /** File text, or undefined when it cannot be read. */
  readFile?: (path: string) => string | undefined;
  exists?: (path: string) => boolean;
  statfs?: (path: string) => { total_bytes: number; free_bytes: number } | undefined;
  spawnSync?: SpawnSyncFn;
  /** `os.release()`. */
  kernelRelease?: () => string;
  /** `os.cpus().length`. */
  logicalCpus?: () => number;
  totalMemory?: () => number;
  freeMemory?: () => number;
  /** Seconds since boot (`os.uptime()`). */
  uptime?: () => number;
  machineLabel?: () => string;
  harneryVersion?: () => string;
  host?: () => HostInfo;
  probeDisplays?: (host: HostInfo) => DisplayReading;
  /** Directory that holds the record. Defaults beside the user config. */
  dir?: string;
}

interface Resolved {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  isWsl: () => boolean;
  readFile: (path: string) => string | undefined;
  exists: (path: string) => boolean;
  statfs: (path: string) => { total_bytes: number; free_bytes: number } | undefined;
  spawnSync: SpawnSyncFn;
  kernelRelease: () => string;
  logicalCpus: () => number;
  totalMemory: () => number;
  freeMemory: () => number;
  uptime: () => number;
  machineLabel: () => string;
  harneryVersion: () => string;
  host: () => HostInfo;
  probeDisplays: (host: HostInfo) => DisplayReading;
  dir: string;
}

function resolveDeps(deps: MachineSpecsDeps): Resolved {
  return {
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    env: deps.env ?? process.env,
    now: deps.now ?? Date.now,
    isWsl: deps.isWsl ?? isWSL,
    readFile: deps.readFile ?? defaultReadFile,
    exists: deps.exists ?? existsSync,
    statfs: deps.statfs ?? defaultStatfs,
    spawnSync: deps.spawnSync ?? defaultSpawnSync,
    kernelRelease: deps.kernelRelease ?? nodeOs.release,
    logicalCpus: deps.logicalCpus ?? (() => nodeOs.cpus().length),
    totalMemory: deps.totalMemory ?? nodeOs.totalmem,
    freeMemory: deps.freeMemory ?? nodeOs.freemem,
    uptime: deps.uptime ?? nodeOs.uptime,
    machineLabel: deps.machineLabel ?? resolveMachineLabel,
    harneryVersion: deps.harneryVersion ?? (() => harneryVersion() || "unknown"),
    host: deps.host ?? (() => detectHost()),
    probeDisplays: deps.probeDisplays ?? defaultProbeDisplays,
    dir: deps.dir ?? dirname(computerPreferencesPath()),
  };
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultStatfs(path: string): { total_bytes: number; free_bytes: number } | undefined {
  try {
    const s = statfsSync(path);
    return {
      total_bytes: Number(s.blocks) * Number(s.bsize),
      free_bytes: Number(s.bavail) * Number(s.bsize),
    };
  } catch {
    return undefined;
  }
}

function defaultProbeDisplays(host: HostInfo): DisplayReading {
  return probeDisplays(host);
}

/** Path of the record file. */
export function machineSpecsPath(deps: MachineSpecsDeps = {}): string {
  return join(deps.dir ?? dirname(computerPreferencesPath()), MACHINE_SPECS_FILE);
}

export function hostKindFor(platform: NodeJS.Platform, wsl: () => boolean): SpecsHostKind {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return wsl() ? "wsl" : "linux";
  return "unknown";
}

function archName(arch: string): string {
  if (arch === "x64") return "x86_64";
  if (arch === "ia32") return "x86";
  return arch;
}

// ---------------------------------------------------------------- probe

/** Probe every section now. Never throws. */
export function probeMachineSpecs(deps: MachineSpecsDeps = {}): MachineSpecs {
  const d = resolveDeps(deps);
  const errors: string[] = [];
  const section = <T>(name: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (error) {
      errors.push(`${name}: ${shortMessage(error)}`);
      return undefined;
    }
  };
  const hostKind = hostKindFor(d.platform, d.isWsl);
  const arch = archName(d.arch);

  let os: OsSpecs | undefined;
  let cpu: CpuSpecs | undefined;
  let memory: { total_bytes: number } | undefined;
  let gpus: GpuSpecs[] | undefined;
  let disks: DiskSpecs[] | undefined;
  let windowsHost: WindowsHostSpecs | undefined;

  if (hostKind === "linux" || hostKind === "wsl") {
    os = section("os", () => linuxOs(d, arch));
    cpu = section("cpu", () =>
      parseCpuinfo(required(d.readFile("/proc/cpuinfo"), "/proc/cpuinfo"), arch, d.logicalCpus),
    );
    memory = section("memory", () => ({
      total_bytes: parseMeminfo(required(d.readFile("/proc/meminfo"), "/proc/meminfo")).total,
    }));
    gpus = section("gpus", () => linuxGpus(d));
    disks = section("disks", () => linuxDisks(d, hostKind));
    if (hostKind === "wsl") {
      const win = section("windows_host", () => windowsCim(d));
      windowsHost = {
        ...(win ? { os: win.os, cpu: win.cpu, memory: win.memory, gpus: win.gpus } : {}),
        wsl: {
          ...(d.env.WSL_DISTRO_NAME ? { distro: d.env.WSL_DISTRO_NAME } : {}),
          ...(os?.kernel ? { kernel: os.kernel } : {}),
        },
      };
      for (const key of ["os", "cpu", "memory", "gpus"] as const)
        if (windowsHost[key] === undefined) delete windowsHost[key];
    }
  } else if (hostKind === "windows") {
    const win = section("windows", () => windowsCim(d));
    os = win?.os;
    cpu = win?.cpu;
    memory = win?.memory;
    gpus = win?.gpus;
    disks = win?.disks;
    if (win && !os) errors.push("os: not reported");
  } else if (hostKind === "macos") {
    os = section("os", () => macOs(d, arch));
    const sys = section("cpu", () => macSysctl(d, arch));
    cpu = sys?.cpu;
    memory = sys ? { total_bytes: sys.memory } : undefined;
    gpus = section("gpus", () => macGpus(d));
    disks = section("disks", () => macDisks(d));
  } else {
    errors.push(`os: unsupported platform ${d.platform}`);
  }

  const displays = section("displays", () => {
    const reading = d.probeDisplays(d.host());
    if (reading.displays.length === 0) throw new Error(reading.error ?? "no displays reported");
    return reading.displays;
  });

  const runtimes = section("runtimes", () => probeRuntimes(d)) ?? {};
  const bootId = bootIdFor(hostKind, d);

  const specs: MachineSpecs = {
    schema_version: MACHINE_SPECS_SCHEMA_VERSION,
    probed_at: new Date(d.now()).toISOString(),
    ...(bootId ? { boot_id: bootId } : {}),
    harnery_version: d.harneryVersion(),
    machine_label: d.machineLabel(),
    host_kind: hostKind,
    os: os ?? { platform: d.platform, name: d.platform, version: "unknown", arch },
    cpu: cpu ?? { model: "unknown", logical_cores: safeNumber(d.logicalCpus) ?? 0, arch },
    memory: memory ?? { total_bytes: safeNumber(d.totalMemory) ?? 0 },
    gpus: gpus ?? [],
    disks: disks ?? [],
    ...(displays ? { displays } : {}),
    runtimes,
    ...(windowsHost ? { windows_host: windowsHost } : {}),
    ...(errors.length ? { errors } : {}),
  };
  return specs;
}

function required(text: string | undefined, what: string): string {
  if (text === undefined) throw new Error(`${what} unreadable`);
  return text;
}

function shortMessage(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function safeNumber(fn: () => number): number | undefined {
  try {
    const n = fn();
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- linux

/** `/etc/os-release` key/value pairs. */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of normalize(text).split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    out[m[1]] = (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function linuxOs(d: Resolved, arch: string): OsSpecs {
  const release = parseOsRelease(
    d.readFile("/etc/os-release") ?? required(d.readFile("/usr/lib/os-release"), "/etc/os-release"),
  );
  const kernel = d.kernelRelease();
  return {
    platform: "linux",
    name: release.NAME ?? "Linux",
    version: release.VERSION ?? release.VERSION_ID ?? "unknown",
    ...(release.BUILD_ID ? { build: release.BUILD_ID } : {}),
    ...(kernel ? { kernel } : {}),
    arch,
  };
}

/** `/proc/cpuinfo` → CPU section. Physical cores count unique (package, core) pairs. */
export function parseCpuinfo(text: string, arch: string, logicalFallback?: () => number): CpuSpecs {
  const blocks = normalize(text)
    .split(/\n\s*\n/)
    .map((block) => {
      const fields: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        fields[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      return fields;
    })
    .filter((f) => Object.keys(f).length > 0);
  const processors = blocks.filter((f) => f.processor !== undefined);
  const first = processors[0] ?? blocks[0] ?? {};
  const all = Object.assign({}, ...blocks) as Record<string, string>;
  const model =
    first["model name"] ?? all["model name"] ?? all.hardware ?? all["cpu model"] ?? "unknown";
  const vendor = first.vendor_id ?? all.vendor_id;
  const pairs = new Set<string>();
  for (const p of processors)
    if (p["core id"] !== undefined) pairs.add(`${p["physical id"] ?? "0"}:${p["core id"]}`);
  let physical = pairs.size || undefined;
  if (!physical && first["cpu cores"]) {
    const packages = new Set(processors.map((p) => p["physical id"] ?? "0")).size || 1;
    physical = Number(first["cpu cores"]) * packages || undefined;
  }
  const logical = processors.length || (logicalFallback ? (safeNumber(logicalFallback) ?? 0) : 0);
  return {
    model,
    ...(vendor ? { vendor } : {}),
    ...(physical ? { physical_cores: physical } : {}),
    logical_cores: logical,
    arch,
  };
}

/** `/proc/meminfo` totals in bytes. */
export function parseMeminfo(text: string): { total: number; available?: number } {
  const value = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m?.[1] ? Number(m[1]) * 1024 : undefined;
  };
  const total = value("MemTotal");
  if (total === undefined) throw new Error("MemTotal missing");
  const available = value("MemAvailable");
  return { total, ...(available !== undefined ? { available } : {}) };
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaSmi(text: string): GpuSpecs[] {
  const out: GpuSpecs[] = [];
  for (const line of normalize(text).split("\n")) {
    const parts = line.split(",").map((s) => s.trim());
    if (!parts[0]) continue;
    const mib = Number(parts[1]);
    out.push({
      name: parts[0],
      vendor: "NVIDIA",
      ...(Number.isFinite(mib) && mib > 0 ? { vram_bytes: mib * 1024 * 1024 } : {}),
    });
  }
  return out;
}

/**
 * `lspci -mm` → display controllers. Skips paravirtual adapters whose vendor
 * is the hypervisor's (a WSL guest sees the Windows GPU as a Microsoft device).
 */
export function parseLspci(text: string): GpuSpecs[] {
  const out: GpuSpecs[] = [];
  for (const line of normalize(text).split("\n")) {
    const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
    const [cls, vendor, device] = fields;
    if (!cls || !/VGA|3D|Display/i.test(cls)) continue;
    if (/Microsoft|Red Hat|VMware|QEMU|VirtualBox/i.test(vendor ?? "")) continue;
    out.push({ name: device || cls, ...(vendor ? { vendor } : {}) });
  }
  return out;
}

const NVIDIA_SMI_WSL = "/usr/lib/wsl/lib/nvidia-smi";

function linuxGpus(d: Resolved): GpuSpecs[] {
  const smiArgs = ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"];
  for (const cmd of ["nvidia-smi", NVIDIA_SMI_WSL]) {
    if (cmd !== "nvidia-smi" && !d.exists(cmd)) continue;
    const r = d.spawnSync(cmd, smiArgs, { timeout: 10_000, env: d.env });
    if (r.status === 0 && !r.error) {
      const gpus = parseNvidiaSmi(r.stdout);
      if (gpus.length) return gpus;
    }
  }
  const r = d.spawnSync("lspci", ["-mm"], { timeout: 10_000, env: d.env });
  if (r.status === 0 && !r.error) return parseLspci(r.stdout);
  return [];
}

const PSEUDO_FS = new Set([
  "tmpfs",
  "devtmpfs",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "overlay",
  "squashfs",
  "iso9660",
  "rootfs",
  "devpts",
  "mqueue",
  "debugfs",
  "tracefs",
  "securityfs",
  "pstore",
  "bpf",
  "autofs",
  "hugetlbfs",
  "configfs",
  "fusectl",
  "binfmt_misc",
  "ramfs",
  "nsfs",
  "efivarfs",
  "fuse.snapfuse",
  "fuse.portal",
  "fuse.gvfsd-fuse",
  "selinuxfs",
  "rpc_pipefs",
  "nfsd",
  "tracefs",
]);
const DISK_FS =
  /^(ext[234]|xfs|btrfs|zfs|f2fs|jfs|reiserfs|ntfs3?|fuseblk|vfat|exfat|bcachefs|apfs|hfs)$/;

export interface MountEntry {
  device: string;
  mount: string;
  filesystem: string;
}

/** `/proc/mounts` lines, with octal escapes (`\040`, `\134`) decoded. */
export function parseProcMounts(text: string): MountEntry[] {
  const decode = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
  const out: MountEntry[] = [];
  for (const line of normalize(text).split("\n")) {
    const [device, mount, filesystem] = line.trim().split(/\s+/);
    if (!device || !mount || !filesystem) continue;
    out.push({ device: decode(device), mount: decode(mount), filesystem });
  }
  return out;
}

/** True when the mount sits under a user's home, which the record never names. */
function isHomePath(path: string): boolean {
  return /^\/(home|Users)\//.test(path) || path === "/root" || path.startsWith("/root/");
}

/**
 * Real local filesystems from the mount table: block devices with a disk
 * filesystem, plus Windows drive roots under WSL. The first mount of a device
 * wins, so bind mounts and repeats are skipped.
 */
export function selectLocalMounts(mounts: MountEntry[], hostKind: SpecsHostKind): MountEntry[] {
  const seen = new Set<string>();
  const out: MountEntry[] = [];
  for (const m of mounts) {
    if (PSEUDO_FS.has(m.filesystem)) continue;
    if (isHomePath(m.mount)) continue;
    const block =
      m.device.startsWith("/dev/") &&
      !m.device.startsWith("/dev/loop") &&
      DISK_FS.test(m.filesystem);
    const drive =
      hostKind === "wsl" &&
      (m.filesystem === "9p" || m.filesystem === "drvfs") &&
      /^[A-Za-z]:\\?$/.test(m.device) &&
      /^\/mnt\/[a-z]$/.test(m.mount);
    if (!block && !drive) continue;
    if (seen.has(m.device)) continue;
    seen.add(m.device);
    out.push(m);
  }
  return out;
}

/** `/sys/block/<dev>/queue/rotational` → disk kind; partitions resolve to their disk. */
export function diskKindFor(
  device: string,
  readFile: (path: string) => string | undefined,
): DiskKind {
  const name = device.replace(/^\/dev\//, "");
  if (!/^[A-Za-z0-9]+$/.test(name)) return "unknown";
  const candidates = [name, name.replace(/p\d+$/, ""), name.replace(/\d+$/, "")];
  for (const c of candidates) {
    const v = readFile(`/sys/block/${c}/queue/rotational`)?.trim();
    if (v === "0") return "ssd";
    if (v === "1") return "hdd";
  }
  return "unknown";
}

function linuxDisks(d: Resolved, hostKind: SpecsHostKind): DiskSpecs[] {
  const mounts = selectLocalMounts(
    parseProcMounts(required(d.readFile("/proc/mounts"), "/proc/mounts")),
    hostKind,
  );
  const out: DiskSpecs[] = [];
  for (const m of mounts) {
    const size = d.statfs(m.mount);
    if (!size || size.total_bytes <= 0) continue;
    // A WSL guest's disks are virtual: the backing drive belongs to Windows.
    const kind =
      hostKind === "wsl"
        ? "unknown"
        : m.device.startsWith("/dev/")
          ? diskKindFor(m.device, d.readFile)
          : "unknown";
    out.push({
      mount: m.mount,
      device: m.device,
      filesystem: m.filesystem,
      total_bytes: size.total_bytes,
      kind,
    });
  }
  return out;
}

// ---------------------------------------------------------------- windows

const WIN_MARKER = "HARNERY_SPECS_JSON:";

/** One PowerShell program that prints one JSON object (no serials, no names). */
export const WINDOWS_SPECS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$ProgressPreference='SilentlyContinue'",
  "$o=@{}",
  "$os=Get-CimInstance Win32_OperatingSystem",
  "$cv=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'",
  "if($os){$o.os=@{caption=$os.Caption;version=$os.Version;build=$os.BuildNumber;ubr=$cv.UBR;display_version=$cv.DisplayVersion}}",
  "$o.cpu=@(Get-CimInstance Win32_Processor | ForEach-Object {@{name=$_.Name;vendor=$_.Manufacturer;cores=$_.NumberOfCores;logical=$_.NumberOfLogicalProcessors;arch=$_.Architecture}})",
  "$cs=Get-CimInstance Win32_ComputerSystem",
  "if($cs){$o.memory=@{total=$cs.TotalPhysicalMemory}}",
  "$o.gpus=@(Get-CimInstance Win32_VideoController | ForEach-Object {@{name=$_.Name;vendor=$_.AdapterCompatibility;ram=$_.AdapterRAM}})",
  "$o.vram=@(Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object {$p=Get-ItemProperty $_.PSPath; if($p.DriverDesc){@{name=$p.DriverDesc;bytes=$p.'HardwareInformation.qwMemorySize'}}})",
  "$o.disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {@{id=$_.DeviceID;fs=$_.FileSystem;size=$_.Size}})",
  `'${WIN_MARKER}' + ($o | ConvertTo-Json -Depth 4 -Compress)`,
].join("\n");

export interface WindowsCim {
  os?: OsSpecs;
  cpu?: CpuSpecs;
  memory?: { total_bytes: number };
  gpus?: GpuSpecs[];
  disks?: DiskSpecs[];
}

const WIN_ARCH: Record<number, string> = { 0: "x86", 5: "arm", 9: "x86_64", 12: "arm64" };

/** Parse the script's stdout. Unknown fields (for example a computer name) are ignored. */
export function parseWindowsCim(stdout: string): WindowsCim {
  const line = normalize(stdout)
    .split("\n")
    .find((l) => l.startsWith(WIN_MARKER));
  if (!line) throw new Error("no JSON from PowerShell");
  const raw = JSON.parse(line.slice(WIN_MARKER.length)) as Record<string, unknown>;
  const list = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []) as Record<string, unknown>[];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v)
      ? v
      : typeof v === "string" && v.trim() && Number.isFinite(Number(v))
        ? Number(v)
        : undefined;
  const out: WindowsCim = {};

  const cpus = list(raw.cpu);
  const arch = WIN_ARCH[num(cpus[0]?.arch) ?? -1] ?? "unknown";
  const o = raw.os as Record<string, unknown> | undefined;
  if (o && typeof o === "object") {
    const build = str(o.build) ?? (num(o.build) !== undefined ? String(num(o.build)) : undefined);
    const ubr = num(o.ubr);
    out.os = {
      platform: "win32",
      name: str(o.caption) ?? "Windows",
      version: str(o.display_version) ?? str(o.version) ?? "unknown",
      ...(build ? { build: ubr !== undefined ? `${build}.${ubr}` : build } : {}),
      ...(str(o.version) ? { kernel: str(o.version) } : {}),
      arch,
    };
  }
  if (cpus.length) {
    const first = cpus[0] ?? {};
    const physical = cpus.reduce((n, c) => n + (num(c.cores) ?? 0), 0);
    const logical = cpus.reduce((n, c) => n + (num(c.logical) ?? 0), 0);
    out.cpu = {
      model: str(first.name) ?? "unknown",
      ...(str(first.vendor) ? { vendor: str(first.vendor) } : {}),
      ...(physical ? { physical_cores: physical } : {}),
      logical_cores: logical,
      arch,
    };
  }
  const mem = raw.memory as Record<string, unknown> | undefined;
  const total = num(mem?.total);
  if (total) out.memory = { total_bytes: total };
  const vram = new Map<string, number>();
  for (const v of list(raw.vram)) {
    const name = str(v.name);
    const bytes = num(v.bytes);
    if (name && bytes && bytes > 0) vram.set(name, bytes);
  }
  out.gpus = list(raw.gpus)
    .filter((g) => str(g.name))
    .map((g) => {
      const name = str(g.name) ?? "";
      // AdapterRAM is a 32-bit field that tops out near 4 GiB; the driver's registry value is exact.
      const bytes = vram.get(name) ?? num(g.ram);
      return {
        name,
        ...(str(g.vendor) ? { vendor: str(g.vendor) } : {}),
        ...(bytes && bytes > 0 ? { vram_bytes: bytes } : {}),
      };
    });
  out.disks = list(raw.disks)
    .filter((k) => str(k.id) && num(k.size))
    .map((k) => ({
      mount: `${str(k.id)}\\`,
      ...(str(k.fs) ? { filesystem: str(k.fs) } : {}),
      total_bytes: num(k.size) ?? 0,
      kind: "unknown" as const,
    }));
  return out;
}

function windowsCim(d: Resolved): WindowsCim {
  const exe = windowsExecutable("powershell.exe", { platform: d.platform, exists: d.exists });
  const encoded = Buffer.from(WINDOWS_SPECS_SCRIPT, "utf16le").toString("base64");
  const r = d.spawnSync(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    timeout: 30_000,
    env: d.env,
  });
  if (r.error) throw new Error(`PowerShell failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`PowerShell exited ${r.status}`);
  return parseWindowsCim(r.stdout);
}

// ---------------------------------------------------------------- macos

/** `sw_vers` lines ("ProductName:\tmacOS"). */
export function parseSwVers(text: string, arch: string, kernel?: string): OsSpecs {
  const f: Record<string, string> = {};
  for (const line of normalize(text).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) f[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    platform: "darwin",
    name: f.ProductName ?? "macOS",
    version: f.ProductVersion ?? "unknown",
    ...(f.BuildVersion ? { build: f.BuildVersion } : {}),
    ...(kernel ? { kernel } : {}),
    arch,
  };
}

/** `sysctl -n machdep.cpu.brand_string hw.physicalcpu hw.logicalcpu hw.memsize`: one value per line. */
export function parseMacSysctl(text: string, arch: string): { cpu: CpuSpecs; memory: number } {
  const [brand, physical, logical, memsize] = normalize(text)
    .trim()
    .split("\n")
    .map((s) => s.trim());
  const memory = Number(memsize);
  if (!Number.isFinite(memory) || memory <= 0) throw new Error("hw.memsize missing");
  return {
    cpu: {
      model: brand || "unknown",
      ...(/apple/i.test(brand ?? "")
        ? { vendor: "Apple" }
        : /intel/i.test(brand ?? "")
          ? { vendor: "GenuineIntel" }
          : {}),
      ...(Number(physical) > 0 ? { physical_cores: Number(physical) } : {}),
      logical_cores: Number(logical) || 0,
      arch,
    },
    memory,
  };
}

/** `system_profiler SPDisplaysDataType -json` → GPUs. Apple silicon reports no separate VRAM. */
export function parseMacDisplaysProfile(text: string): GpuSpecs[] {
  const parsed = JSON.parse(text) as { SPDisplaysDataType?: Record<string, unknown>[] };
  const out: GpuSpecs[] = [];
  for (const g of parsed.SPDisplaysDataType ?? []) {
    const name =
      typeof g.sppci_model === "string"
        ? g.sppci_model
        : typeof g._name === "string"
          ? g._name
          : undefined;
    if (!name) continue;
    const rawVendor = typeof g.spdisplays_vendor === "string" ? g.spdisplays_vendor : undefined;
    const vendor = rawVendor?.replace(/^sppci_vendor_/, "").replace(/\s*\(0x[0-9a-f]+\)$/i, "");
    const vramText = [g.spdisplays_vram, g.spdisplays_vram_shared, g._spdisplays_vram].find(
      (v): v is string => typeof v === "string",
    );
    const m = vramText ? /([\d.]+)\s*(GB|MB)/i.exec(vramText) : null;
    const vram =
      m?.[1] && m[2]
        ? Number(m[1]) * (m[2].toUpperCase() === "GB" ? 1024 ** 3 : 1024 ** 2)
        : undefined;
    out.push({ name, ...(vendor ? { vendor } : {}), ...(vram ? { vram_bytes: vram } : {}) });
  }
  return out;
}

/** `df -kP -l`: the root volume plus mounts under /Volumes. */
export function parseMacDf(text: string): DiskSpecs[] {
  const out: DiskSpecs[] = [];
  const seen = new Set<string>();
  for (const line of normalize(text).split("\n").slice(1)) {
    const m = /^(\S+)\s+(\d+)\s+\d+\s+\d+\s+\S+\s+(.+)$/.exec(line.trim());
    if (!m?.[1] || !m[2] || !m[3]) continue;
    const [, device, blocks, mount] = m;
    if (!device.startsWith("/dev/")) continue;
    if (mount !== "/" && !mount.startsWith("/Volumes/")) continue;
    if (seen.has(device)) continue;
    seen.add(device);
    out.push({ mount, device, total_bytes: Number(blocks) * 1024, kind: "unknown" });
  }
  return out;
}

function runText(d: Resolved, cmd: string, args: string[]): string {
  const r = d.spawnSync(cmd, args, { timeout: 15_000, env: d.env });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
  return r.stdout;
}

function macOs(d: Resolved, arch: string): OsSpecs {
  return parseSwVers(runText(d, "sw_vers", []), arch, d.kernelRelease());
}

function macSysctl(d: Resolved, arch: string) {
  return parseMacSysctl(
    runText(d, "sysctl", [
      "-n",
      "machdep.cpu.brand_string",
      "hw.physicalcpu",
      "hw.logicalcpu",
      "hw.memsize",
    ]),
    arch,
  );
}

function macGpus(d: Resolved): GpuSpecs[] {
  return parseMacDisplaysProfile(runText(d, "system_profiler", ["SPDisplaysDataType", "-json"]));
}

function macDisks(d: Resolved): DiskSpecs[] {
  return parseMacDf(runText(d, "df", ["-kP", "-l"]));
}

// ---------------------------------------------------------------- shared

function probeRuntimes(d: Resolved): { bun?: string; node?: string } {
  const out: { bun?: string; node?: string } = {};
  for (const name of ["bun", "node"] as const) {
    const r = d.spawnSync(name, ["--version"], { timeout: 10_000, env: d.env });
    const version = r.status === 0 && !r.error ? r.stdout.trim().replace(/^v/, "") : "";
    if (/^\d+\.\d+/.test(version)) out[name] = version;
  }
  return out;
}

/**
 * An id that changes when the machine restarts. Linux and WSL read the
 * kernel's boot id; macOS and Windows derive the boot time from the uptime,
 * so a read never starts another process. Undefined when unknown.
 */
export function currentBootId(
  hostKind: SpecsHostKind,
  deps: MachineSpecsDeps = {},
): string | undefined {
  return bootIdFor(hostKind, resolveDeps(deps));
}

function bootIdFor(hostKind: SpecsHostKind, d: Resolved): string | undefined {
  if (hostKind === "linux" || hostKind === "wsl")
    return d.readFile("/proc/sys/kernel/random/boot_id")?.trim() || undefined;
  if (hostKind === "macos" || hostKind === "windows") {
    const up = safeNumber(d.uptime);
    if (up === undefined || up <= 0) return undefined;
    return new Date(Math.round((d.now() - up * 1000) / 1000) * 1000).toISOString();
  }
  return undefined;
}

/** Boot times derived from uptime drift by a second or two between reads. */
const BOOT_TIME_TOLERANCE_MS = 120_000;

export function sameBoot(stored: string, current: string): boolean {
  if (stored === current) return true;
  const a = Date.parse(stored);
  const b = Date.parse(current);
  if (!/T/.test(stored) || !/T/.test(current) || Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) <= BOOT_TIME_TOLERANCE_MS;
}

// ---------------------------------------------------------------- record

export function writeMachineSpecs(specs: MachineSpecs, deps: MachineSpecsDeps = {}): string {
  const path = machineSpecsPath(deps);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(specs, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

function loadStored(
  path: string,
  readFile: (p: string) => string | undefined,
): MachineSpecs | "corrupt" | undefined {
  const text = readFile(path);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as MachineSpecs;
    return parsed && typeof parsed === "object" ? parsed : "corrupt";
  } catch {
    return "corrupt";
  }
}

/** Why the stored record must be probed again, or undefined when it is current. */
export function staleReason(
  stored: MachineSpecs | "corrupt" | undefined,
  current: { harneryVersion: string; bootId?: string; now: number; maxAgeMs: number },
): RefreshReason | undefined {
  if (stored === undefined) return "missing";
  if (stored === "corrupt" || stored.schema_version !== MACHINE_SPECS_SCHEMA_VERSION)
    return "schema";
  if (stored.harnery_version !== current.harneryVersion) return "version";
  if (stored.boot_id && current.bootId && !sameBoot(stored.boot_id, current.bootId)) return "boot";
  const probed = Date.parse(stored.probed_at);
  if (
    Number.isNaN(probed) ||
    current.now - probed > current.maxAgeMs ||
    probed > current.now + 60_000
  )
    return "age";
  return undefined;
}

/** Cheap measurements taken on every read and never stored. */
export function measureLive(specs: MachineSpecs, deps: MachineSpecsDeps = {}): MachineLive {
  const d = resolveDeps(deps);
  let available: number | undefined;
  if (d.platform === "linux") {
    const meminfo = d.readFile("/proc/meminfo");
    try {
      available = meminfo ? parseMeminfo(meminfo).available : undefined;
    } catch {
      available = undefined;
    }
  }
  available ??= safeNumber(d.freeMemory);
  const disks: MachineLive["disks"] = [];
  for (const disk of specs.disks) {
    const s = d.statfs(disk.mount);
    if (s) disks.push({ mount: disk.mount, free_bytes: s.free_bytes });
  }
  return {
    measured_at: new Date(d.now()).toISOString(),
    ...(available !== undefined ? { memory_available_bytes: available } : {}),
    disks,
  };
}

/**
 * The stored record when it is current, otherwise a fresh probe that is
 * written back. `refresh: true` always probes. A failed write still returns
 * the fresh record.
 */
export function readMachineSpecs(
  options: { maxAgeMs?: number; refresh?: boolean } & MachineSpecsDeps = {},
): MachineSpecsRead {
  const { maxAgeMs = DEFAULT_MAX_AGE_MS, refresh = false, ...deps } = options;
  const d = resolveDeps(deps);
  const path = machineSpecsPath(deps);
  let reason: RefreshReason | undefined;
  let stored: MachineSpecs | undefined;
  if (refresh) reason = "forced";
  else {
    const loaded = loadStored(path, d.readFile);
    const hostKind = hostKindFor(d.platform, d.isWsl);
    reason = staleReason(loaded, {
      harneryVersion: d.harneryVersion(),
      bootId: bootIdFor(hostKind, d),
      now: d.now(),
      maxAgeMs,
    });
    if (!reason && loaded && loaded !== "corrupt") stored = loaded;
  }
  if (stored) return { specs: stored, live: measureLive(stored, deps), refreshed: false };
  const specs = probeMachineSpecs(deps);
  try {
    writeMachineSpecs(specs, deps);
  } catch (error) {
    specs.errors = [...(specs.errors ?? []), `record: ${shortMessage(error)}`];
  }
  return { specs, live: measureLive(specs, deps), refreshed: true, ...(reason ? { reason } : {}) };
}
