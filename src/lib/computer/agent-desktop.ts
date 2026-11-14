/**
 * agent-desktop adapter for `harn computer` (ADR 0231).
 *
 * agent-desktop is a single native executable (plus one platform helper on
 * macOS and Linux) that reads and operates apps through the OS accessibility
 * tree. It has no daemon to start: every call is one process. On macOS that
 * process hands its work to a per-environment command host, which it starts
 * on demand and which keeps running after the call returns. Harnery reports
 * those hosts in `status`, stops them in `down`, and restarts them when a call
 * times out, because a host stuck on an unresponsive app would otherwise make
 * every later call wait for the full timeout too.
 *
 * Call timeouts follow the call: a short default, extended by the wait the
 * call itself asks for (`wait_timeout`, `timeout_ms`, the `wait` command's
 * `ms`), so an agent learns about a stuck app in seconds rather than minutes.
 *
 * macOS attributes this executable's permission requests to the app it runs
 * inside (a terminal, an editor, an agent app), so install, doctor and a
 * permission refusal name that app.
 *
 * A Harnery `call <tool> <json>` becomes `agent-desktop batch` with one entry,
 * `{"command": tool, "args": json}`, whose keys are the command's snake_case
 * field names (`--window-id` -> `window_id`, the REF positional -> `ref_id`).
 * The single batch result is unwrapped into the same envelope the direct CLI
 * prints, and its `ok` decides the exit code. `session` and `headed` in the
 * arguments become the batch's `--session` and `--headed` flags. The tool
 * `batch` with `{"commands": [...]}` runs several entries in one process and
 * returns the batch envelope unchanged.
 *
 * Under WSL the Windows build runs through interop, and file-path arguments
 * and results are translated with `wslpath`, as for the other driver.
 *
 * Internal module: not exported from package.json.
 */
import { posix, win32 } from "node:path";
import { installPinnedArchive, markerMatches } from "./archive.ts";
import { translateWindowsResultPaths } from "./cua.ts";
import {
  archLabel,
  defaultSpawnSync,
  defaultWslpath,
  type ProcessRow,
  pathApi,
  readProcessTable,
  requireStateDir,
  responsibleAppName,
  type SpawnSyncFn,
  sleepSync,
  toCallResult,
  wslPaths,
} from "./driver-support.ts";
import type {
  BackgroundProcess,
  DaemonStatus,
  DesktopDriver,
  DriverCallResult,
  HostInfo,
  InstallPlan,
  InstallResult,
  PinnedArtifact,
} from "./types.ts";

export const AGENT_DESKTOP_DRIVER_ID = "agent-desktop";
export const AGENT_DESKTOP_VERSION = "1.0.2";

const RELEASE_BASE = `https://github.com/vercel-labs/agent-desktop/releases/download/v${AGENT_DESKTOP_VERSION}`;

export type AgentDesktopPlatform =
  | "windows-x86_64"
  | "windows-arm64"
  | "darwin-x86_64"
  | "darwin-arm64"
  | "linux-x86_64"
  | "linux-arm64";

