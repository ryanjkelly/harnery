/**
 * Relay client transport for cross-machine presence (ADR 0016, phase 2c).
 *
 * The hooks are short-lived processes, so a live WebSocket needs a home: a
 * small per-repo-per-machine DAEMON that the hooks lazy-start
 * (`ensureRelayDaemon`) and that exits itself when the machine goes idle.
 * The daemon:
 *
 *   - derives the room credentials from the repo identity (root-commit SHA +
 *     origin URL + optional committed `.harnery/presence-salt`)
 *   - holds the socket open with auto-reconnect + jittered backoff
 *   - watches the active V3 ledger and publishes the encrypted presence blob on
 *     change (debounced), plus a 60s keepalive so peers' staleness math works
 *   - decrypts received peer frames and writes them to
 *     `.harnery/presence/remote/<machine>.json`, where `readRemoteMachines`
 *     merges them with the git-refs floor (freshest source per machine wins)
 *   - exits after ~5 minutes with no live local sessions (hooks restart it
 *     when sessions return), and exits if its pid file is superseded
 *   - exits and relaunches itself when the installed Harnery code changes
 *     (ADR 0232), so a fix pulled into the checkout reaches the running daemon
 *
 * Everything fails silent; the git-refs transport is always the floor.
 * Requires a global WebSocket (Bun, Node >= 21, Workers) — on older Nodes the
 * daemon refuses to start and presence stays on git-refs.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { coordEnv } from "../../lib/env.ts";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { harnCliEntry } from "../cli-entry.ts";
import {
  type CodeChangeWatch,
  type CodeIdentityChange,
  type CodeIdentityRecord,
  codeChangeMessage,
  codeIdentityReplacementNeeded,
  currentCodeIdentity,
  watchCodeIdentity,
} from "../code-identity.ts";
import { presenceRelayUrl } from "../config.ts";
import { eventV3ActiveWatchPath } from "../events/v3/reader.ts";
import {
  acquireInstanceLock,
  type InstanceLock,
  instanceLockEndpoint,
  instanceLockFileEndpoint,
} from "../single-instance.ts";
import { closeProcessLoggers, legacyLogFields, processLogger } from "../storage/logger.ts";
import { RotatingTextSink } from "../storage/process-log.ts";
import { buildPresenceBlob, type PresenceBlob } from "./blob.ts";
import { originUrl, rootCommitSha, sanitizeRefComponent } from "./git.ts";
import {
  computeSenderId,
  decryptPayload,
  deriveRoomCredentials,
  encryptPayload,
  parseRelayFrame,
} from "./relay-protocol.ts";
import { initialReconnectState, planReconnect, type ReconnectState } from "./relay-reconnect.ts";

const KEEPALIVE_MS = 60_000;
const WATCH_DEBOUNCE_MS = 500;
const IDLE_EXIT_MS = 5 * 60_000;

function presenceDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "presence");
}

function remoteCacheDir(coordRoot: string): string {
  return join(presenceDir(coordRoot), "remote");
}

function pidFilePath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "relay-daemon.json");
}

export function relayLegacyLogPath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "relay-daemon.log");
}

export interface RelayPidRecord {
  pid: number;
  url: string;
  started_at: string;
  /** The code this daemon loaded; absent on daemons that predate the field. */
  code?: CodeIdentityRecord;
  /**
   * `handover` while this daemon waits for the one it replaced to exit, and
   * has not connected; `connected` after. Absent on older daemons.
   */
  state?: "handover" | "connected";
}

