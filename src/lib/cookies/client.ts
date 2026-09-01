import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Shared cookie-store library.
 *
 * Design:
 *   - CDP-native cookie format (matches Playwright/agent-browser output).
 *   - Caller chooses the store path on construction; the harn defaults are
 *     `~/.cache/harnery/cookies.json`. Consumers can point at any path.
 *   - Pure synchronous I/O; the store is small (<1MB typical) so async
 *     buys nothing and complicates the merge-on-write path.
 */

/** CDP-native cookie. `expires === -1` means session cookie / no expiry. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size?: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
  sameSite?: string;
}

export interface OriginEntry {
  origin: string;
  localStorage: { name: string; value: string }[];
}

export interface CookieStore {
  cookies: Cookie[];
  origins: OriginEntry[];
  exportedAt?: string;
  exportedFrom?: string;
}

export interface CookieJarOptions {
  /** Absolute path to the JSON store. Caller must provide. */
  path: string;
  /** `exportedFrom` tag stamped on every save. Defaults to `"harn-cookies"`. */
  source?: string;
}

export interface InfoResult {
  path: string;
  exists: boolean;
  bytes: number;
  active: number;
  expired: number;
  total: number;
  domains: string[];
  origins: number;
  exportedAt?: string;
  exportedFrom?: string;
}

