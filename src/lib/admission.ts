// Machine-wide admission control for heavy jobs (browser QA matrices,
// production builds): a crash-safe FIFO slot queue with no daemon and no
// distributed-lock pretensions. State is plain files on one machine.
//
// Layout, per resource under a caller-supplied base directory:
//
//   <dir>/<resource>/tickets/<epoch_ms-13pad>-<pid>-<rand>.json   waiters
//   <dir>/<resource>/held/<same filename>.json                    holders
//
// Lexical filename order is enqueue order in BOTH directories. Admission is
// an atomic rename tickets/ → held/. A waiter may rename only when the live
// held count is under capacity AND its ticket is among the first
// (capacity − heldCount) live tickets. After renaming it re-lists held/: if
// live holders exceed capacity and its file is not among the capacity
// lexically-oldest, it renames itself back and rejoins the queue — the
// transient over-admission race self-corrects. Any participant prunes entries
// whose PID is dead or whose age exceeds the TTL. Release unlinks the held
// file; process death leaves a dead-PID file for the next participant to
// prune.
//
// Every ticket that ends (released, timed out, or pruned after its process
// died) appends one record to the admission history (admission-history.ts).
//
// Toolkit tier: this module must not import src/core (layering check).

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMISSION_HISTORY_SCHEMA_VERSION,
  type AdmissionHistoryOutcome,
  type AdmissionReleaseResult,
  appendAdmissionHistory,
  resolveAdmissionHistoryDir,
} from "./admission-history.ts";
import { coordEnv } from "./env.ts";
import { processMayBeAlive } from "./process-alive.ts";

export type { AdmissionReleaseResult } from "./admission-history.ts";

export interface AdmissionConfig {
  /** Base directory holding one subdirectory per resource. */
  dir: string;
  /** Resource name, e.g. "browser-qa" or "build". */
  resource: string;
  /** Maximum concurrent holders. */
  capacity: number;
  /** Poll interval while waiting (default 500ms). */
  pollMs?: number;
  /** Entries older than this are pruned regardless of PID (default 6h). */
  ttlMs?: number;
  /**
   * Directory for the slot-use history. Omitted: resolved from the queue
   * directory (see resolveAdmissionHistoryDir). null: record nothing.
   */
  historyDir?: string | null;
}

export interface AdmissionEntry {
  pid: number;
  label: string;
  created_at: string;
  /** Set on holders once admitted. */
  acquired_at?: string;
  /** Working directory of the queueing process. */
  cwd?: string;
  /** Capacity the queueing process asked for. */
  capacity?: number;
  /** Set on holders that had to wait: the holder labels they first waited behind. */
  waited_behind?: string[];
  /** Coordination instance of the agent session that queued, when the caller knows it. */
  instance_id?: string;
  /** Display name of that session, when the caller knows it. */
  agent?: string;
  /**
   * Start time of the queueing process, recorded only where /proc is absent
   * (macOS). There a dead holder's pid can be reused by an unrelated process,
   * which would otherwise keep its ticket alive until the TTL.
   */
  start?: string;
}

export interface AdmissionWaitInfo {
  /** 1-based position in the ticket queue. */
  position: number;
  holders: AdmissionEntry[];
}

export interface AdmissionAcquireOptions {
  /** Human-readable holder description shown in status listings. */
  label: string;
  /** Maximum wait before AdmissionTimeoutError (default 20 minutes). */
  timeoutMs?: number;
  /** Progress callback, invoked at most once per poll while waiting. */
  onWait?: (info: AdmissionWaitInfo) => void;
  /** Time the caller already spent deferring for memory pressure, for the history. */
  pressureWaitMs?: number;
  /**
   * The agent session queueing, resolved by the caller (this module has no
   * view of coordination state). Recorded on the ticket so status listings
   * can name who holds a slot.
   */
  owner?: { instance_id: string; agent?: string };
}

export interface AdmissionHandle {
  /** The held entry's filename (diagnostics). */
  entry: string;
  /** Milliseconds spent waiting in the queue. */
  waitedMs: number;
  /**
   * Give the slot back and record the slot use in the history. Safe to call
   * more than once; only the first call records.
   */
  release: (result?: AdmissionReleaseResult) => void;
}

