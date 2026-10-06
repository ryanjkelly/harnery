/**
 * Local server registry.
 *
 * Every command that starts a long-lived local server (a preview UI, a tuning
 * panel, a tunnel gate, a dashboard) writes one record under
 * `.harnery/servers/<id>.json` and removes it when the server stops. One
 * reader can then list every running server, stop any of them, and clean up
 * session servers whose starting agent is gone.
 *
 * Two kinds:
 *   - `service`: one long-running copy (a dashboard, a tunnel). Listed and
 *     stoppable by hand; never stopped automatically.
 *   - `session`: one copy per piece of work (a preview for one scene). Eligible
 *     for `gc` once its starting agent has ended or been unobserved for a long
 *     time AND nobody has used the server for the idle window.
 *
 * Fail-closed rules: a record whose pid was recycled is treated as dead, never
 * signalled; an unreadable coordination view makes every owner `unknown`,
 * which `gc` never stops; a record without an owner is never stopped
 * automatically.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { listStates } from "../../lib/tunnel/state.ts";
import { resolveCoordRoot } from "../agents/coord-client.ts";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";
import { checkPidToken, processStartToken } from "../agents/state/proc-start.ts";
import {
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../events/v3/live-route-observer.ts";
import { resolveOwner } from "../hooks/resolve/owner.ts";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import {
  ancestry,
  establishedConnectionCounts,
  listListeningSockets,
  readProcessInfo,
  type ScanSupport,
  scanSupport,
} from "./net.ts";
import { tunnelServerId, tunnelServerInput } from "./tunnels.ts";

export {
  ancestry,
  establishedConnectionCounts,
  listListeningSockets,
  parseLsofListen,
  parseProcNetTcp,
  readProcessInfo,
  scanSupport,
} from "./net.ts";
export { tunnelServerId, tunnelServerInput } from "./tunnels.ts";

export const SERVER_RECORD_SCHEMA_VERSION = 1;
export const SERVER_DEFAULT_IDLE_HOURS = 2;
export const SERVER_DEFAULT_OWNER_STALE_HOURS = 24;
const TOUCH_INTERVAL_MS = 60_000;

export type ServerKind = "service" | "session";

export interface ServerRecord {
  schema_version: typeof SERVER_RECORD_SCHEMA_VERSION;
  id: string;
  kind: ServerKind;
  /** Free-form family name: `preview`, `tunnel`, `dashboard`, ... */
  type: string;
  label: string;
  url?: string;
  port?: number;
  /** The process that owns the server's lifetime (signalled on stop). */
  pid: number;
  start_token?: string;
  /** Further processes that belong to this server (helpers, children). */
  pids?: number[];
  host: string;
  /** What the server serves, usually a directory. */
  scope?: string;
  cwd?: string;
  log?: string;
  /** Graceful stop command; signals are the fallback. */
  stop_argv?: string[];
  owner?: { instance_id: string; name?: string };
  started_at: string;
  registered_at: string;
  last_active_at?: string;
}

export interface RegisterServerInput {
  id?: string;
  kind: ServerKind;
  type: string;
  label?: string;
  url?: string;
  port?: number;
  pid?: number;
  pids?: number[];
  scope?: string;
  cwd?: string;
  log?: string;
  stop_argv?: string[];
  started_at?: string;
  /** `null` records no owner; omitted resolves the calling agent session. */
  owner?: { instance_id: string; name?: string } | null;
}

export interface ServerOptions {
  coordRoot?: string | null;
}

export type ServerState = "running" | "dead" | "other-host";
export type OwnerState = "live" | "abandoned" | "ended" | "unknown" | "none";

export interface ServerView {
  record: ServerRecord;
  state: ServerState;
  owner_state: OwnerState;
  connections: number | null;
  last_active_at: string;
  idle_ms: number;
}

export interface UnregisteredListener {
  pid: number;
  port: number;
  address: string;
  command: string;
  cwd: string | null;
}

