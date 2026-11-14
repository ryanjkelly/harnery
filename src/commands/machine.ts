import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import type { DisplayInfo } from "../lib/computer/types.ts";
import {
  type DiskSpecs,
  type GpuSpecs,
  type MachineSpecsDeps,
  type MachineSpecsRead,
  readMachineSpecs,
} from "../lib/machine-specs.ts";

export interface MachineCommandDeps {
  /** Replaces the record read; tests pass a fake. */
  read?: (options: { maxAgeMs?: number; refresh?: boolean } & MachineSpecsDeps) => MachineSpecsRead;
  specs?: MachineSpecsDeps;
}

interface SpecsOptions {
  json?: boolean;
  refresh?: boolean;
  maxAge?: string;
}

export function registerMachineCommand(
  program: Command,
  emit: EmitContext,
  _context?: HarneryProgramContext,
  deps: MachineCommandDeps = {},
): void {
  const machine = program
    .command("machine")
    .description("Describe this machine's hardware and system (recorded once, refreshed on read)");

  const addSpecsOptions = (cmd: Command) =>
    cmd
      .option("--json", "Structured output: specs, live measurements, refreshed, reason")
      .option("--refresh", "Probe again now even when the record is current")
      .option(
        "--max-age <minutes>",
        "Probe again when the record is older than this (default 1440)",
      );

  const run = (options: SpecsOptions) => {
    let maxAgeMs: number | undefined;
    if (options.maxAge !== undefined) {
      const minutes = Number(options.maxAge);
      if (!Number.isFinite(minutes) || minutes < 0) {
        emit.error({
          code: "invalid_max_age",
          message: `--max-age must be a number of minutes, got "${options.maxAge}"`,
        });
        emit.setExitCode(2);
        return;
      }
      maxAgeMs = minutes * 60_000;
    }
    try {
      const result = (deps.read ?? readMachineSpecs)({
        ...deps.specs,
        ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
        refresh: Boolean(options.refresh),
      });
      if (options.json) {
        emit.config({ format: "json" });
        emit.data({
          specs: result.specs,
          live: result.live,
          refreshed: result.refreshed,
          reason: result.reason ?? null,
        });
      } else {
        emit.config({ format: "text" });
        emit.text(formatMachineSpecs(result, program.name()));
      }
    } catch (error) {
      emit.error({
        code: "machine_specs_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      emit.setExitCode(1);
    }
  };

  // Options live on the subcommand only: parent options would swallow `specs --refresh`.
  machine.action(() => run({}));
  addSpecsOptions(
    machine.command("specs").description("Print this machine's hardware and system description"),
  ).action((options: SpecsOptions) => run(options));
}

const REASON_TEXT: Record<string, string> = {
  missing: "no record existed",
  schema: "the record format changed",
  version: "Harnery was updated",
  boot: "the machine restarted",
  age: "the record was older than the limit",
  forced: "--refresh was given",
};

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "unknown";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TiB`;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function osLine(os: {
  name: string;
  version: string;
  build?: string;
  arch: string;
  kernel?: string;
}) {
  const build = os.build ? ` (build ${os.build})` : "";
  return `${os.name} ${os.version}${build}, ${os.arch}`;
}

function cpuLine(cpu: { model: string; physical_cores?: number; logical_cores: number }) {
  const cores = cpu.physical_cores
    ? `${cpu.physical_cores} cores, ${cpu.logical_cores} threads`
    : `${cpu.logical_cores} logical cores`;
  return `${cpu.model}, ${cores}`;
}

function gpuLine(g: GpuSpecs) {
  return g.vram_bytes ? `${g.name} (${formatBytes(g.vram_bytes)})` : g.name;
}

function displayLine(d: DisplayInfo) {
  const scale = d.scale ? ` at ${Math.round(d.scale * 100)}%` : "";
  return `${d.name ?? d.id}: ${d.bounds.width}x${d.bounds.height}${scale}${d.primary ? ", primary" : ""}`;
}

function diskLine(disk: DiskSpecs, free: number | undefined) {
  const parts = [
    disk.filesystem,
    disk.kind && disk.kind !== "unknown" ? disk.kind.toUpperCase() : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const freeText = free !== undefined ? `${formatBytes(free)} free of ` : "";
  return `${disk.mount}: ${freeText}${formatBytes(disk.total_bytes)}${parts ? ` (${parts})` : ""}`;
}

function ageText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "less than a minute ago";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}

/** The plain summary `machine specs` prints. */
export function formatMachineSpecs(result: MachineSpecsRead, binName = "harn"): string {
  const { specs, live } = result;
  const lines: string[] = [];
  const isWsl = specs.host_kind === "wsl";
  lines.push(`Machine: ${specs.machine_label}${isWsl ? " (WSL guest)" : ""}`);
  lines.push(
    `OS: ${osLine(specs.os)}${specs.os.kernel && !isWsl ? `, kernel ${specs.os.kernel}` : ""}`,
  );
  lines.push(`CPU: ${cpuLine(specs.cpu)}${isWsl ? " available to the guest" : ""}`);
  const avail = live.memory_available_bytes;
  lines.push(
    `Memory: ${formatBytes(specs.memory.total_bytes)} total${avail !== undefined ? `, ${formatBytes(avail)} available now` : ""}`,
  );
  lines.push(`GPUs: ${specs.gpus.length ? specs.gpus.map(gpuLine).join("; ") : "none found"}`);
  if (specs.disks.length) {
    lines.push("Disks:");
    const free = new Map(live.disks.map((d) => [d.mount, d.free_bytes]));
    for (const disk of specs.disks) lines.push(`  ${diskLine(disk, free.get(disk.mount))}`);
  } else lines.push("Disks: none found");
  if (specs.displays?.length) {
    lines.push("Displays:");
    for (const d of specs.displays) lines.push(`  ${displayLine(d)}`);
  }
  if (specs.runtimes.bun || specs.runtimes.node) {
    const rt = [
      specs.runtimes.bun ? `Bun ${specs.runtimes.bun}` : undefined,
      specs.runtimes.node ? `Node ${specs.runtimes.node}` : undefined,
    ].filter(Boolean);
    lines.push(`Runtimes: ${rt.join(", ")}`);
  }
  const win = specs.windows_host;
  if (win) {
    lines.push("Windows host:");
    if (win.os) lines.push(`  OS: ${osLine(win.os)}`);
    if (win.cpu) lines.push(`  CPU: ${cpuLine(win.cpu)}`);
    if (win.memory) lines.push(`  Memory: ${formatBytes(win.memory.total_bytes)} total`);
    if (win.gpus?.length) lines.push(`  GPUs: ${win.gpus.map(gpuLine).join("; ")}`);
    const wsl = [win.wsl.distro, win.wsl.kernel ? `kernel ${win.wsl.kernel}` : undefined].filter(
      Boolean,
    );
    if (wsl.length) lines.push(`  WSL: ${wsl.join(", ")}`);
  }
  if (specs.errors?.length) lines.push(`Not read: ${specs.errors.join("; ")}`);
  const when = result.refreshed
    ? `Probed just now (${REASON_TEXT[result.reason ?? ""] ?? "refreshed"}).`
    : `Probed ${ageText(Date.parse(live.measured_at) - Date.parse(specs.probed_at))} (${specs.probed_at}); the record is current. Run ${binName} machine specs --refresh to probe again.`;
  lines.push(when);
  return lines.join("\n");
}
