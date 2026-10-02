import { type Command, InvalidArgumentError } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  type DiskGroup,
  type DiskOptions,
  type DiskReport,
  diskUsage,
  parseDiskSize,
} from "../lib/disk-usage.ts";

function positive(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    throw new InvalidArgumentError("requires a positive integer");
  return Number(value);
}

export function registerDiskCommand(program: Command, emit: EmitContext): void {
  program
    .command("disk [path]")
    .description("Measure checkout disk usage, including nested repositories and ignored files")
    .option(
      "--git <states>",
      "Filter: tracked, untracked, ignored, git-metadata, non-repository, unknown (comma-separated)",
    )
    .option(
      "--type <types>",
      "File extensions or video, audio, image, media, archive (comma-separated)",
    )
    .option(
      "--exclude <paths>",
      "Skip directory names at any depth or root-relative paths; repeatable, comma-separated",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--group <by>", "Group by directory, repository, extension, git, or files", "directory")
    .option("--depth <n>", "Directory grouping depth; does not limit the scan", positive, 1)
    .option("--top <n>", "Maximum groups and largest files to display", positive, 20)
    .option(
      "--min-size <size>",
      "Include individual files at least this size (e.g. 10MB, 1GiB)",
      parseDiskSize,
    )
    .option("--apparent", "Rank and filter by file lengths instead of allocated blocks")
    .option("--json", "Emit the versioned disk usage report")
    .action(
      (path: string | undefined, options: DiskOptions & { group: DiskGroup; json?: boolean }) => {
        try {
          const { json, ...filters } = options;
          const report = diskUsage(path, filters);
          if (json) {
            emit.config({ format: "json" });
            emit.data(report);
          } else emit.text(renderDiskUsage(report));
          if (!report.complete) emit.setExitCode(1);
        } catch (error) {
          emit.error({
            code: "disk_usage_failed",
            message: error instanceof Error ? error.message : String(error),
          });
          emit.setExitCode(1);
        }
      },
    );
}

export function renderDiskUsage(report: DiskReport): string {
  const bytes = (value: number): string =>
    value >= 1e9
      ? `${(value / 1e9).toFixed(2)} GB`
      : value >= 1e6
        ? `${(value / 1e6).toFixed(2)} MB`
        : value >= 1e3
          ? `${(value / 1e3).toFixed(2)} KB`
          : `${value} B`;
  const size = (row: { allocated_bytes: number | null; apparent_bytes: number }): string =>
    bytes(
      report.measurement === "allocated"
        ? (row.allocated_bytes ?? row.apparent_bytes)
        : row.apparent_bytes,
    );
  const lines = [
    `Disk usage: ${report.root}`,
    `${size(report.totals)} in ${report.totals.files.toLocaleString()} regular files (${report.measurement})`,
    `File lengths: ${bytes(report.totals.apparent_bytes)}. Directory metadata and symlinks are excluded.`,
    "",
    "Git state:",
  ];
  for (const [state, totals] of Object.entries(report.git))
    if (totals.files)
      lines.push(
        `${size(totals).padStart(12)}  ${String(totals.files).padStart(8)} files  ${state}`,
      );
  lines.push(
    "",
    `Largest ${report.filters.group} groups (${report.groups.length} of ${report.group_count}):`,
  );
  for (const row of report.groups)
    lines.push(`${size(row).padStart(12)}  ${String(row.files).padStart(8)} files  ${row.path}`);
  if (report.filters.group !== "files") {
    lines.push("", "Largest files:");
    for (const row of report.largest_files)
      lines.push(`${size(row).padStart(12)}  ${row.git.padEnd(14)}  ${row.path}`);
  }
  if (report.skipped.symlinks || report.skipped.special_files || report.skipped.excluded)
    lines.push(
      "",
      `Skipped: ${report.skipped.symlinks} symlinks, ${report.skipped.special_files} special files, ${report.skipped.excluded} excluded entries.`,
    );
  if (report.issues.length) {
    lines.push("", "Incomplete scan:");
    for (const issue of report.issues) lines.push(`${issue.path}: ${issue.message}`);
  }
  return `${lines.join("\n")}\n`;
}
