/**
 * Local socket and process observation for the server registry.
 *
 * Linux reads procfs directly (no `ss`/`lsof` dependency, works under WSL).
 * macOS shells out to `lsof` and `ps`. Other platforms report `unsupported`
 * so callers can say the scan did not run rather than implying it found
 * nothing.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export type ScanSupport = "procfs" | "lsof" | "unsupported";

export interface ListeningSocket {
  pid: number;
  port: number;
  address: string;
}

export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  command: string;
  cwd: string | null;
}

export function scanSupport(): ScanSupport {
  if (process.platform === "linux") return "procfs";
  if (process.platform === "darwin") return "lsof";
  return "unsupported";
}

interface ProcSocketRow {
  localAddress: string;
  localPort: number;
  state: string;
  inode: string;
}

/** Parse `/proc/net/tcp` or `/proc/net/tcp6` content. */
export function parseProcNetTcp(content: string): ProcSocketRow[] {
  const rows: ProcSocketRow[] = [];
  for (const line of content.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const [address, portHex] = (fields[1] ?? "").split(":");
    if (!address || !portHex) continue;
    rows.push({
      localAddress: decodeProcAddress(address),
      localPort: Number.parseInt(portHex, 16),
      state: fields[3] ?? "",
      inode: fields[9] ?? "",
    });
  }
  return rows;
}

function decodeProcAddress(hex: string): string {
  if (hex.length === 8) {
    const bytes = hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
    return bytes.reverse().join(".");
  }
  if (/^0+$/.test(hex)) return "::";
  if (hex === "00000000000000000000000001000000") return "::1";
  if (hex.startsWith("0000000000000000FFFF0000")) return decodeProcAddress(hex.slice(24));
  return `ipv6:${hex.toLowerCase()}`;
}

function readProcSockets(): ProcSocketRow[] {
  const rows: ProcSocketRow[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      rows.push(...parseProcNetTcp(readFileSync(file, "utf8")));
    } catch {
      // tcp6 is absent on IPv6-disabled kernels.
    }
  }
  return rows;
}

/** Map socket inodes to the pids holding them (only processes we may read). */
function socketOwners(inodes: Set<string>): Map<string, number> {
  const owners = new Map<string, number>();
  if (inodes.size === 0) return owners;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return owners;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match?.[1] && inodes.has(match[1]) && !owners.has(match[1])) {
        owners.set(match[1], Number(entry));
      }
    }
    if (owners.size === inodes.size) break;
  }
  return owners;
}

/** Listening TCP sockets whose owning process this user can see. */
export function listListeningSockets(): ListeningSocket[] {
  const support = scanSupport();
  if (support === "procfs") {
    const listening = readProcSockets().filter((row) => row.state === "0A");
    const owners = socketOwners(new Set(listening.map((row) => row.inode)));
    const seen = new Set<string>();
    const sockets: ListeningSocket[] = [];
    for (const row of listening) {
      const pid = owners.get(row.inode);
      if (!pid) continue;
      const key = `${pid}:${row.localPort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sockets.push({ pid, port: row.localPort, address: row.localAddress });
    }
    return sockets.sort((a, b) => a.port - b.port);
  }
  if (support === "lsof")
    return parseLsofListen(run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  return [];
}

/** Parse `lsof -Fpn` output for listening sockets. */
export function parseLsofListen(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  const seen = new Set<string>();
  let pid = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) {
      const match = /^(.*):(\d+)$/.exec(line.slice(1));
      if (!match?.[2]) continue;
      const port = Number(match[2]);
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sockets.push({ pid, port, address: (match[1] ?? "").replace(/^\[|\]$/g, "") });
    }
  }
  return sockets.sort((a, b) => a.port - b.port);
}

/**
 * Count established server-side connections per local port. A browser tab
 * holding a live-reload socket or keep-alive connection counts as activity.
 */
export function establishedConnectionCounts(ports: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  const wanted = new Set(ports.filter((port) => Number.isInteger(port) && port > 0));
  if (wanted.size === 0) return counts;
  const support = scanSupport();
  if (support === "procfs") {
    for (const row of readProcSockets()) {
      // 01 ESTABLISHED; 03 SYN_RECV, where a deferred-accept server parks a
      // connected client until its first bytes arrive.
      if ((row.state !== "01" && row.state !== "03") || !wanted.has(row.localPort)) continue;
      counts.set(row.localPort, (counts.get(row.localPort) ?? 0) + 1);
    }
    return counts;
  }
  if (support === "lsof") {
    const output = run("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fn"]);
    for (const line of output.split("\n")) {
      const match = /^n.*?:(\d+)->/.exec(line);
      const port = match?.[1] ? Number(match[1]) : 0;
      if (wanted.has(port)) counts.set(port, (counts.get(port) ?? 0) + 1);
    }
  }
  return counts;
}

export function readProcessInfo(pid: number): ProcessInfo | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(afterComm[1]);
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        cwd = null;
      }
      return { pid, ppid: Number.isInteger(ppid) ? ppid : null, command, cwd };
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const ps = run("ps", ["-o", "ppid=,command=", "-p", String(pid)]).trim();
    if (!ps) return null;
    const match = /^(\d+)\s+(.*)$/.exec(ps);
    const cwdLine = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
      .split("\n")
      .find((line) => line.startsWith("n"));
    return {
      pid,
      ppid: match?.[1] ? Number(match[1]) : null,
      command: match?.[2] ?? ps,
      cwd: cwdLine ? cwdLine.slice(1) : null,
    };
  }
  return null;
}

/** The pid followed by its ancestors, nearest first (bounded). */
export function ancestry(pid: number, maxHops = 32): number[] {
  const chain: number[] = [];
  let current: number | null = pid;
  while (current && current > 1 && chain.length < maxHops && !chain.includes(current)) {
    chain.push(current);
    current = readProcessInfo(current)?.ppid ?? null;
  }
  return chain;
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 || result.stdout ? (result.stdout ?? "") : "";
}
