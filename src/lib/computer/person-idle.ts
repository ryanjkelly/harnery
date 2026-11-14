/**
 * How long the person at this desktop has gone without touching the keyboard
 * or mouse, and the wait `harn computer call` runs before a foreground action
 * (ADR 0248).
 *
 * A foreground action brings an agent's window to the front and sends real
 * keyboard and mouse input. While it runs, anything the person types lands in
 * the agent's window. So the command holds a foreground action until the
 * person's input has been quiet for a short period, and refuses it when they
 * stay busy past the wait limit.
 *
 * The reading comes from the operating system: `GetLastInputInfo` on Windows
 * (also from WSL, through interop), the HID idle time on macOS, and
 * `xprintidle` on an X11 Linux desktop when it is installed. The systems count
 * synthetic input as input too, so an agent's own foreground action restarts
 * the quiet period. A host with no reading reports `null`, and the caller
 * proceeds without waiting.
 *
 * Internal module: not exported from package.json.
 */
import { spawnSync } from "node:child_process";
import { windowsExecutable } from "../windows-executable.ts";
import { encodePowerShell } from "./confirm.ts";
import type { HostInfo } from "./types.ts";

/** Quiet period required before a foreground action when config sets none. */
export const DEFAULT_FOREGROUND_QUIET_SECONDS = 3;
/** How long to wait for that quiet period when config sets none. */
export const DEFAULT_FOREGROUND_WAIT_SECONDS = 60;

const PROBE_TIMEOUT_MS = 10_000;
/** Shortest sleep between two readings, so a reading that lags never spins. */
const MIN_SLEEP_MS = 100;

/**
 * Milliseconds since the last keyboard or mouse input in the signed-in
 * session. The tick counters are 32-bit and wrap about every 49.7 days, hence
 * the correction when the current tick is behind the last-input tick.
 */
const WINDOWS_IDLE_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -Namespace HarneryIdle -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
[DllImport("kernel32.dll")] public static extern uint GetTickCount();
'@
$info = New-Object HarneryIdle.Native+LASTINPUTINFO
$info.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($info)
if (-not [HarneryIdle.Native]::GetLastInputInfo([ref]$info)) { exit 3 }
$now = [uint64][HarneryIdle.Native]::GetTickCount()
$last = [uint64]$info.dwTime
if ($now -lt $last) { $now += 4294967296 }
Write-Output ($now - $last)
`;

export interface ProbeRun {
  status: number | null;
  stdout: string;
}

export interface PersonIdleDeps {
  /** Run one helper process; defaults to `spawnSync` with a timeout. */
  run?: (command: string, args: string[]) => ProbeRun;
  /** Defaults to `process.env`. Linux reads `DISPLAY` from it. */
  env?: NodeJS.ProcessEnv;
}

function defaultRun(command: string, args: string[]): ProbeRun {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
}

/** A whole number of milliseconds on a line of its own, else null. */
export function parseIdleMilliseconds(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (/^\d+$/.test(text)) return Number(text);
  }
  return null;
}

/** `"HIDIdleTime" = <nanoseconds>` from `ioreg -c IOHIDSystem`, in milliseconds. */
export function parseMacIdleMilliseconds(stdout: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
  return match ? Math.floor(Number(match[1]) / 1_000_000) : null;
}

/**
 * Milliseconds since the person last used the keyboard or mouse on this
 * desktop, or null when this host gives no reading (no helper, a Wayland
 * session, a failed probe). Null never blocks a call.
 */
export function probePersonIdleMs(host: HostInfo, deps: PersonIdleDeps = {}): number | null {
  const run = deps.run ?? defaultRun;
  try {
    if (host.kind === "windows" || host.kind === "wsl") {
      const result = run(windowsExecutable("powershell.exe"), [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodePowerShell(WINDOWS_IDLE_SCRIPT),
      ]);
      return result.status === 0 ? parseIdleMilliseconds(result.stdout) : null;
    }
    if (host.kind === "macos") {
      const result = run("ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
      return result.status === 0 ? parseMacIdleMilliseconds(result.stdout) : null;
    }
    if (host.kind === "linux") {
      if (!(deps.env ?? process.env).DISPLAY?.trim()) return null;
      const result = run("xprintidle", []);
      return result.status === 0 ? parseIdleMilliseconds(result.stdout) : null;
    }
  } catch {
    return null;
  }
  return null;
}

export interface QuietWaitOptions {
  /** How long the person's input must have been quiet. */
  quietMs: number;
  /** Longest time to wait for that. */
  maxWaitMs: number;
  /** Current idle reading in ms, or null when the host gives none. */
  probe: () => number | null | Promise<number | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface QuietWaitResult {
  /**
   * `quiet`: the person's input was quiet for the required period.
   * `busy`: the wait limit passed and they were still using the desktop.
   * `unknown`: this host gives no reading, so nothing was waited for.
   */
  status: "quiet" | "busy" | "unknown";
  waitedMs: number;
  /** The last reading taken; absent for `unknown`. */
  idleMs?: number;
}

/**
 * Wait until the person's keyboard and mouse have been quiet for `quietMs`.
 * Each sleep lasts exactly as long as the quiet period still needs, so a
 * person who stays away is read twice at most.
 */
export async function waitForQuietDesktop(options: QuietWaitOptions): Promise<QuietWaitResult> {
  const startedAt = options.now();
  for (;;) {
    const idleMs = await options.probe();
    const waitedMs = options.now() - startedAt;
    if (idleMs === null) return { status: "unknown", waitedMs };
    if (idleMs >= options.quietMs) return { status: "quiet", waitedMs, idleMs };
    const remainingMs = options.maxWaitMs - waitedMs;
    if (remainingMs <= 0) return { status: "busy", waitedMs, idleMs };
    await options.sleep(Math.max(MIN_SLEEP_MS, Math.min(options.quietMs - idleMs, remainingMs)));
  }
}