const TARGETS: Record<AgentDesktopPlatform, string> = {
  "windows-x86_64": "x86_64-pc-windows-msvc",
  "windows-arm64": "aarch64-pc-windows-msvc",
  "darwin-x86_64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x86_64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

function pin(platform: AgentDesktopPlatform, sha256: string): PinnedArtifact {
  const fileName = `agent-desktop-v${AGENT_DESKTOP_VERSION}-${TARGETS[platform]}.tar.gz`;
  const os = platform.split("-")[0];
  return {
    version: AGENT_DESKTOP_VERSION,
    fileName,
    url: `${RELEASE_BASE}/${fileName}`,
    sha256,
    format: "tar.gz",
    executableEntry: os === "windows" ? "agent-desktop.exe" : "agent-desktop",
    ...(os === "darwin" ? { requiredEntries: ["agent-desktop-macos-helper"] } : {}),
    ...(os === "linux" ? { requiredEntries: ["agent-desktop-linux-clipboard-owner"] } : {}),
  };
}

/**
 * Pinned archives (SHA-256 from the release `checksums.txt`, build provenance
 * checked with `gh attestation verify` when the pin was set). Upgrading is a
 * change here.
 */
export const AGENT_DESKTOP_PINS: Readonly<Record<AgentDesktopPlatform, PinnedArtifact>> =
  Object.freeze({
    "windows-x86_64": pin(
      "windows-x86_64",
      "2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222",
    ),
    "windows-arm64": pin(
      "windows-arm64",
      "a0ecd6e17e60a0bcfbb45533a72f2d3a7a73508769588273ef08b0477d2b9687",
    ),
    "darwin-x86_64": pin(
      "darwin-x86_64",
      "8edda6df17eafc042395502a823dbb8415bc8ac14835a6731e4d8becc9cb4121",
    ),
    "darwin-arm64": pin(
      "darwin-arm64",
      "7bee385196d7b478de80cf05ca4304aaa38f0eba593b3406ad3c247c1773be19",
    ),
    "linux-x86_64": pin(
      "linux-x86_64",
      "ad661b7a3fd8f990a769243f4889a240ca0e2c8dab3ef5bddd6019086c71e0b4",
    ),
    "linux-arm64": pin(
      "linux-arm64",
      "864cb782e0afc8bf0df19622016b24bdbd1a83fc7749f784ee82aa49a7f845eb",
    ),
  });

/** Default limit for one call; the binary's own deadlines are a few seconds. */
export const AGENT_DESKTOP_CALL_TIMEOUT_MS = 30_000;
/** Upper bound however long a call asks to wait. */
export const AGENT_DESKTOP_MAX_CALL_TIMEOUT_MS = 600_000;
/** The binary's default for `--wait-for` / `--wait-for-gone` without `--wait-timeout`. */
const DEFAULT_WAIT_FOR_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
const HOST_STOP_GRACE_MS = 2_000;
const HOST_KIND = "command host";

/** Milliseconds one command's own arguments ask to wait for. */
function requestedWaitMs(tool: string, args: Record<string, unknown>): number {
  const num = (key: string): number => {
    const value = Number(args[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  let wait = num("wait_timeout") + num("timeout_ms");
  if (tool === "wait") wait += num("ms") || (num("wait_timeout") ? 0 : DEFAULT_WAIT_FOR_MS);
  if ((args.wait_for !== undefined || args.wait_for_gone !== undefined) && !num("wait_timeout"))
    wait += DEFAULT_WAIT_FOR_MS;
  return wait;
}

/**
 * The timeout for one call: the default plus whatever the call asks to wait
 * (summed across a batch's entries), capped at the maximum.
 */
export function agentDesktopCallTimeoutMs(tool: string, args: Record<string, unknown>): number {
  let wait = 0;
  if (tool === "batch" && Array.isArray(args.commands)) {
    for (const entry of args.commands) {
      if (!entry || typeof entry !== "object") continue;
      const { command, args: entryArgs } = entry as { command?: unknown; args?: unknown };
      wait += requestedWaitMs(
        typeof command === "string" ? command : "",
        entryArgs && typeof entryArgs === "object" ? (entryArgs as Record<string, unknown>) : {},
      );
    }
  } else wait = requestedWaitMs(tool, args);
  return Math.min(AGENT_DESKTOP_MAX_CALL_TIMEOUT_MS, AGENT_DESKTOP_CALL_TIMEOUT_MS + wait);
}

/** Commands the binary ships, grouped as its own docs group them. */
export const AGENT_DESKTOP_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  observe: ["snapshot", "find", "get", "is", "screenshot", "list-surfaces"],
  "act on a ref": [
    "click",
    "double-click",
    "triple-click",
    "right-click",
    "type",
    "set-value",
    "clear",
    "focus",
    "select",
    "toggle",
    "check",
    "uncheck",
    "expand",
    "collapse",
    "scroll",
    "scroll-to",
  ],
  "keyboard and mouse": ["press", "hover", "drag", "mouse-move", "mouse-click", "mouse-wheel"],
  "apps and windows": [
    "launch",
    "close-app",
    "list-apps",
    "list-windows",
    "list-displays",
    "focus-window",
    "resize-window",
    "move-window",
    "minimize",
    "maximize",
    "restore",
    "open-system-surface",
  ],
  notifications: [
    "list-notifications",
    "dismiss-notification",
    "dismiss-all-notifications",
    "notification-action",
  ],
  clipboard: ["clipboard-get", "clipboard-set", "clipboard-clear"],
  wait: ["wait"],
  system: ["status", "permissions", "version", "batch"],
});

/** Arg keys whose string values are file paths in the caller's syntax. */
const PATH_ARG_KEYS = new Set(["output_path", "out", "image", "path", "trace", "screenshot"]);

/** Commands that always bring a window to the front. */
const AGENT_DESKTOP_FOREGROUND_COMMANDS: ReadonlySet<string> = new Set(["focus-window"]);

function commandTakesForeground(command: unknown, args: unknown): boolean {
  if (typeof command === "string" && AGENT_DESKTOP_FOREGROUND_COMMANDS.has(command)) return true;
  if (!args || typeof args !== "object") return false;
  const record = args as Record<string, unknown>;
  return record.headed === true || record.activate === true;
}

/**
 * Whether one call may take the foreground: `headed` delivery (the pointer
 * moves and the window takes focus), `activate` on a launch, or
 * `focus-window`, on the call itself or on any command of a `batch`. Headless
 * delivery, the default, never does.
 */
export function agentDesktopTakesForeground(tool: string, args: Record<string, unknown>): boolean {
  if (commandTakesForeground(tool, args)) return true;
  if (tool !== "batch" || !Array.isArray(args.commands)) return false;
  return args.commands.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const step = entry as Record<string, unknown>;
    return commandTakesForeground(step.command, step.args);
  });
}

