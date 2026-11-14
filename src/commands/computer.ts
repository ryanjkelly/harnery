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
// person's approval first, or they declined · 5 a foreground action was held
// back because the person is using the keyboard or mouse (ADR 0248).

import { hostname, userInfo } from "node:os";
import { basename } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveCoordRoot, resolveOwnerAcrossRoots } from "../core/agents/coord-client.ts";
import { agentDisplayName, resolveShortName } from "../core/agents/state/activity-log.ts";
import {
  type AgentWindowPatch,
  COMPUTER_MODES,
  type ComputerMode,
  type ComputerPreferences,
  type ComputerProjectConfig,
  computerModeLooser,
  isComputerMode,
  readComputerConfig,
  readComputerPreferences,
  writeAgentWindowPreference,
  writeBrowserAttachPreference,
  writeComputerPreference,
  writeSignInPreference,
} from "../core/config.ts";
import {
  type BrowserGuard,
  createBrowserGuard,
  type GuardOwner,
} from "../lib/computer/browser-guard.ts";
import type { Confirm } from "../lib/computer/confirm.ts";
import {
  CORNERS,
  type Corner,
  cornerPosition,
  type DisplaySnapshot,
  describeDisplay,
  pickDisplay,
  probeDisplays,
  readDisplayCache,
  SMALLEST_REQUEST,
  type WindowPlacement,
  writeDisplayCache,
} from "../lib/computer/displays.ts";
import { DRIVER_IDS } from "../lib/computer/drivers.ts";
import type {
  DesktopGrant,
  GrantChannel,
  GrantKind,
  GrantLogEntry,
} from "../lib/computer/grants.ts";
import {
  DEFAULT_FOREGROUND_QUIET_SECONDS,
  DEFAULT_FOREGROUND_WAIT_SECONDS,
  probePersonIdleMs,
  waitForQuietDesktop,
} from "../lib/computer/person-idle.ts";
import type {
  BackgroundProcess,
  BrowserCall,
  DaemonStatus,
  DesktopDriver,
  DesktopLease,
  DisplayInfo,
  DriverCallResult,
  HostInfo,
  LeaseApi,
  LeaseOptions,
  LeaseOwner,
  Rect,
  WindowRef,
} from "../lib/computer/types.ts";

/** Exit code for a desktop held by another agent. */
export const EXIT_LEASE_HELD = 3;
/** Exit code when desktop control needs the person's approval first, or they declined. */
export const EXIT_APPROVAL_REQUIRED = 4;
/** Exit code when a foreground action was held back because the person is using the desktop. */
export const EXIT_PERSON_ACTIVE = 5;
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

/** Display detection and placement math (ADR 0251); tests inject fakes. */
export interface DisplaysApi {
  /** Read the displays now. */
  probe(host: HostInfo): DisplaySnapshot;
  readCache(dir: string): DisplaySnapshot | null;
  writeCache(dir: string, snapshot: DisplaySnapshot): void;
  pick(displays: DisplayInfo[], selector: string): DisplayInfo | undefined;
  corner(
    display: DisplayInfo,
    corner: Corner,
    size: { width: number; height: number },
    margin: number,
  ): { x: number; y: number };
  describe(display: DisplayInfo): string;
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
    writeBrowserAttach: (root: string | null, on: boolean | null) => ComputerPreferences;
    /** Patch the person's agent-window choice; null clears it. */
    writeAgentWindow: (patch: AgentWindowPatch | null) => ComputerPreferences;
  };
  /** The project root personal choices are keyed by. */
  projectRoot: () => string | null;
  /** Lease directory for a desktop state dir. */
  leaseDir: (desktopStateDir: string) => string;
  /** Idle expiry when config sets none. */
  defaultIdleMs: number;
  /** Driver stderr passthrough. */
  writeStderr: (text: string) => void;
  /**
   * Milliseconds since the person last used the keyboard or mouse, or null
   * when this host gives no reading. Read before a foreground action.
   */
  personIdleMs: (host: HostInfo) => number | null | Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Browser guard for one lease directory (ADR 0250); tests inject a fake. */
  browserGuard: (dir: string) => BrowserGuard;
  /** Display detection and placement (ADR 0251). */
  displays: DisplaysApi;
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
  const drivers =
    input.drivers ?? (input.driver ? [input.driver] : (defaults?.drivers as DesktopDriver[]));
  return {
    emit: input.emit,
    binName: input.binName,
    host: input.host ?? (defaults?.host as ComputerDeps["host"]),
    drivers,
    lease: input.lease ?? (defaults?.lease as LeaseApi),
    leaseDir: input.leaseDir ?? (defaults?.leaseDir as ComputerDeps["leaseDir"]),
    defaultIdleMs: input.defaultIdleMs ?? (defaults?.defaultIdleMs as number),
    grants: input.grants ?? (defaults?.grants as GrantsApi),
    confirm: input.confirm ?? (defaults?.confirm as Confirm),
    prefs: {
      read: () => readComputerPreferences(),
      write: (root, mode) => writeComputerPreference(root, mode),
      writeSignIn: (root, on) => writeSignInPreference(root, on),
      writeBrowserAttach: (root, on) => writeBrowserAttachPreference(root, on),
      writeAgentWindow: (patch) => writeAgentWindowPreference(patch),
      ...input.prefs,
    },
    projectRoot: input.projectRoot ?? (() => resolveCoordRoot()),
    owner: input.owner ?? (() => resolveLeaseOwner()),
    config: input.config ?? ((prefs) => readComputerConfig(undefined, prefs)),
    writeStderr: input.writeStderr ?? ((text) => process.stderr.write(text)),
    personIdleMs: input.personIdleMs ?? ((host) => probePersonIdleMs(host)),
    sleep: input.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    now: input.now ?? Date.now,
    browserGuard:
      input.browserGuard ??
      ((dir) => createBrowserGuard({ dir, now: () => (input.now ?? Date.now)() })),
    displays: input.displays ?? defaultDisplays(drivers, input.now ?? Date.now),
  };
}

