// `computer`: opt-in desktop control through pinned desktop drivers (ADRs 0228
// and 0231). The driver adapters (src/lib/computer/cua.ts and agent-desktop.ts,
// listed in drivers.ts), host detection and the cross-call desktop lease live
// in src/lib/computer/; this command owns the config gate, driver selection,
// flag parsing, lease policy for `call`, screenshot redaction, rendering, and
// exit codes. Every driver shares the one desktop lease.
//
// Approval modes (ADR 0230): in `ask-each-task` and `ask-once-per-session` an
// agent needs a live approval (`computer grant`, answered by the person) before
// `call` or `lease acquire` will take the desktop.
//
// Exit codes: 0 ok · 1 error (disabled, unsupported host, not installed,
// driver failure; `call` propagates the driver's own exit code) · 3 the
// desktop lease is held by another agent · 4 desktop control needs the
// person's approval first, or they declined.

import { hostname, userInfo } from "node:os";
import { basename } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveCoordRoot, resolveOwnerAcrossRoots } from "../core/agents/coord-client.ts";
import { agentDisplayName, resolveShortName } from "../core/agents/state/activity-log.ts";
import {
  COMPUTER_MODES,
  type ComputerMode,
  type ComputerPreferences,
  type ComputerProjectConfig,
  computerModeLooser,
  isComputerMode,
  readComputerConfig,
  readComputerPreferences,
  writeComputerPreference,
  writeSignInPreference,
} from "../core/config.ts";
import type { Confirm } from "../lib/computer/confirm.ts";
import { DRIVER_IDS } from "../lib/computer/drivers.ts";
import type {
  DesktopGrant,
  GrantChannel,
  GrantKind,
  GrantLogEntry,
} from "../lib/computer/grants.ts";
import type {
  BackgroundProcess,
  DaemonStatus,
  DesktopDriver,
  DesktopLease,
  DriverCallResult,
  HostInfo,
  LeaseApi,
  LeaseOptions,
  LeaseOwner,
} from "../lib/computer/types.ts";

/** Exit code for a desktop held by another agent. */
export const EXIT_LEASE_HELD = 3;
/** Exit code when desktop control needs the person's approval first, or they declined. */
export const EXIT_APPROVAL_REQUIRED = 4;
/** `call` waits this long for another agent's lease when nothing overrides it. */
export const DEFAULT_CALL_WAIT_SECONDS = 30;
/** How long the approval dialog waits for an answer before counting as no. */
export const DEFAULT_CONFIRM_SECONDS = 120;
/** Extra lease time beyond the driver's call timeout, so a slow call never outlives the lease. */
const CALL_LEASE_MARGIN_MS = 15_000;

/** Approval storage; the default writes beside the lease, tests inject an in-memory fake. */
export interface GrantsApi {
  live(
    dir: string,
    ownerId: string,
    project: string | undefined,
    nowMs: number,
  ): DesktopGrant | undefined;
  add(
    dir: string,
    grant: Omit<DesktopGrant, "id" | "granted_at" | "expires_at">,
    options: { nowMs: number; durationMs: number },
  ): DesktopGrant;
  end(
    dir: string,
    options: { nowMs: number; ownerId?: string; project?: string; kind?: GrantKind },
  ): DesktopGrant[];
  log(dir: string, entry: Omit<GrantLogEntry, "at">, nowMs: number): void;
  sessionMaxMs: number;
  defaultTaskMinutes: number;
}

/** Everything the command touches outside itself; tests inject fakes. */
export interface ComputerDeps {
  emit: EmitContext;
  binName: string;
  host: () => HostInfo;
  /** Every available driver, in registry order; `computer.driver` picks the default. */
  drivers: DesktopDriver[];
  lease: LeaseApi;
  owner: () => LeaseOwner;
  /** Effective settings; `prefs` evaluates a hypothetical set of personal choices. */
  config: (prefs?: ComputerPreferences) => ComputerProjectConfig;
  grants: GrantsApi;
  confirm: Confirm;
  /** The person's saved choices and where to save a new one. */
  prefs: {
    read: () => ComputerPreferences;
    write: (root: string | null, mode: ComputerMode | null) => ComputerPreferences;
    writeSignIn: (root: string | null, on: boolean | null) => ComputerPreferences;
  };
  /** The project root personal choices are keyed by. */
  projectRoot: () => string | null;
  /** Lease directory for a desktop state dir. */
  leaseDir: (desktopStateDir: string) => string;
  /** Idle expiry when config sets none. */
  defaultIdleMs: number;
  /** Driver stderr passthrough. */
  writeStderr: (text: string) => void;
  now: () => number;
}

export type ComputerDepsInput = Pick<ComputerDeps, "emit" | "binName"> &
  Partial<Omit<ComputerDeps, "prefs">> & {
    /** Any of the preference functions; the rest read and write the real file. */
    prefs?: Partial<ComputerDeps["prefs"]>;
    /** Shorthand for `drivers: [driver]` (tests). */
    driver?: DesktopDriver;
  };

/**
 * Who is asking for the desktop: the coordinated agent when one is resolvable,
 * else the calling OS user (`shell:<user>@<hostname>`, label `shell-<user>`), so
 * separate shell invocations by the same person share one lease.
 *
 * An agent may act on another project than the one its session is registered
 * in (`HARNERY_COORD_ROOT_OVERRIDE`). Its identity and name then come from its
 * own project, while `project` stays the root the command acts on, which is
 * what approvals are scoped to. Grant, call and done each resolve the owner
 * the same way, so a granted agent is recognized on its next call.
 */
export function resolveLeaseOwner(start: string = process.cwd()): LeaseOwner {
  const found = resolveOwnerAcrossRoots(start);
  const root = resolveCoordRoot(start);
  const id = found.owner;
  if (id) {
    const home = found.root ?? root;
    return {
      id,
      label: home ? resolveShortName(home, id) : agentDisplayName(id),
      ...(root ? { project: root } : {}),
      ...(home ? { sessionProject: home } : {}),
    };
  }
  const user = userInfo().username;
  return {
    id: `shell:${user}@${hostname()}`,
    label: `shell-${user}`,
    ...(root ? { project: root } : {}),
  };
}

async function loadDefaultDeps(): Promise<
  Pick<
    ComputerDeps,
    "host" | "drivers" | "lease" | "leaseDir" | "defaultIdleMs" | "grants" | "confirm"
  >
> {
  const [
    { detectHost },
    drivers,
    { desktopLease, leaseDir, DEFAULT_LEASE_IDLE_MS },
    grants,
    { confirmWithPerson },
  ] = await Promise.all([
    import("../lib/computer/host.ts"),
    import("../lib/computer/drivers.ts").then((m) => m.loadDrivers()),
    import("../lib/computer/lease.ts"),
    import("../lib/computer/grants.ts"),
    import("../lib/computer/confirm.ts"),
  ]);
  return {
    host: () => detectHost(),
    drivers,
    lease: desktopLease,
    leaseDir,
    defaultIdleMs: DEFAULT_LEASE_IDLE_MS,
    grants: {
      live: grants.liveGrant,
      add: grants.addGrant,
      end: grants.endGrants,
      log: grants.logGrantEvent,
      sessionMaxMs: grants.SESSION_GRANT_MAX_MS,
      defaultTaskMinutes: grants.DEFAULT_TASK_GRANT_MINUTES,
    },
    confirm: confirmWithPerson,
  };
}