/** Session names the binary accepts: letters, digits, `-` and `_`, at most 64. */
export function agentDesktopSession(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "harnery").slice(0, 64);
}

export interface AgentDesktopDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  spawnSync?: SpawnSyncFn;
  pins?: Readonly<Record<AgentDesktopPlatform, PinnedArtifact>>;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  wslpath?: (flag: "-w" | "-u", path: string) => string | undefined;
  now?: () => number;
  /** Process table reader (macOS command hosts and the app that launched this process). */
  processTable?: (field: "command" | "comm") => ProcessRow[];
  /** Signal a process; throws when it is gone. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** This process's pid, the start of the walk to the app it runs inside. */
  selfPid?: number;
  sleepSync?: (ms: number) => void;
}

export function agentDesktopPlatform(
  host: HostInfo,
  arch: string,
): AgentDesktopPlatform | undefined {
  const mapped = archLabel(arch);
  if (!mapped) return undefined;
  if (host.kind === "windows" || host.kind === "wsl") return `windows-${mapped}`;
  if (host.kind === "macos") return `darwin-${mapped}`;
  if (host.kind === "linux") return `linux-${mapped}`;
  return undefined;
}

interface Envelope {
  version?: string;
  ok?: boolean;
  command?: string;
  data?: unknown;
  error?: unknown;
}

/**
 * Turn a one-entry batch envelope into the envelope the direct command would
 * print, so callers never see the batch wrapper. Anything else is returned
 * as-is.
 */
export function unwrapSingleBatch(result: DriverCallResult): DriverCallResult {
  const env = result.json as Envelope | undefined;
  if (env?.command !== "batch" || env.ok !== true) return result;
  const results = (env.data as { results?: unknown[] } | undefined)?.results;
  if (!Array.isArray(results) || results.length !== 1) return result;
  const entry = results[0] as Envelope & { execution?: string };
  const ok = entry.ok === true;
  const out: Envelope = {
    version: entry.version ?? env.version,
    ok,
    command: entry.command,
    ...(ok ? { data: entry.data } : { error: entry.error ?? { message: "not executed" } }),
  };
  const stdout = `${JSON.stringify(out)}\n`;
  return { ...result, exitCode: ok ? 0 : 1, stdout, json: out };
}

