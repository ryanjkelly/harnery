/**
 * Host detection for `harn computer` (ADR 0228).
 *
 * Decides whose desktop this process can drive and where the state shared by
 * every caller of that desktop lives (`%LOCALAPPDATA%\harnery`). Native
 * Windows and WSL2 both drive the Windows desktop; everything else is
 * unsupported for now.
 *
 * Internal module: not exported from package.json.
 */
import { win32 } from "node:path";
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
}

const MACOS_REASON =
  "macOS is not yet supported: its desktop driver needs an app bundle and accessibility and screen-recording grants (ADR 0228).";
const LINUX_REASON =
  "Linux desktops are not yet supported; computer use drives a Windows desktop from native Windows or WSL2 (ADR 0228).";

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
  if (platform === "darwin") return { kind: "unsupported", reason: MACOS_REASON };
  if (platform === "linux") return { kind: "unsupported", reason: LINUX_REASON };
  return {
    kind: "unsupported",
    reason: `Platform ${platform} is not supported for computer use (ADR 0228).`,
  };
}
