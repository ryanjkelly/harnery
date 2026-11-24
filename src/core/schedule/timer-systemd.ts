/**
 * The opt-in clock (ADR 0272): one systemd user timer and service per
 * checkout, which call `<bin> schedule tick --source timer --root <checkout>`
 * every few minutes. `installScheduleTimer` writes and enables both units and
 * records `timer.json`; `uninstallScheduleTimer` removes them;
 * `scheduleTimerStatus` reads the state without changing anything.
 *
 * Every `systemctl` and `loginctl` call goes through an injected
 * `ScheduleCommandRunner`, and the unit folder can be overridden, so tests
 * never touch the real service manager.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { harnCliEntry } from "../cli-entry.ts";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import { defaultScheduleCommandRunner } from "./command-runner.ts";
import {
  SCHEDULE_TIMER_INTERVAL_MINUTES,
  type ScheduleTimerInstall,
  validateScheduleTimerInstall,
} from "./job-types.ts";
import { scheduleTimerInstallPath } from "./paths.ts";
import type { ScheduleCommandRunner } from "./types.ts";

/** Prefix of every unit this module writes. */
export const SCHEDULE_TIMER_UNIT_PREFIX = "harnery-schedule-";

/** Thrown for a refusal a person can act on (wrong platform, bad interval). */
export class ScheduleTimerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScheduleTimerError";
  }
}

/** The runtime and script that start the CLI that is running now. */
export interface ScheduleTimerEntry {
  /** The runtime binary (Node or Bun), absolute. */
  execPath: string;
  /** The CLI script that runtime runs, absolute: the host's entry when a host launched. */
  script: string;
}

export interface ScheduleTimerOptions {
  coordRoot: string;
  runner?: ScheduleCommandRunner;
  /** The folder for unit files. Default `$XDG_CONFIG_HOME/systemd/user`. */
  unitDir?: string;
  /** Environment read for `XDG_CONFIG_HOME`, `PATH`, `USER` and WSL markers. */
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Overrides WSL detection. */
  isWsl?: boolean;
}

export interface ScheduleTimerInstallOptions extends ScheduleTimerOptions {
  intervalMinutes?: number;
  /** Overrides the entry point; default is the running process's. */
  entry?: ScheduleTimerEntry;
  now?: () => Date;
}

export interface ScheduleTimerUnits {
  /** Short stable hash of the checkout's real path. */
  key: string;
  timer: string;
  service: string;
  unitDir: string;
  timerPath: string;
  servicePath: string;
}

/** Whether the user's manager keeps running after logout. Null when unknown. */
export interface ScheduleTimerLinger {
  enabled: boolean | null;
  /** The command that turns lingering on, shown as information only. */
  enable_command: string;
}

export interface ScheduleTimerInstallResult {
  units: ScheduleTimerUnits;
  checkout: string;
  interval_minutes: number;
  on_calendar: string;
  command: string[];
  /** The directories of the PATH the service pins, in order. */
  path_dirs: string[];
  record: ScheduleTimerInstall;
  linger: ScheduleTimerLinger;
  /** True when the unit files already existed and were rewritten. */
  reinstalled: boolean;
  notes: string[];
}

export interface ScheduleTimerUninstallResult {
  units: ScheduleTimerUnits;
  /** Unit files that existed and were removed. */
  removed_files: string[];
  removed_record: boolean;
  /** False when there was nothing to remove. */
  was_installed: boolean;
  warnings: string[];
}

export interface ScheduleTimerStatus {
  units: ScheduleTimerUnits;
  checkout: string;
  record: ScheduleTimerInstall | null;
  /** Set when `timer.json` exists but does not validate. */
  record_error?: string;
  timer_file: boolean;
  service_file: boolean;
  /** `systemctl --user is-enabled` output, or null when it could not be asked. */
  enabled: string | null;
  /** `systemctl --user is-active` output, or null when it could not be asked. */
  active: string | null;
}

// ── names and paths ──────────────────────────────────────────────────────────

