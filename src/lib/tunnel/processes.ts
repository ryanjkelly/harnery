// Process and port discovery for the tunnel commands, per platform.
//
// Linux and macOS have `pgrep`/`ps`; Linux has `ss`; both have `lsof`. Windows
// has none of these, so it uses PowerShell for command lines and `netstat` for
// listening sockets. Every probe is best effort: a missing tool yields "no
// answer" (null or an empty list), never a thrown error, and the callers fall
// back to checks that need no tool (a TCP connect probe, a PID check).

import { spawnSync } from "node:child_process";
import { connect } from "node:net";

type Run = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; missing: boolean };

const runTool: Run = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf-8", windowsHide: true, timeout: 15_000 });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  return { status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "", missing };
};

export interface ProcessRow {
  pid: number;
  command: string;
}

/** Parse `ps -axo pid=,command=` output (also the shape the PowerShell probe emits). */
export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.*\S)\s*$/);
    if (m) rows.push({ pid: Number(m[1]), command: m[2] as string });
  }
  return rows;
}

const POWERSHELL_PROCESS_LIST =
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | " +
  'ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }';

/** Every process with a command line, or null when the platform gives no way to list them. */
export function listProcesses(
  platform: NodeJS.Platform = process.platform,
  run: Run = runTool,
): ProcessRow[] | null {
  if (platform === "win32") {
    for (const shell of ["powershell.exe", "pwsh.exe", "pwsh"]) {
      const r = run(shell, ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PROCESS_LIST]);
      if (r.missing) continue;
      if (r.status === 0) return parseProcessRows(r.stdout);
    }
    return null;
  }
  const ps = run("ps", ["-axo", "pid=,command="]);
  return ps.status === 0 ? parseProcessRows(ps.stdout) : null;
}

/**
 * PIDs whose command line matches `pattern`, an extended regular expression
 * (the intersection of `pgrep -f` and JavaScript syntax). Returns [] when
 * nothing matches or no listing tool works.
 */
export function findPidsByCommandLine(
  pattern: string,
  platform: NodeJS.Platform = process.platform,
  run: Run = runTool,
): number[] {
  if (platform !== "win32") {
    const r = run("pgrep", ["-f", pattern]);
    if (!r.missing) {
      if (r.status !== 0) return [];
      return r.stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    }
  }
  const rows = listProcesses(platform, run);
  if (!rows) return [];
  const re = new RegExp(pattern);
  return rows.filter((row) => re.test(row.command)).map((row) => row.pid);
}

/** Ports from `ss -tlnH`: `LISTEN 0 4096 127.0.0.1:9001 0.0.0.0:*`. */
export function parseSsPorts(output: string): number[] {
  return [...output.matchAll(/:(\d+)\s/g)].map((m) => Number(m[1]));
}

/** Ports from `lsof -nP -iTCP -sTCP:LISTEN` rows ending `127.0.0.1:58055 (LISTEN)`. */
export function parseLsofPorts(output: string): number[] {
  return [...output.matchAll(/:(\d+) \(LISTEN\)\s*$/gm)].map((m) => Number(m[1]));
}

/** Ports from `netstat -ano -p TCP` rows: `TCP 0.0.0.0:9001 0.0.0.0:0 LISTENING 4`. */
export function parseNetstatPorts(output: string): number[] {
  return [...output.matchAll(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\b/gim)].map((m) =>
    Number(m[1]),
  );
}

/**
 * Ports with a LISTEN socket, or null when no discovery tool answered.
 *
 * Null is not "no ports": reporting every port as free would let a caller hand
 * out an occupied port, so callers that need a real answer use `portListening`,
 * which falls back to connecting.
 */
export function listeningPorts(
  platform: NodeJS.Platform = process.platform,
  run: Run = runTool,
): Set<number> | null {
  if (platform === "win32") {
    const r = run("netstat", ["-ano", "-p", "TCP"]);
    return !r.missing && r.status === 0 ? new Set(parseNetstatPorts(r.stdout)) : null;
  }
  if (platform === "linux") {
    const ss = run("ss", ["-tlnH"]);
    if (!ss.missing && ss.status === 0) return new Set(parseSsPorts(ss.stdout));
  }
  // macOS and BSD, or Linux without iproute2. lsof reports a failure when any
  // single process is unreadable while stdout still holds usable rows, so
  // judge it on the output.
  const lsof = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  if (!lsof.missing && lsof.stdout.trim()) return new Set(parseLsofPorts(lsof.stdout));
  return null;
}

/** True when something accepts a TCP connection on 127.0.0.1:<port>. */
export function connectProbe(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Whether `port` has a listener, by the platform tool when there is one, else by connecting. */
export async function portListening(port: number): Promise<boolean> {
  const ports = listeningPorts();
  return ports ? ports.has(port) : connectProbe(port);
}
