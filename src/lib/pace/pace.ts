import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Human-pace gate for page loads.
 *
 * Every Harnery surface that loads a web page (`browse`, `browse-ai`, `fetch`,
 * and the headed browse-session verbs) reserves a slot here before the request
 * goes out. Consecutive loads against the same registrable site are spaced by
 * a random gap inside `[minMs, maxMs]`, the way a person reads one page before
 * opening the next. Loads against different sites do not wait on each other.
 * Loopback, private-network, single-label, and reserved-suffix hosts are exempt
 * so local development and page QA keep running at machine speed.
 *
 * The ledger is a small machine-local JSON file (`~/.cache/harnery/pace.json`)
 * shared by every process, so separate `harn fetch` calls in a shell loop are
 * paced the same as one long `harn browse` session. A caller reserves the next
 * slot before it sleeps, so concurrent processes queue behind each other
 * instead of all firing at once.
 *
 * The gate is on by default. `HARNERY_PACE=off` disables it machine-wide and
 * each command carries `--no-pace` for a single run.
 */

export const DEFAULT_PACE_MIN_MS = 3_000;
export const DEFAULT_PACE_MAX_MS = 9_000;
export const DEFAULT_PACE_LEDGER = resolve(homedir(), ".cache", "harnery", "pace.json");

/** Entries idle this long drop out of the ledger on the next write. */
const LEDGER_RETENTION_MS = 60 * 60 * 1_000;
/** A lock older than this belongs to a dead process and is reclaimed. */
const LOCK_STALE_MS = 5_000;
/** Total time a reservation waits for the ledger lock before proceeding anyway. */
const LOCK_WAIT_MS = 500;
const LOCK_POLL_MS = 5;

export interface PacePolicy {
  /** False turns the gate into a no-op. Default true. */
  enabled: boolean;
  /** Shortest gap between two loads of the same site, in ms. */
  minMs: number;
  /** Longest gap between two loads of the same site, in ms. */
  maxMs: number;
  /** Extra exempt host suffixes (`example.test` matches itself and `*.example.test`). */
  exemptSuffixes: string[];
  /** Path of the shared reservation ledger. */
  ledgerPath: string;
}

export interface PaceWait {
  /** Registrable site the reservation was made against. */
  site: string;
  /** Milliseconds the caller waited (0 when the slot was free). */
  waitMs: number;
}

export interface PaceGateDeps {
  now?: () => number;
  random?: () => number;
  /** Called after a reservation, whether or not it waited. */
  onWait?: (wait: PaceWait) => void;
}

interface LedgerEntry {
  /** Epoch ms before which the next load of this site must not start. */
  nextAllowedAt: number;
  /** Epoch ms the most recent reservation was granted for. */
  lastAt: number;
}

interface Ledger {
  version: 1;
  sites: Record<string, LedgerEntry>;
}

const OFF_VALUES = new Set(["off", "0", "false", "no", "none"]);

/**
 * Resolve the pace policy from the environment.
 *
 * - `HARNERY_PACE`: `off` (or `0`, `false`, `no`) disables the gate. Unset or
 *   `human` keeps the default.
 * - `HARNERY_PACE_MIN_MS` / `HARNERY_PACE_MAX_MS`: gap bounds in ms. Both must
 *   be non-negative integers with min <= max.
 * - `HARNERY_PACE_EXEMPT`: comma-separated host suffixes that never wait.
 * - `HARNERY_PACE_LEDGER`: ledger path override.
 */
export function pacePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PacePolicy {
  const mode = env.HARNERY_PACE?.trim().toLowerCase();
  if (mode && mode !== "human" && !OFF_VALUES.has(mode)) {
    throw new Error(`HARNERY_PACE must be "human" or "off" (got "${env.HARNERY_PACE}").`);
  }
  const minMs = readMs(env, "HARNERY_PACE_MIN_MS", DEFAULT_PACE_MIN_MS);
  const maxMs = readMs(env, "HARNERY_PACE_MAX_MS", DEFAULT_PACE_MAX_MS);
  if (minMs > maxMs) {
    throw new Error(
      `HARNERY_PACE_MIN_MS (${minMs}) must not exceed HARNERY_PACE_MAX_MS (${maxMs}).`,
    );
  }
  const exemptSuffixes = (env.HARNERY_PACE_EXEMPT ?? "")
    .split(",")
    .map((s) => normalizeHost(s))
    .filter((s): s is string => s !== null);
  return {
    enabled: !(mode && OFF_VALUES.has(mode)),
    minMs,
    maxMs,
    exemptSuffixes,
    ledgerPath: env.HARNERY_PACE_LEDGER?.trim() || DEFAULT_PACE_LEDGER,
  };
}

function readMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${name} must be a non-negative integer number of milliseconds (got "${raw}").`,
    );
  }
  return Number.parseInt(raw, 10);
}

/**
 * Public suffixes that take two labels, so the registrable site is three
 * labels deep (`news.bbc.co.uk` -> `bbc.co.uk`). A short curated list is
 * enough here: the gate only needs sibling hosts of one site to share a key,
 * and a miss degrades to per-hostname pacing, never to no pacing.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "co.kr",
  "co.in",
  "co.za",
  "com.br",
  "com.mx",
  "com.ar",
  "com.cn",
  "com.tw",
  "com.sg",
  "com.tr",
]);

/** Reserved or local-only suffixes that are never paced. */
const EXEMPT_SUFFIXES = ["localhost", "local", "test", "internal", "example", "invalid"];

function normalizeHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.+$/, "");
  return host ? host : null;
}

function hasSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function isExemptIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isExemptIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}

/**
 * Registrable site a URL belongs to for pacing purposes, or `null` when the
 * URL is exempt: a non-HTTP scheme, a loopback or private address, a
 * single-label or reserved-suffix host, or a configured exemption.
 */
export function paceSiteKey(url: string, exemptSuffixes: readonly string[] = []): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = normalizeHost(parsed.hostname);
  if (!host) return null;
  if (host.startsWith("[") || host.includes(":")) return isExemptIpv6(host) ? null : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isExemptIpv4(host) ? null : host;
  for (const suffix of EXEMPT_SUFFIXES) if (hasSuffix(host, suffix)) return null;
  for (const suffix of exemptSuffixes) if (hasSuffix(host, suffix)) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/** Block the current thread for `ms`. Used by clients that drive a child process synchronously. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class PaceGate {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onWait: ((wait: PaceWait) => void) | undefined;

  constructor(
    readonly policy: PacePolicy,
    deps: PaceGateDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.onWait = deps.onWait;
  }

  /** A gate that never waits, for callers that opted out. */
  static disabled(): PaceGate {
    return new PaceGate({ ...pacePolicyFromEnv({}), enabled: false });
  }

  /**
   * Reserve the next slot for `url` without sleeping. Returns how long the
   * caller should wait before loading, or `null` when the URL is exempt or the
   * gate is disabled. The reservation is recorded even when the wait is zero,
   * so the next load of the same site owes a gap.
   */
  reserve(url: string): PaceWait | null {
    if (!this.policy.enabled) return null;
    const site = paceSiteKey(url, this.policy.exemptSuffixes);
    if (!site) return null;
    const now = this.now();
    const gap = this.policy.minMs + this.random() * (this.policy.maxMs - this.policy.minMs);
    let readyAt = now;
    withLedgerLock(this.policy.ledgerPath, this.now, () => {
      const ledger = readLedger(this.policy.ledgerPath);
      readyAt = Math.max(now, ledger.sites[site]?.nextAllowedAt ?? 0);
      for (const [key, entry] of Object.entries(ledger.sites)) {
        if (entry.nextAllowedAt < now - LEDGER_RETENTION_MS) delete ledger.sites[key];
      }
      ledger.sites[site] = { nextAllowedAt: Math.round(readyAt + gap), lastAt: readyAt };
      writeLedger(this.policy.ledgerPath, ledger);
    });
    const wait = { site, waitMs: Math.max(0, Math.round(readyAt - now)) };
    this.onWait?.(wait);
    return wait;
  }

  /** Reserve a slot and wait it out asynchronously. */
  async before(url: string): Promise<PaceWait | null> {
    const wait = this.reserve(url);
    if (wait && wait.waitMs > 0) {
      await new Promise<void>((done) => setTimeout(done, wait.waitMs));
    }
    return wait;
  }

  /** Reserve a slot and block the thread for it. For `spawnSync`-driven clients. */
  beforeSync(url: string): PaceWait | null {
    const wait = this.reserve(url);
    if (wait && wait.waitMs > 0) sleepSync(wait.waitMs);
    return wait;
  }
}

/**
 * Gate for a CLI command run. `null` when the run passed `--no-pace`;
 * otherwise the environment policy, with every non-zero wait reported through
 * `log` so the operator can see why a load took longer.
 */
export function commandPaceGate(optedIn: boolean, log: (message: string) => void): PaceGate | null {
  if (!optedIn) return null;
  return new PaceGate(pacePolicyFromEnv(), {
    onWait: (wait) => {
      if (wait.waitMs > 0) log(describePaceWait(wait));
    },
  });
}

/** Describe a wait for a human-facing log line. */
export function describePaceWait(wait: PaceWait): string {
  const seconds = (wait.waitMs / 1_000).toFixed(1);
  return `paced ${seconds}s before ${wait.site} (human pace; --no-pace or HARNERY_PACE=off skips)`;
}

function readLedger(path: string): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Ledger>;
    if (parsed && parsed.version === 1 && parsed.sites && typeof parsed.sites === "object") {
      const sites: Record<string, LedgerEntry> = {};
      for (const [key, entry] of Object.entries(parsed.sites)) {
        if (
          entry &&
          typeof entry.nextAllowedAt === "number" &&
          Number.isFinite(entry.nextAllowedAt) &&
          typeof entry.lastAt === "number" &&
          Number.isFinite(entry.lastAt)
        ) {
          sites[key] = { nextAllowedAt: entry.nextAllowedAt, lastAt: entry.lastAt };
        }
      }
      return { version: 1, sites };
    }
  } catch {
    // Missing or corrupt ledger: start fresh. A lost ledger costs one unpaced
    // load per site, never a crash.
  }
  return { version: 1, sites: {} };
}

function writeLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Serialize ledger read-modify-write across processes with an exclusive lock
 * file. The lock is best-effort: a stale lock from a dead process is reclaimed,
 * and a caller that cannot get the lock within `LOCK_WAIT_MS` proceeds without
 * it rather than blocking a page load on a bookkeeping file.
 */
function withLedgerLock(path: string, now: () => number, fn: () => void): void {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const start = now();
  let held = false;
  while (!held && now() - start < LOCK_WAIT_MS) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS)
          rmSync(lockPath, { force: true });
      } catch {
        // Lock vanished between the failed open and the stat; retry.
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    fn();
  } finally {
    if (held) rmSync(lockPath, { force: true });
  }
}