export function readRelayPidRecord(coordRoot: string): RelayPidRecord | null {
  try {
    return JSON.parse(readFileSync(pidFilePath(coordRoot), "utf8")) as RelayPidRecord;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The committed rotatable room salt, when the repo minted one. */
export function readRoomSalt(coordRoot: string): string | undefined {
  try {
    const s = readFileSync(join(coordRoot, ".harnery", "presence-salt"), "utf8").trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

export type EnsureRelayDaemonResult =
  | "disabled"
  | "running"
  | "pending"
  | "started"
  | "replaced"
  | "unavailable";

export interface EnsureRelayDaemonDependencies {
  relayUrl: (coordRoot: string) => string | null;
  isAlive: (pid: number) => boolean;
  currentCode: () => CodeIdentityRecord;
  /** Start a daemon that inherits the launch reservation `token`. */
  launch: (coordRoot: string, token: string) => boolean;
  nowMs: () => number;
  /** Test hook: runs between reading the owner and taking the reservation. */
  beforeReserve?: () => void;
}

/** A launch reservation outlives a daemon that dies before taking its pid file. */
export const RELAY_LAUNCH_RESERVATION_MS = 20_000;
/** How long a new daemon waits for the one it replaces before connecting anyway. */
export const RELAY_HANDOVER_WAIT_MS = 75_000;
/** How often a running daemon checks whether a successor took its pid file. */
const SUPERSEDE_CHECK_MS = 5_000;

function launchReservationPath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "relay-launch.json");
}

interface RelayLaunchReservation {
  token: string;
  pid: number;
  created_at: string;
  expires_at: string;
}

function reservationBody(token: string, nowMs: number): string {
  const body: RelayLaunchReservation = {
    token,
    pid: process.pid,
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + RELAY_LAUNCH_RESERVATION_MS).toISOString(),
  };
  return JSON.stringify(body);
}

function reservationToken(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  try {
    const token = (JSON.parse(raw) as Partial<RelayLaunchReservation>).token;
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reserve the right to launch a relay daemon. This only saves duplicate
 * spawns when hooks race: correctness (at most one connected daemon per
 * project) comes from the instance lock each daemon must hold before it
 * connects, and a duplicate that slips through exits on its own. Returns the
 * reservation's token, which the launched daemon inherits, or null while an
 * unexpired reservation exists. An expired one is simply overwritten.
 */
export function reserveRelayLaunch(coordRoot: string, nowMs = Date.now()): string | null {
  const path = launchReservationPath(coordRoot);
  mkdirSync(presenceDir(coordRoot), { recursive: true });
  const token = randomUUID();
  const body = reservationBody(token, nowMs);
  try {
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
  }
  let expiresAt = Number.NaN;
  try {
    expiresAt = Date.parse(
      (JSON.parse(readFileSync(path, "utf8")) as { expires_at?: string }).expires_at ?? "",
    );
  } catch {
    try {
      expiresAt = statSync(path).mtimeMs + RELAY_LAUNCH_RESERVATION_MS;
    } catch {
      // Gone meanwhile: treat as expired.
    }
  }
  if (Number.isFinite(expiresAt) && expiresAt > nowMs) return null;
  try {
    atomicWriteJson(path, JSON.parse(body));
    return token;
  } catch {
    return null;
  }
}

/** Release the reservation if it is still the one `token` names. */
export function releaseRelayLaunchReservation(coordRoot: string, token: string | undefined): void {
  if (!token) return;
  const path = launchReservationPath(coordRoot);
  try {
    if (reservationToken(readFileSync(path, "utf8")) === token) rmSync(path, { force: true });
  } catch {
    /* it expires on its own */
  }
}

/** Extend the reservation `token` names while its handover is still running. */
export function refreshRelayLaunchReservation(
  coordRoot: string,
  token: string | undefined,
  nowMs = Date.now(),
): void {
  if (!token) return;
  const path = launchReservationPath(coordRoot);
  try {
    if (reservationToken(readFileSync(path, "utf8")) !== token) return;
    atomicWriteJson(path, JSON.parse(reservationBody(token, nowMs)));
  } catch {
    /* the pid file's handover state still refuses a second replacement */
  }
}

/** The reservation a launcher handed to this daemon, if any. */
function inheritedReservationToken(): string | undefined {
  return coordEnv("RELAY_RESERVATION_TOKEN") || undefined;
}

/**
 * Lazy-start the relay daemon for this repo if a relay is configured and no
 * live daemon already owns the pid file. A live daemon that runs older code
 * than this installation is replaced: the new daemon takes over the pid file,
 * the old one sees itself superseded and closes its socket, and the new one
 * connects only after the old process has exited. A launch reservation keeps
 * concurrent hooks from starting more than one daemon. Called from the hook
 * path — must return fast and never throw.
 */
export function ensureRelayDaemon(
  coordRoot: string,
  overrides: Partial<EnsureRelayDaemonDependencies> = {},
): EnsureRelayDaemonResult {
  try {
    const deps: EnsureRelayDaemonDependencies = {
      relayUrl: presenceRelayUrl,
      isAlive: pidAlive,
      currentCode: currentCodeIdentity,
      launch: launchRelayDaemon,
      nowMs: Date.now,
      ...overrides,
    };
    const url = deps.relayUrl(coordRoot);
    if (!url) return "disabled";
    const rec = readRelayPidRecord(coordRoot);
    const live = rec !== null && rec.url === url && deps.isAlive(rec.pid);
    // A successor still waiting for its predecessor is never superseded: a
    // third daemon would wait for the successor only and could connect
    // beside the original owner.
    if (live && rec.state === "handover") return "pending";
    const stale = live && codeIdentityReplacementNeeded(rec.code, deps.currentCode());
    if (live && !stale) return "running";
    deps.beforeReserve?.();
    const token = reserveRelayLaunch(coordRoot, deps.nowMs());
    if (!token) return "pending";
    // Revalidate under the reservation: another launcher may have started a
    // daemon since the owner was read, and this decision was made on that
    // stale snapshot.
    if (!samePidOwner(rec, readRelayPidRecord(coordRoot))) {
      releaseRelayLaunchReservation(coordRoot, token);
      return "pending";
    }
    if (!deps.launch(coordRoot, token)) {
      releaseRelayLaunchReservation(coordRoot, token);
      return "unavailable";
    }
    return stale ? "replaced" : "started";
  } catch {
    return "unavailable";
  }
}

function launchRelayDaemon(coordRoot: string, token: string): boolean {
  try {
    // The runtime itself runs the CLI entry, so the daemon starts on Windows
    // too (see cli-entry.ts).
    const entry = harnCliEntry();
    if (!existsSync(entry)) return false;

    mkdirSync(presenceDir(coordRoot), { recursive: true });
    const sharedLogs = coordEnv("SHARED_LOGS") !== "0";
    const log = sharedLogs ? undefined : openSync(relayLegacyLogPath(coordRoot), "a");
    const child = spawn(process.execPath, [entry, "presence", "relay-daemon"], {
      windowsHide: true,
      cwd: coordRoot,
      detached: true,
      stdio: log === undefined ? ["ignore", "ignore", "ignore"] : ["ignore", log, log],
      // Pin the daemon to this project: an inherited CLAUDE_PROJECT_DIR (or
      // similar) may name another one, whose config has no relay.
      env: {
        ...process.env,
        HARNERY_COORD_ROOT_OVERRIDE: coordRoot,
        HARNERY_OUTPUT_SESSION_TEE: "0",
        // The daemon alone renews and releases the reservation it was launched under.
        HARNERY_RELAY_RESERVATION_TOKEN: token,
      },
    });
    if (log !== undefined) closeSync(log);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export type RelayStartupOutcome = "connect" | "duplicate" | "superseded" | "gave_up";

export interface RelayStartup {
  outcome: RelayStartupOutcome;
  /** Held only when `outcome` is `connect`; the daemon keeps it for life. */
  lock?: InstanceLock;
}

/** The project's relay instance lock: one per resolved project root. */
export function relayInstanceLockEndpoint(coordRoot: string): string {
  return instanceLockEndpoint("relay", coordRoot, presenceDir(coordRoot));
}

/** The socket file used where the runtime refuses an abstract address (Linux). */
export function relayInstanceLockFallback(coordRoot: string): string {
  return instanceLockFileEndpoint("relay", coordRoot, presenceDir(coordRoot));
}

/**
 * Decide whether this daemon may connect. Exclusivity comes from the relay
 * instance lock, which the operating system releases when its holder exits
 * or crashes: no daemon opens the relay socket without holding it.
 *
 * - The lock is free and no other live daemon owns the pid file: take the pid
 *   file and connect.
 * - The lock is held and the pid file's live owner runs older code (this is
 *   its replacement): mark the pid file `handover`, which the owner sees as
 *   superseded within seconds, then poll for the lock until the owner exits.
 *   A live pid-file owner from before the lock existed is waited out the
 *   same way while holding the lock.
 * - The lock is held otherwise: a duplicate launch; exit quietly.
 * - Waiting longer than the handover limit: hand the pid file back, log once,
 *   and exit without connecting. The next launcher call tries again.
 *
 * The pid file and launch reservation are bookkeeping for status and spawn
 * dedupe; they never decide on their own that a daemon may connect.
 */
export async function relayStartupGate(
  coordRoot: string,
  record: RelayPidRecord,
  options: {
    isAlive?: (pid: number) => boolean;
    wait?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
    nowMs?: () => number;
    /** The launch reservation this daemon was started under. */
    reservationToken?: string;
    lockEndpoint?: string;
    acquire?: (endpoint: string) => Promise<InstanceLock | null>;
    log?: (phase: string, message: string) => void;
  } = {},
): Promise<RelayStartup> {
  const isAlive = options.isAlive ?? pidAlive;
  const now = options.nowMs ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const token = options.reservationToken ?? inheritedReservationToken();
  const endpoint = options.lockEndpoint ?? relayInstanceLockEndpoint(coordRoot);
  const acquire =
    options.acquire ??
    ((path: string) =>
      acquireInstanceLock(path, { fallback: relayInstanceLockFallback(coordRoot) }));
  const log =
    options.log ??
    ((phase: string, message: string) =>
      appendPresenceRelayDiagnostic(coordRoot, "relay.lifecycle", { phase, message }));
  // A Unix socket lock lives in this directory.
  mkdirSync(presenceDir(coordRoot), { recursive: true });
  const deadline = now() + (options.timeoutMs ?? RELAY_HANDOVER_WAIT_MS);
  const previous = readRelayPidRecord(coordRoot);
  const ownsPidFile = () => readRelayPidRecord(coordRoot)?.pid === record.pid;
  const previousLive = previous !== null && previous.pid !== record.pid && isAlive(previous.pid);
  let lock = await acquire(endpoint);
  if (!lock) {
    const replacing =
      previousLive &&
      previous.state !== "handover" &&
      record.code !== undefined &&
      codeIdentityReplacementNeeded(previous.code, record.code);
    if (!replacing) {
      log("duplicate", "another relay daemon holds the instance lock; exiting");
      releaseRelayLaunchReservation(coordRoot, token);
      return { outcome: "duplicate" };
    }
  }
  if (!previousLive) {
    atomicWriteJson(pidFilePath(coordRoot), { ...record, state: "connected" });
    releaseRelayLaunchReservation(coordRoot, token);
    return { outcome: "connect", ...(lock ? { lock } : {}) };
  }
  atomicWriteJson(pidFilePath(coordRoot), { ...record, state: "handover" });
  for (;;) {
    if (lock && !isAlive(previous.pid)) {
      atomicWriteJson(pidFilePath(coordRoot), { ...record, state: "connected" });
      releaseRelayLaunchReservation(coordRoot, token);
      return { outcome: "connect", lock };
    }
    if (!ownsPidFile()) {
      await lock?.close();
      releaseRelayLaunchReservation(coordRoot, token);
      return { outcome: "superseded" };
    }
    if (now() >= deadline) break;
    refreshRelayLaunchReservation(coordRoot, token, now());
    await wait(250);
    lock ??= await acquire(endpoint);
  }
  await lock?.close();
  // The previous daemon still runs (stalled, or too old to notice): give its
  // pid file back rather than connect beside it.
  if (ownsPidFile()) atomicWriteJson(pidFilePath(coordRoot), previous);
  log("handover_timeout", `previous daemon pid ${previous.pid} did not exit; not connecting`);
  releaseRelayLaunchReservation(coordRoot, token);
  return { outcome: "gave_up" };
}

/** Same daemon generation: the same pid started at the same moment, or both absent. */
function samePidOwner(a: RelayPidRecord | null, b: RelayPidRecord | null): boolean {
  if (a === null || b === null) return a === b;
  return a.pid === b.pid && a.started_at === b.started_at;
}

export type RelayTickDecision = "continue" | "superseded" | "code_changed" | "idle_exit";

/**
 * What the daemon's 60 s lifecycle tick does next. A superseded pid file wins
 * (another daemon already took over), then a confirmed code change, then the
 * idle exit.
 */
export function relayTickDecision(input: {
  record: RelayPidRecord | null;
  pid: number;
  codeChange: CodeIdentityChange | null;
  idleSince: number | null;
  nowMs: number;
}): RelayTickDecision {
  if (!input.record || input.record.pid !== input.pid) return "superseded";
  if (input.codeChange) return "code_changed";
  if (input.idleSince !== null && input.nowMs - input.idleSince > IDLE_EXIT_MS) return "idle_exit";
  return "continue";
}

/** Foreground daemon loop (spawned detached by ensureRelayDaemon). */
export async function runRelayDaemon(
  coordRoot: string,
  options: { codeWatch?: CodeChangeWatch } = {},
): Promise<number> {
  const codeWatch = options.codeWatch ?? watchCodeIdentity();
  const url = presenceRelayUrl(coordRoot);
  if (!url) {
    const message = "relay-daemon: no relay configured (presence.relay)";
    console.error(message);
    if (coordEnv("SHARED_LOGS") !== "0") {
      appendPresenceRelayDiagnostic(coordRoot, "relay.configuration_error", { message });
    }
    await closeProcessLoggers();
    return 2;
  }
  if (typeof WebSocket === "undefined") {
    const message = "relay-daemon: no global WebSocket in this runtime (need Bun or Node >= 21)";
    console.error(message);
    if (coordEnv("SHARED_LOGS") !== "0") {
      appendPresenceRelayDiagnostic(coordRoot, "relay.runtime_error", { message });
    }
    await closeProcessLoggers();
    return 2;
  }
  const sha = rootCommitSha(coordRoot);
  const origin = originUrl(coordRoot);
  if (!sha || !origin) {
    const message = "relay-daemon: repo has no commits or no origin remote";
    console.error(message);
    if (coordEnv("SHARED_LOGS") !== "0") {
      appendPresenceRelayDiagnostic(coordRoot, "relay.repository_error", { message });
    }
    await closeProcessLoggers();
    return 2;
  }

  // Hold the project's relay instance lock before opening the socket or the
  // watcher, for this daemon's whole life. The operating system releases it
  // when the process exits, so at most one daemon is ever connected.
  const startup = await relayStartupGate(coordRoot, {
    pid: process.pid,
    url,
    started_at: new Date().toISOString(),
    code: codeWatch.initial,
  });
  if (startup.outcome !== "connect") {
    await closeProcessLoggers();
    return 0;
  }
  const instanceLock = startup.lock;

  const creds = await deriveRoomCredentials({
    rootCommitSha: sha,
    originUrl: origin,
    salt: readRoomSalt(coordRoot),
  });
  const machine = sanitizeRefComponent(resolveMachineLabel());
  const senderId = await computeSenderId(creds, machine);
  const wsUrl = `${url.replace(/\/+$/, "")}/v1/room/${creds.roomId}`;

  let ws: WebSocket | null = null;
  let reconnect: ReconnectState = initialReconnectState();
  let lastBasisHash = "";
  let lastSentAt = 0;
  let idleSince: number | null = null;
  let shuttingDown = false;

  // `phase` gives `presence relay-status` a stable key; older records carry
  // only the message.
  const log = (
    msg: string,
    phase: string,
    event = "relay.lifecycle",
    extra: Record<string, unknown> = {},
  ) => {
    console.log(relayDaemonLogLine(new Date(), msg));
    if (coordEnv("SHARED_LOGS") !== "0") {
      appendPresenceRelayDiagnostic(coordRoot, event, { phase, message: msg, ...extra });
    }
  };

  const publishNow = async (force = false): Promise<void> => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const { blob, basisHash, json } = buildPresenceBlob(coordRoot);
      const keepaliveDue = Date.now() - lastSentAt >= KEEPALIVE_MS;
      if (!force && basisHash === lastBasisHash && !keepaliveDue) return;
      const enc = await encryptPayload(creds, json);
      ws.send(JSON.stringify({ t: "pub", sender: senderId, ...enc }));
      lastBasisHash = basisHash;
      lastSentAt = Date.now();
      idleSince = blob.agents.length === 0 ? (idleSince ?? Date.now()) : null;
    } catch {
      /* next trigger retries */
    }
  };

  const handleFrame = async (raw: string): Promise<void> => {
    const frame = parseRelayFrame(raw);
    if (frame?.t !== "pub") return;
    if (frame.sender === senderId) return; // our own warm-join echo
    const pt = await decryptPayload(creds, frame);
    if (!pt) return;
    let blob: PresenceBlob;
    try {
      blob = JSON.parse(pt) as PresenceBlob;
    } catch {
      return;
    }
    if (blob?.v !== 1 || typeof blob.machine !== "string") return;
    const m = sanitizeRefComponent(blob.machine);
    if (m === machine) return;
    try {
      atomicWriteJson(join(remoteCacheDir(coordRoot), `${m}.json`), blob);
    } catch {
      /* best-effort */
    }
  };

  const connect = (): void => {
    if (shuttingDown) return;
    // Per-socket facts for the disconnect record. An error is folded into
    // the close that follows it, so each socket writes at most one record and
    // the reconnect throttle covers errors too.
    let openedAt: number | null = null;
    let socketError: string | undefined;
    let ended = false;
    const scheduleReconnect = (code: number | null, reason: string, wasClean: boolean) => {
      if (ended) return;
      ended = true;
      if (shuttingDown) return;
      const plan = planReconnect(reconnect, {
        code,
        reason,
        wasClean,
        openedAt,
        closedAt: Date.now(),
        error: socketError,
      });
      reconnect = plan.next;
      if (plan.log) {
        const { phase, message, ...fields } = plan.log;
        log(String(message), String(phase), "relay.disconnected", fields);
      }
      setTimeout(connect, plan.delayMs);
    };
    try {
      const sock = new WebSocket(wsUrl);
      ws = sock;
      sock.onopen = () => {
        openedAt = Date.now();
        log(`connected room=${creds.roomId.slice(0, 8)}… as ${machine}`, "connected");
        void publishNow(true);
      };
      sock.onmessage = (ev) => {
        void handleFrame(String(ev.data));
      };
      sock.onclose = (ev) => {
        scheduleReconnect(ev.code, ev.reason ?? "", ev.wasClean);
      };
      sock.onerror = (ev) => {
        socketError ??= errorText(ev);
        try {
          sock.close();
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      socketError = e instanceof Error ? e.message : String(e);
      scheduleReconnect(null, "", false);
    }
  };

  connect();

  // Publish on canonical V3 ledger change (debounced).
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const activeLedger = eventV3ActiveWatchPath(coordRoot);
  try {
    watch(activeLedger, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void publishNow(), WATCH_DEBOUNCE_MS);
    });
  } catch {
    /* keepalive interval still covers publication */
  }

  // Superseded by a newer daemon → close the socket and exit, so the
  // successor (which waits for this process to exit) can connect.
  const exitSuperseded = (): void => {
    log("pid file superseded; exiting", "superseded");
    shuttingDown = true;
    clearInterval(interval);
    clearInterval(supersedeCheck);
    try {
      ws?.close(1000, "superseded");
    } catch {
      /* ignore */
    }
    void Promise.allSettled([instanceLock?.close(), closeProcessLoggers()]).finally(() =>
      process.exit(0),
    );
  };

  // A successor takes the pid file and waits for this process to go; notice
  // within seconds rather than at the next minute tick.
  const supersedeCheck = setInterval(() => {
    if (shuttingDown) return;
    if (readRelayPidRecord(coordRoot)?.pid !== process.pid) exitSuperseded();
  }, SUPERSEDE_CHECK_MS);

  // Keepalive + lifecycle checks.
  const interval = setInterval(() => {
    if (shuttingDown) return;
    void publishNow();
    const codeChange = codeWatch.poll();
    const decision = relayTickDecision({
      record: readRelayPidRecord(coordRoot),
      pid: process.pid,
      codeChange,
      idleSince,
      nowMs: Date.now(),
    });
    if (decision === "superseded") {
      exitSuperseded();
      return;
    }
    // The installed code moved on → close cleanly, hand the pid file to a
    // daemon started from the new code, and exit.
    if (decision === "code_changed" && codeChange) {
      log(codeChangeMessage(codeChange), "code_changed", "relay.lifecycle", {
        from_code: codeChange.from,
        to_code: codeChange.to,
      });
      shuttingDown = true;
      clearInterval(interval);
      clearInterval(supersedeCheck);
      try {
        ws?.close(1000, "code changed");
      } catch {
        /* ignore */
      }
      // Keep the pid file: the successor takes it over and connects only
      // once this process has exited, and the launch reservation keeps a
      // racing hook from starting a second one.
      ensureRelayDaemon(coordRoot);
      void Promise.allSettled([instanceLock?.close(), closeProcessLoggers()]).finally(() =>
        process.exit(0),
      );
      return;
    }
    // Idle machine (no live sessions for a while) → exit; hooks restart us.
    if (decision === "idle_exit") {
      log("no live sessions; idle exit", "idle_exit");
      shuttingDown = true;
      clearInterval(interval);
      clearInterval(supersedeCheck);
      try {
        rmSync(pidFilePath(coordRoot), { force: true });
        ws?.close();
      } catch {
        /* ignore */
      }
      void Promise.allSettled([instanceLock?.close(), closeProcessLoggers()]).finally(() =>
        process.exit(0),
      );
    }
  }, KEEPALIVE_MS);

  // Never resolves in normal operation; exits happen above.
  return await new Promise<number>(() => {});
}

/** Best-effort text of a WebSocket error event (Bun and Node attach `message`). */
function errorText(ev: Event): string {
  const m = (ev as Event & { message?: unknown; error?: unknown }).message;
  if (typeof m === "string" && m) return m;
  const err = (ev as Event & { error?: unknown }).error;
  if (err instanceof Error && err.message) return err.message;
  return ev.type || "error";
}

export function appendPresenceRelayDiagnostic(
  coordRoot: string,
  event: string,
  fields: Record<string, unknown> = {},
): "shared" | "legacy" {
  if (coordEnv("SHARED_LOGS") !== "0") {
    try {
      const logger = processLogger(coordRoot, "presence-relay");
      if (event.includes("error")) logger.error(event, legacyLogFields(fields));
      else logger.info(event, legacyLogFields(fields));
      return "shared";
    } catch {
      // Bootstrap failures retain a bounded text file for process diagnostics.
    }
  }
  const sink = new RotatingTextSink({
    path: relayLegacyLogPath(coordRoot),
    max_bytes: 512 * 1_024,
  });
  sink.append(
    `${JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), event, ...fields })}\n`,
  );
  sink.close();
  return "legacy";
}

/** Daemon status for `presence peers`/doctor surfaces. */
export function relayDaemonStatus(coordRoot: string): {
  running: boolean;
  pid?: number;
  url?: string;
  started_at?: string;
} {
  const rec = readRelayPidRecord(coordRoot);
  if (rec && pidAlive(rec.pid)) {
    return { running: true, pid: rec.pid, url: rec.url, started_at: rec.started_at };
  }
  return { running: false };
}

/**
 * The daemon's stdout line. With shared logs off (`HARNERY_SHARED_LOGS=0`),
 * stdout is redirected to the legacy text log and this line is the only
 * record of the event, so `presence relay-status` parses this exact shape.
 */
export function relayDaemonLogLine(at: Date, message: string): string {
  return `[${at.toISOString()}] ${message}`;
}
