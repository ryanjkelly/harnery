/**
 * Shared contracts for `harn computer` (ADR 0228).
 *
 * The command layer and the desktop lease depend only on these types. Every
 * driver-specific detail (release URLs, archive layout, CLI arguments, config
 * files) lives behind `DesktopDriver` in a driver module such as `cua.ts`.
 *
 * Internal module: not exported from package.json.
 */

/** Where the desktop being driven lives, relative to the calling process. */
export type HostKind =
  /** A native Windows process driving its own desktop. */
  | "windows"
  /** A WSL2 process driving the Windows desktop through interop. */
  | "wsl"
  /** A macOS process driving its own desktop. */
  | "macos"
  /** A native Linux process driving its own graphical session (not WSL). */
  | "linux"
  /** Any other host, or one whose shared state directory cannot be resolved. */
  | "unsupported";

export interface HostInfo {
  kind: HostKind;
  /** Human-readable reason when kind is "unsupported". */
  reason?: string;
  /** Advisory for a supported host that may still fail (e.g. Linux with no graphical session). */
  note?: string;
  /**
   * Directory (in the CALLER's path syntax) that is shared by every caller of
   * this desktop: on Windows and WSL, `%LOCALAPPDATA%\harnery` expressed as a
   * Windows path (windows) or its `/mnt/<drive>/...` form (wsl); on macOS
   * `~/Library/Application Support/harnery`; on Linux `$XDG_STATE_HOME/harnery`.
   * The lease file and driver installs live under it.
   */
  desktopStateDir?: string;
}

/** A pinned, checksum-verified build of one driver for one platform. */
export interface PinnedArtifact {
  /** Driver version, e.g. "0.38.0". */
  version: string;
  /** Archive file name as published. */
  fileName: string;
  /** Download URL. */
  url: string;
  /** Lowercase hex SHA-256 of the archive. */
  sha256: string;
  /** Archive format. */
  format: "zip" | "tar.gz";
  /**
   * Single top-level directory every entry sits under, when the archive has
   * one. That directory becomes the install directory.
   */
  topDir?: string;
  /** Path of the driver executable inside the archive (forward slashes). */
  executableEntry: string;
  /** Other paths (files or directories) the archive must contain. */
  requiredEntries?: string[];
}

export interface InstallPlan {
  driver: string;
  version: string;
  host: HostKind;
  artifact: PinnedArtifact;
  /** Install directory in the caller's path syntax (versioned). */
  installDir: string;
  /** Executable path in the caller's path syntax. */
  executable: string;
  /** Already installed and the executable's archive hash was verified at install time. */
  alreadyInstalled: boolean;
  /** Driver preference file written before first run, caller's path syntax. */
  preferenceFile?: string;
  /** Preferences merged into that file (e.g. telemetry off). */
  preferences?: Record<string, unknown>;
  /** Further install actions shown in the preview (e.g. placing an app bundle). */
  steps?: string[];
  /** One-time setup the person must do outside Harnery (e.g. OS permission grants). */
  setup?: string[];
}

export interface InstallResult extends InstallPlan {
  installed: boolean;
}

export interface DaemonStatus {
  running: boolean;
  /** Raw first line(s) from the driver's status output, for display. */
  detail: string;
  pid?: number;
  /**
   * Whether this daemon was started with the grant that lets it attach to the
   * person's running browser (ADR 0249). Known only for a daemon Harnery
   * started; absent for a driver without that grant or a daemon of unknown
   * origin.
   */
  browserAttach?: boolean;
  /**
   * The running daemon's own version, when the driver can tell. The command
   * restarts a daemon whose version is not the pinned one (ADR 0250).
   */
  version?: string;
}

/**
 * What one driver call does to a browser, for the browser guard (ADR 0250).
 * `attach` joins the person's running browser; `launch` starts a
 * driver-owned isolated one; `bind` mints a target for one window; `read`
 * snapshots a tab; `type` enters text; `point` clicks or moves the pointer
 * (what an overlay can intercept); `act` is any other change to a tab
 * (navigate, select, dialog, download, file input); `opaque` is a program
 * that names browser tools and cannot be checked call by call.
 */