export class CookieStoreParseError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Cookie-store parse failed at "${path}" after a stable read: ${detail}. ` +
        "The original cookie-store file was left unchanged.",
      { cause },
    );
    this.name = "CookieStoreParseError";
    this.path = path;
  }
}

const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 10;
const STABLE_READ_ATTEMPTS = 5;
const STABLE_READ_POLL_MS = 10;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

interface FileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function snapshot(path: string): FileSnapshot {
  const stat = statSync(path);
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readStableFile(path: string): string | undefined {
  for (let attempt = 1; attempt <= STABLE_READ_ATTEMPTS; attempt++) {
    let before: FileSnapshot;
    try {
      before = snapshot(path);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }

    try {
      const raw = readFileSync(path, "utf8");
      const after = snapshot(path);
      if (sameSnapshot(before, after)) return raw;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }

    if (attempt < STABLE_READ_ATTEMPTS) sleepSync(STABLE_READ_POLL_MS);
  }

  throw new Error(
    `Cookie-store read failed at "${path}": the file did not remain stable across ` +
      `${STABLE_READ_ATTEMPTS} attempts. The original cookie-store file was left unchanged.`,
  );
}

function atomicWrite(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A successful rename already removed the temporary path. A failed
      // cleanup must not hide the original write error.
    }
  }
}

function withStoreLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lockFd: number | undefined;

  while (lockFd === undefined) {
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(
          lockFd,
          `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        );
      } catch (error) {
        closeSync(lockFd);
        lockFd = undefined;
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the lock-write error.
        }
        throw error;
      }
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        if (lockFd !== undefined) closeSync(lockFd);
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Cookie-store update timed out waiting for lock "${lockPath}" after ${LOCK_WAIT_MS}ms. ` +
            "The cookie-store file was left unchanged.",
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }

  closeSync(lockFd);
  try {
    return operation();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // The update has already committed. Do not replace its result with a
      // cleanup error; a later writer will report the exact lock path.
    }
  }
}

export class CookieJar {
  readonly path: string;
  private readonly source: string;

  constructor(opts: CookieJarOptions) {
    this.path = opts.path;
    this.source = opts.source ?? "harn-cookies";
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  load(): CookieStore {
    const raw = readStableFile(this.path);
    if (raw === undefined) return { cookies: [], origins: [] };
    let parsed: CookieStore;
    try {
      parsed = JSON.parse(raw) as CookieStore;
    } catch (error) {
      throw new CookieStoreParseError(this.path, error);
    }
    return {
      cookies: parsed.cookies ?? [],
      origins: parsed.origins ?? [],
      exportedAt: parsed.exportedAt,
      exportedFrom: parsed.exportedFrom,
    };
  }

  /**
   * Persist a store, stamping `exportedAt` (now) and `exportedFrom`
   * (constructor-provided source). Creates the parent directory if needed.
   */
  save(store: CookieStore): void {
    withStoreLock(this.path, () => this.saveUnlocked(store));
  }

  private saveUnlocked(store: CookieStore): CookieStore {
    const stamped = this.stamp(store);
    atomicWrite(this.path, `${JSON.stringify(stamped, null, 2)}\n`);
    return stamped;
  }

  private stamp(store: CookieStore): CookieStore {
    return {
      ...store,
      exportedAt: new Date().toISOString(),
      exportedFrom: this.source,
    };
  }

  private update<T>(operation: (store: CookieStore) => { store: CookieStore; result: T }): T {
    return withStoreLock(this.path, () => {
      const updated = operation(this.load());
      this.saveUnlocked(updated.store);
      return updated.result;
    });
  }

  /**
   * Read + filter helper. Drops expired cookies. Optional domain filter
   * uses the same `domainMatches` logic Playwright/CDP do (leading dot
   * means subdomain match).
   */
  list(filter: { domain?: string } = {}): Cookie[] {
    const store = this.load();
    let cookies = store.cookies.filter((c) => !isExpired(c));
    if (filter.domain) {
      cookies = cookies.filter((c) => domainMatches(c.domain, filter.domain!));
    }
    return cookies;
  }

  /**
   * Set a single cookie, merging into the store on `(name, domain, path)`.
   * Returns the saved store.
   */
  set(cookie: Cookie): CookieStore {
    return this.merge([cookie]);
  }

  /** Merge cookies and origins in one interprocess-coordinated update. */
  merge(cookies: Cookie[], origins: OriginEntry[] = []): CookieStore {
    return this.update((store) => {
      const merged = mergeCookies(store, cookies);
      const byOrigin = new Map(store.origins.map((origin) => [origin.origin, origin]));
      for (const origin of origins) byOrigin.set(origin.origin, origin);
      merged.origins = [...byOrigin.values()];
      return { store: merged, result: merged };
    });
  }

  /**
   * Clear cookies. Pass `{ all: true }` to wipe everything (including
   * origins/localStorage), or `{ domain: "..." }` to drop matching cookies
   * + origins. Returns counts before/after.
   */
  clear(opts: { domain?: string; all?: boolean }): { before: number; after: number } {
    if (!opts.domain && !opts.all) {
      throw new Error("Specify { domain } or { all: true }");
    }
    return this.update((store) => {
      const before = store.cookies.length;
      if (opts.all) {
        store.cookies = [];
        store.origins = [];
      } else if (opts.domain) {
        const dom = opts.domain;
        store.cookies = store.cookies.filter((c) => !domainMatches(c.domain, dom));
        store.origins = store.origins.filter((o) => {
          try {
            return !domainMatches(dom, new URL(o.origin).hostname);
          } catch {
            return true;
          }
        });
      }
      return {
        store,
        result: { before, after: store.cookies.length },
      };
    });
  }

  /**
   * Build a `Cookie:` header value for a URL. Only cookies that match
   * domain + path + secure rules are included. Returns `""` when nothing
   * matches.
   */
  header(url: string): string {
    const store = this.load();
    const cookies = matchingCookies(store, url);
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /**
   * Import cookies from a JSON file. Accepts three shapes:
   *   - `{ cookies: [...] }` (CDP/agent-browser native)
   *   - `{ data: { cookies: [...] } }` (agent-browser wrapper envelope)
   *   - `[...]` (raw array)
   *
   * `replace: true` overwrites the store; default merges on `(name, domain, path)`.
   * Returns the count imported.
   */
  import(filePath: string, opts: { replace?: boolean } = {}): { count: number } {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const raw = readFileSync(filePath, "utf-8");
    const incoming = JSON.parse(raw);
    const cookies: Cookie[] = incoming.cookies ?? incoming.data?.cookies ?? incoming;
    if (!Array.isArray(cookies)) {
      throw new Error(`Expected a cookies array in ${filePath}`);
    }

    if (opts.replace) {
      const store: CookieStore = { cookies, origins: incoming.origins ?? [] };
      this.save(store);
    } else {
      this.merge(cookies, incoming.origins ?? []);
    }
    return { count: cookies.length };
  }

  /** Write the entire store to a file (for sharing with another tool). */
  export(filePath: string): { count: number } {
    const store = this.load();
    const stamped: CookieStore = {
      ...store,
      exportedAt: new Date().toISOString(),
      exportedFrom: `${this.source}-export`,
    };
    atomicWrite(filePath, `${JSON.stringify(stamped, null, 2)}\n`);
    return { count: stamped.cookies.length };
  }

  /** Stats for the `info` command. Stable shape so callers can JSON it. */
  info(): InfoResult {
    if (!existsSync(this.path)) {
      return {
        path: this.path,
        exists: false,
        bytes: 0,
        active: 0,
        expired: 0,
        total: 0,
        domains: [],
        origins: 0,
      };
    }
    const store = this.load();
    const expired = store.cookies.filter(isExpired).length;
    const active = store.cookies.length - expired;
    const domainSet = new Set(
      store.cookies.map((c) => (c.domain.startsWith(".") ? c.domain.slice(1) : c.domain)),
    );
    return {
      path: this.path,
      exists: true,
      bytes: statSync(this.path).size,
      active,
      expired,
      total: store.cookies.length,
      domains: [...domainSet].sort(),
      origins: store.origins.length,
      exportedAt: store.exportedAt,
      exportedFrom: store.exportedFrom,
    };
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (also exported so callers without a CookieJar can use them)
// ---------------------------------------------------------------------------

/**
 * Merge cookies into a store. Newer entries with the same
 * `(name, domain, path)` triple replace older ones. Pure; caller must save.
 */
export function mergeCookies(store: CookieStore, incoming: Cookie[]): CookieStore {
  const key = (c: Cookie) => `${c.name}|${c.domain}|${c.path}`;
  const map = new Map<string, Cookie>();
  for (const c of store.cookies) map.set(key(c), c);
  for (const c of incoming) map.set(key(c), c);
  return { ...store, cookies: Array.from(map.values()) };
}

/** RFC 6265 domain match. Leading dot in cookie domain means subdomain match. */
export function domainMatches(cookieDomain: string, hostname: string): boolean {
  const cd = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  if (hostname === cd) return true;
  if (hostname.endsWith(`.${cd}`)) return true;
  return false;
}

/** RFC 6265 path match. */
export function pathMatches(cookiePath: string, urlPath: string): boolean {
  if (urlPath === cookiePath) return true;
  if (urlPath.startsWith(cookiePath) && cookiePath.endsWith("/")) return true;
  if (urlPath.startsWith(`${cookiePath}/`)) return true;
  return false;
}

/** `expires <= 0` is a session cookie / no expiry; otherwise compare to now. */
export function isExpired(cookie: Cookie): boolean {
  if (cookie.expires <= 0) return false;
  return cookie.expires < Date.now() / 1000;
}

/** Cookies that should be sent with a request to `url`. */
export function matchingCookies(store: CookieStore, url: string): Cookie[] {
  const parsed = new URL(url);
  const isSecure = parsed.protocol === "https:";
  return store.cookies.filter((c) => {
    if (isExpired(c)) return false;
    if (!domainMatches(c.domain, parsed.hostname)) return false;
    if (!pathMatches(c.path, parsed.pathname)) return false;
    if (c.secure && !isSecure) return false;
    return true;
  });
}