/** The checkout's real path (symlinks resolved), or its absolute path. */
export function scheduleTimerCheckout(coordRoot: string): string {
  try {
    return realpathSync(coordRoot);
  } catch {
    return resolve(coordRoot);
  }
}

/** A short stable hash of a checkout path; two checkouts never share one. */
export function scheduleTimerKey(checkoutRealPath: string): string {
  return createHash("sha256").update(checkoutRealPath).digest("hex").slice(0, 12);
}

/** `$XDG_CONFIG_HOME/systemd/user`, defaulting to `~/.config/systemd/user`. */
export function scheduleTimerUnitDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  // systemd runs only on Linux, so the unit folder is a POSIX path on every host.
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg?.startsWith("/") ? xdg : posix.join(home, ".config");
  return posix.join(base, "systemd", "user");
}

export function scheduleTimerUnits(opts: ScheduleTimerOptions): ScheduleTimerUnits {
  const key = scheduleTimerKey(scheduleTimerCheckout(opts.coordRoot));
  const unitDir =
    opts.unitDir ?? scheduleTimerUnitDir(opts.env ?? process.env, opts.homeDir ?? homedir());
  const timer = `${SCHEDULE_TIMER_UNIT_PREFIX}${key}.timer`;
  const service = `${SCHEDULE_TIMER_UNIT_PREFIX}${key}.service`;
  return {
    key,
    timer,
    service,
    unitDir,
    timerPath: join(unitDir, timer),
    servicePath: join(unitDir, service),
  };
}

/**
 * The running CLI's entry: the runtime plus the script it was started with
 * (`argv[1]`), which is the host CLI's own entry when a host launched this
 * process. Falls back to Harnery's entry when the script cannot be found.
 */
export function resolveScheduleTimerEntry(): ScheduleTimerEntry {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  const script = invoked && existsSync(invoked) ? invoked : harnCliEntry();
  return { execPath: process.execPath, script };
}

/** The exact argument list the service runs. */
export function scheduleTimerCommand(entry: ScheduleTimerEntry, checkout: string): string[] {
  return [
    entry.execPath,
    entry.script,
    "schedule",
    "tick",
    "--source",
    "timer",
    "--root",
    checkout,
  ];
}

/** `OnCalendar=` for an interval that divides an hour. */
export function scheduleTimerOnCalendar(intervalMinutes: number): string {
  if (
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 60 ||
    60 % intervalMinutes !== 0
  ) {
    throw new ScheduleTimerError(
      "bad_timer_interval",
      `the timer interval must be a whole number of minutes that divides an hour (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60); got ${intervalMinutes}`,
    );
  }
  return intervalMinutes === 60 ? "*:00" : `*:0/${intervalMinutes}`;
}

// ── unit text and systemd escaping ───────────────────────────────────────────

function refuseControlChars(value: string, what: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ScheduleTimerError(
      "bad_timer_value",
      `${what} contains a control character, which a unit file cannot hold`,
    );
  }
  return value;
}

/** Escape systemd specifiers: `%` becomes `%%`. */
export function systemdEscapeSpecifiers(value: string): string {
  return value.replace(/%/g, "%%");
}

/**
 * One `ExecStart=` argument, double-quoted: backslash and quote are escaped,
 * `%` becomes `%%` (specifiers) and `$` becomes `$$` (variable expansion).
 */