export interface BrowserCall {
  kind: "attach" | "launch" | "bind" | "read" | "type" | "point" | "act" | "opaque";
  /** The driver tool, for messages. */
  tool: string;
  session?: string;
  pid?: number;
  window_id?: number;
  target_id?: string;
  tab_id?: string;
  /** Page element ref the call acts on, e.g. "p7:0". */
  ref?: string;
  /** True for a navigation, which invalidates the tab's refs. */
  navigates?: boolean;
}

/** What a browser call's result showed, for the browser guard to remember. */
export interface BrowserObservation {
  /** A successful bind: the target the driver minted for (pid, window_id). */
  bound?: { target_id: string; pid?: number; window_id?: number };
  /** A successful driver-owned launch: the browser process the driver started. */
  launched_pid?: number;
  /** A snapshot of one tab. */
  snapshot?: {
    target_id: string;
    tab_id: string;
    /** Refs of fields that take a password, passcode or one-time code. */
    sensitive_refs: string[];
    /** A password manager's save or fill offer is showing in the page. */
    password_offer: boolean;
  };
  /** The call reached the page (typed, clicked, navigated) rather than being refused. */
  delivered?: boolean;
}

/** One top-level window of a running program. */
export interface WindowRef {
  pid: number;
  window_id: number;
}

/** How to start a driver's daemon. */
export interface DaemonStartOptions {
  /** Start it able to attach to the person's running browser (ADR 0249). */
  browserAttach?: boolean;
}

/**
 * A process a driver starts on its own and leaves running after a call returns
 * (for example agent-desktop's per-environment command host on macOS). It is
 * not a daemon `up` starts, but `status` reports it and `down` stops it.
 */
export interface BackgroundProcess {
  pid: number;
  /** What the process is, e.g. "command host". */
  kind: string;
}

export interface DriverCallResult {
  /** Process exit code of the driver invocation. */
  exitCode: number;
  /** Driver stdout with CRLF normalized to LF. */
  stdout: string;
  /** Driver stderr with CRLF normalized to LF. */
  stderr: string;
  /** Parsed stdout when it is a single JSON value, else undefined. */
  json?: unknown;
}

/**
 * The adapter boundary. Each driver (`cua.ts`, `agent-desktop.ts`) implements
 * it; the command picks one through the registry in `drivers.ts` and never
 * branches on a driver id.
 */
