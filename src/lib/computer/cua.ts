/**
 * Cua Driver adapter for `harn computer` (ADR 0228).
 *
 * Everything specific to this driver lives here: the pinned release and its
 * archive hashes, the archive layout, the driver's preference file, and the
 * `call` / `list-tools` / `describe` / `status` / `serve` / `stop` arguments.
 * The command layer and the desktop lease see only `DesktopDriver`.
 *
 * Under WSL the Windows build runs through interop: the `/mnt/<drive>/...`
 * executable is spawned directly, environment variables cross through
 * `WSLENV`, and file paths in tool arguments and results are translated with
 * `wslpath`.
 *
 * Internal module: not exported from package.json.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import { windowsPathToWsl, wslPathToWindows } from "../browser/windows-chrome.ts";
import { extractZip, listZip, type ZipLimits } from "../zip/index.ts";
import type {
  DaemonStatus,
  DesktopDriver,
  DriverCallResult,
  HostInfo,
  InstallPlan,
  InstallResult,
  PinnedArtifact,
} from "./types.ts";

export const CUA_DRIVER_ID = "cua";
export const CUA_DRIVER_VERSION = "0.38.0";

const RELEASE_BASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}`;

/** Windows-side architectures with a pinned build. */
export type CuaArch = "x86_64" | "arm64";

function pin(arch: CuaArch, sha256: string): PinnedArtifact {
  const stem = `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-${arch}`;
  return {
    version: CUA_DRIVER_VERSION,
    fileName: `${stem}.zip`,
    url: `${RELEASE_BASE}/${stem}.zip`,
    sha256,
    executableEntry: `${stem}/cua-driver.exe`,
  };
}

/** Pinned archives keyed by `windows-<arch>`. Upgrading is a change here. */
export const CUA_PINS: Readonly<Record<`windows-${CuaArch}`, PinnedArtifact>> = Object.freeze({
  "windows-x86_64": pin(
    "x86_64",
    "997f20114ad3db227a854e1e5a886234f76405b155f4af70605d4b7ca4a436a1",
  ),
  "windows-arm64": pin("arm64", "c442872360cbb819e288b9f30daa7e3d2693d5945495d1400bcd90af5bd16402"),
});

/** Preferences merged into the driver's config before its first run. */
export const CUA_PREFERENCES: Readonly<Record<string, unknown>> = Object.freeze({
  telemetry_enabled: false,
});

export const CUA_TELEMETRY_ENV = "CUA_DRIVER_RS_TELEMETRY_ENABLED";
export const INSTALL_MARKER = ".harnery-install.json";
export const CALL_TIMEOUT_MS = 120_000;
export const STATUS_TIMEOUT_MS = 15_000;
export const START_DEADLINE_MS = 10_000;
const START_POLL_MS = 250;

/** The release's executables are tens of MB each; allow headroom over the defaults. */
const ARCHIVE_LIMITS: Partial<ZipLimits> = {
  archiveBytes: 256 * 1024 * 1024,
  entryBytes: 128 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
};