/** The real display module; the probe falls back to the first installed driver that lists displays. */
function defaultDisplays(drivers: DesktopDriver[], now: () => number): DisplaysApi {
  return {
    probe: (host) =>
      probeDisplays(host, {
        now,
        driverDisplays: () => {
          const lister = drivers.find((d) => d.listDisplays && d.installedExecutable(host));
          return lister?.listDisplays?.(host);
        },
      }),
    readCache: readDisplayCache,
    writeCache: writeDisplayCache,
    pick: pickDisplay,
    corner: cornerPosition,
    describe: describeDisplay,
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
  return describeSourceOf(config.sign_in_source);
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

function describeSourceOf(source: ComputerProjectConfig["browser_attach_source"]): string {
  if (source === "user-project") return "your setting for this project";
  if (source === "user-default") return "your setting for all projects";
  return "the default";
}

/** The person's own browser-attach choice for one project, before the project's and the desktop's gates. */
function personBrowserAttach(prefs: ComputerPreferences, root: string): boolean {
  return prefs.browser_attach_projects?.[root] ?? prefs.browser_attach ?? false;
}

/** The `browser:` status line: whether agents may attach to this person's running browser (ADR 0249). */
function describeBrowserAttach(config: ComputerProjectConfig, bin: string): string {
  const source = describeSourceOf(config.browser_attach_source);
  if (!config.project_browser_attach)
    return "off (this project does not allow agents to attach to your browser)";
  if (config.browser_attach)
    return `on: agents may attach to your running browser and work in its tabs (${source})`;
  if (!config.enabled) {
    return config.person_browser_attach
      ? `off while your desktop control is off (you turned it on, ${source}; \`${bin} computer browser-attach off\` removes it)`
      : "off (desktop control is off)";
  }
  return `off (${source}; \`${bin} computer browser-attach on\` lets agents attach to your running browser)`;
}

/** Whether this driver's daemon should start able to attach to the person's browser. */
function wantsBrowserAttach(config: ComputerProjectConfig, driver: DesktopDriver): boolean {
  return config.browser_attach && driver.supportsBrowserAttach === true;
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

/** The quiet period a foreground action waits for, and how long it waits (ADR 0248). */
function foregroundQuiet(config: ComputerProjectConfig): { quietMs: number; maxWaitMs: number } {
  return {
    quietMs: Math.round(
      (config.foreground_quiet_seconds ?? DEFAULT_FOREGROUND_QUIET_SECONDS) * 1000,
    ),
    maxWaitMs: Math.round(
      (config.foreground_wait_seconds ?? DEFAULT_FOREGROUND_WAIT_SECONDS) * 1000,
    ),
  };
}

function describeForegroundQuiet(config: ComputerProjectConfig): string {
  const { quietMs, maxWaitMs } = foregroundQuiet(config);
  if (quietMs <= 0) return "sent at once (the quiet wait is off)";
  return (
    `waits until the keyboard and mouse have been quiet for ${formatSeconds(quietMs)}, ` +
    `for up to ${formatSeconds(maxWaitMs)}`
  );
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
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

/**
 * Start the driver's daemon if it is not running. `browserAttach` starts it
 * able to attach to the person's running browser (ADR 0249); `requireGrant`
 * also restarts a running daemon that lacks that grant.
 */
/** A driver result that reports a refusal; drivers answer a refusal with exit 0. */
function driverRefused(result: DriverCallResult): boolean {
  try {
    const value = JSON.parse(result.stdout) as { status?: unknown; refusal?: unknown };
    return value?.status === "refused" || (value?.refusal !== undefined && value.refusal !== null);
  } catch {
    return false;
  }
}

async function ensureDaemon(
  driver: DesktopDriver,
  host: HostInfo,
  options: { browserAttach?: boolean; requireGrant?: boolean } = {},
): Promise<DaemonStatus & { restartedFrom?: string }> {
  let current = driver.daemonStatus(host);
  // A daemon left running by an older (or newer) Harnery build speaks a
  // different protocol than the pinned driver, so restart it (ADR 0250).
  let restartedFrom: string | undefined;
  if (current.running && current.version !== undefined && current.version !== driver.version) {
    const old = current.version;
    current = driver.stopDaemon(host);
    if (current.running) {
      throw new ComputerError(
        "computer_daemon_failed",
        `The ${driver.id} daemon is running version ${old}, not the pinned ${driver.version}, and did not stop for a restart${current.detail ? `: ${current.detail}` : "."}`,
      );
    }
    restartedFrom = old;
  }
  if (current.running && options.requireGrant && current.browserAttach !== true) {
    current = driver.stopDaemon(host);
    if (current.running) {
      throw new ComputerError(
        "computer_daemon_failed",
        `The ${driver.id} daemon is running without browser attach and did not stop for a restart${current.detail ? `: ${current.detail}` : "."}`,
      );
    }
  }
  if (current.running) return current;
  const started = await driver.startDaemon(host, { browserAttach: options.browserAttach === true });
  if (!started.running) {
    throw new ComputerError(
      "computer_daemon_failed",
      `The ${driver.id} daemon did not start${started.detail ? `: ${started.detail}` : "."}`,
    );
  }
  return restartedFrom !== undefined ? { ...started, restartedFrom } : started;
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
    ? `running${daemon.pid !== undefined ? ` (pid ${daemon.pid})` : ""}${daemon.browserAttach ? ", able to attach to your browser" : ""}${daemon.version !== undefined && daemon.version !== driver.version ? `, version ${daemon.version} (not the pinned ${driver.version}; the next call restarts it)` : ""}`
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
        `Exit codes: 0 ok · 1 error · ${EXIT_LEASE_HELD} desktop held by another agent · ${EXIT_APPROVAL_REQUIRED} approval needed or declined · ` +
        `${EXIT_PERSON_ACTIVE} foreground action held back while the person is using the desktop.\n` +
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
        let browserWindows: ReturnType<BrowserGuard["list"]> = [];
        if (supported) {
          try {
            browserWindows = browserGuardFor(deps, host as SupportedHost).list();
          } catch {
            browserWindows = [];
          }
        }
        const displayCache = supported ? cachedDisplays(deps, host as SupportedHost) : null;
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
            browser_attach: config.browser_attach,
            project_browser_attach: config.project_browser_attach,
            browser_attach_source: config.browser_attach_source,
            person_browser_attach: config.person_browser_attach,
            foreground_quiet_seconds: foregroundQuiet(config).quietMs / 1000,
            foreground_wait_seconds: foregroundQuiet(config).maxWaitMs / 1000,
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
            browser_windows: browserWindows,
            displays: displayCache,
            agent_window: config.agent_window,
            agent_window_source: config.agent_window_source,
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
          `browser:   ${describeBrowserAttach(config, deps.binName)}`,
          `quiet:     a foreground action ${describeForegroundQuiet(config)}`,
          `window:    ${describePlacement(config)}`,
          ...(supported
            ? [`displays:  ${describeDisplayCache(displayCache, nowMs, deps.binName)}`]
            : []),
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
        if (browserWindows.length > 0)
          lines.push(
            `windows:   ${browserWindows.length} agent browser window${browserWindows.length === 1 ? "" : "s"} open: ${browserWindows
              .map((w) => `${w.owner_label} (window ${w.window_id})`)
              .join(", ")}`,
          );
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
          const status = await ensureDaemon(driver, host, {
            browserAttach: wantsBrowserAttach(deps.config(), driver),
          });
          lines.push(
            status.restartedFrom !== undefined
              ? `${driver.id}: restarted the daemon on the pinned ${driver.version} (was ${status.restartedFrom})${status.pid !== undefined ? `, pid ${status.pid}` : ""}${status.browserAttach ? ", able to attach to your browser" : ""}.`
              : `${driver.id}: daemon running${status.pid !== undefined ? ` (pid ${status.pid})` : ""}${status.browserAttach ? ", able to attach to your browser" : ""}.`,
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
        "`session` defaults to your agent name; inline base64 screenshots are redacted unless --keep-screenshot. " +
        "A foreground action waits until the person's keyboard and mouse are quiet.",
    )
    .option(DRIVER_OPTION, driverHelp("to call (default: the project's default driver)"))
    .option(
      "--wait <seconds>",
      "How long to wait for another agent's lease (default: config wait_seconds or 30).",
    )
    .option("--keep-screenshot", "Print inline base64 screenshots instead of redacting them.")
    .option(
      "--person-window",
      "The person asked you to work in a browser window they opened; lets a browser call act in a window you did not open.",
    )
    .action(
      guarded(
        input,
        async (
          deps,
          tool: string,
          rawJson: string | undefined,
          opts: {
            driver?: string;
            wait?: string;
            keepScreenshot?: boolean;
            personWindow?: boolean;
          },
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
          // Attaching to the person's running browser reaches every site they
          // are signed in to, so it needs their own opt-in (ADR 0249).
          const attach = driver.attachesPersonBrowser?.(tool, args) ?? false;
          if (attach && !config.browser_attach) {
            throw new ComputerError(
              "browser_attach_off",
              `Browser attach is ${describeBrowserAttach(config, deps.binName)}, so this attach to the person's running browser was not sent.`,
              EXIT_APPROVAL_REQUIRED,
              "Nothing was sent. Work in the browser window through the accessibility route instead (get_window_state or agent-desktop refs), or ask the person whether to turn browser attach on.",
            );
          }
          if (!("session" in args)) args.session = owner.label;

          // The browser guard (ADR 0250) keeps an agent inside browser windows
          // it opened for itself and away from password fields. It decides
          // before the lease is taken, so a refused call sends nothing.
          const personWindow = opts.personWindow === true;
          const calls = driver.browserCalls?.(tool, args) ?? [];
          const guard = browserGuardFor(deps, host);
          for (const call of calls) {
            const decision = guard.check(guardOwner(owner), call, { personWindow });
            if (!decision.ok)
              throw new ComputerError(
                decision.code,
                decision.message,
                EXIT_APPROVAL_REQUIRED,
                decision.hint,
              );
          }
          if (personWindow) {
            for (const call of calls) {
              if (call.kind !== "attach" && call.kind !== "bind") continue;
              deps.grants.log(
                deps.leaseDir(host.desktopStateDir),
                {
                  event: "browser-attach-changed",
                  owner_id: owner.id,
                  owner_label: owner.label,
                  ...(owner.project ? { project: owner.project } : {}),
                  detail: `person window used: pid ${call.pid ?? "?"} window ${call.window_id ?? "?"} (${call.tool})`,
                },
                deps.now(),
              );
            }
          }

          // Hold the lease for at least the driver's call timeout, so a slow
          // call never runs on after its lease lapsed and another agent took
          // the desktop; refresh to the normal idle period once it returns.
          // A foreground action fronts a window and sends real input, so the
          // person's own typing would land in it. Hold it until their input
          // has been quiet; the lease covers that wait as well.
          const quiet = foregroundQuiet(config);
          const foreground = quiet.quietMs > 0 && (driver.takesForeground?.(tool, args) ?? false);
          const acquired = await deps.lease.acquire(
            owner,
            leaseOptions(
              deps,
              host,
              Math.round(waitSeconds * 1000),
              callLeaseIdleMs(deps, driver, tool, args) + (foreground ? quiet.maxWaitMs : 0),
            ),
          );
          if (!acquired.ok) throw heldError(deps, acquired.holder);
          // A new stretch of computer use: read the displays now, since the
          // person may have plugged one in or moved one since (ADR 0251).
          if (acquired.fresh) refreshDisplays(deps, host);

          if (driver.hasDaemon)
            await ensureDaemon(driver, host, {
              browserAttach: wantsBrowserAttach(config, driver),
              requireGrant: attach,
            });
          if (foreground) await awaitQuietDesktop(deps, host, owner, quiet);
          const translated = driver.translateArgsPaths(host, tool, args);
          const result = driver.call(host, tool, translated);
          // A program the call launched opens where the person is working;
          // move its windows to the agent-window corner (ADR 0251).
          if (result.exitCode === 0 && config.agent_window.move_apps && driver.launchedProcess) {
            let launched: { pid: number } | undefined;
            try {
              launched = driver.launchedProcess(tool, result.stdout);
            } catch {
              launched = undefined;
            }
            if (launched) await placeLaunchedWindows(deps, host, launched.pid);
          }
          await deps.lease.acquire(owner, leaseOptions(deps, host));
          observeBrowserCalls(deps, guard, owner, driver, tool, calls, result, personWindow);
          let stdout = driver.translateResultPaths(host, result.stdout);
          if (!opts.keepScreenshot) stdout = redactInlineScreenshots(stdout);
          printDriverResult(deps, result, stdout);
        },
      ),
    );

  // ----------------------------------------------------------------- browser
  const browser = computer
    .command("browser")
    .description(
      "Work in a browser window of your own inside the person's running browser (ADR 0250): open one, then close it when done.",
    );

  browser
    .command("open [url]")
    .description(
      "Open a new window in the person's running browser, attach to it and bind it, holding the desktop lease. " +
        "Prints the window, target and tab ids to act on with the driver's browser tools.",
    )
    .option(
      "--browser-pid <pid>",
      "The browser process to open the window in (default: the front-most supported browser).",
    )
    .option(DRIVER_OPTION, driverHelp("to use (default: the project's default driver)"))
    .option("--json", "Emit the ids as JSON.")
    .action(
      guarded(
        input,
        async (
          deps,
          url: string | undefined,
          opts: { browserPid?: string; driver?: string; json?: boolean },
        ) => {
          const config = requireEnabled(deps);
          const host = requireSupported(deps.host());
          const driver = selectDriver(deps, opts.driver);
          if (!driver.openBrowserWindow) {
            throw new ComputerError(
              "browser_open_unsupported",
              `The ${driver.id} driver cannot open a browser window.`,
            );
          }
          let pid: number | undefined;
          if (opts.browserPid !== undefined) {
            pid = Number(opts.browserPid);
            if (!Number.isInteger(pid) || pid <= 0)
              throw new ComputerError("computer_usage", "--browser-pid must be a process id.");
          }
          requireInstalled(deps, driver, host);
          const owner = deps.owner();
          requireApproval(deps, config, host, owner);
          if (!config.browser_attach) {
            throw new ComputerError(
              "browser_attach_off",
              `Browser attach is ${describeBrowserAttach(config, deps.binName)}, so no window was opened in the person's running browser.`,
              EXIT_APPROVAL_REQUIRED,
              "Nothing was sent. Work in the browser window through the accessibility route instead (get_window_state or agent-desktop refs), or ask the person whether to turn browser attach on.",
            );
          }
          const session = owner.label;
          const quiet = foregroundQuiet(config);
          const waitSeconds = config.wait_seconds ?? DEFAULT_CALL_WAIT_SECONDS;
          const acquired = await deps.lease.acquire(
            owner,
            leaseOptions(
              deps,
              host,
              Math.round(waitSeconds * 1000),
              callLeaseIdleMs(deps, driver, "browser_prepare", { session }) +
                (quiet.quietMs > 0 ? quiet.maxWaitMs : 0),
            ),
          );
          if (!acquired.ok) throw heldError(deps, acquired.holder);
          if (driver.hasDaemon)
            await ensureDaemon(driver, host, { browserAttach: true, requireGrant: true });
          // Opening a window and attaching both take the screen.
          if (quiet.quietMs > 0) await awaitQuietDesktop(deps, host, owner, quiet);

          let win: WindowRef;
          try {
            win = await driver.openBrowserWindow(host, {
              ...(url !== undefined ? { url } : {}),
              ...(pid !== undefined ? { pid } : {}),
            });
          } catch (err) {
            await deps.lease.acquire(owner, leaseOptions(deps, host));
            throw new ComputerError(
              "browser_open_failed",
              `Could not open a browser window: ${(err as Error).message ?? String(err)}`,
            );
          }
          const guard = browserGuardFor(deps, host);
          guard.recordWindow(guardOwner(owner), { ...win, session });
          // Out of the person's way first (ADR 0251): move the window onto the
          // target display at the size it opened with. It is shrunk only after
          // the attach, because the browser's own attach setup opens a page in
          // this window and did not finish in a window at its minimum size.
          placeWindow(deps, host, win, { resize: false, fresh: true });

          const send = (tool: string, args: Record<string, unknown>): DriverCallResult => {
            const calls = driver.browserCalls?.(tool, args) ?? [];
            const result = driver.call(host, tool, driver.translateArgsPaths(host, tool, args));
            observeBrowserCalls(deps, guard, owner, driver, tool, calls, result, false);
            return result;
          };
          const ids = { pid: win.pid, window_id: win.window_id, session };
          // The window is of no use without the attach, so a failure closes it again.
          const failed = (result: DriverCallResult) => {
            printDriverResult(deps, result, driver.translateResultPaths(host, result.stdout));
            const cleanup = closeBrowserWork(deps, host, owner);
            const leftOpen = cleanup?.left_open.some((w) => w.window_id === win.window_id) ?? true;
            deps.writeStderr(
              leftOpen
                ? `The browser did not attach. Window ${win.window_id} (pid ${win.pid}) is still open; tell the person.\n`
                : `The browser did not attach, so the window opened for it was closed again.\n`,
            );
            deps.emit.setExitCode(1);
          };
          const prepared = send("browser_prepare", {
            ...ids,
            strategy: { kind: "existing_profile" },
          });
          if (prepared.exitCode !== 0 || driverRefused(prepared)) {
            failed(prepared);
            await deps.lease.acquire(owner, leaseOptions(deps, host));
            return;
          }
          // Small, and bound last: the driver mints the ids for the frame the
          // window ends up with.
          const placed = placeWindow(deps, host, win, { resize: true });
          if ("skipped" in placed)
            deps.writeStderr(`Left the browser window where it opened: ${placed.skipped}.\n`);
          const bound = send("get_browser_state", { ...ids });
          const bind = bound.exitCode === 0 ? parseBind(bound, url) : null;
          await deps.lease.acquire(owner, leaseOptions(deps, host));
          if (!bind) {
            failed(bound);
            return;
          }
          const out = {
            ...ids,
            target_id: bind.target_id,
            tab_id: bind.tab_id ?? null,
            url: bind.url ?? null,
            ...("skipped" in placed
              ? { placement_skipped: placed.skipped }
              : { display: placed.display, frame: placed.frame }),
          };
          if (opts.json) {
            deps.emit.data(out);
            return;
          }
          emitLine(
            deps.emit,
            [
              `Opened browser window ${win.window_id} (pid ${win.pid}) for session ${session}.`,
              `Bound target ${bind.target_id}${bind.tab_id ? `, tab ${bind.tab_id}` : ""}${bind.url ? ` at ${bind.url}` : ""}.`,
              ...("skipped" in placed
                ? []
                : [
                    `Placed it on display ${placed.display} at ${placed.frame.x},${placed.frame.y}, ${placed.frame.width} by ${placed.frame.height}.`,
                  ]),
              `Act in it with the driver's browser tools using these ids, and finish with \`${deps.binName} computer browser close\`.`,
            ].join("\n"),
          );
        },
      ),
    );

  browser
    .command("close")
    .description("End your browser sessions and close the browser windows you opened for yourself.")
    .option("--json", "Emit what was ended and closed as JSON.")
    .action(
      guarded(input, (deps, opts: { json?: boolean }) => {
        const host = requireSupported(deps.host());
        const owner = deps.owner();
        const cleanup = closeBrowserWork(deps, host, owner) ?? {
          sessions: [],
          closed: [],
          left_open: [],
        };
        if (opts.json) {
          deps.emit.data(cleanup);
          return;
        }
        const lines = describeCleanup(cleanup);
        emitLine(
          deps.emit,
          lines.length > 0 ? lines.join("\n") : "No browser work of yours to close.",
        );
      }),
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
        const browser = describeCleanup(closeBrowserWork(deps, host, owner));
        const released = deps.lease.release(owner, leaseOptions(deps, host));
        if (released) {
          emitLine(
            deps.emit,
            [`Released the desktop lease held by ${owner.label}.`, ...browser].join("\n"),
          );
          return;
        }
        const current = deps.lease.read(leaseOptions(deps, host));
        if (!current) {
          emitLine(deps.emit, ["The desktop was not leased.", ...browser].join("\n"));
          return;
        }
        if (browser.length > 0) emitLine(deps.emit, browser.join("\n"));
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
        const browser = describeCleanup(closeBrowserWork(deps, host, owner));
        const released = deps.lease.release(owner, leaseOptions(deps, host));
        emitLine(
          deps.emit,
          [
            `${released ? "Released the desktop" : "You did not hold the desktop"}${ended ? " and ended your task approval" : ""}.`,
            ...browser,
          ].join("\n"),
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

  // ---------------------------------------------------------- browser-attach
  computer
    .command("browser-attach [state]")
    .description(
      "Show or set whether agents may attach to your running browser and work in its tabs " +
        "(on | off), where the project allows it (ADR 0249). Off by default; turning it on asks " +
        "the person at this computer first and restarts the driver daemon with the grant.",
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
          const report = (
            config: ComputerProjectConfig,
            scope?: "project" | "all-projects",
            daemon?: string[],
          ) =>
            opts.json
              ? deps.emit.data({
                  browser_attach: config.browser_attach,
                  project_browser_attach: config.project_browser_attach,
                  browser_attach_source: config.browser_attach_source,
                  person_browser_attach: config.person_browser_attach,
                  ...(scope ? { scope } : {}),
                  ...(daemon ? { daemon } : {}),
                })
              : emitLine(
                  deps.emit,
                  [
                    `Browser attach: ${describeBrowserAttach(config, deps.binName)}.`,
                    ...(daemon ?? []),
                  ].join("\n"),
                );
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
            throw new ComputerError("computer_usage", "Browser attach must be on or off.");
          }
          if (!current.project_browser_attach) {
            throw new ComputerError(
              "browser_attach_not_allowed",
              current.project_enabled
                ? "This project does not let agents attach to people's browsers (`computer.browser_attach` in .harnery/config.jsonc), and a personal choice cannot turn it on."
                : `This project has desktop control off, so agents cannot attach to anyone's browser. ${enableHint()}`,
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
            browser_attach_projects: { ...(prefs.browser_attach_projects ?? {}) },
          };
          if (root === null) {
            if (on === null) delete next.browser_attach;
            else next.browser_attach = on;
          } else if (next.browser_attach_projects) {
            if (on === null) delete next.browser_attach_projects[root];
            else next.browser_attach_projects[root] = on;
          }
          const after = deps.config(next);
          const scope = root === null ? "all your projects" : "this project";
          const here = deps.projectRoot();
          const previous =
            root === null ? prefs.browser_attach : prefs.browser_attach_projects?.[root];
          const loosens =
            (on === true && previous !== true) ||
            (here !== null && personBrowserAttach(next, here) && !personBrowserAttach(prefs, here));
          if (loosens) {
            const answer = await deps.confirm({
              title: "Let agents work in your browser?",
              message: [
                `Let AI agents attach to your running browser in ${scope} and work in its tabs: read pages, type and click, without moving your mouse.`,
                "",
                "They act inside the sites you are already signed in to. Attaching the first time briefly brings the browser forward. Agents still never sign in or type passwords through this route.",
              ].join("\n"),
              timeoutMs: DEFAULT_CONFIRM_SECONDS * 1000,
            });
            if (answer.answer !== "approved") {
              throw new ComputerError(
                "computer_approval_declined",
                `Not changed: turning browser attach on needs the person's approval, and ${answer.answer === "unavailable" ? `there was no way to ask (${answer.detail ?? "no prompt"})` : "it was not given"}.`,
                EXIT_APPROVAL_REQUIRED,
              );
            }
          }
          deps.prefs.writeBrowserAttach(root, on);
          const host = deps.host();
          let daemon: string[] | undefined;
          if (host.kind !== "unsupported" && host.desktopStateDir) {
            deps.grants.log(
              deps.leaseDir(host.desktopStateDir),
              {
                event: "browser-attach-changed",
                ...(root ? { project: root } : {}),
                detail: `${on === null ? "cleared" : on ? "on" : "off"} (${scope})`,
              },
              deps.now(),
            );
            daemon = await alignBrowserAttachDaemons(deps, host as SupportedHost, after);
          }
          report(after, root === null ? "all-projects" : "project", daemon);
        },
      ),
    );

  // ---------------------------------------------------------------- displays
  computer
    .command("displays")
    .description(
      "Read the desktop's displays now (and save them for window placement), numbered left to right; --cached shows the last reading.",
    )
    .option("--cached", "Show the last reading instead of reading the displays now.")
    .option("--json", "Emit the reading as JSON.")
    .action(
      guarded(input, (deps, opts: { cached?: boolean; json?: boolean }) => {
        const host = requireSupported(deps.host());
        const snapshot = opts.cached ? cachedDisplays(deps, host) : refreshDisplays(deps, host);
        if (!snapshot) {
          throw new ComputerError(
            "displays_not_read",
            `The displays have not been read yet. Run \`${deps.binName} computer displays\` to read them now.`,
          );
        }
        if (opts.json) {
          deps.emit.data(snapshot);
          if (snapshot.displays.length === 0) deps.emit.setExitCode(1);
          return;
        }
        if (snapshot.displays.length === 0) {
          throw new ComputerError(
            "displays_none",
            `No displays were found${snapshot.error ? `: ${snapshot.error}` : "."}`,
          );
        }
        const placement = deps.config().agent_window;
        const target = deps.displays.pick(snapshot.displays, placement.display);
        const lines: string[] = [];
        for (let i = 1; i <= snapshot.displays.length; i++) {
          const display = deps.displays.pick(snapshot.displays, String(i));
          if (!display) continue;
          lines.push(
            `${i}. ${deps.displays.describe(display)}${display === target ? " (agent windows go here)" : ""}`,
          );
        }
        lines.push(
          `Read ${describeAge(snapshot.probed_at, deps.now())} (${snapshot.probed_at}) from ${snapshot.source}.`,
        );
        emitLine(deps.emit, lines.join("\n"));
      }),
    );

  // ------------------------------------------------------------------ window
  computer
    .command("window")
    .description(
      "Show or set where agents' own windows go (ADR 0251): which display, which corner, what size. " +
        "By default the smallest size the program allows, in the bottom-right corner of the secondary display. " +
        "Your choice applies in every project.",
    )
    .option(
      "--display <selector>",
      "secondary, primary, a number from `computer displays`, or a display id or name.",
    )
    .option("--corner <corner>", `Which corner (${CORNERS.join(", ")}).`)
    .option("--size <size>", "WIDTHxHEIGHT (e.g. 800x600), or smallest.")
    .option("--margin <pixels>", `Gap from the display's edges (0 to ${MAX_WINDOW_MARGIN}).`)
    .option("--apps <state>", "on: also move programs an agent launches there; off: leave them.")
    .option("--clear", "Remove your own choice, so the project's default applies.")
    .option("--json", "Emit the result as JSON.")
    .action(
      guarded(
        input,
        (
          deps,
          opts: {
            display?: string;
            corner?: string;
            size?: string;
            margin?: string;
            apps?: string;
            clear?: boolean;
            json?: boolean;
          },
        ) => {
          const report = (config: ComputerProjectConfig, changed: boolean) =>
            opts.json
              ? deps.emit.data({
                  agent_window: config.agent_window,
                  agent_window_source: config.agent_window_source,
                  ...(changed ? { changed: true } : {}),
                })
              : emitLine(
                  deps.emit,
                  `${changed ? "Agent windows now go" : "Agent windows go"}: ${describePlacement(config)}.`,
                );
          const setting =
            opts.display !== undefined ||
            opts.corner !== undefined ||
            opts.size !== undefined ||
            opts.margin !== undefined ||
            opts.apps !== undefined;
          if (!setting && !opts.clear) {
            report(deps.config(), false);
            return;
          }
          if (setting && opts.clear)
            throw new ComputerError("computer_usage", "Pass settings or --clear, not both.");
          let patch: AgentWindowPatch | null = null;
          if (setting) {
            patch = {};
            if (opts.display !== undefined) {
              const display = opts.display.trim();
              if (!display)
                throw new ComputerError("computer_usage", "--display must name a display.");
              patch.display = display;
            }
            if (opts.corner !== undefined) {
              if (!(CORNERS as readonly string[]).includes(opts.corner))
                throw new ComputerError(
                  "computer_usage",
                  `--corner must be one of ${CORNERS.join(", ")}.`,
                );
              patch.corner = opts.corner as Corner;
            }
            if (opts.size !== undefined) {
              const size = parseWindowSize(opts.size);
              patch.width = size ? size.width : null;
              patch.height = size ? size.height : null;
            }
            if (opts.margin !== undefined) {
              const margin = Number(opts.margin);
              if (!Number.isInteger(margin) || margin < 0 || margin > MAX_WINDOW_MARGIN)
                throw new ComputerError(
                  "computer_usage",
                  `--margin must be a whole number of pixels from 0 to ${MAX_WINDOW_MARGIN}.`,
                );
              patch.margin = margin;
            }
            if (opts.apps !== undefined) {
              if (opts.apps !== "on" && opts.apps !== "off")
                throw new ComputerError("computer_usage", "--apps must be on or off.");
              patch.move_apps = opts.apps === "on";
            }
          }
          const written = deps.prefs.writeAgentWindow(patch);
          report(deps.config(written), true);
        },
      ),
    );

  return computer;
}

/**
 * Restart each running daemon whose browser-attach grant no longer matches
 * the setting, so turning it off takes the grant away at once (ADR 0249).
 * A daemon is left alone while another agent holds the desktop.
 */
async function alignBrowserAttachDaemons(
  deps: ComputerDeps,
  host: SupportedHost,
  config: ComputerProjectConfig,
): Promise<string[]> {
  const lines: string[] = [];
  const holder = deps.lease.read(leaseOptions(deps, host));
  const heldByOther = holder && holder.owner_id !== deps.owner().id ? holder : null;
  for (const driver of deps.drivers) {
    if (!driver.supportsBrowserAttach || !driver.hasDaemon || !driver.installedExecutable(host))
      continue;
    const want = wantsBrowserAttach(config, driver);
    const status = driver.daemonStatus(host);
    if (!status.running || (status.browserAttach === true) === want) continue;
    if (heldByOther) {
      lines.push(
        `${driver.id}: the running daemon was not restarted because the desktop is held by ${describeLease(heldByOther, deps.now())}; ` +
          `run \`${deps.binName} computer down\` and \`${deps.binName} computer up\` once it is free.`,
      );
      continue;
    }
    const stopped = driver.stopDaemon(host);
    if (stopped.running) {
      lines.push(`${driver.id}: the running daemon did not stop: ${stopped.detail}`);
      deps.emit.setExitCode(1);
      continue;
    }
    const started = await driver.startDaemon(host, { browserAttach: want });
    lines.push(
      started.running
        ? `${driver.id}: restarted the daemon ${want ? "with" : "without"} browser attach.`
        : `${driver.id}: the daemon stopped but did not start again; \`${deps.binName} computer up\` starts it.`,
    );
  }
  return lines;
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

/**
 * Hold a foreground action until the person's keyboard and mouse have been
 * quiet (ADR 0248). When they stay busy, return the lease to its normal
 * length and refuse with `person_active`; nothing is sent.
 */
async function awaitQuietDesktop(
  deps: ComputerDeps,
  host: SupportedHost,
  owner: LeaseOwner,
  quiet: { quietMs: number; maxWaitMs: number },
): Promise<void> {
  const waited = await waitForQuietDesktop({
    ...quiet,
    probe: () => deps.personIdleMs(host),
    now: deps.now,
    sleep: deps.sleep,
  });
  if (waited.status === "busy") {
    await deps.lease.acquire(owner, leaseOptions(deps, host));
    throw new ComputerError(
      "person_active",
      `The person is using the keyboard or mouse, so this foreground action was not sent ` +
        `(waited ${formatSeconds(waited.waitedMs)} for ${formatSeconds(quiet.quietMs)} of quiet).`,
      EXIT_PERSON_ACTIVE,
      "Nothing was sent. Do other work and try once more later, or use a background route. Do not retry in a loop.",
    );
  }
  if (waited.waitedMs >= 1000)
    deps.writeStderr(
      `Waited ${formatSeconds(waited.waitedMs)} for the person's keyboard and mouse to go quiet before this foreground action.\n`,
    );
}

function guardOwner(owner: LeaseOwner): GuardOwner {
  return { id: owner.id, label: owner.label };
}

function browserGuardFor(deps: ComputerDeps, host: SupportedHost): BrowserGuard {
  return deps.browserGuard(deps.leaseDir(host.desktopStateDir));
}

/**
 * Tell the browser guard what one driver call did. A direct browser call is
 * read through the driver's own observation; nested steps only report whether
 * the whole call went through. A guard failure never fails the call.
 */
function observeBrowserCalls(
  deps: ComputerDeps,
  guard: BrowserGuard,
  owner: LeaseOwner,
  driver: DesktopDriver,
  tool: string,
  calls: BrowserCall[],
  result: DriverCallResult,
  personWindow: boolean,
): void {
  if (calls.length === 0) return;
  const who = guardOwner(owner);
  try {
    const direct = calls.length === 1 && calls[0]?.tool === tool;
    for (const call of calls) {
      const observation = direct
        ? (driver.browserObservation?.(call, result.stdout) ?? {})
        : { delivered: result.exitCode === 0 };
      guard.observe(who, call, observation, { personWindow });
    }
  } catch (err) {
    deps.writeStderr(
      `The browser guard could not record this call's result: ${(err as Error).message ?? String(err)}\n`,
    );
  }
}

/** The driver that does browser work: the first registered one that reports browser calls. */
function browserDriver(deps: ComputerDeps): DesktopDriver | undefined {
  return deps.drivers.find((d) => typeof d.browserCalls === "function");
}

export interface BrowserCleanup {
  /** Driver sessions ended. */
  sessions: string[];
  /** Windows closed. */
  closed: WindowRef[];
  /** Windows that could not be closed; the person should be told. */
  left_open: WindowRef[];
}

/**
 * End the owner's browser sessions, close the windows it opened for itself,
 * and forget them (ADR 0250). Best effort: never throws. Null when there is
 * nothing to do here (unsupported host, no browser driver installed, or no
 * recorded work).
 */
function closeBrowserWork(
  deps: ComputerDeps,
  host: HostInfo,
  owner: LeaseOwner,
): BrowserCleanup | null {
  try {
    if (host.kind === "unsupported" || !host.desktopStateDir) return null;
    const driver = browserDriver(deps);
    if (!driver?.installedExecutable(host)) return null;
    const guard = browserGuardFor(deps, host as SupportedHost);
    const who = guardOwner(owner);
    const work = guard.work(who);
    if (work.sessions.length === 0 && work.windows.length === 0) return null;
    const cleanup: BrowserCleanup = { sessions: [], closed: [], left_open: [] };
    for (const session of work.sessions) {
      try {
        const result = driver.call(host, "end_session", { session });
        if (result.exitCode === 0) cleanup.sessions.push(session);
      } catch {
        // best effort
      }
    }
    for (const window of work.windows) {
      let closed = false;
      try {
        closed = driver.closeWindow?.(host, window) ?? false;
      } catch {
        closed = false;
      }
      (closed ? cleanup.closed : cleanup.left_open).push(window);
    }
    try {
      guard.clear(who);
    } catch {
      // best effort
    }
    return cleanup;
  } catch {
    return null;
  }
}

function describeWindow(w: WindowRef): string {
  return `window ${w.window_id} (pid ${w.pid})`;
}

/** Plain lines for a cleanup, empty when nothing was ended, closed or left open. */
function describeCleanup(cleanup: BrowserCleanup | null): string[] {
  if (!cleanup) return [];
  const lines: string[] = [];
  const done: string[] = [];
  if (cleanup.sessions.length > 0)
    done.push(
      `ended browser session${cleanup.sessions.length === 1 ? "" : "s"} ${cleanup.sessions.join(", ")}`,
    );
  if (cleanup.closed.length > 0)
    done.push(`closed ${cleanup.closed.map(describeWindow).join(", ")}`);
  if (done.length > 0) {
    const text = done.join(" and ");
    lines.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
  }
  if (cleanup.left_open.length > 0)
    lines.push(
      `Could not close browser ${cleanup.left_open.map(describeWindow).join(", ")}; tell the person it is still open.`,
    );
  return lines;
}

/** The target and tab a bind (get_browser_state) returned, read leniently. */
/** A page of the browser itself (settings, its attach setup page), never the agent's page. */
const BROWSER_INTERNAL_URL = /^(?:chrome|edge|brave|about|devtools|chrome-extension):/i;

/**
 * The target and tab from a bind result. The tab is the one showing `wanted`
 * when given, else the active tab that is not a browser-internal page, else
 * the first such tab, else whatever is active.
 */
function parseBind(
  result: DriverCallResult,
  wanted?: string,
): { target_id: string; tab_id?: string; url?: string } | null {
  let json = result.json;
  if (json === undefined) {
    try {
      json = JSON.parse(result.stdout);
    } catch {
      return null;
    }
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  if (typeof record.target_id !== "string") return null;
  const tabs = Array.isArray(record.tabs)
    ? record.tabs.filter(
        (t): t is Record<string, unknown> => !!t && typeof t === "object" && !Array.isArray(t),
      )
    : [];
  const urlOf = (t: Record<string, unknown>) => (typeof t.url === "string" ? t.url : "");
  const pages = tabs.filter((t) => !BROWSER_INTERNAL_URL.test(urlOf(t)));
  const tab =
    (wanted ? tabs.find((t) => urlOf(t) === wanted) : undefined) ??
    pages.find((t) => t.active === true) ??
    pages[0] ??
    tabs.find((t) => t.active === true) ??
    tabs[0];
  const tabId = tab ? (tab.tab_id ?? tab.id) : undefined;
  return {
    target_id: record.target_id,
    ...(typeof tabId === "string" ? { tab_id: tabId } : {}),
    ...(tab && typeof tab.url === "string" ? { url: tab.url } : {}),
  };
}

// ---------------------------------------------------------------- displays

function displayCacheDir(deps: ComputerDeps, host: SupportedHost): string {
  return deps.leaseDir(host.desktopStateDir);
}

/**
 * Read the displays now and save them for the rest of this stretch of
 * computer use (ADR 0251). Best effort: never throws and never fails a command.
 */
export function refreshDisplays(deps: ComputerDeps, host: SupportedHost): DisplaySnapshot {
  let snapshot: DisplaySnapshot;
  try {
    snapshot = deps.displays.probe(host);
  } catch (err) {
    return {
      probed_at: new Date(deps.now()).toISOString(),
      source: "none",
      displays: [],
      error: (err as Error).message ?? String(err),
    };
  }
  try {
    deps.displays.writeCache(displayCacheDir(deps, host), snapshot);
  } catch {
    // best effort: the snapshot still serves this command
  }
  return snapshot;
}

function cachedDisplays(deps: ComputerDeps, host: SupportedHost): DisplaySnapshot | null {
  try {
    return deps.displays.readCache(displayCacheDir(deps, host));
  } catch {
    return null;
  }
}

/** The first installed driver that can move windows. */
function windowMover(deps: ComputerDeps, host: HostInfo): DesktopDriver | undefined {
  return deps.drivers.find((d) => {
    if (typeof d.setWindowFrame !== "function") return false;
    try {
      return Boolean(d.installedExecutable(host));
    } catch {
      return false;
    }
  });
}

export type PlaceResult = { display: string; frame: Rect } | { skipped: string };

/**
 * Put one of the agent's windows where the person wants agent windows
 * (ADR 0251). With `resize`, it is first moved onto the target display at the
 * requested size (the smallest the program allows unless the placement names
 * one), because a display with another scale changes the size; the actual
 * frame read back then decides the corner position. Without `resize`, it is
 * only moved, and only when it fits. `fresh` reads the displays now instead
 * of using the last reading. Never throws.
 */
export function placeWindow(
  deps: ComputerDeps,
  host: SupportedHost,
  window: WindowRef & { frame?: Rect },
  options: { resize: boolean; fresh?: boolean },
): PlaceResult {
  try {
    const placement: WindowPlacement = deps.config().agent_window;
    const mover = windowMover(deps, host);
    if (!mover?.setWindowFrame) return { skipped: "no installed driver can move windows" };
    const snapshot = options.fresh
      ? refreshDisplays(deps, host)
      : (cachedDisplays(deps, host) ?? refreshDisplays(deps, host));
    if (snapshot.displays.length === 0)
      return { skipped: `no displays were found${snapshot.error ? ` (${snapshot.error})` : ""}` };
    const display = deps.displays.pick(snapshot.displays, placement.display);
    if (!display) return { skipped: `no display matches "${placement.display}"` };
    const area = display.work_area ?? display.bounds;
    let size: Rect;
    if (options.resize) {
      const actual = mover.setWindowFrame(host, window, {
        x: area.x,
        y: area.y,
        width: placement.width ?? SMALLEST_REQUEST.width,
        height: placement.height ?? SMALLEST_REQUEST.height,
      });
      if (!actual) return { skipped: "the driver could not size the window" };
      size = actual;
    } else {
      const frame =
        window.frame ??
        mover.windowsOf?.(host, window.pid)?.find((w) => w.window_id === window.window_id)?.frame;
      if (!frame) return { skipped: "the window's size is unknown" };
      if (frame.width > area.width || frame.height > area.height) {
        // Too large for the target display: it keeps its size where it can
        // and is cut down only to what fits there.
        const fitted = mover.setWindowFrame(host, window, {
          x: area.x,
          y: area.y,
          width: Math.min(frame.width, area.width),
          height: Math.min(frame.height, area.height),
        });
        if (!fitted) return { skipped: "the driver could not fit the window on the display" };
        size = fitted;
      } else size = frame;
    }
    const position = deps.displays.corner(display, placement.corner, size, placement.margin);
    const moved = mover.setWindowFrame(
      host,
      { pid: window.pid, window_id: window.window_id },
      position,
    );
    if (!moved) return { skipped: "the driver could not move the window" };
    return { display: display.id, frame: moved };
  } catch (err) {
    return { skipped: `placing the window failed: ${(err as Error).message ?? String(err)}` };
  }
}

const LAUNCH_POLL_MS = 250;
const LAUNCH_WAIT_MS = 3_000;
const LAUNCH_MAX_WINDOWS = 3;

/**
 * Move the windows of a program a call just launched to the agent-window
 * corner, without resizing them. Best effort and silent unless one moved.
 */
async function placeLaunchedWindows(
  deps: ComputerDeps,
  host: SupportedHost,
  pid: number,
): Promise<void> {
  try {
    const mover = windowMover(deps, host);
    if (!mover?.windowsOf) return;
    let windows: (WindowRef & { frame?: Rect })[] = [];
    for (let waited = 0; ; waited += LAUNCH_POLL_MS) {
      try {
        windows = mover.windowsOf(host, pid) ?? [];
      } catch {
        windows = [];
      }
      if (windows.length > 0 || waited >= LAUNCH_WAIT_MS) break;
      await deps.sleep(LAUNCH_POLL_MS);
    }
    let movedTo: string | undefined;
    for (const window of windows.slice(0, LAUNCH_MAX_WINDOWS)) {
      const placed = placeWindow(deps, host, window, { resize: false });
      if ("display" in placed) movedTo ??= placed.display;
    }
    if (movedTo !== undefined)
      deps.writeStderr(`Moved the launched program's window to display ${movedTo}.\n`);
  } catch {
    // best effort
  }
}

function describeSize(placement: WindowPlacement): string {
  if (placement.width !== undefined && placement.height !== undefined)
    return `${placement.width} by ${placement.height}`;
  if (placement.width !== undefined) return `${placement.width} wide, smallest height`;
  if (placement.height !== undefined) return `${placement.height} high, smallest width`;
  return "the smallest size the program allows";
}

function describeWindowSource(config: ComputerProjectConfig): string {
  if (config.agent_window_source === "user") return "your setting";
  if (config.agent_window_source === "project") return "the project's setting";
  return "the default";
}

/** One plain line for the effective agent-window placement. */
function describePlacement(config: ComputerProjectConfig): string {
  const p = config.agent_window;
  const display = /^\d+$/.test(p.display)
    ? `display ${p.display}`
    : p.display === "primary" || p.display === "secondary"
      ? `the ${p.display} display`
      : `display ${p.display}`;
  return (
    `${describeSize(p)}, ${p.corner} corner of ${display}` +
    `${p.margin > 0 ? `, ${p.margin}px from the edges` : ""}; ` +
    `launched programs ${p.move_apps ? "move there too" : "stay where they open"} (${describeWindowSource(config)})`
  );
}

function describeAge(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "at an unknown time";
  if (seconds < 120) return `${seconds}s ago`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** The `displays:` status line, from the last reading. */
function describeDisplayCache(
  snapshot: DisplaySnapshot | null,
  nowMs: number,
  bin: string,
): string {
  const hint = `\`${bin} computer displays\` reads them now`;
  if (!snapshot) return `not read yet; ${hint}`;
  const age = describeAge(snapshot.probed_at, nowMs);
  if (snapshot.displays.length === 0)
    return `none found${snapshot.error ? ` (${snapshot.error})` : ""}, read ${age}; ${hint}`;
  const n = snapshot.displays.length;
  return `${n} display${n === 1 ? "" : "s"}, read ${age}; ${hint}`;
}

const MAX_WINDOW_SIZE = 20_000;
const MAX_WINDOW_MARGIN = 2_000;

/** `--size WxH` as two positive integers, or null for `smallest`. */
function parseWindowSize(raw: string): { width: number; height: number } | null {
  const value = raw.trim().toLowerCase();
  if (value === "smallest") return null;
  const m = /^(\d+)x(\d+)$/.exec(value);
  const width = m ? Number(m[1]) : Number.NaN;
  const height = m ? Number(m[2]) : Number.NaN;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_WINDOW_SIZE ||
    height > MAX_WINDOW_SIZE
  ) {
    throw new ComputerError(
      "computer_usage",
      `--size must be WIDTHxHEIGHT (two whole numbers from 1 to ${MAX_WINDOW_SIZE}, e.g. 800x600) or smallest.`,
    );
  }
  return { width, height };
}

export function registerComputerCommand(
  program: Command,
  emit: EmitContext,
  binName: string,
): void {
  createComputerCommand({ emit, binName }, program);
}