export interface DesktopDriver {
  /** Stable id, e.g. "cua". */
  readonly id: string;
  /** Pinned version this Harnery build installs. */
  readonly version: string;
  /** Short description shown by `status` and the skill. */
  readonly summary: string;
  /**
   * True when the driver runs a background daemon that `up` starts and `down`
   * stops. A driver without one runs per call, and `up`/`down` are no-ops.
   */
  readonly hasDaemon: boolean;
  /** Longest one `call` may run before the driver gives up, in ms; the lease outlasts it. */
  readonly callTimeoutMs?: number;
  /**
   * The timeout for one specific call, when it depends on the call's own wait
   * arguments. Falls back to `callTimeoutMs` when absent.
   */
  callTimeoutFor?(tool: string, args: Record<string, unknown>): number;
  /**
   * True when this call may bring a window to the front or send real keyboard
   * and mouse input, so it would collide with a person who is typing. The
   * command waits for their input to go quiet first (ADR 0248). Absent means
   * the driver never does that.
   */
  takesForeground?(tool: string, args: Record<string, unknown>): boolean;
  /**
   * True when this call attaches the driver to the person's running browser
   * profile (ADR 0249), which the command allows only where browser attach
   * is on. Absent means the driver has no such route.
   */
  attachesPersonBrowser?(tool: string, args: Record<string, unknown>): boolean;
  /** True when the driver can attach to the person's running browser at all. */
  readonly supportsBrowserAttach?: boolean;
  /**
   * The browser calls inside one driver call (itself, or its nested steps),
   * for the browser guard. Empty when the call touches no browser.
   */
  browserCalls?(tool: string, args: Record<string, unknown>): BrowserCall[];
  /** What one browser call's stdout showed. `call` is one entry of `browserCalls`. */
  browserObservation?(call: BrowserCall, stdout: string): BrowserObservation;
  /**
   * Open a new window in the person's running browser and return it. `pid`
   * picks the browser process; without it the driver picks the person's
   * front-most supported browser. Brings that window forward.
   */
  openBrowserWindow?(host: HostInfo, options: { url?: string; pid?: number }): Promise<WindowRef>;
  /** Close one window without bringing anything forward. False when it could not. */
  closeWindow?(host: HostInfo, window: WindowRef): boolean;
  /** Background processes the driver left running on this host (see BackgroundProcess). */
  backgroundProcesses?(host: HostInfo): BackgroundProcess[];
  /** Stop every background process; returns the ones still running afterwards. */
  stopBackgroundProcesses?(host: HostInfo): BackgroundProcess[];
  /** Resolve the install plan for this host without side effects. */
  planInstall(host: HostInfo): InstallPlan;
  /** Download, verify, extract and write preferences. Idempotent. */
  install(plan: InstallPlan): Promise<InstallResult>;
  /** Executable path if the pinned version is installed, else undefined. */
  installedExecutable(host: HostInfo): string | undefined;
  daemonStatus(host: HostInfo): DaemonStatus;
  /** Start the daemon unelevated if it is not running. Returns the new status. */
  startDaemon(host: HostInfo, options?: DaemonStartOptions): Promise<DaemonStatus>;
  stopDaemon(host: HostInfo): DaemonStatus;
  /** One tool call. `args` is the JSON object passed to the tool. */
  call(host: HostInfo, tool: string, args: Record<string, unknown>): DriverCallResult;
  /** Tool catalog lines ("name: description"). */
  listTools(host: HostInfo): DriverCallResult;
  /** Full description + input schema of one tool. */
  describe(host: HostInfo, tool: string): DriverCallResult;
  /** End-to-end diagnostics (driver's own health report). */
  health(host: HostInfo): DriverCallResult;
  /**
   * Rewrite caller-side paths inside tool args to the driver's path syntax
   * (e.g. WSL `/home/...` -> `\\wsl.localhost\...`, `/mnt/c/...` -> `C:\...`),
   * and the reverse for paths in results. Identity on native hosts.
   */
  translateArgsPaths(
    host: HostInfo,
    tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown>;
  translateResultPaths(host: HostInfo, stdout: string): string;
}

/** Who is asking for the desktop. Resolved by the command layer. */
export interface LeaseOwner {
  /** Stable id: the agent instance id, or `pid:<pid>@<host>` without one. */
  id: string;
  /** Display label, e.g. "agent-Dexter". Also the default driver session. */
  label: string;
  /** Project root the command acts on; approvals are scoped to it. */
  project?: string;
  /**
   * Project root the agent's own session is registered in, when known. It
   * differs from `project` when an agent acts on another project.
   */
  sessionProject?: string;
}

/** On-disk lease record (one per desktop). */
export interface DesktopLease {
  schema: 1;
  owner_id: string;
  owner_label: string;
  project?: string;
  /** Increments on every fresh acquisition (no lease, or the previous one expired or was released). */
  generation: number;
  acquired_at: string;
  refreshed_at: string;
  /** ISO time after which the lease is free for anyone. */
  expires_at: string;
}

export interface LeaseOptions {
  /** Directory holding the lease file (HostInfo.desktopStateDir/computer). */
  dir: string;
  /** Idle expiry, refreshed on every acquire by the same owner. Default 120s. */
  idleMs?: number;
  /** How long to wait for another owner's lease. Default 0 (fail at once). */
  waitMs?: number;
  /** Poll interval while waiting. Default 500ms. */
  pollMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export type LeaseAcquireResult =
  | {
      ok: true;
      lease: DesktopLease /** true when this call took the lease from nobody/expired. */;
      fresh: boolean;
    }
  | { ok: false; holder: DesktopLease; waitedMs: number };

export interface LeaseApi {
  acquire(owner: LeaseOwner, opts: LeaseOptions): Promise<LeaseAcquireResult>;
  /** Release only if held by `owner`. Returns true when a lease was removed. */
  release(owner: LeaseOwner, opts: LeaseOptions): boolean;
  /** Current unexpired lease, or null. */
  read(opts: LeaseOptions): DesktopLease | null;
}