/** Fill in every dependency the caller did not inject; driver modules load lazily. */
async function resolveDeps(input: ComputerDepsInput): Promise<ComputerDeps> {
  const needsDefaults =
    !input.host ||
    (!input.drivers && !input.driver) ||
    !input.lease ||
    !input.leaseDir ||
    !input.grants ||
    !input.confirm ||
    input.defaultIdleMs === undefined;
  const defaults = needsDefaults ? await loadDefaultDeps() : undefined;
  return {
    emit: input.emit,
    binName: input.binName,
    host: input.host ?? (defaults?.host as ComputerDeps["host"]),
    drivers:
      input.drivers ?? (input.driver ? [input.driver] : (defaults?.drivers as DesktopDriver[])),
    lease: input.lease ?? (defaults?.lease as LeaseApi),
    leaseDir: input.leaseDir ?? (defaults?.leaseDir as ComputerDeps["leaseDir"]),
    defaultIdleMs: input.defaultIdleMs ?? (defaults?.defaultIdleMs as number),
    grants: input.grants ?? (defaults?.grants as GrantsApi),
    confirm: input.confirm ?? (defaults?.confirm as Confirm),
    prefs: {
      read: () => readComputerPreferences(),
      write: (root, mode) => writeComputerPreference(root, mode),
      writeSignIn: (root, on) => writeSignInPreference(root, on),
      ...input.prefs,
    },
    projectRoot: input.projectRoot ?? (() => resolveCoordRoot()),
    owner: input.owner ?? (() => resolveLeaseOwner()),
    config: input.config ?? ((prefs) => readComputerConfig(undefined, prefs)),
    writeStderr: input.writeStderr ?? ((text) => process.stderr.write(text)),
    now: input.now ?? Date.now,
  };
}

class ComputerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
    readonly hint?: string,
  ) {
    super(message);
  }
}

function enableHint(): string {
  return `Set "computer": { "mode": "ask-each-task" } (or ${COMPUTER_MODES.filter(
    (m) => m !== "off" && m !== "ask-each-task",
  )
    .map((m) => `"${m}"`)
    .join(" or ")}) in .harnery/config.jsonc to enable it for this project.`;
}

function requireEnabled(deps: ComputerDeps): ComputerProjectConfig {
  const config = deps.config();
  if (config.enabled) return config;
  if (config.config_error) {
    throw new ComputerError(
      "computer_config_invalid",
      `Computer use is off because the project's computer settings are invalid: ${config.config_error}.`,
    );
  }
  if (config.project_enabled) {
    throw new ComputerError(
      "computer_disabled",
      `Computer use is off by your own choice (${describeSource(config)}). Change it with \`${deps.binName} computer mode <mode>\`.`,
    );
  }
  throw new ComputerError(
    "computer_disabled",
    `Computer use is off in this project. ${enableHint()}`,
  );
}

function describeSource(config: ComputerProjectConfig): string {
  if (config.mode_source === "user-project") return "your setting for this project";
  if (config.mode_source === "user-default") return "your setting for all projects";
  return "the project's setting";
}

function describeMode(mode: ComputerMode): string {
  switch (mode) {
    case "off":
      return "off";
    case "ask-each-task":
      return "ask before each task";
    case "ask-once-per-session":
      return "ask once per agent session";
    case "on":
      return "on, no asking";
  }
}

function describeSignInSource(config: ComputerProjectConfig): string {
  if (config.sign_in_source === "user-project") return "your setting for this project";
  if (config.sign_in_source === "user-default") return "your setting for all projects";
  return "the default";
}

/** The person's own sign-in choice for one project, before the project's and the desktop's gates. */
function personSignIn(prefs: ComputerPreferences, root: string): boolean {
  return prefs.sign_in_projects?.[root] ?? prefs.sign_in ?? false;
}

/** The `sign-in:` status line: whether agents may sign in to websites for this person, and why. */
function describeSignIn(config: ComputerProjectConfig, bin: string): string {
  if (!config.project_sign_in) return "off (this project does not allow agents to sign in for you)";
  if (config.sign_in) {
    return `on: agents may sign in to websites for you with your password manager (${describeSignInSource(config)})`;
  }
  if (!config.enabled) {
    return config.person_sign_in
      ? `off while your desktop control is off (you turned it on, ${describeSignInSource(config)}; it comes back with desktop control; \`${bin} computer sign-in off\` removes it)`
      : "off (desktop control is off)";
  }
  return `off: you sign in yourself (${describeSignInSource(config)}; \`${bin} computer sign-in on\` lets agents do it)`;
}

function grantKindFor(mode: ComputerMode): GrantKind | null {
  if (mode === "ask-each-task") return "task";
  if (mode === "ask-once-per-session") return "session";
  return null;
}

function grantDurationMs(
  deps: ComputerDeps,
  config: ComputerProjectConfig,
  kind: GrantKind,
): number {
  if (kind === "session") return deps.grants.sessionMaxMs;
  return Math.round((config.grant_minutes ?? deps.grants.defaultTaskMinutes) * 60_000);
}

/**
 * In an ask mode, refuse unless the owner holds a live approval for this
 * project. Returns the approval (undefined in `on` mode).
 */
function requireApproval(
  deps: ComputerDeps,
  config: ComputerProjectConfig,
  host: SupportedHost,
  owner: LeaseOwner,
): DesktopGrant | undefined {
  const kind = grantKindFor(config.mode);
  if (!kind) return undefined;
  const grant = deps.grants.live(
    deps.leaseDir(host.desktopStateDir),
    owner.id,
    owner.project,
    deps.now(),
  );
  if (grant) return grant;
  throw new ComputerError(
    "computer_approval_required",
    `Desktop control needs the person's approval first (${describeMode(config.mode)}). Run \`${deps.binName} computer grant --purpose "<what you will do on the desktop>"\`; they answer a Yes/No prompt.`,
    EXIT_APPROVAL_REQUIRED,
  );
}

function grantMessage(
  owner: LeaseOwner,
  purpose: string,
  kind: GrantKind,
  durationMs: number,
): string {
  const lasts =
    kind === "task"
      ? `for this task only, up to ${Math.round(durationMs / 60_000)} minutes`
      : `for the rest of this agent's session, up to ${Math.round(durationMs / 3_600_000)} hours`;
  const where = owner.sessionProject ?? owner.project;
  const who = where ? `an AI agent working in ${basename(where)}` : "an AI agent";
  return [
    `${owner.label} (${who}) wants to use this computer's screen, mouse and keyboard.`,
    "",
    `What for: ${purpose}`,
    "",
    `If you allow it, the approval lasts ${lasts}.`,
    "",
    "Before you allow it, close or minimize anything it should not see, on every screen: what is on screen can be sent to the AI provider. It must not send messages, emails or posts unless you approve each one separately.",
  ].join("\n");
}

type SupportedHost = HostInfo & { desktopStateDir: string };