export function systemdQuoteExecArg(value: string): string {
  refuseControlChars(value, "a command argument");
  const escaped = value
    .replace(/\\/g, () => "\\\\")
    .replace(/"/g, () => '\\"')
    .replace(/%/g, () => "%%")
    .replace(/\$/g, () => "$$");
  return `"${escaped}"`;
}

/** One `Environment=` assignment, double-quoted. `Environment=` does not expand `$`. */
export function systemdQuoteEnvironment(name: string, value: string): string {
  refuseControlChars(value, `the ${name} value`);
  const escaped = `${name}=${value}`
    .replace(/\\/g, () => "\\\\")
    .replace(/"/g, () => '\\"')
    .replace(/%/g, () => "%%");
  return `"${escaped}"`;
}

export interface ScheduleTimerUnitTextInput {
  checkout: string;
  command: string[];
  path: string;
  intervalMinutes: number;
}

/** The service unit. It pins PATH and nothing else from the environment. */
export function renderScheduleServiceUnit(input: ScheduleTimerUnitTextInput): string {
  const checkout = refuseControlChars(input.checkout, "the checkout path");
  if (checkout.trim() !== checkout) {
    throw new ScheduleTimerError(
      "bad_timer_value",
      "the checkout path starts or ends with whitespace, which WorkingDirectory= cannot hold",
    );
  }
  const name = systemdEscapeSpecifiers(basename(checkout));
  return [
    "[Unit]",
    `Description=Starts any Harnery jobs that are due in ${name} (harnery schedule tick)`,
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${systemdEscapeSpecifiers(checkout)}`,
    `Environment=${systemdQuoteEnvironment("PATH", input.path)}`,
    `ExecStart=${input.command.map(systemdQuoteExecArg).join(" ")}`,
    "",
  ].join("\n");
}

/** The timer unit. */
export function renderScheduleTimerUnit(input: ScheduleTimerUnitTextInput): string {
  const name = systemdEscapeSpecifiers(
    basename(refuseControlChars(input.checkout, "the checkout path")),
  );
  return [
    "[Unit]",
    `Description=Checks every few minutes for Harnery jobs due in ${name}`,
    "",
    "[Timer]",
    `OnCalendar=${scheduleTimerOnCalendar(input.intervalMinutes)}`,
    "Persistent=true",
    "AccuracySec=30s",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

// ── platform checks ──────────────────────────────────────────────────────────

function detectWsl(opts: ScheduleTimerOptions): boolean {
  if (opts.isWsl !== undefined) return opts.isWsl;
  const env = opts.env ?? process.env;
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

const WSL_NOTE =
  "This is WSL: the timer runs only while the WSL guest is running, so ticks stop when Windows shuts the guest down.";

function refusePlatform(platform: NodeJS.Platform): void {
  if (platform === "linux") return;
  const name =
    platform === "darwin"
      ? "macOS"
      : platform === "win32"
        ? "Windows"
        : `this platform (${platform})`;
  throw new ScheduleTimerError(
    "timer_platform_unsupported",
    `the schedule timer needs systemd on Linux; ${name} is not supported yet (macOS and Windows timers are not supported yet). Due jobs still run at session start and on prompts.`,
  );
}

const USER_MANAGER_STATES = new Set([
  "running",
  "degraded",
  "starting",
  "initializing",
  "maintenance",
]);

async function refuseUnusableSystemctl(runner: ScheduleCommandRunner, wsl: boolean): Promise<void> {
  const result = await runner(["systemctl", "--user", "is-system-running"]);
  const state = result.stdout.trim();
  if (!result.error && USER_MANAGER_STATES.has(state)) return;
  const reason =
    result.error === "ENOENT"
      ? "systemctl is not installed"
      : `systemctl --user is not usable (${state || result.stderr.trim() || result.error || `exit ${result.exitCode}`})`;
  const wslHint = wsl
    ? " On WSL, systemd must be enabled for the guest (systemd=true under [boot] in /etc/wsl.conf), and the timer runs only while the guest is running."
    : "";
  throw new ScheduleTimerError(
    "timer_systemctl_unavailable",
    `the schedule timer needs a systemd user manager: ${reason}.${wslHint}`,
  );
}

async function readLinger(
  runner: ScheduleCommandRunner,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ScheduleTimerLinger> {
  let user = env.USER?.trim() || "";
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = "";
    }
  }
  const enable_command = user ? `loginctl enable-linger ${user}` : "loginctl enable-linger";
  if (!user) return { enabled: null, enable_command };
  const result = await runner(["loginctl", "show-user", user, "--property=Linger", "--value"]);
  const value = result.stdout.trim();
  if (result.error || result.exitCode !== 0) return { enabled: null, enable_command };
  return { enabled: value === "yes" ? true : value === "no" ? false : null, enable_command };
}

// ── file helpers ─────────────────────────────────────────────────────────────

function writeUnitFile(path: string, text: string): void {
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o644 });
  renameSync(temporary, path);
}

function failureText(argv: readonly string[], r: Awaited<ReturnType<ScheduleCommandRunner>>) {
  const detail = r.stderr.trim() || r.stdout.trim() || r.error || `exit ${r.exitCode}`;
  return `${argv.join(" ")} failed: ${detail}`;
}

function succeeded(r: Awaited<ReturnType<ScheduleCommandRunner>>): boolean {
  return !r.error && r.exitCode === 0;
}

// ── install / uninstall / status ─────────────────────────────────────────────

/**
 * Write and enable this checkout's timer and service, then record
 * `timer.json`. Installing again rewrites both units, so a changed PATH or
 * entry point is picked up. When reloading or enabling fails, the files this
 * call wrote are removed and the error is thrown.
 */
export async function installScheduleTimer(
  opts: ScheduleTimerInstallOptions,
): Promise<ScheduleTimerInstallResult> {
  const runner = opts.runner ?? defaultScheduleCommandRunner;
  const env = opts.env ?? process.env;
  const wsl = detectWsl(opts);
  refusePlatform(opts.platform ?? process.platform);
  const intervalMinutes = opts.intervalMinutes ?? SCHEDULE_TIMER_INTERVAL_MINUTES;
  const onCalendar = scheduleTimerOnCalendar(intervalMinutes);
  await refuseUnusableSystemctl(runner, wsl);

  const checkout = scheduleTimerCheckout(opts.coordRoot);
  const units = scheduleTimerUnits(opts);
  const entry = opts.entry ?? resolveScheduleTimerEntry();
  const command = scheduleTimerCommand(entry, checkout);
  const path = env.PATH ?? "";
  const textInput = { checkout, command, path, intervalMinutes };
  const serviceText = renderScheduleServiceUnit(textInput);
  const timerText = renderScheduleTimerUnit(textInput);

  const reinstalled = existsSync(units.timerPath) || existsSync(units.servicePath);
  mkdirSync(units.unitDir, { recursive: true });
  writeUnitFile(units.servicePath, serviceText);
  writeUnitFile(units.timerPath, timerText);

  const rollback = async (message: string): Promise<never> => {
    await runner(["systemctl", "--user", "disable", "--now", units.timer]);
    rmSync(units.timerPath, { force: true });
    rmSync(units.servicePath, { force: true });
    rmSync(scheduleTimerInstallPath(opts.coordRoot), { force: true });
    await runner(["systemctl", "--user", "daemon-reload"]);
    throw new ScheduleTimerError("timer_enable_failed", `${message}. The unit files were removed.`);
  };

  const reloadArgv = ["systemctl", "--user", "daemon-reload"];
  const reload = await runner(reloadArgv);
  if (!succeeded(reload)) return rollback(failureText(reloadArgv, reload));
  const enableArgv = ["systemctl", "--user", "enable", "--now", units.timer];
  const enable = await runner(enableArgv);
  if (!succeeded(enable)) return rollback(failureText(enableArgv, enable));

  const record: ScheduleTimerInstall = {
    schema_version: 1,
    installed_at: (opts.now?.() ?? new Date()).toISOString(),
    interval_minutes: intervalMinutes,
    unit: units.timer,
    command,
  };
  const check = validateScheduleTimerInstall(record);
  if (!check.ok) return rollback(`the timer record is invalid: ${check.errors.join("; ")}`);
  writePrivateJsonAtomic(scheduleTimerInstallPath(opts.coordRoot), record);

  const linger = await readLinger(runner, env);
  const notes: string[] = [];
  if (linger.enabled === false) {
    notes.push(
      `Lingering is off for this user, so the timer stops when the user logs out. To keep it running, run: ${linger.enable_command}`,
    );
  } else if (linger.enabled === null) {
    notes.push(
      `Could not tell whether lingering is on. Without it the timer stops at logout; it is turned on with: ${linger.enable_command}`,
    );
  }
  if (wsl) notes.push(WSL_NOTE);

  return {
    units,
    checkout,
    interval_minutes: intervalMinutes,
    on_calendar: onCalendar,
    command,
    // A systemd unit's PATH is always colon-separated, whatever host wrote it.
    path_dirs: path.split(":").filter((dir) => dir.length > 0),
    record,
    linger,
    reinstalled,
    notes,
  };
}

/**
 * Disable and remove this checkout's timer and service and its `timer.json`.
 * Touches only the two units this checkout's key names. Safe when nothing is
 * installed; on a platform without systemd it only removes the record.
 */
export async function uninstallScheduleTimer(
  opts: ScheduleTimerOptions,
): Promise<ScheduleTimerUninstallResult> {
  const runner = opts.runner ?? defaultScheduleCommandRunner;
  const units = scheduleTimerUnits(opts);
  const recordPath = scheduleTimerInstallPath(opts.coordRoot);
  const present = [units.timerPath, units.servicePath].filter((p) => existsSync(p));
  const hadRecord = existsSync(recordPath);
  const warnings: string[] = [];
  const linux = (opts.platform ?? process.platform) === "linux";

  if (hadRecord) {
    const recorded = readRecord(recordPath).record;
    if (recorded && recorded.unit !== units.timer) {
      warnings.push(
        `timer.json named ${recorded.unit}, which is not this checkout's unit ${units.timer}; only ${units.timer} was touched.`,
      );
    }
  }

  if (linux && present.length > 0) {
    const disableArgv = ["systemctl", "--user", "disable", "--now", units.timer];
    const disable = await runner(disableArgv);
    if (!succeeded(disable)) warnings.push(failureText(disableArgv, disable));
  }
  for (const path of present) rmSync(path, { force: true });
  if (linux && present.length > 0) {
    const reloadArgv = ["systemctl", "--user", "daemon-reload"];
    const reload = await runner(reloadArgv);
    if (!succeeded(reload)) warnings.push(failureText(reloadArgv, reload));
  }
  if (hadRecord) rmSync(recordPath, { force: true });

  return {
    units,
    removed_files: present,
    removed_record: hadRecord,
    was_installed: present.length > 0 || hadRecord,
    warnings,
  };
}

