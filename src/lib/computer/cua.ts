/**
 * Cua Driver adapter for `harn computer` (ADRs 0228 and 0231).
 *
 * Everything specific to this driver lives here: the pinned release and its
 * archive hashes, the archive layout per platform, the driver's preference
 * file, the macOS app bundle, and the `call` / `list-tools` / `describe` /
 * `status` / `serve` / `stop` arguments. The command layer and the desktop
 * lease see only `DesktopDriver`.
 *
 * Under WSL the Windows build runs through interop: the `/mnt/<drive>/...`
 * executable is spawned directly, environment variables cross through
 * `WSLENV`, and file paths in tool arguments and results are translated with
 * `wslpath`.
 *
 * On macOS the driver must run from `/Applications/CuaDriver.app`: macOS ties
 * Accessibility and Screen Recording grants to that signed bundle and its
 * location. Install verifies the bundle's signature and identifier before it
 * copies the bundle there. Until both grants apply, the daemon answers every
 * tool, its own permission check included, with `permissions_pending`; health
 * and call turn that into a check that names the app and the steps to take.
 *
 * Internal module: not exported from package.json.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { windowsExecutable } from "../windows-executable.ts";
import { INSTALL_MARKER, installPinnedArchive, markerMatches } from "./archive.ts";
import {
  archLabel,
  defaultSpawnDetached,
  defaultSpawnSync,
  defaultWslpath,
  mergePreferences,
  normalize,
  pathApi,
  requireStateDir,
  type SpawnDetachedFn,
  type SpawnResult,
  type SpawnSyncFn,
  toCallResult,
  withWslEnv,
  wslPaths,
} from "./driver-support.ts";
import type {
  DaemonStatus,
  DesktopDriver,
  DriverCallResult,
  HostInfo,
  InstallPlan,
  InstallResult,
  PinnedArtifact,
} from "./types.ts";

export type { SpawnResult, SpawnSyncFn };
export { INSTALL_MARKER };

export const CUA_DRIVER_ID = "cua";
export const CUA_DRIVER_VERSION = "0.38.0";

const RELEASE_BASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}`;

/** Process architectures with a pinned build. */
export type CuaArch = "x86_64" | "arm64";

/** Pin keys: one archive per platform build. macOS ships one universal build. */
export type CuaPlatform =
  | "windows-x86_64"
  | "windows-arm64"
  | "darwin-universal"
  | "linux-x86_64"
  | "linux-arm64";

export const CUA_APP_NAME = "CuaDriver.app";
export const CUA_BUNDLE_ID = "com.trycua.driver";

function pin(platform: CuaPlatform, sha256: string): PinnedArtifact {
  const stem = `cua-driver-rs-${CUA_DRIVER_VERSION}-${platform}`;
  const windows = platform.startsWith("windows-");
  const darwin = platform.startsWith("darwin-");
  const ext = windows ? "zip" : "tar.gz";
  return {
    version: CUA_DRIVER_VERSION,
    fileName: `${stem}.${ext}`,
    url: `${RELEASE_BASE}/${stem}.${ext}`,
    sha256,
    format: windows ? "zip" : "tar.gz",
    topDir: stem,
    executableEntry: windows
      ? `${stem}/cua-driver.exe`
      : darwin
        ? `${stem}/${CUA_APP_NAME}/Contents/MacOS/cua-driver`
        : `${stem}/cua-driver`,
    ...(darwin ? { requiredEntries: [`${stem}/${CUA_APP_NAME}/Contents/Info.plist`] } : {}),
  };
}

/** Pinned archives. Upgrading is a change here (SHA-256 from the release `checksums.txt`). */
export const CUA_PINS: Readonly<Record<CuaPlatform, PinnedArtifact>> = Object.freeze({
  "windows-x86_64": pin(
    "windows-x86_64",
    "997f20114ad3db227a854e1e5a886234f76405b155f4af70605d4b7ca4a436a1",
  ),
  "windows-arm64": pin(
    "windows-arm64",
    "c442872360cbb819e288b9f30daa7e3d2693d5945495d1400bcd90af5bd16402",
  ),
  "darwin-universal": pin(
    "darwin-universal",
    "121cf20cafd2cfa69dd720e8967350c6406b22e558be6889de7a1ae3343b6d4b",
  ),
  "linux-x86_64": pin(
    "linux-x86_64",
    "a305cbd531f94d6413c5db300c33df68e3adbe8b92b9604cf8e645c5f6cb1fa3",
  ),
  "linux-arm64": pin(
    "linux-arm64",
    "ed8a51125ade8807c7717c3dde13d62bd31e6275e6b5e2446cf018d0b01d93b3",
  ),
});