export interface ServersReport {
  schema_version: 1;
  coord_root: string;
  scan: ScanSupport;
  servers: ServerView[];
  unregistered: UnregisteredListener[];
  pruned: string[];
}

export function serversDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "servers");
}

function rootOf(options?: ServerOptions): string | null {
  return options?.coordRoot === undefined ? resolveCoordRoot() : options.coordRoot;
}

/** A stable id for one server family serving one scope. */
export function serverId(type: string, scope?: string): string {
  const family = slug(type) || "server";
  if (!scope) return family;
  const digest = createHash("sha256").update(resolve(scope)).digest("hex").slice(0, 6);
  const name = slug(basename(resolve(scope))).slice(0, 32);
  return [family, name, digest].filter(Boolean).join("-");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isValidServerId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,95}$/.test(id);
}

function recordPath(coordRoot: string, id: string): string {
  if (!isValidServerId(id)) throw new Error(`invalid server id: ${id}`);
  return join(serversDir(coordRoot), `${id}.json`);
}

/**
 * Record a running server. Returns null when no coordination root resolves
 * (a tool running outside any Harnery project), so callers never fail
 * because registration was impossible.
 */
export function registerServer(
  input: RegisterServerInput,
  options?: ServerOptions,
): ServerRecord | null {
  const coordRoot = rootOf(options);
  if (!coordRoot) return null;
  const pid = input.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`invalid server pid: ${pid}`);
  if (
    input.port !== undefined &&
    !(Number.isInteger(input.port) && input.port > 0 && input.port < 65536)
  )
    throw new Error(`invalid server port: ${input.port}`);
  const id = input.id ?? serverId(input.type, input.scope);
  const now = new Date().toISOString();
  const startToken = processStartToken(pid);
  const owner = input.owner === undefined ? callingOwner(coordRoot) : (input.owner ?? undefined);
  const record: ServerRecord = {
    schema_version: SERVER_RECORD_SCHEMA_VERSION,
    id,
    kind: input.kind,
    type: input.type,
    label: input.label ?? id,
    ...(input.url ? { url: input.url } : {}),
    ...(input.port ? { port: input.port } : {}),
    pid,
    ...(startToken ? { start_token: startToken } : {}),
    ...(input.pids?.length
      ? { pids: input.pids.filter((p) => Number.isSafeInteger(p) && p > 0) }
      : {}),
    host: hostname(),
    ...(input.scope ? { scope: resolve(input.scope) } : {}),
    ...(input.cwd ? { cwd: resolve(input.cwd) } : {}),
    ...(input.log ? { log: resolve(input.log) } : {}),
    ...(input.stop_argv?.length ? { stop_argv: input.stop_argv } : {}),
    ...(owner ? { owner } : {}),
    started_at: input.started_at ?? now,
    registered_at: now,
    last_active_at: now,
  };
  writePrivateJsonAtomic(recordPath(coordRoot, id), record);
  return record;
}

/** Best-effort registration that never throws (for server start paths). */
export function tryRegisterServer(
  input: RegisterServerInput,
  options?: ServerOptions,
): ServerRecord | null {
  try {
    return registerServer(input, options);
  } catch {
    return null;
  }
}