function readRecord(path: string): { record: ScheduleTimerInstall | null; error?: string } {
  if (!existsSync(path)) return { record: null };
  try {
    const check = validateScheduleTimerInstall(JSON.parse(readFileSync(path, "utf8")));
    if (check.ok) return { record: check.value };
    return { record: null, error: check.errors.join("; ") };
  } catch (err) {
    return { record: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read-only: the record, the unit files, and what systemd says about the timer. */
export async function scheduleTimerStatus(
  opts: ScheduleTimerOptions,
): Promise<ScheduleTimerStatus> {
  const runner = opts.runner ?? defaultScheduleCommandRunner;
  const units = scheduleTimerUnits(opts);
  const { record, error } = readRecord(scheduleTimerInstallPath(opts.coordRoot));
  const status: ScheduleTimerStatus = {
    units,
    checkout: scheduleTimerCheckout(opts.coordRoot),
    record,
    timer_file: existsSync(units.timerPath),
    service_file: existsSync(units.servicePath),
    enabled: null,
    active: null,
  };
  if (error) status.record_error = error;
  if ((opts.platform ?? process.platform) !== "linux") return status;
  const ask = async (verb: "is-enabled" | "is-active"): Promise<string | null> => {
    const r = await runner(["systemctl", "--user", verb, units.timer]);
    if (r.error) return null;
    return r.stdout.trim() || null;
  };
  status.enabled = await ask("is-enabled");
  status.active = await ask("is-active");
  return status;
}
