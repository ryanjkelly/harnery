/**
 * Finding the 1Password CLI and preparing its environment.
 *
 * On WSL the CLI with desktop-app integration is the Windows `op.exe`; on
 * macOS and Linux it is the native `op`. A host may install a forwarding
 * helper that gives the desktop approval prompt a stable name; `detectOp`
 * prefers it on WSL and macOS when the host's resolver reports one.
 */

import { readFileSync } from "node:fs";
import { runProcessSync, which as whichOnPath } from "./process.ts";
import type { BridgeResolver } from "./types.ts";

/** True when the Linux kernel reports a WSL build, even if WSL_* variables were dropped. */
export function isWslKernel(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return false;
  }
}

/** True when this process runs inside WSL. */
export function isWslRuntime(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  kernel: () => boolean = isWslKernel,
): boolean {
  return platform === "linux" && (Boolean(env.WSL_INTEROP || env.WSL_DISTRO_NAME) || kernel());
}

/** Trimmed stdout of a successful synchronous command, or null. */
function commandText(argv: string[]): string | null {
  const result = runProcessSync(argv);
  if (result.exitCode !== 0) return null;
  return result.stdout.replace(/\r/g, "").trim() || null;
}

/** Translate a Windows path to its WSL path with `wslpath -u`. */
export function windowsPathToWsl(value: string): string | null {
  return commandText(["wslpath", "-u", value.trim()]);
}

/**
 * Stdout of a successful `wslpath` call with only its final line ending
 * removed, so a filename's own leading or trailing spaces survive.
 */
function exactPathOutput(argv: string[]): string | null {
  const result = runProcessSync(argv);
  if (result.exitCode !== 0) return null;
  return result.stdout.replace(/\r?\n$/, "") || null;
}

/** Translate a WSL path to its Windows path with `wslpath -w`, keeping every character of the name. */
export function wslPathToWindows(value: string): string | null {
  return exactPathOutput(["wslpath", "-w", value]);
}

/**
 * The Windows form of a WSL path, or null unless translating it back with
 * `wslpath -u` yields exactly the same path. Use it before handing a checked
 * destination to a Windows program, so the file written is the file checked.
 */
export function wslPathToWindowsVerified(value: string): string | null {
  const windows = wslPathToWindows(value);
  if (!windows) return null;
  return exactPathOutput(["wslpath", "-u", windows]) === value ? windows : null;
}

/**
 * Ask Windows `where.exe` for `op.exe` when the WSL PATH is Linux-only, as in
 * a sandboxed agent shell. Windows interop still works there, but a PATH
 * lookup cannot see the Windows install location.
 */
export function locateWindowsOpFromWsl(): string | null {
  const whereExe = windowsPathToWsl("C:\\Windows\\System32\\where.exe");
  if (!whereExe) return null;
  const out = commandText([whereExe, "op.exe"]);
  const first = out
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ? windowsPathToWsl(first) : null;
}

/**
 * The Windows `%LOCALAPPDATA%` folder seen from WSL, as both a Windows and a
 * WSL path, or null outside WSL. Hosts use it to place a Windows helper.
 */
export function windowsLocalAppData(
  overrides: {
    wsl?: boolean;
    which?: (binary: string) => string | null;
    run?: (argv: string[]) => string | null;
  } = {},
): { win: string; wsl: string } | null {
  if (!(overrides.wsl ?? isWslRuntime())) return null;
  const run = overrides.run ?? commandText;
  const which = overrides.which ?? ((binary: string) => whichOnPath(binary) ?? null);
  const cmd = which("cmd.exe") ?? run(["wslpath", "-u", "C:\\Windows\\System32\\cmd.exe"]);
  if (!cmd) return null;
  const win = run([cmd, "/c", "echo %LOCALAPPDATA%"]);
  if (!win?.includes(":\\")) return null;
  const wsl = run(["wslpath", "-u", win]);
  if (!wsl) return null;
  return { win, wsl };
}

/** Injectable platform facts, for deterministic tests. */
export interface OpDetectionRuntime {
  env: Record<string, string | undefined>;
  platform: string;
  which: (binary: string) => string | null;
  locateWindowsOp: () => string | null;
  locateBridge: BridgeResolver;
  wslKernel: () => boolean;
}

/**
 * Resolve the 1Password CLI binary.
 *
 * Precedence: `$OP_BIN`; on WSL the host helper, then `op.exe` on PATH, then
 * `op.exe` found through Windows; on native Windows `op.exe`; on macOS the
 * host helper; then native `op`; then `op.exe` as a last resort.
 */
export function detectOp(overrides: Partial<OpDetectionRuntime> = {}): string | null {
  const runtime: OpDetectionRuntime = {
    env: overrides.env ?? process.env,
    platform: overrides.platform ?? process.platform,
    which: overrides.which ?? ((binary) => whichOnPath(binary) ?? null),
    locateWindowsOp: overrides.locateWindowsOp ?? locateWindowsOpFromWsl,
    locateBridge: overrides.locateBridge ?? (() => null),
    wslKernel: overrides.wslKernel ?? isWslKernel,
  };

  if (runtime.env.OP_BIN) return runtime.env.OP_BIN;

  if (isWslRuntime(runtime.env, runtime.platform, runtime.wslKernel)) {
    const bridge = runtime.locateBridge();
    if (bridge) return bridge;
    if (runtime.which("op.exe")) return "op.exe";
    const windowsOp = runtime.locateWindowsOp();
    if (windowsOp) return windowsOp;
  } else if (runtime.platform === "win32" && runtime.which("op.exe")) {
    return "op.exe";
  } else if (runtime.platform === "darwin") {
    const bridge = runtime.locateBridge();
    if (bridge) return bridge;
  }

  if (runtime.which("op")) return "op";
  if (runtime.which("op.exe")) return "op.exe";
  return null;
}

/** True when the resolved binary is a Windows executable (op.exe or a helper). */
export function isWindowsOp(op: string): boolean {
  return /\.exe$/i.test(op);
}

/**
 * Environment for an `op` subprocess. On macOS, a subprocess with redirected
 * stdin can report no configured accounts unless desktop integration is
 * enabled explicitly. An explicit setting, or service-account, Connect, or
 * manual-session authentication, is left as given.
 */
export function opEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): NodeJS.ProcessEnv {
  if (
    platform !== "darwin" ||
    env.OP_BIOMETRIC_UNLOCK_ENABLED !== undefined ||
    env.OP_SERVICE_ACCOUNT_TOKEN ||
    env.OP_CONNECT_HOST ||
    env.OP_CONNECT_TOKEN ||
    Object.keys(env).some((key) => key.startsWith("OP_SESSION") && env[key])
  ) {
    return { ...env };
  }
  return { ...env, OP_BIOMETRIC_UNLOCK_ENABLED: "true" };
}
