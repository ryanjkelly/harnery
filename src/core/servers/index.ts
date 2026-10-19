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
 * Fail-closed rules: a record whose pid was recycled is never signalled;
 * an unreadable start token or coordination view is `unknown`,
 * which `gc` never stops; a record without an owner is never stopped
 * automatically.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { resolveCoordRoot } from "../agents/coord-client.ts";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";
import {
  type ProcessGenerationSignalDependencies,
  type ProcessGenerationVerdict,
  processStartToken,
  signalIfSameGeneration,
  verifyProcessGeneration,
} from "../agents/state/proc-start.ts";
import { serverPortRange } from "../config.ts";
import {
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../events/v3/live-route-observer.ts";
import { resolveOwner } from "../hooks/resolve/owner.ts";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import { acquireNoClobberLease } from "../workflow/workspaces/leases.ts";
import {
  ancestry,
  establishedConnectionCounts,
  listListeningPorts,
  listListeningSockets,
  processStartedAt,
  readProcessInfo,
  type ScanSupport,
  scanSupport,
} from "./net.ts";

export {
  processStartToken,
  signalIfSameGeneration,
  verifyProcessGeneration,
} from "../agents/state/proc-start.ts";
export { acquireNoClobberLease } from "../workflow/workspaces/leases.ts";
export {
  ancestry,
  establishedConnectionCounts,
  listListeningPorts,
  listListeningSockets,
  lsofConnectionCounts,
  lsofListeningSockets,
  parseElapsed,
  parseLsofListen,
  parseProcNetTcp,
  processStartedAt,
  psProcessInfo,
  readProcessInfo,
  scanSupport,
} from "./net.ts";
export { createTunnelReadinessVerifier, tunnelServerId, tunnelServerInput } from "./tunnels.ts";

export const SERVER_RECORD_SCHEMA_VERSION = 2;
export const SERVER_DEFAULT_IDLE_HOURS = 2;
export const SERVER_DEFAULT_OWNER_STALE_HOURS = 24;
const TOUCH_INTERVAL_MS = 60_000;

export type ServerKind = "service" | "session";

export interface ServerRecord {
  schema_version: typeof SERVER_RECORD_SCHEMA_VERSION;
  id: string;
  registration_id: string;
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
  /** Generation witnesses captured when the further processes registered. */
  pids_start_tokens?: Record<string, string>;
  host: string;
  /** What the server serves, usually a directory. */
  scope?: string;
  cwd?: string;
  log?: string;
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
  /** Preserve an observed witness when adopting, rather than probing a new generation. */
  start_token?: string;
  pids?: number[];
  scope?: string;
  cwd?: string;
  log?: string;
  started_at?: string;
  /** `null` records no owner; omitted resolves the calling agent session. */
  owner?: { instance_id: string; name?: string } | null;
}

export interface ServerOptions {
  coordRoot?: string | null;
}

export type ServerState = "running" | "dead" | "other-host" | "unknown";
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
  /** Captured during the scan, before a stop can be authorized. */
  start_token?: string;
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
  return withServerMutation(coordRoot, id, () => {
    const path = recordPath(coordRoot, id);
    const now = new Date().toISOString();
    const startToken = input.start_token ?? processStartToken(pid);
    const pids = [...new Set(input.pids?.filter((p) => Number.isSafeInteger(p) && p > 0))];
    const pidsStartTokens: Record<string, string> = {};
    for (const auxiliaryPid of pids) {
      const token = processStartToken(auxiliaryPid);
      if (token) pidsStartTokens[auxiliaryPid] = token;
    }
    const owner = input.owner === undefined ? callingOwner(coordRoot) : (input.owner ?? undefined);
    const record: ServerRecord = {
      schema_version: SERVER_RECORD_SCHEMA_VERSION,
      id,
      registration_id: randomUUID(),
      kind: input.kind,
      type: input.type,
      label: input.label ?? id,
      ...(input.url ? { url: input.url } : {}),
      ...(input.port ? { port: input.port } : {}),
      pid,
      ...(startToken ? { start_token: startToken } : {}),
      ...(pids.length ? { pids, pids_start_tokens: pidsStartTokens } : {}),
      host: hostname(),
      ...(input.scope ? { scope: resolve(input.scope) } : {}),
      ...(input.cwd ? { cwd: resolve(input.cwd) } : {}),
      ...(input.log ? { log: resolve(input.log) } : {}),
      ...(owner ? { owner } : {}),
      started_at: input.started_at ?? now,
      registered_at: now,
      last_active_at: now,
    };
    if (
      input.start_token !== undefined &&
      verifyProcessGeneration(pid, input.start_token) !== "same"
    )
      throw new Error(`pid ${pid} generation could not be verified before registration`);
    if (existsSync(path)) {
      const existing = readRecord(path);
      if (!existing)
        throw new Error(
          `registration ${id} custody is unknown: invalid or older server record retained`,
        );
      if (sameProcessCustody(existing, record) && serverState(existing) === "running")
        return existing;
      if (existing.host !== hostname() || !allProcessesAbsent(existing))
        throw new Error(`registration ${id} custody is held by a live or unverifiable server`);
    }
    writePrivateJsonAtomic(path, record);
    return record;
  });
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

/** Remove only the exact registration receipt observed by the caller. */
export function unregisterServer(record: ServerRecord, options?: ServerOptions): boolean {
  const coordRoot = rootOf(options);
  if (!coordRoot || !record || !isValidServerId(record.id)) return false;
  return withServerMutation(coordRoot, record.id, () => removeServerReceipt(coordRoot, record));
}

/** Hold the exact registration receipt until a synchronous or asynchronous effect settles. */
export function withServerRegistrationCustody<T>(
  record: ServerRecord,
  options: ServerOptions,
  effect: () => PromiseLike<T>,
): Promise<T>;
export function withServerRegistrationCustody<T>(
  record: ServerRecord,
  options: ServerOptions,
  effect: () => T,
): T;
export function withServerRegistrationCustody<T>(
  record: ServerRecord,
  options: ServerOptions,
  effect: () => T | PromiseLike<T>,
): T | Promise<T> {
  const coordRoot = rootOf(options);
  if (!coordRoot) throw new Error("registration custody root is unavailable");
  const lease = serverMutationLease(coordRoot, record.id);
  try {
    const current = readServer(record.id, { coordRoot });
    if (
      !current ||
      current.registration_id !== record.registration_id ||
      !sameProcessCustody(current, record)
    )
      throw new Error(`registration ${record.id} custody changed`);
    const result = effect();
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as PromiseLike<T>).then === "function"
    )
      return Promise.resolve(result).finally(() => lease.release());
    lease.release();
    return result as T;
  } catch (error) {
    lease.release();
    throw error;
  }
}

