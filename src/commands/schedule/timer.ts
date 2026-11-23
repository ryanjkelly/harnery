/**
 * `schedule install`, `schedule uninstall` and `schedule timer-status`: the
 * opt-in systemd user timer that calls `schedule tick` for this checkout
 * (ADR 0272). Status is its own read-only subcommand rather than a flag on
 * `install`, so checking can never install by mistake.
 */

import type { Command } from "commander";
import { defaultEmit, type EmitContext } from "../../commander.ts";
import { resolveCoordRoot } from "../../core/agents/coord-client.ts";
import { resolveBinName } from "../../core/config.ts";
import { SCHEDULE_TIMER_INTERVAL_MINUTES } from "../../core/schedule/job-types.ts";
import {
  installScheduleTimer,
  ScheduleTimerError,
  type ScheduleTimerInstallOptions,
  type ScheduleTimerInstallResult,
  type ScheduleTimerStatus,
  type ScheduleTimerUninstallResult,
  scheduleTimerStatus,
  uninstallScheduleTimer,
} from "../../core/schedule/timer-systemd.ts";

/** Test seams: the coordination root and every option the timer module takes. */
export type ScheduleTimerDeps = Partial<Omit<ScheduleTimerInstallOptions, "intervalMinutes">>;

function coordRootFor(deps: ScheduleTimerDeps, emit: EmitContext): string | null {
  const root = deps.coordRoot ?? resolveCoordRoot();
  if (root) return root;
  emit.error({ code: "not_in_project", message: "not inside a Harnery project" });
  emit.setExitCode(1);
  return null;
}

function fail(emit: EmitContext, error: unknown): void {
  if (error instanceof ScheduleTimerError) {
    emit.error({ code: error.code, message: error.message });
  } else {
    emit.error({
      code: "schedule_timer_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  emit.setExitCode(1);
}

/** Attach `install`, `uninstall` and `timer-status` to the `schedule` command. */
export function registerScheduleTimerCommands(
  schedule: Command,
  emit: EmitContext = defaultEmit,
  deps: ScheduleTimerDeps = {},
): void {
  schedule
    .command("install")
    .description(
      "Install one systemd user timer for this checkout that runs the schedule tick (Linux only).",
    )
    .option(
      "--interval-minutes <n>",
      "Minutes between ticks; must divide an hour",
      String(SCHEDULE_TIMER_INTERVAL_MINUTES),
    )
    .option("--json", "Emit the install result as JSON")
    .action(async (opts: { intervalMinutes: string; json?: boolean }) => {
      const coordRoot = coordRootFor(deps, emit);
      if (!coordRoot) return;
      const intervalMinutes = Number(opts.intervalMinutes);
      try {
        const result = await installScheduleTimer({ ...deps, coordRoot, intervalMinutes });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
        } else emit.text(renderInstall(result, resolveBinName(coordRoot)));
      } catch (error) {
        fail(emit, error);
      }
    });

  schedule
    .command("uninstall")
    .description("Disable and remove this checkout's schedule timer and service.")
    .option("--json", "Emit the uninstall result as JSON")
    .action(async (opts: { json?: boolean }) => {
      const coordRoot = coordRootFor(deps, emit);
      if (!coordRoot) return;
      try {
        const result = await uninstallScheduleTimer({ ...deps, coordRoot });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(result);
        } else emit.text(renderUninstall(result));
      } catch (error) {
        fail(emit, error);
      }
    });

  schedule
    .command("timer-status")
    .description(
      "Show whether this checkout's schedule timer is installed and running (read-only).",
    )
    .option("--json", "Emit the status as JSON")
    .action(async (opts: { json?: boolean }) => {
      const coordRoot = coordRootFor(deps, emit);
      if (!coordRoot) return;
      try {
        const status = await scheduleTimerStatus({ ...deps, coordRoot });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(status);
        } else emit.text(renderStatus(status, resolveBinName(coordRoot)));
      } catch (error) {
        fail(emit, error);
      }
    });
}

function renderInstall(r: ScheduleTimerInstallResult, bin: string): string {
  const lines = [
    `${r.reinstalled ? "Reinstalled" : "Installed"} the schedule timer for ${r.checkout}.`,
    "",
    `Timer:    ${r.units.timer} (every ${r.interval_minutes} min, OnCalendar=${r.on_calendar})`,
    `Service:  ${r.units.service}`,
    `Unit dir: ${r.units.unitDir}`,
    "",
    "The service runs:",
    `  ${r.command.map(shellQuote).join(" ")}`,
    "",
    "PATH pinned in the service:",
    ...(r.path_dirs.length > 0 ? r.path_dirs.map((d) => `  ${d}`) : ["  (empty)"]),
  ];
  if (r.notes.length > 0) lines.push("", ...r.notes);
  lines.push(
    "",
    `Check it with \`${bin} schedule timer-status\`; remove it with \`${bin} schedule uninstall\`.`,
  );
  return `${lines.join("\n")}\n`;
}

function renderUninstall(r: ScheduleTimerUninstallResult): string {
  const lines = r.was_installed
    ? [
        `Removed the schedule timer ${r.units.timer} and service ${r.units.service}.`,
        ...(r.removed_record ? ["Removed timer.json."] : []),
      ]
    : [`No schedule timer is installed for this checkout (${r.units.timer}).`];
  if (r.warnings.length > 0) lines.push("", ...r.warnings.map((w) => `warning: ${w}`));
  return `${lines.join("\n")}\n`;
}

function renderStatus(s: ScheduleTimerStatus, bin: string): string {
  const lines = [
    `Checkout: ${s.checkout}`,
    `Timer:    ${s.units.timer} (file ${s.timer_file ? "present" : "missing"})`,
    `Service:  ${s.units.service} (file ${s.service_file ? "present" : "missing"})`,
    `Enabled:  ${s.enabled ?? "unknown"}`,
    `Active:   ${s.active ?? "unknown"}`,
  ];
  if (s.record) {
    lines.push(
      `Record:   installed ${s.record.installed_at}, every ${s.record.interval_minutes} min`,
    );
  } else if (s.record_error) {
    lines.push(`Record:   unreadable (${s.record_error})`);
  } else {
    lines.push(`Record:   none; install with \`${bin} schedule install\``);
  }
  return `${lines.join("\n")}\n`;
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}
