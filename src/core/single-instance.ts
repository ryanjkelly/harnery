/**
 * An operating-system-held, single-instance lock (ADR 0232).
 *
 * The lock is a local IPC server listening on a per-scope endpoint: a named
 * pipe on Windows, a Unix domain socket elsewhere. Only one process can
 * listen on an endpoint at a time, and the operating system closes it when
 * that process exits or crashes, so a holder can never leak the lock the way
 * a lock file can. A file-based reservation can only reduce duplicate work;
 * this is what guarantees exclusivity.
 *
 * On Linux the socket lives in the abstract namespace: it has no file, so the
 * kernel frees it with its holder and there is nothing stale to recover. If
 * the runtime refuses an abstract address, the caller's file fallback is
 * used instead.
 *
 * A socket file (macOS, or the Linux fallback) outlives a crashed holder. A
 * failed listen probes it, and recovery is serialized: only the starter that
 * atomically creates a `<socket>.recover` guard may unlink the file, and only
 * after probing it again under the guard. Unlinking does not close a
 * listener, so without the guard a second starter could unlink a socket the
 * first had just bound and bind its own. A guard older than ten seconds
 * (left by a recoverer that crashed mid-recovery) is removed.
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";

export interface InstanceLock {
  readonly endpoint: string;
  /** Release the lock. Process exit releases it as well. */
  close(): Promise<void>;
}

export interface InstanceLockDependencies {
  platform: NodeJS.Platform;
  listen: (endpoint: string) => Promise<Server | { close: () => Promise<void> }>;
  probe: (endpoint: string) => Promise<"live" | "stale">;
  unlink: (endpoint: string) => void;
  /** Atomically take the stale-recovery guard; false when another starter holds it. */
  acquireGuard: (path: string) => Promise<boolean>;
  releaseGuard: (path: string) => void;
}

/** A recovery guard older than this was left by a recoverer that crashed. */
export const RECOVERY_GUARD_STALE_MS = 10_000;

function isAbstract(endpoint: string): boolean {
  return endpoint.startsWith("\0");
}

async function acquireGuardDirectory(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs <= RECOVERY_GUARD_STALE_MS) return false;
      rmSync(path, { recursive: true, force: true });
    } catch {
      return false;
    }
  }
  return false;
}

/** Unix socket paths are limited to roughly 104 bytes on macOS and 108 on Linux. */
const MAX_SOCKET_PATH_BYTES = 100;

function scopeHash(name: string, scope: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? win32 : posix;
  const resolved = paths.resolve(scope);
  const normalized = platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(`${name}\0${normalized}`).digest("hex").slice(0, 24);
}

/**
 * The endpoint for one lock: `name` says what it guards and `scope`
 * (typically a resolved project root) which instance. A named pipe on
 * Windows, an abstract-namespace socket on Linux, and elsewhere the socket
 * file from `instanceLockFileEndpoint`.
 */
export function instanceLockEndpoint(
  name: string,
  scope: string,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const hash = scopeHash(name, scope, platform);
  if (platform === "win32") return `\\\\.\\pipe\\harnery-${name}-${hash}`;
  if (platform === "linux") return `\0harnery-${name}-${hash}`;
  return instanceLockFileEndpoint(name, scope, directory, platform);
}

/**
 * A socket file in `directory` when its path is short enough, else in the
 * system temp directory: the macOS endpoint and the Linux fallback.
 */
export function instanceLockFileEndpoint(
  name: string,
  scope: string,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? win32 : posix;
  const local = paths.join(directory, `${name}.sock`);
  return Buffer.byteLength(local) <= MAX_SOCKET_PATH_BYTES
    ? local
    : paths.join(tmpdir(), `harnery-${name}-${scopeHash(name, scope, platform)}.sock`);
}

function listenOnce(endpoint: string): Promise<Server> {
  return new Promise((done, fail) => {
    // A probe that connects is told nothing and closed at once.
    const server = createServer((socket) => socket.destroy());
    server.once("error", fail);
    server.listen(endpoint, () => {
      server.off("error", fail);
      // The lock never keeps a process alive on its own.
      server.unref();
      done(server);
    });
  });
}

function probeEndpoint(endpoint: string): Promise<"live" | "stale"> {
  return new Promise((done) => {
    const socket = createConnection(endpoint);
    const finish = (verdict: "live" | "stale") => {
      clearTimeout(timer);
      socket.destroy();
      done(verdict);
    };
    // A holder too busy to accept within a second is still a holder.
    const timer = setTimeout(() => finish("live"), 1_000);
    socket.once("connect", () => finish("live"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "live"),
    );
  });
}

function closeServer(server: Server | { close: () => Promise<void> }): Promise<void> {
  if (!("address" in server)) return server.close();
  return new Promise((done) => {
    try {
      server.close(() => done());
    } catch {
      done();
    }
  });
}

/**
 * Take the lock, or return null when a live process holds it (or the
 * endpoint cannot be used at all). Never waits; callers that must wait poll.
 */
export async function acquireInstanceLock(
  endpoint: string,
  overrides: Partial<InstanceLockDependencies> & {
    /** A socket file to use when the runtime refuses an abstract address. */
    fallback?: string;
  } = {},
): Promise<InstanceLock | null> {
  const { fallback, ...rest } = overrides;
  const deps: InstanceLockDependencies = {
    platform: process.platform,
    listen: listenOnce,
    probe: probeEndpoint,
    unlink: (path) => rmSync(path, { force: true }),
    acquireGuard: acquireGuardDirectory,
    releaseGuard: (path) => rmSync(path, { recursive: true, force: true }),
    ...rest,
  };
  const attempt = await tryListen(deps, endpoint);
  if (attempt !== "in_use" && attempt !== "failed") return attempt;
  // A named pipe or an abstract socket disappears with its holder: in use
  // means held, and there is never anything stale to recover.
  if (deps.platform === "win32" || isAbstract(endpoint)) {
    if (attempt === "failed" && isAbstract(endpoint) && fallback) {
      return acquireInstanceLock(fallback, rest);
    }
    return null;
  }
  if (attempt === "failed") return null;
  return recoverStaleSocket(deps, endpoint);
}

async function tryListen(
  deps: InstanceLockDependencies,
  endpoint: string,
): Promise<InstanceLock | "in_use" | "failed"> {
  try {
    const server = await deps.listen(endpoint);
    let closed = false;
    return {
      endpoint,
      close: async () => {
        if (closed) return;
        closed = true;
        await closeServer(server);
      },
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "in_use" : "failed";
  }
}

/**
 * A socket file is in use but may be left by a crashed holder. Recover it
 * only under the guard, and only if it still refuses connections when probed
 * under the guard; a starter that cannot get the guard treats it as held.
 */
async function recoverStaleSocket(
  deps: InstanceLockDependencies,
  endpoint: string,
): Promise<InstanceLock | null> {
  if ((await deps.probe(endpoint)) === "live") return null;
  const guard = `${endpoint}.recover`;
  if (!(await deps.acquireGuard(guard))) return null;
  try {
    // Another starter may have recovered it and bound while this one waited.
    if ((await deps.probe(endpoint)) === "live") return null;
    try {
      deps.unlink(endpoint);
    } catch {
      return null;
    }
    const attempt = await tryListen(deps, endpoint);
    return attempt === "in_use" || attempt === "failed" ? null : attempt;
  } finally {
    try {
      deps.releaseGuard(guard);
    } catch {
      // A guard left behind expires after RECOVERY_GUARD_STALE_MS.
    }
  }
}
