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
// Toolkit tier: this module must not import src/core (layering check).

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coordEnv } from "./env.ts";

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
}

export interface AdmissionEntry {
  pid: number;
  label: string;
  created_at: string;
  /** Set on holders once admitted. */
  acquired_at?: string;
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
}

export interface AdmissionHandle {
  /** The held entry's filename (diagnostics). */
  entry: string;
  /** Milliseconds spent waiting in the queue. */
  waitedMs: number;
  /** Give the slot back. Safe to call more than once. */
  release: () => void;
}

export class AdmissionTimeoutError extends Error {
  readonly holders: AdmissionEntry[];
  constructor(resource: string, timeoutMs: number, holders: AdmissionEntry[]) {
    const labels = holders.map((holder) => `${holder.label} (pid ${holder.pid})`).join(", ");
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

const DEFAULT_POLL_MS = 500;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
/** An unparseable entry younger than this is left alone (it may be mid-write
 * by a non-atomic writer); older, it is torn garbage and gets pruned. */
const UNPARSEABLE_GRACE_MS = 60 * 1000;

/** Is a PID alive on this machine? EPERM counts as alive; only ESRCH counts
 * as dead (fail toward respecting holders rather than stealing slots). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM = exists but not ours = alive. ESRCH (and anything else) = treat
    // as dead only on ESRCH; unknown errors count as alive (fail toward
    // respecting holders rather than stealing their slot).
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

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
function listLive(dir: string, ttlMs: number): LiveEntry[] {
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
    if (!pidAlive(entry.pid) || Number.isNaN(age) || age > ttlMs) {
      try {
        unlinkSync(path);
      } catch {
        // a peer pruned it first
      }
      continue;
    }
    live.push({ name, entry });
  }
  return live;
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

  const myEntry: AdmissionEntry = {
    pid: process.pid,
    label: options.label,
    created_at: new Date().toISOString(),
  };
  const myName = `${String(Date.now()).padStart(13, "0")}-${process.pid}-${randomUUID().slice(0, 8)}.json`;
  writeEntry(tickets, myName, myEntry);

  const startedWaiting = Date.now();
  const deadline = startedWaiting + timeoutMs;
  try {
    while (true) {
      const liveHeld = listLive(held, ttlMs);
      const liveTickets = listLive(tickets, ttlMs);
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
        const heldNow = listLive(held, ttlMs);
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
        writeEntry(held, myName, { ...myEntry, acquired_at: new Date().toISOString() });
        let released = false;
        return {
          entry: myName,
          waitedMs: Date.now() - startedWaiting,
          release: () => {
            if (released) return;
            released = true;
            try {
              unlinkSync(join(held, myName));
            } catch {
              // already pruned
            }
          },
        };
      }
      options.onWait?.({
        position: myIndex + 1,
        holders: liveHeld.map((holderEntry) => holderEntry.entry),
      });
      if (Date.now() >= deadline) {
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
  config: Pick<AdmissionConfig, "dir" | "resource" | "ttlMs">,
): AdmissionStatus {
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const full: AdmissionConfig = { ...config, capacity: 1 };
  return {
    resource: config.resource,
    holders: listLive(heldDir(full), ttlMs).map((holderEntry) => holderEntry.entry),
    waiters: listLive(ticketsDir(full), ttlMs).map((ticket) => ticket.entry),
  };
}

/**
 * Base directory for admission queue state. tmpdir clears on reboot, which
 * is correct — stale queue state must not outlive the boot. Override with
 * HARNERY_ADMISSION_DIR. Host CLIs and harn commands must share this helper
 * so they join the same machine-wide queues.
 */
export function admissionBaseDir(): string {
  return coordEnv("ADMISSION_DIR") ?? join(tmpdir(), "harnery-admission");
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
