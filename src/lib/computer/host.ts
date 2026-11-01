/**
 * Host detection for `harn computer` (ADR 0228).
 *
 * Decides whose desktop this process can drive and where the state shared by
 * every caller of that desktop lives. Native Windows and WSL2 both drive the
 * Windows desktop and share `%LOCALAPPDATA%\harnery`; macOS uses
 * `~/Library/Application Support/harnery`; a Linux desktop uses
 * `$XDG_STATE_HOME/harnery` (default `~/.local/state/harnery`). ADR 0231.
 *
 * Internal module: not exported from package.json.
 */
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { isWSL } from "../browser/launch-args.ts";
import { windowsLocalAppData, windowsPathToWsl } from "../browser/windows-chrome.ts";
import type { HostInfo } from "./types.ts";

export interface HostDeps {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. Native Windows reads `LOCALAPPDATA` from it. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the shared WSL probe. Consulted only on Linux. */
  isWsl?: () => boolean;
  /** `%LOCALAPPDATA%` as a Windows path, read through interop. WSL only. */
  localAppData?: () => string | undefined;
  /** Defaults to `os.homedir()`. macOS and Linux only. */
  home?: () => string;
}

const LINUX_NO_SESSION_NOTE =
  "No graphical session found (DISPLAY and WAYLAND_DISPLAY are unset); run from the signed-in user's desktop session.";

let cached: HostInfo | undefined;

/**
 * Resolve the host. The default (no deps) result is cached for the life of
 * the process; injected deps always recompute.
 */
export function detectHost(deps?: HostDeps): HostInfo {
  if (!deps && cached) return cached;
  const result = resolveHost(deps ?? {});
  if (!deps) cached = result;
  return result;
}

/** Forget the cached default result (tests only). */
export function resetHostCache(): void {
  cached = undefined;
}

function resolveHost(deps: HostDeps): HostInfo {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData)
      return {
        kind: "unsupported",
        reason: "LOCALAPPDATA is not set, so the shared desktop state directory is unknown.",
      };
    return { kind: "windows", desktopStateDir: win32.join(localAppData, "harnery") };
  }
  if (platform === "linux" && (deps.isWsl ?? isWSL)()) {
    const localAppData = (deps.localAppData ?? windowsLocalAppData)();
    if (!localAppData)
      return {
        kind: "unsupported",
        reason:
          "Running under WSL, but %LOCALAPPDATA% could not be read through Windows interop (cmd.exe). Check that interop is enabled.",
      };
    let mounted: string;
    try {
      mounted = windowsPathToWsl(localAppData);
    } catch {
      return {
        kind: "unsupported",
        reason: `Running under WSL, but %LOCALAPPDATA% is not a drive-letter path: ${localAppData}`,
      };
    }
    return { kind: "wsl", desktopStateDir: `${mounted}/harnery` };
  }
  const home = (deps.home ?? homedir)();
  if (platform === "darwin") {
    if (!home) return { kind: "unsupported", reason: "The home directory is unknown." };
    return {
      kind: "macos",
      desktopStateDir: posix.join(home, "Library", "Application Support", "harnery"),
    };
  }
  if (platform === "linux") {
    const xdgState = env.XDG_STATE_HOME?.trim();
    const base = xdgState?.startsWith("/")
      ? xdgState
      : home
        ? posix.join(home, ".local", "state")
        : "";
    if (!base) return { kind: "unsupported", reason: "The home directory is unknown." };
    const graphical = Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
    return {
      kind: "linux",
      desktopStateDir: posix.join(base, "harnery"),
      ...(graphical ? {} : { note: LINUX_NO_SESSION_NOTE }),
    };
  }
  return {
    kind: "unsupported",
    reason: `Platform ${platform} is not supported for computer use (ADR 0231).`,
  };
}