function requireSupported(host: HostInfo): SupportedHost {
  if (host.kind === "unsupported" || !host.desktopStateDir) {
    throw new ComputerError(
      "computer_unsupported_host",
      `Computer use is not available on this host: ${host.reason ?? "no supported desktop driver build"}`,
    );
  }
  return host as SupportedHost;
}

/**
 * The driver a command acts on: `--driver`, else the project's
 * `computer.driver`, else the first registered driver.
 */
function selectDriver(deps: ComputerDeps, requested?: string): DesktopDriver {
  const id = requested ?? deps.config().driver ?? deps.drivers[0]?.id;
  const found = deps.drivers.find((d) => d.id === id);
  if (found) return found;
  throw new ComputerError(
    "computer_usage",
    `Unknown desktop driver "${id}". Available: ${deps.drivers.map((d) => d.id).join(", ")}.`,
  );
}

/** `--driver` narrows to one driver; without it, every driver. */
function targetDrivers(deps: ComputerDeps, requested?: string): DesktopDriver[] {
  return requested ? [selectDriver(deps, requested)] : deps.drivers;
}

function defaultDriverId(deps: ComputerDeps): string | undefined {
  try {
    return selectDriver(deps).id;
  } catch {
    return undefined;
  }
}

function requireInstalled(deps: ComputerDeps, driver: DesktopDriver, host: HostInfo): string {
  const exe = driver.installedExecutable(host);
  if (exe) return exe;
  throw new ComputerError(
    "computer_not_installed",
    `The pinned desktop driver (${driver.id} ${driver.version}) is not installed. Run \`${deps.binName} computer install --driver ${driver.id} --yes\`.`,
  );
}

function configuredIdleMs(deps: ComputerDeps): number {
  const idleSeconds = deps.config().idle_seconds;
  return idleSeconds !== undefined ? Math.round(idleSeconds * 1000) : deps.defaultIdleMs;
}

function leaseOptions(
  deps: ComputerDeps,
  host: SupportedHost,
  waitMs = 0,
  idleMs = configuredIdleMs(deps),
): LeaseOptions {
  return {
    dir: deps.leaseDir(host.desktopStateDir),
    idleMs,
    waitMs,
    now: deps.now,
  };
}

/** Lease time for one `call`: long enough that the call itself can never outlive the lease. */
function callLeaseIdleMs(
  deps: ComputerDeps,
  driver: DesktopDriver,
  tool: string,
  args: Record<string, unknown>,
): number {
  const timeout = driver.callTimeoutFor?.(tool, args) ?? driver.callTimeoutMs ?? 0;
  return Math.max(configuredIdleMs(deps), timeout + CALL_LEASE_MARGIN_MS);
}

function secondsUntil(iso: string, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 1000));
}

function expiresInSeconds(lease: DesktopLease, nowMs: number): number {
  return secondsUntil(lease.expires_at, nowMs);
}

function describeLease(lease: DesktopLease, nowMs: number): string {
  return `${lease.owner_label} (generation ${lease.generation}, idle-expires in ${expiresInSeconds(lease, nowMs)}s)`;
}

function heldError(deps: ComputerDeps, holder: DesktopLease): ComputerError {
  return new ComputerError(
    "computer_lease_held",
    `Desktop is held by ${describeLease(holder, deps.now())}. Wait, or ask them to run \`${deps.binName} computer lease release\`.`,
    EXIT_LEASE_HELD,
  );
}

function parseSeconds(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 3600) {
    throw new ComputerError("computer_usage", `${flag} must be a number of seconds from 0 to 3600`);
  }
  return value;
}

function parseCallArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ComputerError(
      "computer_usage",
      `Tool arguments must be JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ComputerError("computer_usage", "Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

const PNG_B64_RE = /"([A-Za-z0-9_]*png_b64)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
/** Any long run of base64 in a string value (a screenshot under a generic key such as `data`). */
const LONG_B64_RE = /"([A-Za-z0-9_]+)"(\s*:\s*)"([A-Za-z0-9+/]{2048,}={0,2})"/g;

/**
 * Replace inline base64 screenshots in driver output with a short note, so a
 * single state read cannot flood the calling agent's context. Works on the raw
 * text, so the driver's formatting survives.
 */
export function redactInlineScreenshots(stdout: string): string {
  const note = (key: string, sep: string, value: string) =>
    `"${key}"${sep}"<omitted ${value.length} chars; save to a file (screenshot_out_file or output_path) or pass --keep-screenshot>"`;
  return stdout
    .replace(PNG_B64_RE, (_m, key: string, sep: string, value: string) => note(key, sep, value))
    .replace(LONG_B64_RE, (_m, key: string, sep: string, value: string) => note(key, sep, value));
}

function printDriverResult(deps: ComputerDeps, result: DriverCallResult, stdout = result.stdout) {
  if (stdout) emitLine(deps.emit, stdout);
  if (result.stderr)
    deps.writeStderr(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  if (result.exitCode !== 0) deps.emit.setExitCode(result.exitCode);
}

async function ensureDaemon(driver: DesktopDriver, host: HostInfo): Promise<DaemonStatus> {
  const current = driver.daemonStatus(host);
  if (current.running) return current;
  const started = await driver.startDaemon(host);
  if (!started.running) {
    throw new ComputerError(
      "computer_daemon_failed",
      `The ${driver.id} daemon did not start${started.detail ? `: ${started.detail}` : "."}`,
    );
  }
  return started;
}

function describeBackground(procs: BackgroundProcess[], stopHint?: string): string {
  if (procs.length === 0) return "none running";
  const kinds = [...new Set(procs.map((p) => p.kind))].join(", ");
  const plural = procs.length === 1 ? "" : "s";
  const base = `${procs.length} ${kinds}${plural} running (pid ${procs.map((p) => p.pid).join(", ")})`;
  return stopHint ? `${base}; ${stopHint}` : base;
}

function describeDaemon(driver: DesktopDriver, daemon: DaemonStatus | null): string {
  if (!driver.hasDaemon) return "not needed (runs per call)";
  if (!daemon) return "n/a";
  return daemon.running
    ? `running${daemon.pid !== undefined ? ` (pid ${daemon.pid})` : ""}`
    : `stopped${daemon.detail ? ` (${daemon.detail})` : ""}`;
}

const DRIVER_OPTION = "--driver <id>";
function driverHelp(what: string): string {
  return `Desktop driver ${what} (${DRIVER_IDS.join(" or ")}).`;
}

/** Write human-readable text, ending it with exactly one newline. */
function emitLine(emit: { text(s: string): void }, s: string): void {
  emit.text(s.endsWith("\n") ? s : `${s}\n`);
}

/** Run one action, turning a ComputerError (or any throw) into emit.error + exit code. */
function guarded<A extends unknown[]>(
  input: ComputerDepsInput,
  body: (deps: ComputerDeps, ...args: A) => Promise<void> | void,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const deps = await resolveDeps(input);
    try {
      await body(deps, ...args);
    } catch (err) {
      if (err instanceof ComputerError) {
        deps.emit.error({
          code: err.code,
          message: err.message,
          ...(err.hint ? { hint: err.hint } : {}),
        });
        deps.emit.setExitCode(err.exitCode);
        return;
      }
      deps.emit.error({ code: "computer_error", message: (err as Error).message ?? String(err) });
      deps.emit.setExitCode(1);
    }
  };
}

interface DoctorCheck {
  name: string;
  status: string;
  message?: string;
}

/** Pull `{name, status, message}` checks out of the driver's health report, leniently. */
function healthChecks(json: unknown): DoctorCheck[] | undefined {
  const source = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? (json as Record<string, unknown>).checks
      : undefined;
  const toCheck = (name: string, value: unknown): DoctorCheck | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const status =
      record.status ??
      record.state ??
      (record.ok === true ? "pass" : record.ok === false ? "fail" : undefined);
    if (typeof status !== "string") return undefined;
    const message = record.message ?? record.detail;
    return {
      name: typeof record.name === "string" ? record.name : name,
      status,
      ...(typeof message === "string" ? { message } : {}),
    };
  };
  if (Array.isArray(source)) {
    const checks = source
      .map((value, i) => toCheck(`check-${i + 1}`, value))
      .filter((c): c is DoctorCheck => c !== undefined);
    return checks.length > 0 ? checks : undefined;
  }
  if (source && typeof source === "object") {
    const checks = Object.entries(source as Record<string, unknown>)
      .map(([name, value]) => toCheck(name, value))
      .filter((c): c is DoctorCheck => c !== undefined);
    return checks.length > 0 ? checks : undefined;
  }
  return undefined;
}

// "skip" is a check that does not apply on this platform, not a failure.
const PASSING = new Set(["pass", "passed", "ok", "healthy", "success", "skip", "skipped", "info"]);

/**
 * Build the `computer` command tree under `parent` (a fresh root when omitted)
 * and return it. Tests pass fakes for host/driver/lease/owner/config.
 */
export function createComputerCommand(
  input: ComputerDepsInput,
  parent: Command = new Command(),
): Command {
  const bin = input.binName;
  const computer = parent
    .command("computer")
    .description(
      "Opt-in desktop control through pinned desktop drivers (cua, agent-desktop): install them, run any daemon, " +
        "and call their tools while holding a desktop lease shared by every agent on this machine.",
    )
    .addHelpText(
      "after",
      `\nEnable per project with "computer": { "mode": "ask-each-task" } (or "ask-once-per-session" or "on")\n` +
        `in .harnery/config.jsonc; each person may then choose their own with \`${bin} computer mode <mode>\`.\n` +
        `Exit codes: 0 ok · 1 error · ${EXIT_LEASE_HELD} desktop held by another agent · ${EXIT_APPROVAL_REQUIRED} approval needed or declined.\n` +
        `Start with \`${bin} computer status\`.`,
    );

  // ------------------------------------------------------------------ status
  computer
    .command("status")
    .description(
      "Show the approval mode and your approval, the host, each pinned driver with its install and daemon, and the desktop lease holder.",
    )
    .option("--json", "Emit the status as JSON.")
    .action(
      guarded(input, (deps, opts: { json?: boolean }) => {
        const config = deps.config();
        const host = deps.host();
        const supported = host.kind !== "unsupported" && Boolean(host.desktopStateDir);
        const defaultId = defaultDriverId(deps);
        const drivers = deps.drivers.map((driver) => {
          const installed = supported ? (driver.installedExecutable(host) ?? null) : null;
          let daemon: DaemonStatus | null = null;
          if (installed && driver.hasDaemon) {
            try {
              daemon = driver.daemonStatus(host);
            } catch (err) {
              daemon = { running: false, detail: (err as Error).message };
            }
          }
          let background: BackgroundProcess[] | null = null;
          if (installed && driver.backgroundProcesses) {
            try {
              background = driver.backgroundProcesses(host);
            } catch {
              background = null;
            }
          }
          return { driver, installed, daemon, background };
        });
        const lease = supported ? deps.lease.read(leaseOptions(deps, host as SupportedHost)) : null;
        const nowMs = deps.now();
        const owner = deps.owner();
        const grant = supported
          ? (deps.grants.live(
              deps.leaseDir((host as SupportedHost).desktopStateDir),
              owner.id,
              owner.project,
              nowMs,
            ) ?? null)
          : null;
        if (opts.json) {
          deps.emit.data({
            enabled: config.enabled,
            mode: config.mode,
            project_mode: config.project_mode,
            mode_source: config.mode_source,
            ...(config.config_error ? { config_error: config.config_error } : {}),
            sign_in: config.sign_in,
            project_sign_in: config.project_sign_in,
            sign_in_source: config.sign_in_source,
            person_sign_in: config.person_sign_in,
            approval: grant,
            host: {
              kind: host.kind,
              ...(host.reason ? { reason: host.reason } : {}),
              ...(host.note ? { note: host.note } : {}),
            },
            default_driver: defaultId ?? null,
            drivers: drivers.map(({ driver, installed, daemon, background }) => ({
              id: driver.id,
              version: driver.version,
              summary: driver.summary,
              has_daemon: driver.hasDaemon,
              installed,
              daemon,
              background_processes: background,
            })),
            lease: lease ? { ...lease, expires_in_seconds: expiresInSeconds(lease, nowMs) } : null,
          });
          return;
        }
        const modeLine = config.config_error
          ? `off (invalid settings: ${config.config_error})`
          : !config.project_enabled
            ? `off (${enableHint()})`
            : `${config.mode}: ${describeMode(config.mode)} (${describeSource(config)}; project default ${config.project_mode})`;
        const grantKind = grantKindFor(config.mode);
        const lines = [
          `mode:      ${modeLine}`,
          ...(grantKind
            ? [
                `approval:  ${
                  grant
                    ? `${grant.kind} approval for "${grant.purpose}", ends in ${secondsUntil(grant.expires_at, nowMs)}s`
                    : `none; run \`${deps.binName} computer grant --purpose "<what for>"\` before using the desktop`
                }`,
              ]
            : []),
          `sign-in:   ${describeSignIn(config, deps.binName)}`,
          `host:      ${host.kind}${host.reason ? ` (${host.reason})` : ""}${host.note ? ` (${host.note})` : ""}`,
        ];
        for (const { driver, installed, daemon, background } of drivers) {
          lines.push(
            `driver:    ${driver.id} ${driver.version} (pinned${driver.id === defaultId ? ", default" : ""}): ${driver.summary}`,
          );
          if (supported) {
            lines.push(`  installed: ${installed ?? "not installed"}`);
            if (installed) lines.push(`  daemon:    ${describeDaemon(driver, daemon)}`);
            if (installed && background)
              lines.push(
                `  helpers:   ${describeBackground(background, `\`${deps.binName} computer down\` stops them`)}`,
              );
          }
        }
        if (supported)
          lines.push(`lease:     ${lease ? `held by ${describeLease(lease, nowMs)}` : "free"}`);
        emitLine(deps.emit, lines.join("\n"));
      }),
    );

  // ----------------------------------------------------------------- install
  computer
    .command("install")
    .description(
      "Preview the pinned driver installs (URL, SHA-256, install dir, other steps); --yes downloads, verifies, and installs them.",
    )
    .option(DRIVER_OPTION, driverHelp("to install; default: every driver"))
    .option("--yes", "Apply the install. Without it, only the plan is shown.")
    .option("--json", "Emit the plans or results as JSON.")
    .action(
      guarded(input, async (deps, opts: { driver?: string; yes?: boolean; json?: boolean }) => {
        requireEnabled(deps);
        const host = requireSupported(deps.host());
        const drivers = targetDrivers(deps, opts.driver);
        const plans = drivers.map((driver) => ({ driver, plan: driver.planInstall(host) }));
        if (!opts.yes) {
          if (opts.json) {
            deps.emit.data({ applied: false, plans: plans.map(({ plan }) => plan) });
            return;
          }
          const lines: string[] = [];
          for (const { plan } of plans) {
            lines.push(
              `${plan.alreadyInstalled ? "Already installed" : "Would install"}: ${plan.driver} ${plan.version} for ${plan.host}`,
              `  url:          ${plan.artifact.url}`,
              `  sha256:       ${plan.artifact.sha256}`,
              `  install dir:  ${plan.installDir}`,
              `  executable:   ${plan.executable}`,
            );
            if (plan.preferenceFile)
              lines.push(
                `  preferences:  ${plan.preferenceFile} ${JSON.stringify(plan.preferences ?? {})}`,
              );
            for (const step of plan.steps ?? []) lines.push(`  step:         ${step}`);
            for (const item of plan.setup ?? []) lines.push(`  you:          ${item}`);
          }
          const pending = plans.filter(({ plan }) => !plan.alreadyInstalled);
          lines.push(
            pending.length === 0
              ? "Nothing to do."
              : `Re-run with --yes to install: \`${deps.binName} computer install${opts.driver ? ` --driver ${opts.driver}` : ""} --yes\`.`,
          );
          emitLine(deps.emit, lines.join("\n"));
          return;
        }
        const results: unknown[] = [];
        const lines: string[] = [];
        let failed = false;
        for (const { driver, plan } of plans) {
          try {
            const result = await driver.install(plan);
            results.push(result);
            lines.push(
              result.installed
                ? `Installed ${result.driver} ${result.version} at ${result.executable}.`
                : `${result.driver} ${result.version} was already installed at ${result.executable}.`,
            );
            for (const item of result.setup ?? []) lines.push(`  you: ${item}`);
          } catch (err) {
            failed = true;
            const message = (err as Error).message ?? String(err);
            results.push({ driver: driver.id, error: message });
            lines.push(`Failed to install ${driver.id} ${driver.version}: ${message}`);
          }
        }
        if (opts.json) deps.emit.data({ applied: true, results });
        else {
          if (!failed && drivers.some((d) => d.hasDaemon))
            lines.push(`Start daemons with \`${deps.binName} computer up\`.`);
          emitLine(deps.emit, lines.join("\n"));
        }
        if (failed) deps.emit.setExitCode(1);
      }),
    );

  // ---------------------------------------------------------------- up/down
  computer
    .command("up")
    .description(
      "Start each installed driver's daemon (unelevated) if it is not running; drivers without a daemon need nothing.",
    )
    .option(DRIVER_OPTION, driverHelp("to start; default: every installed driver"))
    .action(
      guarded(input, async (deps, opts: { driver?: string }) => {
        requireEnabled(deps);
        const host = requireSupported(deps.host());
        const drivers = targetDrivers(deps, opts.driver);
        if (opts.driver) requireInstalled(deps, drivers[0] as DesktopDriver, host);
        const installed = drivers.filter((d) => d.installedExecutable(host));
        if (installed.length === 0) requireInstalled(deps, drivers[0] as DesktopDriver, host);
        const lines: string[] = [];
        for (const driver of installed) {
          if (!driver.hasDaemon) {
            lines.push(`${driver.id}: no daemon needed.`);
            continue;
          }
          const status = await ensureDaemon(driver, host);
          lines.push(
            `${driver.id}: daemon running${status.pid !== undefined ? ` (pid ${status.pid})` : ""}.`,
          );
        }
        emitLine(deps.emit, lines.join("\n"));
      }),
    );

  computer
    .command("down")
    .description(
      "Stop each installed driver's daemon and any background processes it left running " +
        "(left alone while another agent holds the desktop, since a call may be using them).",
    )
    .option(DRIVER_OPTION, driverHelp("to stop; default: every installed driver"))
    .action(
      guarded(input, (deps, opts: { driver?: string }) => {
        const host = requireSupported(deps.host());
        const drivers = targetDrivers(deps, opts.driver);
        if (opts.driver) requireInstalled(deps, drivers[0] as DesktopDriver, host);
        const lines: string[] = [];
        const holder = deps.lease.read(leaseOptions(deps, host));
        const owner = deps.owner();
        const heldByOther = holder && holder.owner_id !== owner.id ? holder : null;
        for (const driver of drivers.filter((d) => d.installedExecutable(host))) {
          const background = driver.backgroundProcesses?.(host) ?? [];
          if (background.length > 0 && driver.stopBackgroundProcesses) {
            if (heldByOther) {
              lines.push(
                `${driver.id}: left ${describeBackground(background)}; the desktop is held by ${describeLease(heldByOther, deps.now())}.`,
              );
              deps.emit.setExitCode(EXIT_LEASE_HELD);
            } else {
              const remaining = driver.stopBackgroundProcesses(host);
              lines.push(
                remaining.length
                  ? `${driver.id}: could not stop ${describeBackground(remaining)}.`
                  : `${driver.id}: stopped ${background.length} ${background[0]?.kind ?? "process"}${background.length === 1 ? "" : "s"}.`,
              );
              if (remaining.length) deps.emit.setExitCode(1);
            }
          }
          if (!driver.hasDaemon) {
            if (background.length === 0) lines.push(`${driver.id}: no daemon.`);
            continue;
          }
          const status = driver.stopDaemon(host);
          lines.push(
            status.running
              ? `${driver.id}: daemon still running: ${status.detail}`
              : `${driver.id}: daemon stopped.`,
          );
          if (status.running) deps.emit.setExitCode(1);
        }
        emitLine(deps.emit, lines.length ? lines.join("\n") : "No driver is installed.");
      }),
    );

  // ------------------------------------------------------------------ doctor
  computer
    .command("doctor")
    .description("Run each installed driver's own health report; any non-passing check exits 1.")
    .option(DRIVER_OPTION, driverHelp("to check; default: every installed driver"))
    .option("--json", "Emit the checks as JSON.")
    .action(
      guarded(input, (deps, opts: { driver?: string; json?: boolean }) => {
        const host = requireSupported(deps.host());
        const drivers = targetDrivers(deps, opts.driver);
        if (opts.driver) requireInstalled(deps, drivers[0] as DesktopDriver, host);
        const installed = drivers.filter((d) => d.installedExecutable(host));
        if (installed.length === 0) requireInstalled(deps, drivers[0] as DesktopDriver, host);
        const reports = installed.map((driver) => {
          const result = driver.health(host);
          let json = result.json;
          if (json === undefined) {
            try {
              json = JSON.parse(result.stdout);
            } catch {
              json = undefined;
            }
          }
          const checks = healthChecks(json);
          const failing = checks?.filter((c) => !PASSING.has(c.status.toLowerCase())) ?? [];
          const ok = result.exitCode === 0 && checks !== undefined && failing.length === 0;
          return { driver, result, json, checks, ok };
        });
        const ok = reports.every((r) => r.ok);
        if (opts.json) {
          deps.emit.data({
            ok,
            drivers: reports.map(({ driver, result, json, checks, ok }) => ({
              driver: driver.id,
              ok,
              exit_code: result.exitCode,
              checks: checks ?? null,
              report: json ?? result.stdout,
            })),
          });
        } else {
          const lines: string[] = [];
          for (const { driver, result, checks } of reports) {
            lines.push(`${driver.id} ${driver.version}:`);
            if (checks)
              for (const c of checks)
                lines.push(`  ${c.status.padEnd(6)} ${c.name}${c.message ? `: ${c.message}` : ""}`);
            else {
              if (result.stdout) lines.push(result.stdout.replace(/\n$/, ""));
              lines.push("  No structured checks in the driver's health report.");
            }
          }
          emitLine(deps.emit, lines.join("\n"));
        }
        for (const { result } of reports) if (result.stderr) deps.writeStderr(result.stderr);
        if (!ok) deps.emit.setExitCode(1);
      }),
    );

  // ---------------------------------------------------------- tools/describe
  computer
    .command("tools")
    .description("List a driver's tools.")
    .option(DRIVER_OPTION, driverHelp("to list (default: the project's default driver)"))
    .action(
      guarded(input, (deps, opts: { driver?: string }) => {
        const host = requireSupported(deps.host());
        const driver = selectDriver(deps, opts.driver);
        requireInstalled(deps, driver, host);
        printDriverResult(deps, driver.listTools(host));
      }),
    );

  computer
    .command("describe <tool>")
    .description("Show one tool's description and arguments.")
    .option(
      DRIVER_OPTION,
      driverHelp("the tool belongs to (default: the project's default driver)"),
    )
    .action(
      guarded(input, (deps, tool: string, opts: { driver?: string }) => {
        const host = requireSupported(deps.host());
        const driver = selectDriver(deps, opts.driver);
        requireInstalled(deps, driver, host);
        printDriverResult(deps, driver.describe(host, tool));
      }),
    );

  // -------------------------------------------------------------------- call
  computer
    .command("call <tool> [json]")
    .description(
      "Call one driver tool with a JSON object of arguments, holding the desktop lease. " +
        "`session` defaults to your agent name; inline base64 screenshots are redacted unless --keep-screenshot.",
    )
    .option(DRIVER_OPTION, driverHelp("to call (default: the project's default driver)"))
    .option(
      "--wait <seconds>",
      "How long to wait for another agent's lease (default: config wait_seconds or 30).",
    )
    .option("--keep-screenshot", "Print inline base64 screenshots instead of redacting them.")
    .action(
      guarded(
        input,
        async (
          deps,
          tool: string,
          rawJson: string | undefined,
          opts: { driver?: string; wait?: string; keepScreenshot?: boolean },
        ) => {
          const config = requireEnabled(deps);
          const host = requireSupported(deps.host());
          const driver = selectDriver(deps, opts.driver);
          requireInstalled(deps, driver, host);
          const args = parseCallArgs(rawJson);
          const waitSeconds =
            parseSeconds(opts.wait, "--wait") ?? config.wait_seconds ?? DEFAULT_CALL_WAIT_SECONDS;
          const owner = deps.owner();
          requireApproval(deps, config, host, owner);
          if (!("session" in args)) args.session = owner.label;

          // Hold the lease for at least the driver's call timeout, so a slow
          // call never runs on after its lease lapsed and another agent took
          // the desktop; refresh to the normal idle period once it returns.
          const acquired = await deps.lease.acquire(
            owner,
            leaseOptions(
              deps,
              host,
              Math.round(waitSeconds * 1000),
              callLeaseIdleMs(deps, driver, tool, args),
            ),
          );
          if (!acquired.ok) throw heldError(deps, acquired.holder);

          if (driver.hasDaemon) await ensureDaemon(driver, host);
          const translated = driver.translateArgsPaths(host, tool, args);
          const result = driver.call(host, tool, translated);
          await deps.lease.acquire(owner, leaseOptions(deps, host));
          let stdout = driver.translateResultPaths(host, result.stdout);
          if (!opts.keepScreenshot) stdout = redactInlineScreenshots(stdout);
          printDriverResult(deps, result, stdout);
        },
      ),
    );

  // ------------------------------------------------------------------- lease
  const lease = computer
    .command("lease")
    .description(
      "Inspect, take, or release the desktop lease shared by every agent on this machine.",
    );

  lease
    .command("status")
    .description("Show the current desktop lease holder, or that the desktop is free.")
    .option("--json", "Emit the lease as JSON (null when free).")
    .action(
      guarded(input, (deps, opts: { json?: boolean }) => {
        const host = requireSupported(deps.host());
        const current = deps.lease.read(leaseOptions(deps, host));
        const nowMs = deps.now();
        if (opts.json) {
          deps.emit.data({
            lease: current
              ? { ...current, expires_in_seconds: expiresInSeconds(current, nowMs) }
              : null,
          });
          return;
        }
        emitLine(deps.emit, current ? `held by ${describeLease(current, nowMs)}` : "free");
      }),
    );

  lease
    .command("acquire")
    .description("Take (or refresh) the desktop lease for yourself without calling a tool.")
    .option("--wait <seconds>", "How long to wait for another agent's lease (default 0).")
    .action(
      guarded(input, async (deps, opts: { wait?: string }) => {
        const config = requireEnabled(deps);
        const host = requireSupported(deps.host());
        const waitSeconds = parseSeconds(opts.wait, "--wait") ?? 0;
        const owner = deps.owner();
        requireApproval(deps, config, host, owner);
        const result = await deps.lease.acquire(
          owner,
          leaseOptions(deps, host, Math.round(waitSeconds * 1000)),
        );
        if (!result.ok) throw heldError(deps, result.holder);
        emitLine(
          deps.emit,
          `${result.fresh ? "Acquired" : "Refreshed"} the desktop lease: ${describeLease(result.lease, deps.now())}.`,
        );
      }),
    );

  lease
    .command("release")
    .description("Release the desktop lease if you hold it; this also ends your task approval.")
    .action(
      guarded(input, (deps) => {
        const host = requireSupported(deps.host());
        const owner = deps.owner();
        endOwnTaskApproval(deps, host, owner, "released the desktop");
        const released = deps.lease.release(owner, leaseOptions(deps, host));
        if (released) {
          emitLine(deps.emit, `Released the desktop lease held by ${owner.label}.`);
          return;
        }
        const current = deps.lease.read(leaseOptions(deps, host));
        if (!current) {
          emitLine(deps.emit, "The desktop was not leased.");
          return;
        }
        throw new ComputerError(
          "computer_lease_held",
          `Not released: the desktop is held by ${describeLease(current, deps.now())}, not ${owner.label}.`,
          EXIT_LEASE_HELD,
        );
      }),
    );

  // ------------------------------------------------------------------- grant
  computer
    .command("grant")
    .description(
      "Ask the person at this computer to approve desktop control for one stated purpose " +
        "(ask-each-task) or this agent session (ask-once-per-session). They answer a Yes/No " +
        "prompt; no answer counts as no.",
    )
    .requiredOption("--purpose <text>", "What you will do on the desktop, in plain words.")
    .option(
      "--timeout <seconds>",
      `How long to wait for the person's answer (default ${DEFAULT_CONFIRM_SECONDS}).`,
    )
    .action(
      guarded(input, async (deps, opts: { purpose: string; timeout?: string }) => {
        const config = requireEnabled(deps);
        const host = requireSupported(deps.host());
        const purpose = opts.purpose.trim();
        if (!purpose)
          throw new ComputerError("computer_usage", "--purpose must say what you will do.");
        const kind = grantKindFor(config.mode);
        if (!kind) {
          emitLine(
            deps.emit,
            `No approval needed: desktop control is ${describeMode(config.mode)}.`,
          );
          return;
        }
        const owner = deps.owner();
        const dir = deps.leaseDir(host.desktopStateDir);
        const existing = deps.grants.live(dir, owner.id, owner.project, deps.now());
        if (existing && existing.purpose === purpose) {
          emitLine(
            deps.emit,
            `Already approved for "${purpose}"; ends in ${secondsUntil(existing.expires_at, deps.now())}s.`,
          );
          return;
        }
        const durationMs = grantDurationMs(deps, config, kind);
        const timeoutSeconds = parseSeconds(opts.timeout, "--timeout") ?? DEFAULT_CONFIRM_SECONDS;
        const base = {
          owner_id: owner.id,
          owner_label: owner.label,
          project: owner.project,
          kind,
          purpose,
        };
        deps.grants.log(dir, { event: "requested", ...base }, deps.now());
        const answer = await deps.confirm({
          title: "Allow desktop control?",
          message: grantMessage(owner, purpose, kind, durationMs),
          timeoutMs: Math.round(timeoutSeconds * 1000),
        });
        if (answer.answer !== "approved") {
          const event =
            answer.answer === "denied"
              ? "denied"
              : answer.answer === "timed-out"
                ? "timed-out"
                : "unavailable";
          deps.grants.log(
            dir,
            {
              event,
              ...base,
              ...(answer.via ? { via: answer.via } : {}),
              ...(answer.detail ? { detail: answer.detail } : {}),
            },
            deps.now(),
          );
          const why =
            answer.answer === "denied"
              ? "The person said no."
              : answer.answer === "timed-out"
                ? `No answer within ${timeoutSeconds}s, which counts as no.`
                : `There was no way to ask the person here: ${answer.detail ?? "no prompt available"}. They can approve by running this command in their own terminal.`;
          throw new ComputerError(
            "computer_approval_declined",
            `Desktop control was not approved. ${why} Do not use the desktop; tell the person what you needed it for.`,
            EXIT_APPROVAL_REQUIRED,
          );
        }
        const via: GrantChannel = answer.via ?? "dialog";
        const grant = deps.grants.add(
          dir,
          { ...base, approved_via: via },
          { nowMs: deps.now(), durationMs },
        );
        deps.grants.log(dir, { event: "approved", ...base, via }, deps.now());
        emitLine(
          deps.emit,
          `Approved: ${kind === "task" ? "this task" : "this session"} may use the desktop for "${purpose}" until ${grant.expires_at}. ` +
            `When you finish, run \`${deps.binName} computer done\`.`,
        );
      }),
    );

  // -------------------------------------------------------------------- done
  computer
    .command("done")
    .description("Finish desktop work: end your task approval and release the desktop lease.")
    .action(
      guarded(input, (deps) => {
        const host = requireSupported(deps.host());
        const owner = deps.owner();
        const ended = endOwnTaskApproval(deps, host, owner, "finished");
        const released = deps.lease.release(owner, leaseOptions(deps, host));
        emitLine(
          deps.emit,
          `${released ? "Released the desktop" : "You did not hold the desktop"}${ended ? " and ended your task approval" : ""}.`,
        );
      }),
    );

  // ------------------------------------------------------------------ revoke
  computer
    .command("revoke")
    .description(
      "End desktop-control approvals now: yours by default, or every agent's on this desktop with --all.",
    )
    .option("--all", "End every agent's approval on this desktop.")
    .action(
      guarded(input, (deps, opts: { all?: boolean }) => {
        const host = requireSupported(deps.host());
        const owner = deps.owner();
        const dir = deps.leaseDir(host.desktopStateDir);
        const ended = deps.grants.end(
          dir,
          opts.all ? { nowMs: deps.now() } : { nowMs: deps.now(), ownerId: owner.id },
        );
        for (const g of ended) {
          deps.grants.log(
            dir,
            {
              event: "revoked",
              owner_id: g.owner_id,
              owner_label: g.owner_label,
              ...(g.project ? { project: g.project } : {}),
              kind: g.kind,
              purpose: g.purpose,
            },
            deps.now(),
          );
        }
        emitLine(
          deps.emit,
          ended.length === 0
            ? "No approvals to end."
            : `Ended ${ended.length} approval${ended.length === 1 ? "" : "s"}: ${ended.map((g) => g.owner_label).join(", ")}.`,
        );
      }),
    );

  // -------------------------------------------------------------------- mode
  computer
    .command("mode [mode]")
    .description(
      `Show or set your own desktop-control mode (${COMPUTER_MODES.join(" | ")}) where the project allows desktop control. ` +
        "Loosening it asks the person at this computer first.",
    )
    .option("--all-projects", "Set your mode for every project instead of just this one.")
    .option("--clear", "Remove your own mode, so the project's default applies.")
    .option("--json", "Emit the result as JSON.")
    .action(
      guarded(
        input,
        async (
          deps,
          raw: string | undefined,
          opts: { allProjects?: boolean; clear?: boolean; json?: boolean },
        ) => {
          const current = deps.config();
          if (raw === undefined && !opts.clear) {
            if (opts.json) {
              deps.emit.data({
                mode: current.mode,
                project_mode: current.project_mode,
                mode_source: current.mode_source,
                ...(current.config_error ? { config_error: current.config_error } : {}),
              });
              return;
            }
            emitLine(
              deps.emit,
              `${current.mode}: ${describeMode(current.mode)} (${describeSource(current)}; project default ${current.project_mode}).`,
            );
            return;
          }
          if (raw !== undefined && opts.clear) {
            throw new ComputerError("computer_usage", "Pass a mode or --clear, not both.");
          }
          if (raw !== undefined && !isComputerMode(raw)) {
            throw new ComputerError(
              "computer_usage",
              `Mode must be one of ${COMPUTER_MODES.join(", ")}.`,
            );
          }
          if (!current.project_enabled) {
            throw new ComputerError(
              "computer_disabled",
              `This project has desktop control off, and a personal mode cannot turn it on. ${enableHint()}`,
            );
          }
          const root = opts.allProjects ? null : deps.projectRoot();
          if (!opts.allProjects && !root) {
            throw new ComputerError("computer_usage", "Not inside a project; pass --all-projects.");
          }
          const mode = raw === undefined ? null : (raw as ComputerMode);
          const prefs = deps.prefs.read();
          const next: ComputerPreferences = { ...prefs, projects: { ...(prefs.projects ?? {}) } };
          if (root === null) {
            if (mode === null) delete next.mode;
            else next.mode = mode;
          } else if (next.projects) {
            if (mode === null) delete next.projects[root];
            else next.projects[root] = mode;
          }
          const after = deps.config(next);
          const scope = root === null ? "all your projects" : "this project";
          if (computerModeLooser(after.mode, current.mode)) {
            const answer = await deps.confirm({
              title: "Loosen desktop control?",
              message: [
                `Change desktop control for ${scope} from "${describeMode(current.mode)}" to "${describeMode(after.mode)}".`,
                "",
                "AI agents would then need less of your approval before using this computer's screen, mouse and keyboard.",
              ].join("\n"),
              timeoutMs: DEFAULT_CONFIRM_SECONDS * 1000,
            });
            if (answer.answer !== "approved") {
              throw new ComputerError(
                "computer_approval_declined",
                `Mode not changed: loosening it needs the person's approval, and ${answer.answer === "unavailable" ? `there was no way to ask (${answer.detail ?? "no prompt"})` : "it was not given"}.`,
                EXIT_APPROVAL_REQUIRED,
              );
            }
          }
          deps.prefs.write(root, mode);
          const host = deps.host();
          if (host.kind !== "unsupported" && host.desktopStateDir) {
            deps.grants.log(
              deps.leaseDir(host.desktopStateDir),
              {
                event: "mode-changed",
                ...(root ? { project: root } : {}),
                detail: `${current.mode} -> ${after.mode} (${scope})`,
              },
              deps.now(),
            );
          }
          if (opts.json) {
            deps.emit.data({
              mode: after.mode,
              mode_source: after.mode_source,
              scope: root === null ? "all-projects" : "project",
            });
            return;
          }
          emitLine(
            deps.emit,
            `Desktop control for ${scope} is now ${after.mode}: ${describeMode(after.mode)}.`,
          );
        },
      ),
    );

  // ----------------------------------------------------------------- sign-in
  computer
    .command("sign-in [state]")
    .description(
      "Show or set whether agents may sign in to websites for you (on | off), in your own browser " +
        "through your password manager's extension, where the project allows it. Off by default; " +
        "turning it on asks the person at this computer first.",
    )
    .option("--all-projects", "Set it for every project instead of just this one.")
    .option(
      "--clear",
      "Remove your own choice, so the default (off) or your all-projects choice applies.",
    )
    .option("--json", "Emit the result as JSON.")
    .action(
      guarded(
        input,
        async (
          deps,
          raw: string | undefined,
          opts: { allProjects?: boolean; clear?: boolean; json?: boolean },
        ) => {
          const current = deps.config();
          const report = (config: ComputerProjectConfig, scope?: "project" | "all-projects") =>
            opts.json
              ? deps.emit.data({
                  sign_in: config.sign_in,
                  project_sign_in: config.project_sign_in,
                  sign_in_source: config.sign_in_source,
                  person_sign_in: config.person_sign_in,
                  ...(scope ? { scope } : {}),
                })
              : emitLine(deps.emit, `Agent sign-in: ${describeSignIn(config, deps.binName)}.`);
          if (raw === undefined && !opts.clear) {
            report(current);
            return;
          }
          if (raw !== undefined && opts.clear) {
            throw new ComputerError(
              "computer_usage",
              "Pass on, off or --clear, not more than one.",
            );
          }
          if (raw !== undefined && raw !== "on" && raw !== "off") {
            throw new ComputerError("computer_usage", "Agent sign-in must be on or off.");
          }
          if (!current.project_sign_in) {
            throw new ComputerError(
              "sign_in_not_allowed",
              current.project_enabled
                ? "This project does not let agents sign in for people (`computer.sign_in` in .harnery/config.jsonc), and a personal choice cannot turn it on."
                : `This project has desktop control off, so agents cannot sign in for anyone. ${enableHint()}`,
            );
          }
          const root = opts.allProjects ? null : deps.projectRoot();
          if (!opts.allProjects && !root) {
            throw new ComputerError("computer_usage", "Not inside a project; pass --all-projects.");
          }
          const on = raw === undefined ? null : raw === "on";
          const prefs = deps.prefs.read();
          const next: ComputerPreferences = {
            ...prefs,
            sign_in_projects: { ...(prefs.sign_in_projects ?? {}) },
          };
          if (root === null) {
            if (on === null) delete next.sign_in;
            else next.sign_in = on;
          } else if (next.sign_in_projects) {
            if (on === null) delete next.sign_in_projects[root];
            else next.sign_in_projects[root] = on;
          }
          const after = deps.config(next);
          const scope = root === null ? "all your projects" : "this project";
          // Ask whenever the change lets agents sign in somewhere they could not:
          // setting `on` where it was not, or clearing a project's `off` under an
          // all-projects `on`.
          const here = deps.projectRoot();
          const previous = root === null ? prefs.sign_in : prefs.sign_in_projects?.[root];
          const loosens =
            (on === true && previous !== true) ||
            (here !== null && personSignIn(next, here) && !personSignIn(prefs, here));
          if (loosens) {
            const answer = await deps.confirm({
              title: "Let agents sign in for you?",
              message: [
                `Let AI agents sign in to websites for you in ${scope}.`,
                "",
                "They would use your own browser and choose your saved login in your password manager's extension. They never type a password themselves, and a locked password manager, a passkey or a code sent to you still comes to you.",
              ].join("\n"),
              timeoutMs: DEFAULT_CONFIRM_SECONDS * 1000,
            });
            if (answer.answer !== "approved") {
              throw new ComputerError(
                "computer_approval_declined",
                `Not changed: turning agent sign-in on needs the person's approval, and ${answer.answer === "unavailable" ? `there was no way to ask (${answer.detail ?? "no prompt"})` : "it was not given"}.`,
                EXIT_APPROVAL_REQUIRED,
              );
            }
          }
          deps.prefs.writeSignIn(root, on);
          const host = deps.host();
          if (host.kind !== "unsupported" && host.desktopStateDir) {
            deps.grants.log(
              deps.leaseDir(host.desktopStateDir),
              {
                event: "sign-in-changed",
                ...(root ? { project: root } : {}),
                detail: `${on === null ? "cleared" : on ? "on" : "off"} (${scope})`,
              },
              deps.now(),
            );
          }
          report(after, root === null ? "all-projects" : "project");
        },
      ),
    );

  return computer;
}

/** End the owner's task approval in this project, logging it. True when one ended. */
function endOwnTaskApproval(
  deps: ComputerDeps,
  host: SupportedHost,
  owner: LeaseOwner,
  why: string,
): boolean {
  const dir = deps.leaseDir(host.desktopStateDir);
  const ended = deps.grants.end(dir, {
    nowMs: deps.now(),
    ownerId: owner.id,
    ...(owner.project ? { project: owner.project } : {}),
    kind: "task",
  });
  for (const g of ended) {
    deps.grants.log(
      dir,
      {
        event: "ended",
        owner_id: g.owner_id,
        owner_label: g.owner_label,
        ...(g.project ? { project: g.project } : {}),
        kind: g.kind,
        purpose: g.purpose,
        detail: why,
      },
      deps.now(),
    );
  }
  return ended.length > 0;
}

export function registerComputerCommand(
  program: Command,
  emit: EmitContext,
  binName: string,
): void {
  createComputerCommand({ emit, binName }, program);
}