function callingOwner(coordRoot: string): ServerRecord["owner"] {
  try {
    const owner = resolveOwner({ payload: null, coordRoot });
    if (!owner) return undefined;
    const name = readLiveCoordinationRow(coordRoot, owner.instance_id)?.name;
    return { instance_id: owner.instance_id, ...(name ? { name } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Remove a server's record. With `pid`, only a record still naming that pid
 * is removed, so a replacement that re-registered the same id survives.
 */
export function unregisterServer(id: string, options?: ServerOptions & { pid?: number }): boolean {
  const coordRoot = rootOf(options);
  if (!coordRoot || !isValidServerId(id)) return false;
  const path = recordPath(coordRoot, id);
  if (options?.pid !== undefined) {
    const record = readRecord(path);
    if (record && record.pid !== options.pid) return false;
  }
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function readServer(id: string, options?: ServerOptions): ServerRecord | null {
  const coordRoot = rootOf(options);
  if (!coordRoot || !isValidServerId(id)) return null;
  return readRecord(recordPath(coordRoot, id));
}

/** Mark a server as used now. */
export function touchServer(id: string, options?: ServerOptions & { now?: Date }): void {
  const coordRoot = rootOf(options);
  if (!coordRoot || !isValidServerId(id)) return;
  const path = recordPath(coordRoot, id);
  const record = readRecord(path);
  if (!record) return;
  writePrivateJsonAtomic(path, {
    ...record,
    last_active_at: (options?.now ?? new Date()).toISOString(),
  });
}

/**
 * A request hook for servers that want precise idle tracking: call the
 * returned function on every request; it writes at most once a minute.
 */
export function createServerToucher(id: string, options?: ServerOptions): () => void {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < TOUCH_INTERVAL_MS) return;
    last = now;
    try {
      touchServer(id, options);
    } catch {
      // Activity tracking must never break the server.
    }
  };
}

function readRecord(path: string): ServerRecord | null {
  try {
    if (!existsSync(path) || statSync(path).size > 64 * 1024) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as ServerRecord;
    if (
      value?.schema_version !== SERVER_RECORD_SCHEMA_VERSION ||
      typeof value.id !== "string" ||
      !Number.isSafeInteger(value.pid) ||
      (value.kind !== "service" && value.kind !== "session")
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function readServerRecords(options?: ServerOptions): ServerRecord[] {
  const coordRoot = rootOf(options);
  if (!coordRoot) return [];
  const dir = serversDir(coordRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readRecord(join(dir, name)))
    .filter((record): record is ServerRecord => record !== null)
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
    );
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function serverState(record: ServerRecord): ServerState {
  if (record.host !== hostname()) return "other-host";
  if (!pidAlive(record.pid)) return "dead";
  return checkPidToken(record.pid, record.start_token) === "mismatch" ? "dead" : "running";
}

type OwnerReader = (instanceId: string) => OwnerState;

function ownerReader(coordRoot: string, ownerStaleMs: number, nowMs: number): OwnerReader {
  let view: ReturnType<typeof readCoordinationViewV3> | null = null;
  let failed = false;
  try {
    view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(coordRoot));
  } catch {
    failed = true;
  }
  return (instanceId) => {
    if (failed || !view) return "unknown";
    const generation = view.instances[liveInstanceIdV3(instanceId)];
    if (generation?.phase !== "live") return "ended";
    const observed = Date.parse(generation.last_observed_at);
    if (!Number.isFinite(observed)) return "unknown";
    return nowMs - observed > ownerStaleMs ? "abandoned" : "live";
  };
}

export interface ListServersOptions extends ServerOptions {
  /** Look for listening processes inside the project that never registered. */
  scan?: boolean;
  /** Record observed connections as activity (default true). */
  sample?: boolean;
  /** Delete records of servers that are no longer running (default true). */
  prune?: boolean;
  ownerStaleHours?: number;
  now?: Date;
}

/** Read every record, observe it, and optionally find unregistered listeners. */
export function listServers(options?: ListServersOptions): ServersReport {
  const coordRoot = rootOf(options);
  if (!coordRoot) throw new Error("no Harnery project found (coordination root did not resolve)");
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const ownerStaleMs = hours(options?.ownerStaleHours ?? SERVER_DEFAULT_OWNER_STALE_HOURS);
  adoptRunningTunnels(coordRoot);
  const records = readServerRecords({ coordRoot });
  const ownerOf = ownerReader(coordRoot, ownerStaleMs, nowMs);
  const states = records.map((record) => serverState(record));
  const counts = establishedConnectionCounts(
    records.filter((_, i) => states[i] === "running").map((r) => r.port ?? 0),
  );
  const support = scanSupport();
  const pruned: string[] = [];
  const servers: ServerView[] = [];
  records.forEach((record, i) => {
    const state = states[i]!;
    if (state === "dead" && options?.prune !== false) {
      unregisterServer(record.id, { coordRoot, pid: record.pid });
      pruned.push(record.id);
      return;
    }
    const connections =
      state === "running" && record.port && support !== "unsupported"
        ? (counts.get(record.port) ?? 0)
        : null;
    let lastActive = record.last_active_at ?? record.registered_at;
    if (connections && options?.sample !== false) {
      lastActive = now.toISOString();
      try {
        touchServer(record.id, { coordRoot, now });
      } catch {
        // Observation stays correct for this read even if the write fails.
      }
    }
    const lastMs = Date.parse(lastActive);
    servers.push({
      record,
      state,
      owner_state: record.owner ? ownerOf(record.owner.instance_id) : "none",
      connections,
      last_active_at: lastActive,
      idle_ms: Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) : 0,
    });
  });
  const unregistered = options?.scan === false ? [] : findUnregisteredListeners(coordRoot, servers);
  return {
    schema_version: 1,
    coord_root: coordRoot,
    scan: support,
    servers,
    unregistered,
    pruned,
  };
}

/** Register running tunnels that have no current record. Returns adopted ids. */
export function adoptRunningTunnels(coordRoot: string): string[] {
  const adopted: string[] = [];
  let states: ReturnType<typeof listStates>;
  try {
    states = listStates(coordRoot);
  } catch {
    return adopted;
  }
  for (const state of states) {
    if (!state.gate_pid || !pidAlive(state.gate_pid)) continue;
    const id = tunnelServerId(state.name);
    if (readServer(id, { coordRoot })?.pid === state.gate_pid) continue;
    if (tryRegisterServer(tunnelServerInput(state, coordRoot), { coordRoot })) adopted.push(id);
  }
  return adopted;
}

/** Processes that browser automation and editors start; never project servers. */
const IGNORED_LISTENER_COMMANDS = [
  /(^|\/)(chrome|chromium|chrome-headless-shell|headless_shell|msedge|firefox)( |$)/i,
  /\/(\.vscode-server|\.cursor-server|\.windsurf-server)\//,
  /--type=(renderer|gpu-process|utility)/,
];

/**
 * Listening processes that run inside the project (working directory or
 * command line within the coordination root) but are not covered by any
 * registered server: not a recorded pid, not a descendant of one, and not on
 * a recorded port.
 */
export function findUnregisteredListeners(
  coordRoot: string,
  servers: Array<Pick<ServerView, "record" | "state">>,
): UnregisteredListener[] {
  const running = servers.filter((server) => server.state === "running");
  const covered = new Set<number>();
  const ports = new Set<number>();
  for (const { record } of running) {
    covered.add(record.pid);
    for (const pid of record.pids ?? []) covered.add(pid);
    if (record.port) ports.add(record.port);
  }
  const results: UnregisteredListener[] = [];
  const seenPids = new Map<number, boolean>();
  for (const socket of listListeningSockets()) {
    if (ports.has(socket.port) || socket.pid === process.pid) continue;
    let inside = seenPids.get(socket.pid);
    const info = readProcessInfo(socket.pid);
    if (!info) continue;
    if (inside === undefined) {
      inside =
        !IGNORED_LISTENER_COMMANDS.some((pattern) => pattern.test(info.command)) &&
        (within(coordRoot, info.cwd) || mentions(info.command, coordRoot)) &&
        !ancestry(socket.pid).some((pid) => covered.has(pid));
      seenPids.set(socket.pid, inside);
    }
    if (!inside) continue;
    results.push({
      pid: socket.pid,
      port: socket.port,
      address: socket.address,
      command: info.command.slice(0, 300),
      cwd: info.cwd,
    });
  }
  return results;
}

function within(root: string, path: string | null): boolean {
  if (!path) return false;
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function mentions(command: string, root: string): boolean {
  return command.split(/\s+/).some((arg) => arg === root || arg.startsWith(`${root}/`));
}

function hours(value: number): number {
  return value * 3_600_000;
}

export interface GcPolicy {
  idleHours?: number;
  ownerStaleHours?: number;
}

export interface GcDecision {
  id: string;
  action: "stop" | "keep";
  reason: string;
}

/**
 * Decide which session servers to stop. Pure: the caller supplies the views.
 * A server is stopped only when all hold: kind `session`, running on this
 * host, its owner ended or went unobserved past the stale window, and it has
 * been idle for the idle window.
 */
export function planServerGc(views: ServerView[], policy?: GcPolicy): GcDecision[] {
  const idleMs = hours(policy?.idleHours ?? SERVER_DEFAULT_IDLE_HOURS);
  return views.map(({ record, state, owner_state, idle_ms }) => {
    const keep = (reason: string): GcDecision => ({ id: record.id, action: "keep", reason });
    if (state !== "running") return keep(`server is ${state}`);
    if (record.kind !== "session") return keep("services are only stopped by hand");
    if (owner_state === "none") return keep("no starting agent was recorded");
    if (owner_state === "unknown") return keep("the starting agent's state could not be read");
    if (owner_state === "live") return keep("the starting agent is still active");
    if (idle_ms < idleMs)
      return keep(`used within the last ${policy?.idleHours ?? SERVER_DEFAULT_IDLE_HOURS}h`);
    return {
      id: record.id,
      action: "stop",
      reason: `starting agent ${owner_state === "ended" ? "has ended" : "has been unobserved past the stale window"} and the server has been idle ${Math.round(idle_ms / 60_000)} min`,
    };
  });
}

export interface StopResult {
  id: string;
  stopped: boolean;
  method: "not-running" | "stop-command" | "signal" | "refused";
  detail?: string;
}

/**
 * Stop one server: its graceful stop command first when recorded, then
 * SIGTERM to its process group, then SIGKILL after the grace period. A pid
 * whose start token no longer matches is never signalled.
 */
export async function stopServer(
  record: ServerRecord,
  options?: ServerOptions & { graceMs?: number },
): Promise<StopResult> {
  const coordRoot = rootOf(options);
  const graceMs = options?.graceMs ?? 5_000;
  const finish = (result: StopResult): StopResult => {
    if (result.stopped || result.method === "not-running")
      unregisterServer(record.id, { coordRoot, pid: record.pid });
    return result;
  };
  const state = serverState(record);
  if (state === "other-host")
    return { id: record.id, stopped: false, method: "refused", detail: `runs on ${record.host}` };
  if (state === "dead") return finish({ id: record.id, stopped: false, method: "not-running" });

  if (record.stop_argv?.length) {
    const [command, ...args] = record.stop_argv;
    spawnSync(command!, args, { stdio: "ignore", timeout: 30_000, cwd: record.cwd });
    if (await exited(record, graceMs))
      return finish({ id: record.id, stopped: true, method: "stop-command" });
  }
  signal(record.pid, "SIGTERM");
  for (const pid of record.pids ?? []) signal(pid, "SIGTERM");
  if (await exited(record, graceMs))
    return finish({ id: record.id, stopped: true, method: "signal" });
  if (serverState(record) === "running") {
    signal(record.pid, "SIGKILL");
    for (const pid of record.pids ?? []) signal(pid, "SIGKILL");
  }
  const stopped = await exited(record, 2_000);
  return finish({
    id: record.id,
    stopped,
    method: "signal",
    ...(stopped ? {} : { detail: "process survived SIGKILL" }),
  });
}

function signal(pid: number, name: NodeJS.Signals): void {
  // Detached servers lead their own process group; signal the group so a
  // wrapper (npm, bunx) does not orphan the real listener.
  try {
    process.kill(-pid, name);
    return;
  } catch {
    // Not a group leader, or already gone.
  }
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

async function exited(record: ServerRecord, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (serverState(record) !== "running") return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return serverState(record) !== "running";
}

/** Ensure the registry directory exists (for hosts that write records directly). */
export function ensureServersDir(coordRoot: string): string {
  const dir = serversDir(coordRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}