/** Preferences merged into the driver's config before its first run. */
export const CUA_PREFERENCES: Readonly<Record<string, unknown>> = Object.freeze({
  telemetry_enabled: false,
});

export const CUA_TELEMETRY_ENV = "CUA_DRIVER_RS_TELEMETRY_ENABLED";
export const CALL_TIMEOUT_MS = 120_000;
export const STATUS_TIMEOUT_MS = 15_000;
export const START_DEADLINE_MS = 10_000;
const START_POLL_MS = 250;

/** Arg keys whose string values are file paths in the caller's syntax. */
const PATH_ARG_KEYS = new Set([
  "screenshot_out_file",
  "output_dir",
  "path",
  "paths",
  "image_path",
  "file_path",
]);

export interface CuaDeps {
  /** HTTP fetch for the archive download. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Synchronous process runner for the driver, cmd.exe, powershell.exe, codesign and ditto. */
  spawnSync?: SpawnSyncFn;
  /** Detached background start (`serve` outside WSL). */
  spawnDetached?: SpawnDetachedFn;
  /** Pin table override (tests). Defaults to `CUA_PINS`. */
  pins?: Readonly<Record<CuaPlatform, PinnedArtifact>>;
  /** Process architecture used to pick the pin. Defaults to `process.arch`. */
  arch?: string;
  /** Base environment for driver runs. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** `%USERPROFILE%` as a Windows path (WSL reads it through cmd.exe). */
  windowsUserProfile?: (host: HostInfo) => string | undefined;
  /** Home directory on macOS and Linux. Defaults to `os.homedir()`. */
  home?: () => string;
  /** Where the macOS app bundle goes. Defaults to `/Applications`. */
  macApplicationsDir?: string;
  /** `wslpath <flag> <path>`; returns undefined when the conversion fails. */
  wslpath?: (flag: "-w" | "-u", path: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The pin key for this host, or undefined when no build covers it. */
export function cuaPlatform(host: HostInfo, arch: string): CuaPlatform | undefined {
  if (host.kind === "macos") return "darwin-universal";
  const mapped = archLabel(arch);
  if (!mapped) return undefined;
  if (host.kind === "windows" || host.kind === "wsl") return `windows-${mapped}`;
  if (host.kind === "linux") return `linux-${mapped}`;
  return undefined;
}

/** `CFBundleIdentifier` and `CFBundleShortVersionString` from an XML Info.plist. */
export function readBundleInfo(plistPath: string): { id?: string; version?: string } {
  let text: string;
  try {
    text = readFileSync(plistPath, "utf8");
  } catch {
    return {};
  }
  const value = (key: string): string | undefined =>
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1];
  const out: { id?: string; version?: string } = {};
  const id = value("CFBundleIdentifier");
  const version = value("CFBundleShortVersionString");
  if (id) out.id = id;
  if (version) out.version = version;
  return out;
}

/**
 * Convert Windows paths in path-like keys of a JSON result back to the
 * caller's syntax. Non-JSON or path-free output is returned unchanged.
 */
export function translateWindowsResultPaths(
  stdout: string,
  toCaller: (path: string) => string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  let changed = false;
  // Strip the Win32 extended-length prefixes a driver may return:
  // `\\?\UNC\host\share` -> `\\host\share`, `\\?\C:\x` -> `C:\x`.
  const unprefix = (value: string): string =>
    value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
  const isWindowsPath = (value: string): boolean =>
    /^[A-Za-z]:\\/.test(unprefix(value)) || /^\\\\wsl/i.test(unprefix(value));
  const isPathKey = (key: string): boolean =>
    key === "path" || key === "paths" || key.endsWith("_path") || key.endsWith("_file");
  const convert = (value: unknown): unknown => {
    if (typeof value !== "string" || !isWindowsPath(value)) return value;
    changed = true;
    return toCaller(unprefix(value));
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (isPathKey(key) && typeof value === "string") out[key] = convert(value);
      else if (isPathKey(key) && Array.isArray(value)) out[key] = value.map(convert);
      else out[key] = walk(value);
    }
    return out;
  };
  const result = walk(parsed);
  if (!changed) return stdout;
  const pretty = stdout.trim().includes("\n");
  const trailing = stdout.endsWith("\n") ? "\n" : "";
  return `${pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)}${trailing}`;
}