export class AdmissionTimeoutError extends Error {
  readonly holders: AdmissionEntry[];
  constructor(resource: string, timeoutMs: number, holders: AdmissionEntry[]) {
    const labels = holders.map((holder) => describeAdmissionHolder(holder)).join(", ");
    const seconds =
      timeoutMs < 10_000 ? (timeoutMs / 1000).toFixed(1) : String(Math.round(timeoutMs / 1000));
    super(
      `no ${resource} slot became free within ${seconds}s; ` +
        `current holder(s): ${labels || "none (queue contention)"}`,
    );
    this.name = "AdmissionTimeoutError";
    this.holders = holders;
  }
}

/** `label (agent-Name, pid N)`, naming the agent when the ticket records one. */
export function describeAdmissionHolder(holder: AdmissionEntry): string {
  const who = holder.agent ? `agent-${holder.agent}, ` : "";
  return `${holder.label || "(no label)"} (${who}pid ${holder.pid})`;
}

const DEFAULT_POLL_MS = 500;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
/** An unparseable entry younger than this is left alone (it may be mid-write
 * by a non-atomic writer); older, it is torn garbage and gets pruned. */
const UNPARSEABLE_GRACE_MS = 60 * 1000;

function ticketsDir(config: AdmissionConfig): string {
  return join(config.dir, config.resource, "tickets");
}

function heldDir(config: AdmissionConfig): string {
  return join(config.dir, config.resource, "held");
}

function ensureDirs(config: AdmissionConfig): void {
  mkdirSync(ticketsDir(config), { recursive: true });
  mkdirSync(heldDir(config), { recursive: true });
}