function removeServerReceipt(coordRoot: string, record: ServerRecord): boolean {
  const path = recordPath(coordRoot, record.id);
  const current = readRecord(path);
  if (
    !current ||
    current.registration_id !== record.registration_id ||
    !sameProcessCustody(current, record)
  )
    return false;
  rmSync(path);
  return true;
}

function serverMutationLease(coordRoot: string, id: string) {
  recordPath(coordRoot, id);
  const scope = `server-registration-${id}`;
  return acquireNoClobberLease({
    path: join(serversDir(coordRoot), ".custody", id),
    scope,
    authoritySha256: createHash("sha256").update(scope).digest("hex"),
    staleAfterMs: 1,
  });
}

function withServerMutation<T>(coordRoot: string, id: string, operation: () => T): T {
  const lease = serverMutationLease(coordRoot, id);
  try {
    return operation();
  } finally {
    lease.release();
  }
}

function sameProcessCustody(a: ServerRecord, b: ServerRecord): boolean {
  const helpers = (record: ServerRecord) =>
    [...new Set(record.pids ?? [])]
      .sort((x, y) => x - y)
      .map((pid) => [pid, record.pids_start_tokens?.[pid] ?? null]);
  return (
    a.schema_version === SERVER_RECORD_SCHEMA_VERSION &&
    b.schema_version === SERVER_RECORD_SCHEMA_VERSION &&
    a.id === b.id &&
    a.pid === b.pid &&
    a.start_token === b.start_token &&
    a.host === b.host &&
    a.kind === b.kind &&
    a.type === b.type &&
    a.scope === b.scope &&
    a.owner?.instance_id === b.owner?.instance_id &&
    JSON.stringify(helpers(a)) === JSON.stringify(helpers(b))
  );
}