/** Create a Cua Driver adapter. Every side effect is injectable for tests. */
export function createCuaDriver(deps: CuaDeps = {}): DesktopDriver {
  const run = deps.spawnSync ?? defaultSpawnSync;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const baseEnv = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const home = deps.home ?? homedir;
  const applicationsDir = deps.macApplicationsDir ?? "/Applications";
  const appPath = posix.join(applicationsDir, CUA_APP_NAME);
  const appExecutable = posix.join(appPath, "Contents", "MacOS", "cua-driver");
  let userProfileCache: string | undefined;

  const windowsUserProfile =
    deps.windowsUserProfile ??
    ((host: HostInfo): string | undefined => {
      if (host.kind === "windows") return baseEnv().USERPROFILE?.trim() || undefined;
      const result = run(windowsExecutable("cmd.exe"), ["/c", "echo %USERPROFILE%"], {
        timeout: STATUS_TIMEOUT_MS,
        env: baseEnv(),
      });
      const value = normalize(result.stdout).trim();
      return result.status === 0 && /^[A-Za-z]:\\/.test(value) ? value : undefined;
    });

  const paths = wslPaths(deps.wslpath ?? defaultWslpath(run, baseEnv, STATUS_TIMEOUT_MS));

  function artifactFor(host: HostInfo): PinnedArtifact {
    const arch = deps.arch ?? process.arch;
    const platform = cuaPlatform(host, arch);
    if (!platform)
      throw new Error(
        `No pinned Cua Driver build for ${host.kind} on architecture ${arch}; supported: x64 (x86_64), arm64.`,
      );
    return (deps.pins ?? CUA_PINS)[platform];
  }

  function layout(host: HostInfo): { installDir: string; extracted: string; executable: string } {
    const stateDir = requireStateDir(host);
    const p = pathApi(host);
    const installDir = p.join(stateDir, "tools", "cua-driver", CUA_DRIVER_VERSION);
    const artifact = artifactFor(host);
    const extracted = p.join(installDir, ...artifact.executableEntry.split("/").slice(1));
    // On macOS the archive copy is staging; the driver runs from /Applications.
    const executable = host.kind === "macos" ? appExecutable : extracted;
    return { installDir, extracted, executable };
  }

  function preferenceFile(host: HostInfo): string {
    requireStateDir(host);
    if (host.kind === "macos" || host.kind === "linux")
      return posix.join(home(), ".cua-driver", "config.json");
    if (!userProfileCache) {
      const profile = windowsUserProfile(host);
      if (!profile)
        throw new Error(
          "Could not resolve the Windows user profile directory (%USERPROFILE%) for the driver's preference file.",
        );
      userProfileCache = profile;
    }
    if (host.kind === "windows") return win32.join(userProfileCache, ".cua-driver", "config.json");
    return posix.join(paths.toCaller(userProfileCache), ".cua-driver", "config.json");
  }

  /** The /Applications bundle is the pinned version from Cua. */
  function appCurrent(): boolean {
    const info = readBundleInfo(posix.join(appPath, "Contents", "Info.plist"));
    return (
      info.id === CUA_BUNDLE_ID && info.version === CUA_DRIVER_VERSION && existsSync(appExecutable)
    );
  }

  function installedExecutable(host: HostInfo): string | undefined {
    if (host.kind === "unsupported" || !host.desktopStateDir) return undefined;
    let artifact: PinnedArtifact;
    let where: ReturnType<typeof layout>;
    try {
      artifact = artifactFor(host);
      where = layout(host);
    } catch {
      return undefined;
    }
    if (!markerMatches(where.installDir, where.extracted, artifact, pathApi(host)))
      return undefined;
    if (host.kind === "macos" && !appCurrent()) return undefined;
    return existsSync(where.executable) ? where.executable : undefined;
  }

  function driverEnv(host: HostInfo): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv(), [CUA_TELEMETRY_ENV]: "0" };
    return host.kind === "wsl" ? withWslEnv(env, [CUA_TELEMETRY_ENV]) : env;
  }

  function requireExecutable(host: HostInfo): string {
    requireStateDir(host);
    const exe = installedExecutable(host);
    if (!exe)
      throw new Error(
        `Cua Driver ${CUA_DRIVER_VERSION} is not installed for this desktop; install it with the computer install command first.`,
      );
    return exe;
  }

  function exec(host: HostInfo, args: string[], timeout: number): DriverCallResult {
    const exe = requireExecutable(host);
    const result = run(exe, args, { timeout, env: driverEnv(host) });
    return toCallResult(`cua-driver ${args[0]}`, timeout, result);
  }

  function daemonStatus(host: HostInfo): DaemonStatus {
    const result = exec(host, ["status"], STATUS_TIMEOUT_MS);
    const text = result.stdout.trim() || result.stderr.trim();
    const detail = text.split("\n").slice(0, 3).join("\n");
    const running = result.exitCode === 0 && !/not running/i.test(result.stdout);
    const status: DaemonStatus = { running, detail };
    const pid = /pid:\s*(\d+)/i.exec(result.stdout);
    if (running && pid) status.pid = Number(pid[1]);
    return status;
  }

  function planInstall(host: HostInfo): InstallPlan {
    requireStateDir(host);
    const artifact = artifactFor(host);
    const { installDir, executable } = layout(host);
    const plan: InstallPlan = {
      driver: CUA_DRIVER_ID,
      version: CUA_DRIVER_VERSION,
      host: host.kind,
      artifact,
      installDir,
      executable,
      alreadyInstalled: installedExecutable(host) === executable,
      preferenceFile: preferenceFile(host),
      preferences: { ...CUA_PREFERENCES },
    };
    if (host.kind === "macos") {
      const existing = readBundleInfo(posix.join(appPath, "Contents", "Info.plist"));
      plan.steps = [
        `Verify the ${CUA_APP_NAME} signature (codesign --verify --deep --strict) and bundle id ${CUA_BUNDLE_ID}.`,
        existing.id
          ? `Replace ${appPath} (${existing.id} ${existing.version ?? "unknown version"}) with ${CUA_DRIVER_VERSION} unless it already matches.`
          : `Copy ${CUA_APP_NAME} to ${appPath}; macOS ties the driver's permission grants to that location.`,
      ];
      plan.setup = [
        "Starting the daemon opens System Settings: turn on CuaDriver under Privacy & Security > Accessibility " +
          "(Device Control and Data Access on macOS 27 and later) and > Screen Recording, then restart the daemon " +
          "(computer down, then computer up). A new grant can take about a minute to apply.",
      ];
    }
    if (host.kind === "linux")
      plan.setup = ["Run from the signed-in user's graphical session with at-spi2-core installed."];
    return plan;
  }

  function placeMacApp(plan: InstallPlan): void {
    const staged = posix.join(plan.installDir, CUA_APP_NAME);
    const verify = run("codesign", ["--verify", "--deep", "--strict", staged], {
      timeout: 60_000,
      env: baseEnv(),
    });
    if (verify.status !== 0)
      throw new Error(
        `${CUA_APP_NAME} failed signature verification; ${appPath} was not changed. ${normalize(
          verify.stderr || verify.error?.message || "",
        ).trim()}`.trim(),
      );
    const stagedInfo = readBundleInfo(posix.join(staged, "Contents", "Info.plist"));
    if (stagedInfo.id !== CUA_BUNDLE_ID)
      throw new Error(
        `Downloaded app has bundle id ${stagedInfo.id ?? "<missing>"}, not ${CUA_BUNDLE_ID}; ${appPath} was not changed.`,
      );
    if (appCurrent()) return;
    const existing = readBundleInfo(posix.join(appPath, "Contents", "Info.plist"));
    if (existsSync(appPath) && existing.id !== CUA_BUNDLE_ID)
      throw new Error(
        `${appPath} exists but is not Cua Driver (bundle id ${existing.id ?? "<missing>"}); move it aside, then retry.`,
      );
    const temp = posix.join(
      applicationsDir,
      `.${CUA_APP_NAME}.harnery-${randomBytes(4).toString("hex")}`,
    );
    const copy = run("ditto", [staged, temp], { timeout: 120_000, env: baseEnv() });
    if (copy.status !== 0) {
      rmSync(temp, { recursive: true, force: true });
      throw new Error(
        `Copying ${CUA_APP_NAME} to ${applicationsDir} failed: ${normalize(
          copy.stderr || copy.error?.message || "no output",
        ).trim()}`,
      );
    }
    if (existsSync(appPath)) rmSync(appPath, { recursive: true, force: true });
    renameSync(temp, appPath);
  }

  async function install(plan: InstallPlan): Promise<InstallResult> {
    if (plan.host === "unsupported")
      throw new Error("Computer use is not supported on this host; nothing to install.");
    const p = plan.host === "windows" ? win32 : posix;
    // Preferences go down before the binary can ever run, installed or not.
    if (plan.preferenceFile && plan.preferences)
      mergePreferences(plan.preferenceFile, plan.preferences, p);
    const extracted = await installPinnedArchive({
      artifact: plan.artifact,
      installDir: plan.installDir,
      p,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      now,
    });
    let appChanged = false;
    if (plan.host === "macos") {
      appChanged = !appCurrent();
      placeMacApp(plan);
    }
    const installed = extracted || appChanged;
    return { ...plan, alreadyInstalled: !installed, installed };
  }

  async function startDaemon(host: HostInfo): Promise<DaemonStatus> {
    const exe = requireExecutable(host);
    const current = daemonStatus(host);
    if (current.running) return current;
    const env = driverEnv(host);
    if (host.kind === "wsl") {
      const windowsExe = paths.toWindows(exe).replace(/'/g, "''");
      const command = `Start-Process -FilePath '${windowsExe}' -ArgumentList 'serve' -WindowStyle Hidden`;
      const result = run(windowsExecutable("powershell.exe"), ["-NoProfile", "-Command", command], {
        timeout: 30_000,
        env,
      });
      if (result.status !== 0)
        throw new Error(
          `Starting the driver daemon failed: ${normalize(
            result.stderr || result.stdout || result.error?.message || "no output",
          )
            .trim()
            .slice(0, 400)}`,
        );
    } else {
      (deps.spawnDetached ?? defaultSpawnDetached)(exe, ["serve"], env);
    }
    const deadline = now() + START_DEADLINE_MS;
    let status = current;
    while (now() < deadline) {
      await sleep(START_POLL_MS);
      status = daemonStatus(host);
      if (status.running) return status;
    }
    return status;
  }

  /** What to do when the daemon reports `permissions_pending`, for doctor and call. */
  function permissionsPendingHint(): string {
    return (
      `macOS has not yet granted Accessibility and Screen Recording to CuaDriver (${appPath}). ` +
      "Turn on CuaDriver under both in System Settings > Privacy & Security (Accessibility is named " +
      "Device Control and Data Access on macOS 27 and later), then restart the driver daemon (computer down, then computer up). " +
      "A new grant can take about a minute to apply."
    );
  }

  const isPermissionsPending = (result: DriverCallResult): boolean =>
    /permissions_pending/.test(result.stdout) || /permissions_pending/.test(result.stderr);

  function health(host: HostInfo): DriverCallResult {
    const result = exec(host, ["call", "health_report", "{}"], CALL_TIMEOUT_MS);
    if (result.json !== undefined) return result;
    const text = `${result.stdout}\n${result.stderr}`;
    let check: { name: string; status: string; message: string } | undefined;
    if (host.kind === "macos" && isPermissionsPending(result))
      check = { name: "tcc_permissions", status: "fail", message: permissionsPendingHint() };
    else if (/daemon is not running/i.test(text))
      check = {
        name: "daemon",
        status: "fail",
        message: "not running; start it with the computer up command",
      };
    if (!check) return result;
    const json = { checks: [check] };
    return { exitCode: 1, stdout: `${JSON.stringify(json)}\n`, stderr: "", json };
  }

  function call(host: HostInfo, tool: string, args: Record<string, unknown>): DriverCallResult {
    const result = exec(host, ["call", tool, JSON.stringify(args)], CALL_TIMEOUT_MS);
    if (host.kind === "macos" && isPermissionsPending(result))
      result.stderr += `${permissionsPendingHint()}\n`;
    return result;
  }

  function stopDaemon(host: HostInfo): DaemonStatus {
    exec(host, ["stop"], STATUS_TIMEOUT_MS);
    return daemonStatus(host);
  }

  function translateArgsPaths(
    host: HostInfo,
    _tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (host.kind !== "wsl") return args;
    const convert = (value: unknown): unknown =>
      typeof value === "string" && value.startsWith("/") ? paths.toWindows(value) : value;
    const out: Record<string, unknown> = { ...args };
    for (const [key, value] of Object.entries(args)) {
      if (!PATH_ARG_KEYS.has(key)) continue;
      out[key] = Array.isArray(value) ? value.map(convert) : convert(value);
    }
    return out;
  }

  return {
    id: CUA_DRIVER_ID,
    version: CUA_DRIVER_VERSION,
    summary:
      "tool calls with JSON arguments; accessibility, keyboard and pixel routes; screenshots; isolated browser control through CDP",
    hasDaemon: true,
    callTimeoutMs: CALL_TIMEOUT_MS,
    planInstall,
    install,
    installedExecutable,
    daemonStatus,
    startDaemon,
    stopDaemon,
    call,
    listTools: (host) => exec(host, ["list-tools"], CALL_TIMEOUT_MS),
    describe: (host, tool) => exec(host, ["describe", tool], CALL_TIMEOUT_MS),
    health,
    translateArgsPaths,
    translateResultPaths: (host, stdout) =>
      host.kind === "wsl" ? translateWindowsResultPaths(stdout, paths.toCaller) : stdout,
  };
}

export const cuaDriver: DesktopDriver = createCuaDriver();