export function createAgentDesktopDriver(deps: AgentDesktopDeps = {}): DesktopDriver {
  const run = deps.spawnSync ?? defaultSpawnSync;
  const baseEnv = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const paths = wslPaths(deps.wslpath ?? defaultWslpath(run, baseEnv, STATUS_TIMEOUT_MS));
  const processTable =
    deps.processTable ?? ((field: "command" | "comm") => readProcessTable(run, baseEnv(), field));
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const pause = deps.sleepSync ?? sleepSync;

  /** The app macOS charges this agent's permission requests to, when it can be named. */
  function grantTarget(host: HostInfo): string | undefined {
    if (host.kind !== "macos") return undefined;
    try {
      return responsibleAppName(processTable("comm"), deps.selfPid ?? process.pid);
    } catch {
      return undefined;
    }
  }

  /** Where to grant, in words: the named app, or a description when it cannot be named. */
  function grantPlace(host: HostInfo): string {
    const app = grantTarget(host);
    return app
      ? `"${app}" (the app this agent runs in)`
      : "the app your agent runs in (its terminal, editor, or agent app)";
  }

  function grantHint(host: HostInfo): string {
    return (
      `Grant Accessibility and Screen Recording to ${grantPlace(host)} in System Settings > Privacy & Security ` +
      "(Accessibility is named Device Control and Data Access on macOS 27 and later). " +
      "Each app you run agents from needs its own grant, and a new grant can take about a minute to apply."
    );
  }

  function artifactFor(host: HostInfo): PinnedArtifact {
    const arch = deps.arch ?? process.arch;
    const platform = agentDesktopPlatform(host, arch);
    if (!platform)
      throw new Error(
        `No pinned agent-desktop build for ${host.kind} on architecture ${arch}; supported: x64 (x86_64), arm64.`,
      );
    return (deps.pins ?? AGENT_DESKTOP_PINS)[platform];
  }

  function layout(host: HostInfo): { installDir: string; executable: string } {
    const stateDir = requireStateDir(host);
    const p = pathApi(host);
    const installDir = p.join(stateDir, "tools", "agent-desktop", AGENT_DESKTOP_VERSION);
    return { installDir, executable: p.join(installDir, artifactFor(host).executableEntry) };
  }

  function installedExecutable(host: HostInfo): string | undefined {
    if (host.kind === "unsupported" || !host.desktopStateDir) return undefined;
    try {
      const { installDir, executable } = layout(host);
      return markerMatches(installDir, executable, artifactFor(host), pathApi(host))
        ? executable
        : undefined;
    } catch {
      return undefined;
    }
  }

  function requireExecutable(host: HostInfo): string {
    requireStateDir(host);
    const exe = installedExecutable(host);
    if (!exe)
      throw new Error(
        `agent-desktop ${AGENT_DESKTOP_VERSION} is not installed for this desktop; install it with the computer install command first.`,
      );
    return exe;
  }

  function exec(host: HostInfo, args: string[], timeout = AGENT_DESKTOP_CALL_TIMEOUT_MS) {
    const exe = requireExecutable(host);
    const raw = run(exe, args, { timeout, env: baseEnv() });
    const result = toCallResult(`agent-desktop ${args[0]}`, timeout, raw);
    const timedOut = (raw.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (timedOut && host.kind === "macos") {
      const remaining = stopBackgroundProcesses(host);
      result.stderr +=
        "An app may not be answering accessibility requests. " +
        (remaining.length
          ? `agent-desktop's command host could not be stopped (pid ${remaining.map((p) => p.pid).join(", ")}). `
          : "Harnery restarted agent-desktop's command host, so the next call starts fresh. ") +
        "Snapshot again before retrying; the action may already have been delivered.\n";
    }
    return result;
  }

  function backgroundProcesses(host: HostInfo): BackgroundProcess[] {
    if (host.kind !== "macos") return [];
    const exe = installedExecutable(host);
    if (!exe) return [];
    // The host runs the executable with no arguments; a call always has some.
    return processTable("command")
      .filter((row) => row.command === exe)
      .map((row) => ({ pid: row.pid, kind: HOST_KIND }));
  }

  function stopBackgroundProcesses(host: HostInfo): BackgroundProcess[] {
    const signal = (procs: BackgroundProcess[], sig: NodeJS.Signals) => {
      for (const proc of procs)
        try {
          kill(proc.pid, sig);
        } catch {
          // Already gone.
        }
    };
    const targets = backgroundProcesses(host);
    if (targets.length === 0) return [];
    signal(targets, "SIGTERM");
    const alive = () => {
      const pids = new Set(backgroundProcesses(host).map((p) => p.pid));
      return targets.filter((p) => pids.has(p.pid));
    };
    for (let waited = 0; waited < HOST_STOP_GRACE_MS && alive().length > 0; waited += 100)
      pause(100);
    const stubborn = alive();
    if (stubborn.length === 0) return [];
    signal(stubborn, "SIGKILL");
    pause(200);
    return alive();
  }

  function planInstall(host: HostInfo): InstallPlan {
    requireStateDir(host);
    const artifact = artifactFor(host);
    const { installDir, executable } = layout(host);
    const plan: InstallPlan = {
      driver: AGENT_DESKTOP_DRIVER_ID,
      version: AGENT_DESKTOP_VERSION,
      host: host.kind,
      artifact,
      installDir,
      executable,
      alreadyInstalled: installedExecutable(host) === executable,
    };
    if (host.kind === "macos")
      plan.setup = [
        `${grantHint(host)} \`${executable} permissions --guide\` opens the right System Settings page.`,
      ];
    if (host.kind === "linux")
      plan.setup = [
        "Run from the signed-in user's graphical session with at-spi2-core installed (GNOME 46 or later is the primary target).",
      ];
    return plan;
  }

  async function install(plan: InstallPlan): Promise<InstallResult> {
    if (plan.host === "unsupported")
      throw new Error("Computer use is not supported on this host; nothing to install.");
    const installed = await installPinnedArchive({
      artifact: plan.artifact,
      installDir: plan.installDir,
      p: plan.host === "windows" ? win32 : posix,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    return { ...plan, alreadyInstalled: !installed, installed };
  }

  const noDaemon = (host: HostInfo): DaemonStatus => {
    requireExecutable(host);
    return { running: true, detail: "no daemon; each call runs the executable once" };
  };

  function call(host: HostInfo, tool: string, args: Record<string, unknown>): DriverCallResult {
    const { session, headed, commands, ...rest } = args;
    const flags: string[] = [];
    if (typeof session === "string" && session)
      flags.push("--session", agentDesktopSession(session));
    if (headed === true) flags.push("--headed");
    if (tool === "batch") {
      if (!Array.isArray(commands))
        return {
          exitCode: 2,
          stdout: "",
          stderr: 'The batch tool takes {"commands": [{"command": "...", "args": {...}}, ...]}.\n',
        };
      return exec(
        host,
        ["batch", JSON.stringify(commands), ...flags],
        agentDesktopCallTimeoutMs(tool, { commands }),
      );
    }
    const entry = { command: tool, args: commands === undefined ? rest : { ...rest, commands } };
    const result = unwrapSingleBatch(
      exec(
        host,
        ["batch", JSON.stringify([entry]), ...flags],
        agentDesktopCallTimeoutMs(tool, rest),
      ),
    );
    if (host.kind === "macos" && /"code"\s*:\s*"PERM_DENIED"/.test(result.stdout))
      result.stderr += `${grantHint(host)}\n`;
    return result;
  }

  function listTools(host: HostInfo): DriverCallResult {
    requireExecutable(host);
    const lines = Object.entries(AGENT_DESKTOP_COMMANDS).map(
      ([group, names]) => `${group}: ${names.join(", ")}`,
    );
    lines.push(
      "",
      "JSON keys are each command's snake_case field names: --window-id -> window_id; the REF positional -> ref_id; screenshot PATH -> output_path.",
      "Loop rules for agents: describe skill:desktop; platform notes: describe skill:platform.",
    );
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }

  function describe(host: HostInfo, tool: string): DriverCallResult {
    const skill = /^skill:(.+)$/.exec(tool)?.[1];
    if (skill) {
      const result = exec(host, ["skills", "get", skill]);
      const content = (result.json as { data?: { content?: string } } | undefined)?.data?.content;
      return content
        ? { ...result, stdout: `${content.replace(/\r\n?/g, "\n")}\n`, json: undefined }
        : result;
    }
    const help = exec(host, [tool, "--help"]);
    // An unknown key makes the binary list the accepted ones, without running anything.
    const probe = exec(host, [
      "batch",
      JSON.stringify([{ command: tool, args: { __harnery_probe: 1 } }]),
    ]);
    // The binary reports a validation failure either for the whole batch or for its entry.
    const probed = probe.json as
      | {
          error?: { message?: string };
          data?: { results?: { error?: { message?: string } }[] };
        }
      | undefined;
    const message = String(
      probed?.error?.message ?? probed?.data?.results?.[0]?.error?.message ?? "",
    );
    const expected = /expected (.+)$/.exec(message)?.[1];
    const keys = expected
      ? `JSON keys for computer call: ${expected.replace(/ or /g, ", ").replace(/one of /, "")}`
      : "JSON keys for computer call: the snake_case long-flag names above (positionals: REF -> ref_id, PATH -> output_path).";
    return { ...help, stdout: `${help.stdout.replace(/\n*$/, "")}\n\n${keys}\n` };
  }

  function health(host: HostInfo): DriverCallResult {
    const result = exec(host, ["status"], STATUS_TIMEOUT_MS);
    const data = (result.json as { data?: { permissions?: Record<string, { state?: string }> } })
      ?.data;
    if (!data?.permissions) return result;
    const place = grantPlace(host);
    const checks = Object.entries(data.permissions).map(([name, value]) => {
      const state = value?.state ?? "unknown";
      if (state === "granted" || state === "not_required")
        return { name, status: "pass", message: state };
      // macOS cannot report Automation ahead of time; it asks per target app when an action needs it.
      if (name === "automation" && state === "unknown")
        return {
          name,
          status: "info",
          message: "unknown until an action scripts another app; macOS asks then",
        };
      return {
        name,
        status: "fail",
        message:
          host.kind === "macos" && (name === "accessibility" || name === "screen_recording")
            ? `${state}; grant it to ${place} in System Settings > Privacy & Security, then retry (a new grant can take about a minute)`
            : state,
      };
    });
    const json = { checks, report: result.json };
    return { ...result, stdout: `${JSON.stringify(json)}\n`, json };
  }

  function translateArgsPaths(
    host: HostInfo,
    _tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (host.kind !== "wsl") return args;
    const convert = (value: unknown): unknown =>
      typeof value === "string" && value.startsWith("/") ? paths.toWindows(value) : value;
    const fix = (record: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = { ...record };
      for (const [key, value] of Object.entries(record))
        if (PATH_ARG_KEYS.has(key))
          out[key] = Array.isArray(value) ? value.map(convert) : convert(value);
      return out;
    };
    const out = fix(args);
    if (Array.isArray(args.commands))
      out.commands = args.commands.map((entry) =>
        entry && typeof entry === "object" && (entry as { args?: unknown }).args
          ? { ...(entry as object), args: fix((entry as { args: Record<string, unknown> }).args) }
          : entry,
      );
    return out;
  }

  return {
    id: AGENT_DESKTOP_DRIVER_ID,
    version: AGENT_DESKTOP_VERSION,
    summary:
      "accessibility-tree snapshots with refs scoped to each snapshot; headless semantic actions by default; no daemon",
    hasDaemon: false,
    callTimeoutMs: AGENT_DESKTOP_CALL_TIMEOUT_MS,
    callTimeoutFor: agentDesktopCallTimeoutMs,
    takesForeground: agentDesktopTakesForeground,
    backgroundProcesses,
    stopBackgroundProcesses,
    planInstall,
    install,
    installedExecutable,
    daemonStatus: noDaemon,
    startDaemon: async (host) => noDaemon(host),
    stopDaemon: noDaemon,
    call,
    listTools,
    describe,
    health,
    translateArgsPaths,
    translateResultPaths: (host, stdout) =>
      host.kind === "wsl" ? translateWindowsResultPaths(stdout, paths.toCaller) : stdout,
  };
}

export const agentDesktopDriver: DesktopDriver = createAgentDesktopDriver();