function writeEntry(dir: string, name: string, entry: AdmissionEntry): void {
  const tmp = join(dir, `.${name}.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
  renameSync(tmp, join(dir, name));
}

interface LiveEntry {
  name: string;
  entry: AdmissionEntry;
}

/** List live entries in lexical (= enqueue) order, pruning dead-PID, expired,
 * and torn files as a side effect. Every participant prunes, so a crashed
 * holder's slot frees as soon as anyone else looks. */
type PruneReason = Extract<AdmissionHistoryOutcome, "abandoned" | "expired">;

function listLive(
  dir: string,
  ttlMs: number,
  onPrune?: (entry: AdmissionEntry, reason: PruneReason) => void,
): LiveEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const now = Date.now();
  const live: LiveEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let entry: AdmissionEntry | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.pid === "number" && typeof record.created_at === "string") {
          entry = {
            pid: record.pid,
            label: typeof record.label === "string" ? record.label : "",
            created_at: record.created_at,
            ...(typeof record.acquired_at === "string" ? { acquired_at: record.acquired_at } : {}),
            ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
            ...(typeof record.capacity === "number" ? { capacity: record.capacity } : {}),
            ...(typeof record.start === "string" ? { start: record.start } : {}),
            ...(typeof record.instance_id === "string" ? { instance_id: record.instance_id } : {}),
            ...(typeof record.agent === "string" ? { agent: record.agent } : {}),
            ...(Array.isArray(record.waited_behind)
              ? {
                  waited_behind: record.waited_behind.filter(
                    (label): label is string => typeof label === "string",
                  ),
                }
              : {}),
          };
        }
      }
    } catch {
      // fall through: unparseable
    }
    if (!entry) {
      // Torn or foreign file: prune once it is clearly not mid-write. The
      // enqueue timestamp is the filename prefix, so age is known without
      // content.
      const stamp = Number.parseInt(name.slice(0, 13), 10);
      if (!Number.isFinite(stamp) || now - stamp > UNPARSEABLE_GRACE_MS) {
        try {
          unlinkSync(path);
        } catch {
          // a peer pruned it first
        }
      }
      continue;
    }
    const age = now - Date.parse(entry.created_at);
    const dead = !processMayBeAlive(entry.pid) || holderPidReused(entry);
    if (dead || Number.isNaN(age) || age > ttlMs) {
      let pruned = false;
      try {
        unlinkSync(path);
        pruned = true;
      } catch {
        // a peer pruned it first, and records it
      }
      if (pruned) onPrune?.(entry, dead ? "abandoned" : "expired");
      continue;
    }
    live.push({ name, entry });
  }
  return live;
}

function historyDirFor(config: Pick<AdmissionConfig, "dir" | "historyDir">): string | null {
  return config.historyDir !== undefined
    ? config.historyDir
    : resolveAdmissionHistoryDir(config.dir);
}

/** Record an entry a participant pruned because its process died or it expired. */
function recordPruned(
  historyDir: string | null,
  resource: string,
  entry: AdmissionEntry,
  reason: PruneReason,
): void {
  if (!historyDir) return;
  const now = Date.now();
  const enqueuedMs = Date.parse(entry.created_at);
  const acquiredMs = entry.acquired_at ? Date.parse(entry.acquired_at) : Number.NaN;
  appendAdmissionHistory(historyDir, {
    v: ADMISSION_HISTORY_SCHEMA_VERSION,
    resource,
    label: entry.label,
    pid: entry.pid,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(entry.capacity !== undefined ? { capacity: entry.capacity } : {}),
    outcome: reason,
    enqueued_at: entry.created_at,
    ...(entry.acquired_at ? { acquired_at: entry.acquired_at } : {}),
    ended_at: new Date(now).toISOString(),
    wait_ms: Number.isNaN(enqueuedMs)
      ? 0
      : Math.max(0, (Number.isNaN(acquiredMs) ? now : acquiredMs) - enqueuedMs),
    ...(Number.isNaN(acquiredMs) ? {} : { hold_ms: Math.max(0, now - acquiredMs) }),
    ...(entry.waited_behind?.length ? { waited_behind: entry.waited_behind } : {}),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Join the FIFO queue for one resource and resolve once a slot is held.
 * Throws AdmissionTimeoutError (with the holders snapshot) when no slot
 * frees within the timeout — the caller decides whether that is fatal.
 */
export async function acquireAdmission(
  config: AdmissionConfig,
  options: AdmissionAcquireOptions,
): Promise<AdmissionHandle> {
  if (!Number.isInteger(config.capacity) || config.capacity < 1) {
    throw new Error(`admission capacity must be a positive integer, got ${config.capacity}`);
  }
  ensureDirs(config);
  const pollMs = config.pollMs ?? DEFAULT_POLL_MS;
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tickets = ticketsDir(config);
  const held = heldDir(config);

  const historyDir = historyDirFor(config);
  const onPrune = (entry: AdmissionEntry, reason: PruneReason): void =>
    recordPruned(historyDir, config.resource, entry, reason);
  const myEntry: AdmissionEntry = {
    pid: process.pid,
    label: options.label,
    created_at: new Date().toISOString(),
    cwd: process.cwd(),
    capacity: config.capacity,
    ...(options.owner ? { instance_id: options.owner.instance_id } : {}),
    ...(options.owner?.agent ? { agent: options.owner.agent } : {}),
  };
  const start = holderStartToken(process.pid);
  if (start) myEntry.start = start;
  let waitedBehind: string[] | undefined;
  const pressureWait = options.pressureWaitMs ? { pressure_wait_ms: options.pressureWaitMs } : {};
  const myName = `${String(Date.now()).padStart(13, "0")}-${process.pid}-${randomUUID().slice(0, 8)}.json`;
  writeEntry(tickets, myName, myEntry);

  const startedWaiting = Date.now();
  const deadline = startedWaiting + timeoutMs;
  try {
    while (true) {
      const liveHeld = listLive(held, ttlMs, onPrune);
      const liveTickets = listLive(tickets, ttlMs, onPrune);
      const myIndex = liveTickets.findIndex((ticket) => ticket.name === myName);
      if (myIndex === -1) {
        // Pruned by a peer (should not happen while we are alive) or lost to
        // a race; re-enqueue at the back rather than failing the caller.
        writeEntry(tickets, myName, myEntry);
        await sleep(pollMs);
        continue;
      }
      const free = config.capacity - liveHeld.length;
      if (free > 0 && myIndex < free) {
        renameSync(join(tickets, myName), join(held, myName));
        // Verify: the rename can transiently over-admit when a slot freed
        // between two waiters' listings. Lexical order (= enqueue order)
        // decides who stays; the loser rejoins the queue with its original
        // priority because the filename keeps its enqueue timestamp.
        const heldNow = listLive(held, ttlMs, onPrune);
        if (heldNow.length > config.capacity) {
          const keepers = new Set(
            heldNow.slice(0, config.capacity).map((holderEntry) => holderEntry.name),
          );
          if (!keepers.has(myName)) {
            renameSync(join(held, myName), join(tickets, myName));
            await sleep(pollMs);
            continue;
          }
        }
        const acquiredAt = new Date();
        writeEntry(held, myName, { ...myEntry, acquired_at: acquiredAt.toISOString() });
        const waitedMs = acquiredAt.getTime() - startedWaiting;
        let released = false;
        return {
          entry: myName,
          waitedMs,
          release: (result?: AdmissionReleaseResult) => {
            if (released) return;
            released = true;
            try {
              unlinkSync(join(held, myName));
            } catch {
              // already pruned
            }
            const endedAt = new Date();
            appendAdmissionHistory(historyDir, {
              v: ADMISSION_HISTORY_SCHEMA_VERSION,
              resource: config.resource,
              label: myEntry.label,
              pid: myEntry.pid,
              ...(myEntry.cwd ? { cwd: myEntry.cwd } : {}),
              capacity: config.capacity,
              outcome: "released",
              enqueued_at: myEntry.created_at,
              acquired_at: acquiredAt.toISOString(),
              ended_at: endedAt.toISOString(),
              wait_ms: waitedMs,
              hold_ms: endedAt.getTime() - acquiredAt.getTime(),
              ...(waitedBehind?.length ? { waited_behind: waitedBehind } : {}),
              ...pressureWait,
              ...(result?.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
              ...(result?.signal !== undefined ? { signal: result.signal } : {}),
            });
          },
        };
      }
      if (waitedBehind === undefined) {
        // Persist who this ticket waits behind, so the record survives even
        // if this process dies in the queue and a peer prunes the ticket.
        waitedBehind = liveHeld.map((holderEntry) => holderEntry.entry.label);
        myEntry.waited_behind = waitedBehind;
        writeEntry(tickets, myName, myEntry);
      }
      options.onWait?.({
        position: myIndex + 1,
        holders: liveHeld.map((holderEntry) => holderEntry.entry),
      });
      if (Date.now() >= deadline) {
        const endedAt = new Date();
        appendAdmissionHistory(historyDir, {
          v: ADMISSION_HISTORY_SCHEMA_VERSION,
          resource: config.resource,
          label: myEntry.label,
          pid: myEntry.pid,
          ...(myEntry.cwd ? { cwd: myEntry.cwd } : {}),
          capacity: config.capacity,
          outcome: "timeout",
          enqueued_at: myEntry.created_at,
          ended_at: endedAt.toISOString(),
          wait_ms: endedAt.getTime() - startedWaiting,
          ...(waitedBehind?.length ? { waited_behind: waitedBehind } : {}),
          ...pressureWait,
        });
        throw new AdmissionTimeoutError(
          config.resource,
          timeoutMs,
          liveHeld.map((holderEntry) => holderEntry.entry),
        );
      }
      await sleep(pollMs);
    }
  } finally {
    // On any non-admitted exit (timeout, caller abort via throw), leave no
    // ticket behind. A successful acquire has already moved the file out.
    try {
      unlinkSync(join(tickets, myName));
    } catch {
      // admitted (file moved) or already pruned
    }
  }
}

export interface AdmissionStatus {
  resource: string;
  capacity?: number;
  holders: AdmissionEntry[];
  waiters: AdmissionEntry[];
}

/** Snapshot the queue for one resource, pruning dead entries on the way. */
export function admissionStatus(
  config: Pick<AdmissionConfig, "dir" | "resource" | "ttlMs" | "historyDir">,
): AdmissionStatus {
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const full: AdmissionConfig = { ...config, capacity: 1 };
  const historyDir = historyDirFor(config);
  const onPrune = (entry: AdmissionEntry, reason: PruneReason): void =>
    recordPruned(historyDir, config.resource, entry, reason);
  return {
    resource: config.resource,
    holders: listLive(heldDir(full), ttlMs, onPrune).map((holderEntry) => holderEntry.entry),
    waiters: listLive(ticketsDir(full), ttlMs, onPrune).map((ticket) => ticket.entry),
  };
}

/**
 * Base directory for admission queue state. The temp directory clears on
 * reboot, which is correct: stale queue state must not outlive the boot.
 * Override with HARNERY_ADMISSION_DIR. Host CLIs and harn commands must share
 * this helper so they join the same machine-wide queues.
 *
 * On POSIX the default is the literal /tmp, not os.tmpdir(): agent sandboxes
 * often set a private TMPDIR per session, and a queue under it would admit
 * every session on its own.
 */
export function admissionBaseDir(): string {
  return (
    coordEnv("ADMISSION_DIR") ??
    (process.platform === "win32" ? join(tmpdir(), "harnery-admission") : "/tmp/harnery-admission")
  );
}

/**
 * Linux memory pressure: the `full avg10` figure from /proc/pressure/memory,
 * the share of the last ten seconds in which every runnable task stalled on
 * memory. Undefined where pressure stall information is unavailable.
 */
export function memoryPressureFullAvg10(): number | undefined {
  try {
    const line = readFileSync("/proc/pressure/memory", "utf8")
      .split("\n")
      .find((candidate) => candidate.startsWith("full"));
    const match = line ? /avg10=([0-9.]+)/.exec(line) : null;
    return match?.[1] !== undefined ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export interface PressureWaitOptions {
  /** Defer while `full avg10` is above this value. */
  threshold: number;
  /** Give up deferring after this long and let the caller start anyway. */
  maxWaitMs: number;
  pollMs?: number;
  /** Pressure reader; tests inject one. */
  read?: () => number | undefined;
  /** Called once when deferral starts and once if it gives up. */
  onWait?: (event: { pressure: number; waitedMs: number; gaveUp: boolean }) => void;
}

/**
 * Wait, holding no slot, while the machine is already stalling on memory, so
 * a heavy job does not start into a storm. Never blocks forever: after
 * maxWaitMs it returns and the caller starts anyway. Returns the time waited.
 */
export async function waitForMemoryPressure(options: PressureWaitOptions): Promise<number> {
  const read = options.read ?? memoryPressureFullAvg10;
  const pollMs = options.pollMs ?? 5_000;
  const started = Date.now();
  let announced = false;
  while (true) {
    const pressure = read();
    if (pressure === undefined || pressure <= options.threshold) return Date.now() - started;
    const waitedMs = Date.now() - started;
    if (waitedMs + pollMs > options.maxWaitMs) {
      options.onWait?.({ pressure, waitedMs, gaveUp: true });
      return waitedMs;
    }
    if (!announced) {
      announced = true;
      options.onWait?.({ pressure, waitedMs, gaveUp: false });
    }
    await sleep(pollMs);
  }
}

/** Resources present under an admission base directory. */
export function listAdmissionResources(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Read a process start time; null when it cannot be read. */
export type AdmissionStartReader = (pid: number) => string | null;

/**
 * Whether ticket holders are identified by start time as well as pid. Only
 * where Linux /proc is absent; Linux keeps the plain pid check.
 */
export function admissionStartIdentityApplies(): boolean {
  return process.platform !== "win32" && !existsSync("/proc/self/stat");
}

/**
 * `ps -o lstart=` with the timezone and locale pinned, so every reader
 * renders the same instant the same way.
 */
const psStartReader: AdmissionStartReader = (pid) => {
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    const value = out.status === 0 ? out.stdout.split("\n")[0]?.trim().replace(/\s+/g, " ") : "";
    return value ? value : null;
  } catch {
    return null;
  }
};

/** The start token to record for `pid`, or undefined where none applies. */
export function holderStartToken(
  pid: number,
  applies: boolean = admissionStartIdentityApplies(),
  read: AdmissionStartReader = psStartReader,
): string | undefined {
  return applies ? (read(pid) ?? undefined) : undefined;
}

/** Live holders already confirmed, so a waiter does not spawn ps on every poll. */
const confirmedHolders = new Map<string, number>();
const CONFIRM_TTL_MS = 30_000;

/**
 * True only when the entry recorded a start time and the live process now
 * on that pid started at a different time: the holder died and its pid was
 * reused. An unreadable start time counts as the same process.
 */
export function holderPidReused(
  entry: Pick<AdmissionEntry, "pid" | "start">,
  applies: boolean = admissionStartIdentityApplies(),
  read: AdmissionStartReader = psStartReader,
  now: number = Date.now(),
): boolean {
  if (!applies || !entry.start) return false;
  const key = `${entry.pid}:${entry.start}`;
  const confirmed = confirmedHolders.get(key);
  if (confirmed !== undefined && now - confirmed < CONFIRM_TTL_MS) return false;
  const current = read(entry.pid);
  if (current === null) return false;
  if (current !== entry.start) {
    confirmedHolders.delete(key);
    return true;
  }
  if (confirmedHolders.size > 1_000) confirmedHolders.clear();
  confirmedHolders.set(key, now);
  return false;
}
