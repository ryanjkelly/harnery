/**
 * An operating-system-held, single-instance lock (ADR 0232).
 *
 * The lock is a local IPC server listening on a per-scope endpoint: a named
 * pipe on Windows, a Unix domain socket file elsewhere. Only one process can
 * listen on an endpoint at a time, and the operating system closes it when
 * that process exits or crashes, so a holder can never leak the lock the way
 * a lock file can.
 *
 * Every holder answers each connection with a banner carrying a random
 * per-process nonce, so a probe can tell who holds the endpoint. A Unix
 * socket file outlives a crashed holder; a starter that finds it refusing
 * connections unlinks it and binds. Two starters can both do that, and
 * unlinking does not close a listener, so on POSIX a bind is never trusted
 * on its own: after binding, the holder waits a short settle and probes the
 * path, and keeps the lock only if the banner it reads is its own. A holder
 * displaced later finds out from `verify()`, which long-lived holders call
 * periodically.
 */

import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { posix, win32 } from "node:path";

export interface InstanceLock {
  readonly endpoint: string;
  /** This holder's banner nonce. */
  readonly nonce: string;
  /** Does the endpoint still answer with this holder's nonce? */
  verify(): Promise<boolean>;
  /** Release the lock. Process exit releases it as well. */
  close(): Promise<void>;
}

/** What a probe found: nobody (`stale`), or a holder and its nonce when it identified itself. */
export type InstanceProbe = { kind: "stale" } | { kind: "held"; nonce?: string };

export interface InstanceLockDependencies {
  platform: NodeJS.Platform;
  listen: (endpoint: string, banner: string) => Promise<{ close: () => Promise<void> }>;
  probe: (endpoint: string) => Promise<InstanceProbe>;
  unlink: (endpoint: string) => void;
  settle: (milliseconds: number) => Promise<void>;
  nonce: () => string;
}

const BANNER_PREFIX = "harnery-lock:";
/** How long a new POSIX holder waits before checking it was not displaced. */
export const INSTANCE_LOCK_SETTLE_MS = 250;
/** Unix socket paths are limited to roughly 104 bytes on macOS and 108 on Linux. */
const MAX_SOCKET_PATH_BYTES = 100;
/**
 * The fallback directory for a socket path that would be too long. A fixed
 * path, not the runtime's temp directory, so every runtime picks the same
 * endpoint for the same project.
 */
const POSIX_FALLBACK_DIRECTORY = "/tmp";

/**
 * The endpoint for one lock: `name` says what it guards, `scope` (typically a
 * resolved project root) which instance. A named pipe on Windows; elsewhere
 * a socket file in `directory`, or in `/tmp` under a name derived from the
 * scope when that path would be too long.
 */
export function instanceLockEndpoint(
  name: string,
  scope: string,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? win32 : posix;
  const resolved = paths.resolve(scope);
  const normalized = platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = createHash("sha256").update(`${name}\0${normalized}`).digest("hex").slice(0, 24);
  if (platform === "win32") return `\\\\.\\pipe\\harnery-${name}-${hash}`;
  const local = paths.join(directory, `${name}.sock`);
  return Buffer.byteLength(local) <= MAX_SOCKET_PATH_BYTES
    ? local
    : paths.join(POSIX_FALLBACK_DIRECTORY, `harnery-${name}-${hash}.sock`);
}

function listenWithBanner(
  endpoint: string,
  banner: string,
): Promise<{ close: () => Promise<void> }> {
  return new Promise((done, fail) => {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.end(`${banner}\n`);
    });
    server.once("error", fail);
    server.listen(endpoint, () => {
      server.off("error", fail);
      // The lock never keeps a process alive on its own.
      server.unref();
      done({ close: () => closeServer(server) });
    });
  });
}

/**
 * Probe the endpoint. A refused or missing endpoint is stale; a harnery
 * banner names its holder; anything else (silence, garbage, other errors)
 * is treated as held, so a probe never licenses unlinking a live socket.
 */
export function probeInstanceEndpoint(endpoint: string): Promise<InstanceProbe> {
  return new Promise((done) => {
    let settled = false;
    let received = "";
    const socket = createConnection(endpoint);
    const finish = (result: InstanceProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(result);
    };
    const timer = setTimeout(() => finish({ kind: "held" }), 1_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      const line = received.split("\n")[0] ?? "";
      if (received.includes("\n") || received.length > 256) {
        finish(
          line.startsWith(BANNER_PREFIX)
            ? { kind: "held", nonce: line.slice(BANNER_PREFIX.length) }
            : { kind: "held" },
        );
      }
    });
    socket.once("end", () => {
      const line = received.split("\n")[0] ?? "";
      finish(
        line.startsWith(BANNER_PREFIX)
          ? { kind: "held", nonce: line.slice(BANNER_PREFIX.length) }
          : { kind: "held" },
      );
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ECONNREFUSED" || error.code === "ENOENT"
          ? { kind: "stale" }
          : { kind: "held" },
      ),
    );
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => {
    try {
      server.close(() => done());
    } catch {
      done();
    }
  });
}

/**
 * Take the lock, or return null when another process holds it (or the
 * endpoint cannot be used). Never waits beyond the POSIX settle check;
 * callers that must wait poll.
 */
export async function acquireInstanceLock(
  endpoint: string,
  overrides: Partial<InstanceLockDependencies> = {},
): Promise<InstanceLock | null> {
  const deps: InstanceLockDependencies = {
    platform: process.platform,
    listen: listenWithBanner,
    probe: probeInstanceEndpoint,
    unlink: (path) => rmSync(path, { force: true }),
    settle: (ms) => new Promise((done) => setTimeout(done, ms)),
    nonce: randomUUID,
    ...overrides,
  };
  const nonce = deps.nonce();
  const banner = `${BANNER_PREFIX}${nonce}`;
  let server = await tryListen(deps, endpoint, banner);
  if (server === "failed") return null;
  if (server === "in_use") {
    // A named pipe disappears with its holder: in use means held.
    if (deps.platform === "win32") return null;
    // A socket file that refuses connections was left by a crashed holder.
    if ((await deps.probe(endpoint)).kind !== "stale") return null;
    try {
      deps.unlink(endpoint);
    } catch {
      return null;
    }
    server = await tryListen(deps, endpoint, banner);
    if (server === "failed" || server === "in_use") return null;
  }
  const bound = server;
  let closed = false;
  const lock: InstanceLock = {
    endpoint,
    nonce,
    verify: async () => {
      if (closed) return false;
      if (deps.platform === "win32") return true;
      const found = await deps.probe(endpoint);
      return found.kind === "held" && found.nonce === nonce;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await bound.close();
    },
  };
  if (deps.platform !== "win32") {
    // Another starter may have unlinked and rebound the same path.
    await deps.settle(INSTANCE_LOCK_SETTLE_MS);
    if (!(await lock.verify())) {
      await lock.close();
      return null;
    }
  }
  return lock;
}

async function tryListen(
  deps: InstanceLockDependencies,
  endpoint: string,
  banner: string,
): Promise<{ close: () => Promise<void> } | "in_use" | "failed"> {
  try {
    return await deps.listen(endpoint, banner);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "in_use" : "failed";
  }
}
