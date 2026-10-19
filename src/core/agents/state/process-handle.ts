import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import type { ProcessGenerationVerdict } from "./proc-start.ts";

export interface ProcessHandleSignalResult {
  sent: boolean;
  verdict: ProcessGenerationVerdict;
}

interface NativeHelperResult extends ProcessHandleSignalResult {
  token?: string;
}

export type NativeProcessHelperRunner = (
  command: string,
  args: string[],
  options: {
    input: string;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
) => { status: number | null; stdout: string | Buffer | null; error?: Error };

// The helper owns the descriptor throughout observation and effect. The second
// input line authorizes the effect; EOF releases the handle without signaling.
export const LINUX_PROCESS_HANDLE_SCRIPT = `
import json, os, pathlib, signal, sys
result = {"sent": False, "verdict": "unknown"}
fd = None
try:
    request = json.loads(sys.stdin.readline())
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("pidfd support unavailable")
    fd = os.pidfd_open(request["pid"])
    stat = pathlib.Path("/proc/%d/stat" % request["pid"]).read_text()
    ticks = stat[stat.rfind(") ") + 2:].split()[19]
    boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip().replace("-", "")[:8]
    token = "l%s.%s" % (boot, ticks)
    result["token"] = token
    recorded = request.get("token")
    result["verdict"] = "same" if token == recorded else "different"
    if request["mode"] == "signal" and result["verdict"] == "same":
        print(json.dumps({"phase": "verified"}), flush=True)
        if sys.stdin.readline().strip() == "signal":
            signal.pidfd_send_signal(fd, request["signal"])
            result["sent"] = True
except Exception:
    pass
finally:
    if fd is not None:
        os.close(fd)
print(json.dumps(result), flush=True)
`;

export const WINDOWS_PROCESS_HANDLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$result = @{ sent = $false; verdict = 'unknown' }
$handle = [IntPtr]::Zero
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HarneryProcessHandle {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle, uint exitCode);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  $access = [uint32]0x101000
  if ($request.mode -eq 'signal') { $access = $access -bor 1 }
  $handle = [HarneryProcessHandle]::OpenProcess($access, $false, [uint32]$request.pid)
  if ($handle -eq [IntPtr]::Zero) { throw 'process handle unavailable' }
  [long]$creation = 0; [long]$exitTime = 0; [long]$kernel = 0; [long]$userTime = 0
  if (-not [HarneryProcessHandle]::GetProcessTimes($handle, [ref]$creation, [ref]$exitTime, [ref]$kernel, [ref]$userTime)) { throw 'process time unavailable' }
  $token = 'w' + $creation.ToString([Globalization.CultureInfo]::InvariantCulture)
  $result.token = $token
  $result.verdict = if ($token -ceq $request.token) { 'same' } else { 'different' }
  if ($request.mode -eq 'signal' -and $result.verdict -eq 'same') {
    [Console]::Out.WriteLine('{"phase":"verified"}')
    [Console]::Out.Flush()
    if ([Console]::In.ReadLine() -eq 'signal' -and [HarneryProcessHandle]::WaitForSingleObject($handle, 0) -eq 258) {
      $result.sent = [HarneryProcessHandle]::TerminateProcess($handle, 1)
    }
  }
} catch {} finally {
  if ($handle -ne [IntPtr]::Zero) { [void][HarneryProcessHandle]::CloseHandle($handle) }
}
$result | ConvertTo-Json -Compress
`;

function runHelper(
  request: { mode: "probe" | "signal"; pid: number; token?: string; signal?: number },
  platform: NodeJS.Platform,
  run: NativeProcessHelperRunner,
): NativeHelperResult {
  const unknown = { sent: false, verdict: "unknown" } as const;
  if (!Number.isInteger(request.pid) || request.pid <= 0) return unknown;
  if (platform !== "linux" && platform !== "win32") return unknown;
  try {
    const command = platform === "linux" ? "python3" : "powershell.exe";
    const args =
      platform === "linux"
        ? ["-I", "-c", LINUX_PROCESS_HANDLE_SCRIPT]
        : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_HANDLE_SCRIPT];
    const output = run(command, args, {
      input: `${JSON.stringify(request)}\nsignal\n`,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    if (output.error || output.status !== 0) return unknown;
    const lines = String(output.stdout ?? "")
      .trim()
      .split(/\r?\n/);
    const parsed = JSON.parse(lines.at(-1) ?? "") as NativeHelperResult;
    if (
      typeof parsed.sent !== "boolean" ||
      !["same", "different", "unknown"].includes(parsed.verdict) ||
      (parsed.sent && parsed.verdict !== "same")
    )
      return unknown;
    return parsed;
  } catch {
    return unknown;
  }
}

/** Windows creation FILETIME, read from an OpenProcess handle. */
export function windowsProcessStartToken(
  pid: number,
  run: NativeProcessHelperRunner = spawnSync,
): string | null {
  const result = runHelper({ mode: "probe", pid }, "win32", run);
  return typeof result.token === "string" && /^w\d+$/.test(result.token) ? result.token : null;
}

/** No numeric-PID signaling fallback is permitted when an exact handle fails. */
export function signalProcessWithHandle(
  pid: number,
  recordedToken: string,
  signal: NodeJS.Signals | number,
  options: { platform?: NodeJS.Platform; run?: NativeProcessHelperRunner } = {},
): ProcessHandleSignalResult {
  const platform = options.platform ?? process.platform;
  const number = typeof signal === "number" ? signal : constants.signals[signal];
  if (
    !Number.isInteger(number) ||
    number <= 0 ||
    (platform === "linux" && !/^l[0-9a-f]{8}\.\d+$/.test(recordedToken)) ||
    (platform === "win32" && (!/^w\d+$/.test(recordedToken) || ![9, 15].includes(number)))
  )
    return { sent: false, verdict: "unknown" };
  const result = runHelper(
    { mode: "signal", pid, token: recordedToken, signal: number },
    platform,
    options.run ?? spawnSync,
  );
  return { sent: result.sent, verdict: result.verdict };
}