/** Arg keys whose string values are file paths in the caller's syntax. */
const PATH_ARG_KEYS = new Set([
  "screenshot_out_file",
  "output_dir",
  "path",
  "paths",
  "image_path",
  "file_path",
]);

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type SpawnSyncFn = (
  command: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => SpawnResult;

export interface CuaDeps {
  /** HTTP fetch for the archive download. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Synchronous process runner for the driver, cmd.exe and powershell.exe. */
  spawnSync?: SpawnSyncFn;
  /** Detached background start (native Windows `serve`). */
  spawnDetached?: (command: string, args: string[], env: NodeJS.ProcessEnv) => void;
  /** Pin table override (tests). Defaults to `CUA_PINS`. */
  pins?: Readonly<Record<`windows-${CuaArch}`, PinnedArtifact>>;
  /** Process architecture used to pick the pin. Defaults to `process.arch`. */
  arch?: string;
  /** Base environment for driver runs. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** `%USERPROFILE%` as a Windows path (WSL reads it through cmd.exe). */
  windowsUserProfile?: (host: HostInfo) => string | undefined;
  /** `wslpath <flag> <path>`; returns undefined when the conversion fails. */
  wslpath?: (flag: "-w" | "-u", path: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface InstallMarker {
  version: string;
  sha256: string;
  installed_at: string;
}

function pathApi(host: HostInfo): typeof posix {
  return host.kind === "windows" ? win32 : posix;
}

function requireSupported(host: HostInfo): string {
  if (host.kind === "unsupported" || !host.desktopStateDir)
    throw new Error(
      `Computer use is not supported on this host: ${host.reason ?? "no shared desktop state directory"}`,
    );
  return host.desktopStateDir;
}

/** Map a process architecture onto a pinned Windows build. */
export function cuaArch(arch: string): CuaArch | undefined {
  if (arch === "x64" || arch === "x86_64" || arch === "amd64") return "x86_64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  return undefined;
}

function normalize(text: string | undefined): string {
  return (text ?? "").replace(/\r\n?/g, "\n");
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

const defaultSpawnSync: SpawnSyncFn = (command, args, options) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout,
    env: options.env,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
};

const defaultSpawnDetached = (command: string, args: string[], env: NodeJS.ProcessEnv): void => {
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
};

/** Create a Cua Driver adapter. Every side effect is injectable for tests. */
export function createCuaDriver(deps: CuaDeps = {}): DesktopDriver {
  const run = deps.spawnSync ?? defaultSpawnSync;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const baseEnv = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  let userProfileCache: string | undefined;

  const windowsUserProfile =
    deps.windowsUserProfile ??
    ((host: HostInfo): string | undefined => {
      if (host.kind === "windows") return baseEnv().USERPROFILE?.trim() || undefined;
      const result = run("cmd.exe", ["/c", "echo %USERPROFILE%"], {
        timeout: STATUS_TIMEOUT_MS,
        env: baseEnv(),
      });
      const value = normalize(result.stdout).trim();
      return result.status === 0 && /^[A-Za-z]:\\/.test(value) ? value : undefined;
    });

  const wslpath =
    deps.wslpath ??
    ((flag: "-w" | "-u", path: string): string | undefined => {
      const result = run("wslpath", [flag, path], { timeout: STATUS_TIMEOUT_MS, env: baseEnv() });
      const value = normalize(result.stdout).trim();
      return result.status === 0 && value ? value : undefined;
    });

  function artifactFor(): PinnedArtifact {
    const arch = deps.arch ?? process.arch;
    const mapped = cuaArch(arch);
    if (!mapped)
      throw new Error(
        `No pinned Cua Driver build for architecture ${arch}; supported: x64 (x86_64), arm64.`,
      );
    return (deps.pins ?? CUA_PINS)[`windows-${mapped}`];
  }

  function paths(host: HostInfo): { installDir: string; executable: string } {
    const stateDir = requireSupported(host);
    const p = pathApi(host);
    const installDir = p.join(stateDir, "tools", "cua-driver", CUA_DRIVER_VERSION);
    return { installDir, executable: p.join(installDir, "cua-driver.exe") };
  }

  function preferenceFile(host: HostInfo): string {
    requireSupported(host);
    if (!userProfileCache) {
      const profile = windowsUserProfile(host);
      if (!profile)
        throw new Error(
          "Could not resolve the Windows user profile directory (%USERPROFILE%) for the driver's preference file.",
        );
      userProfileCache = profile;
    }
    if (host.kind === "windows") return win32.join(userProfileCache, ".cua-driver", "config.json");
    return posix.join(windowsPathToWsl(userProfileCache), ".cua-driver", "config.json");
  }

  function readMarker(installDir: string, p: typeof posix): InstallMarker | undefined {
    try {
      return JSON.parse(readFileSync(p.join(installDir, INSTALL_MARKER), "utf8")) as InstallMarker;
    } catch {
      return undefined;
    }
  }

  function installedExecutable(host: HostInfo): string | undefined {
    if (host.kind === "unsupported" || !host.desktopStateDir) return undefined;
    let artifact: PinnedArtifact;
    try {
      artifact = artifactFor();
    } catch {
      return undefined;
    }
    const { installDir, executable } = paths(host);
    const marker = readMarker(installDir, pathApi(host));
    if (!marker || marker.version !== artifact.version || marker.sha256 !== artifact.sha256)
      return undefined;
    return existsSync(executable) ? executable : undefined;
  }

  function driverEnv(host: HostInfo): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv(), [CUA_TELEMETRY_ENV]: "0" };
    if (host.kind === "wsl") {
      const entries = (env.WSLENV ?? "").split(":").filter(Boolean);
      if (!entries.some((entry) => entry.split("/")[0] === CUA_TELEMETRY_ENV))
        entries.push(CUA_TELEMETRY_ENV);
      env.WSLENV = entries.join(":");
    }
    return env;
  }

  function requireExecutable(host: HostInfo): string {
    requireSupported(host);
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
    const stdout = normalize(result.stdout);
    let stderr = normalize(result.stderr);
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      const note =
        code === "ETIMEDOUT"
          ? `cua-driver ${args[0]} timed out after ${Math.round(timeout / 1000)}s`
          : `cua-driver ${args[0]} failed to run: ${result.error.message}`;
      stderr = stderr ? `${stderr.replace(/\n$/, "")}\n${note}\n` : `${note}\n`;
    }
    const out: DriverCallResult = {
      exitCode: result.status ?? (result.error ? -1 : 1),
      stdout,
      stderr,
    };
    const json = parseJson(stdout);
    if (json !== undefined) out.json = json;
    return out;
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
    requireSupported(host);
    const artifact = artifactFor();
    const { installDir, executable } = paths(host);
    return {
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
  }

  function mergePreferences(file: string, preferences: Record<string, unknown>, p: typeof posix) {
    let existing: Record<string, unknown> = {};
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
      if (raw.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(
            `Driver preference file ${file} is not valid JSON; fix or remove it, then retry.`,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error(`Driver preference file ${file} is not a JSON object.`);
        existing = parsed as Record<string, unknown>;
      }
    }
    const merged = { ...existing, ...preferences };
    mkdirSync(p.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`);
    renameSync(temp, file);
  }

  async function download(url: string): Promise<Uint8Array> {
    const fetchFn = deps.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchFn(url, { redirect: "follow" });
    } catch (error) {
      throw new Error(
        `Downloading ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function install(plan: InstallPlan): Promise<InstallResult> {
    if (plan.host === "unsupported")
      throw new Error("Computer use is not supported on this host; nothing to install.");
    const p = plan.host === "windows" ? win32 : posix;
    const artifact = plan.artifact;
    const markerOk = (): boolean => {
      const marker = readMarker(plan.installDir, p);
      return (
        !!marker &&
        marker.version === artifact.version &&
        marker.sha256 === artifact.sha256 &&
        existsSync(plan.executable)
      );
    };
    // Preferences go down before the binary can ever run, installed or not.
    mergePreferences(plan.preferenceFile, plan.preferences, p);
    if (markerOk()) return { ...plan, alreadyInstalled: true, installed: false };

    const bytes = await download(artifact.url);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== artifact.sha256.toLowerCase())
      throw new Error(
        `Refusing ${artifact.fileName}: SHA-256 ${actual} does not match the pinned ${artifact.sha256}. Nothing was installed.`,
      );

    const parent = p.dirname(plan.installDir);
    mkdirSync(parent, { recursive: true });
    const tag = `${process.pid}-${randomBytes(4).toString("hex")}`;
    const archive = p.join(parent, `.download-${tag}.zip`);
    const stage = p.join(parent, `.stage-${tag}`);
    try {
      writeFileSync(archive, bytes);
      const topDir = artifact.executableEntry.split("/")[0] as string;
      const entries = listZip(archive, { limits: ARCHIVE_LIMITS });
      const stray = entries.find((entry) => !entry.name.startsWith(`${topDir}/`));
      if (stray) throw new Error(`Unexpected entry outside ${topDir}/ in archive: ${stray.name}`);
      if (!entries.some((entry) => entry.name === artifact.executableEntry))
        throw new Error(`Archive lacks ${artifact.executableEntry}.`);
      extractZip(archive, stage, { limits: ARCHIVE_LIMITS });
      const extracted = p.join(stage, topDir);
      if (!statSync(extracted).isDirectory()) throw new Error(`Archive lacks ${topDir}/.`);
      const marker: InstallMarker = {
        version: artifact.version,
        sha256: artifact.sha256,
        installed_at: new Date(now()).toISOString(),
      };
      writeFileSync(p.join(extracted, INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
      // A versioned dir without a matching marker is a broken earlier attempt.
      if (existsSync(plan.installDir)) rmSync(plan.installDir, { recursive: true, force: true });
      renameSync(extracted, plan.installDir);
    } finally {
      rmSync(archive, { force: true });
      rmSync(stage, { recursive: true, force: true });
    }
    return { ...plan, alreadyInstalled: false, installed: true };
  }

  async function startDaemon(host: HostInfo): Promise<DaemonStatus> {
    const exe = requireExecutable(host);
    const current = daemonStatus(host);
    if (current.running) return current;
    const env = driverEnv(host);
    if (host.kind === "wsl") {
      const windowsExe = toWindows(exe).replace(/'/g, "''");
      const command = `Start-Process -FilePath '${windowsExe}' -ArgumentList 'serve' -WindowStyle Hidden`;
      const result = run("powershell.exe", ["-NoProfile", "-Command", command], {
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

  function stopDaemon(host: HostInfo): DaemonStatus {
    exec(host, ["stop"], STATUS_TIMEOUT_MS);
    return daemonStatus(host);
  }

  function toWindows(path: string): string {
    const converted = wslpath("-w", path);
    if (converted) return converted;
    if (/^\/mnt\/[a-z]\//.test(path)) return wslPathToWindows(path);
    // wslpath can refuse a path that does not exist yet (an output file).
    const dir = posix.dirname(path);
    const parent = dir !== path ? wslpath("-w", dir) : undefined;
    return parent ? `${parent.replace(/\\$/, "")}\\${posix.basename(path)}` : path;
  }

  function toCaller(path: string): string {
    const converted = wslpath("-u", path);
    if (converted) return converted;
    try {
      return windowsPathToWsl(path);
    } catch {
      return path;
    }
  }

  function translateArgsPaths(
    host: HostInfo,
    _tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (host.kind !== "wsl") return args;
    const convert = (value: unknown): unknown =>
      typeof value === "string" && value.startsWith("/") ? toWindows(value) : value;
    const out: Record<string, unknown> = { ...args };
    for (const [key, value] of Object.entries(args)) {
      if (!PATH_ARG_KEYS.has(key)) continue;
      out[key] = Array.isArray(value) ? value.map(convert) : convert(value);
    }
    return out;
  }

  function translateResultPaths(host: HostInfo, stdout: string): string {
    if (host.kind !== "wsl") return stdout;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return stdout;
    }
    let changed = false;
    // Strip the Win32 extended-length prefixes the driver may return:
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

  return {
    id: CUA_DRIVER_ID,
    version: CUA_DRIVER_VERSION,
    planInstall,
    install,
    installedExecutable,
    daemonStatus,
    startDaemon,
    stopDaemon,
    call: (host, tool, args) => exec(host, ["call", tool, JSON.stringify(args)], CALL_TIMEOUT_MS),
    listTools: (host) => exec(host, ["list-tools"], CALL_TIMEOUT_MS),
    describe: (host, tool) => exec(host, ["describe", tool], CALL_TIMEOUT_MS),
    health: (host) => exec(host, ["call", "health_report", "{}"], CALL_TIMEOUT_MS),
    translateArgsPaths,
    translateResultPaths,
  };
}

export const cuaDriver: DesktopDriver = createCuaDriver();