export function readServer(id: string, options?: ServerOptions): ServerRecord | null {
  const coordRoot = rootOf(options);
  if (!coordRoot || !isValidServerId(id)) return null;
  const path = recordPath(coordRoot, id);
  const record = readRecord(path);
  if (!record && existsSync(path))
    throw new Error(
      `server record ${id} is invalid or uses an older schema; retained without custody`,
    );
  return record;
}

/** Mark a server as used now. */
export function touchServer(id: string, options?: ServerOptions & { now?: Date }): void {
  const coordRoot = rootOf(options);
  if (!coordRoot || !isValidServerId(id)) return;
  withServerMutation(coordRoot, id, () => {
    const path = recordPath(coordRoot, id);
    const record = readRecord(path);
    if (!record) return;
    writePrivateJsonAtomic(path, {
      ...record,
      last_active_at: (options?.now ?? new Date()).toISOString(),
    });
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
      typeof value.registration_id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.registration_id) ||
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
    .map((name) => {
      const record = readRecord(join(dir, name));
      if (!record)
        throw new Error(
          `server record ${name} is invalid or uses an older schema; retained without custody`,
        );
      return record;
    })
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
    );
}

export function pidAlive(pid: number): boolean {
  return processPresence(pid) !== "absent";
}

function processPresence(
  pid: number,
  probePid?: (pid: number) => boolean,
): "present" | "absent" | "unknown" {
  try {
    if (probePid) return probePid(pid) ? "present" : "absent";
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "absent" : code === "EPERM" ? "present" : "unknown";
  }
}

function allProcessesAbsent(record: ServerRecord, probePid?: (pid: number) => boolean): boolean {
  return [record.pid, ...(record.pids ?? [])].every(
    (pid) => processPresence(pid, probePid) === "absent",
  );
}

export function serverState(
  record: ServerRecord,
  readToken?: (pid: number) => string | null,
  probePid?: (pid: number) => boolean,
): ServerState {
  if (record.host !== hostname()) return "other-host";
  const presence = processPresence(record.pid, probePid);
  if (presence === "absent") return allProcessesAbsent(record, probePid) ? "dead" : "unknown";
  if (presence === "unknown") return "unknown";
  const verdict = verifyProcessGeneration(record.pid, record.start_token, readToken);
  return verdict === "same" ? "running" : verdict === "different" ? "dead" : "unknown";
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
    if (state === "dead" && allProcessesAbsent(record) && options?.prune !== false) {
      unregisterServer(record, { coordRoot });
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
  const registered = servers.filter((server) => server.record.host === hostname());
  const covered = new Set<number>();
  const ports = new Set<number>();
  for (const { record } of registered) {
    covered.add(record.pid);
    for (const pid of record.pids ?? []) covered.add(pid);
    if (record.port) ports.add(record.port);
  }
  const results: UnregisteredListener[] = [];
  const seenPids = new Map<number, boolean>();
  for (const socket of listListeningSockets()) {
    if (ports.has(socket.port) || covered.has(socket.pid) || socket.pid === process.pid) continue;
    const startToken = processStartToken(socket.pid);
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
      ...(startToken ? { start_token: startToken } : {}),
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
  method: "not-running" | "signal" | "refused";
  generation?: ProcessGenerationVerdict;
  detail?: string;
}

export interface ServerProcessDependencies extends ProcessGenerationSignalDependencies {
  probePid?: (pid: number) => boolean;
}

/**
 * Stop a verified server with SIGTERM, then SIGKILL after the grace period.
 * Every signal targets one retained process handle, including auxiliary processes.
 * Each target requires a fresh generation check. Unknown or different generations retain the record.
 */
export async function stopServer(
  record: ServerRecord,
  options?: ServerOptions & {
    graceMs?: number;
    signalDependencies?: ServerProcessDependencies;
  },
): Promise<StopResult> {
  const coordRoot = rootOf(options);
  if (!coordRoot)
    return {
      id: record.id,
      stopped: false,
      method: "refused",
      generation: "unknown",
      detail: "registration custody root is unavailable",
    };
  let lease: ReturnType<typeof serverMutationLease>;
  try {
    lease = serverMutationLease(coordRoot, record.id);
  } catch {
    return {
      id: record.id,
      stopped: false,
      method: "refused",
      generation: "unknown",
      detail: "registration custody is unavailable",
    };
  }
  try {
    const current = readServer(record.id, { coordRoot });
    if (!current || current.registration_id !== record.registration_id)
      return {
        id: record.id,
        stopped: false,
        method: "refused",
        generation: "unknown",
        detail: "registration custody changed; retained current server",
      };
    return await stopServerWithCustody(record, coordRoot, options);
  } finally {
    lease.release();
  }
}

async function stopServerWithCustody(
  record: ServerRecord,
  coordRoot: string,
  options?: ServerOptions & { graceMs?: number; signalDependencies?: ServerProcessDependencies },
): Promise<StopResult> {
  const graceMs = options?.graceMs ?? 5_000;
  const dependencies = options?.signalDependencies ?? {};
  const targets = [
    { pid: record.pid, token: record.start_token },
    ...[...new Set(record.pids ?? [])]
      .filter((pid) => pid !== record.pid)
      .map((pid) => ({ pid, token: record.pids_start_tokens?.[pid] })),
  ];
  const refuse = (pid: number, generation: ProcessGenerationVerdict): StopResult => ({
    id: record.id,
    stopped: false,
    method: "refused",
    generation,
    detail: `pid ${pid} generation is ${generation}; left the server record in place`,
  });
  const finish = (result: StopResult): StopResult => {
    if (result.stopped || result.method === "not-running") removeServerReceipt(coordRoot, record);
    return result;
  };
  if (record.host !== hostname())
    return { id: record.id, stopped: false, method: "refused", detail: `runs on ${record.host}` };
  const leaderPresence = processPresence(record.pid, dependencies.probePid);
  if (
    leaderPresence === "unknown" ||
    (leaderPresence === "absent" && !allProcessesAbsent(record, dependencies.probePid))
  )
    return refuse(record.pid, "unknown");
  // Check every recorded live process before sending the first signal.
  for (const target of targets) {
    const presence = processPresence(target.pid, dependencies.probePid);
    if (presence === "absent") continue;
    if (presence === "unknown") return refuse(target.pid, "unknown");
    const verdict = verifyProcessGeneration(target.pid, target.token, dependencies.readToken);
    if (verdict !== "same") return refuse(target.pid, verdict);
  }
  if (targets.every((target) => processPresence(target.pid, dependencies.probePid) === "absent"))
    return finish({ id: record.id, stopped: false, method: "not-running" });

  const current = readServer(record.id, { coordRoot });
  if (!current || !sameProcessCustody(current, record)) return refuse(record.pid, "unknown");
  for (const name of ["SIGTERM", "SIGKILL"] as const) {
    for (const target of targets) {
      const presence = processPresence(target.pid, dependencies.probePid);
      if (presence === "absent") continue;
      if (presence === "unknown") return refuse(target.pid, "unknown");
      const result = signalIfSameGeneration(target.pid, target.token, name, dependencies);
      if (!result.sent || result.verdict !== "same")
        return refuse(target.pid, result.verdict === "same" ? "unknown" : result.verdict);
    }
    const observed = await waitForExit(targets, name === "SIGTERM" ? graceMs : 2_000, dependencies);
    if (observed.refused) return refuse(observed.refused.pid, observed.refused.verdict);
    if (observed.exited)
      return finish({ id: record.id, stopped: true, method: "signal", generation: "same" });
  }
  return {
    id: record.id,
    stopped: false,
    method: "signal",
    generation: "same",
    detail: "process survived SIGKILL",
  };
}

async function waitForExit(
  targets: Array<{ pid: number; token: string | undefined }>,
  waitMs: number,
  dependencies: ServerProcessDependencies,
): Promise<{
  exited: boolean;
  refused?: { pid: number; verdict: ProcessGenerationVerdict };
}> {
  const deadline = Date.now() + waitMs;
  while (true) {
    let live = false;
    for (const target of targets) {
      const presence = processPresence(target.pid, dependencies.probePid);
      if (presence === "absent") continue;
      if (presence === "unknown")
        return { exited: false, refused: { pid: target.pid, verdict: "unknown" } };
      const verdict = verifyProcessGeneration(target.pid, target.token, dependencies.readToken);
      if (verdict !== "same") return { exited: false, refused: { pid: target.pid, verdict } };
      live = true;
    }
    if (!live) return { exited: true };
    if (Date.now() >= deadline) return { exited: false };
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The first free port in the configured range for `type`
 * (`.harnery/config.jsonc` `servers.port_ranges`). Skips ports any process is
 * listening on and ports a registered server claims. Returns null when the
 * type has no configured range; throws when the range is exhausted.
 */
export function allocateServerPort(type: string, options?: ServerOptions): number | null {
  const coordRoot = rootOf(options);
  const range = serverPortRange(type, coordRoot);
  if (!range) return null;
  const taken = listListeningPorts();
  for (const record of readServerRecords({ coordRoot })) {
    const state = serverState(record);
    if (record.port && (state === "running" || state === "unknown")) taken.add(record.port);
  }
  for (let port = range[0]; port <= range[1]; port++) if (!taken.has(port)) return port;
  throw new Error(`no free port for ${type} in ${range[0]}-${range[1]}`);
}

export interface AdoptOptions extends ServerOptions {
  type?: string;
  kind?: ServerKind;
  label?: string;
  scope?: string;
  /** `self` (default) records the adopting agent as owner; `none` records no owner. */
  owner?: "self" | "none";
  dependencies?: {
    listServers?: typeof listServers;
    readToken?: (pid: number) => string | null;
  };
}

/**
 * Register a running server that never registered itself. Only a pid the scan
 * reports as an unregistered listener inside the project can be adopted.
 */
export function adoptServer(pid: number, options?: AdoptOptions): ServerRecord {
  const coordRoot = rootOf(options);
  if (!coordRoot) throw new Error("no Harnery project found (coordination root did not resolve)");
  const report = (options?.dependencies?.listServers ?? listServers)({ coordRoot, sample: false });
  const listeners = report.unregistered.filter((item) => item.pid === pid);
  if (!listeners.length)
    throw new Error(`pid ${pid} is not an unregistered listener inside this project`);
  const ports = listeners.map((item) => item.port).sort((a, b) => a - b);
  const first = listeners[0]!;
  const generation = verifyProcessGeneration(
    pid,
    first.start_token,
    options?.dependencies?.readToken,
  );
  if (generation !== "same")
    throw new Error(`pid ${pid} generation is ${generation}; adoption refused`);
  const type = options?.type ?? "adopted";
  const scope = options?.scope ?? first.cwd ?? undefined;
  const started = processStartedAt(pid);
  const record = registerServer(
    {
      id: serverId(type, `${scope ?? ""}#${pid}`),
      kind: options?.kind ?? "session",
      type,
      label: options?.label ?? `Adopted: ${first.command.slice(0, 80)}`,
      url: `http://127.0.0.1:${ports[0]}/`,
      port: ports[0],
      pid,
      start_token: first.start_token,
      ...(scope ? { scope } : {}),
      ...(first.cwd ? { cwd: first.cwd } : {}),
      ...(options?.owner === "none" ? { owner: null } : {}),
      ...(started ? { started_at: started } : {}),
    },
    { coordRoot },
  );
  if (!record) throw new Error("registration failed");
  return record;
}

/** Ensure the registry directory exists (for hosts that write records directly). */
export function ensureServersDir(coordRoot: string): string {
  const dir = serversDir(coordRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}
