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
 * On POSIX a crashed holder leaves its socket file behind. A failed listen
 * therefore probes the endpoint: a refused connection means the file is
 * stale, so it is unlinked and the listen retried once; an accepted
 * connection means a live process holds the lock.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
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
}

/** Unix socket paths are limited to roughly 104 bytes on macOS and 108 on Linux. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * The endpoint for one lock: `name` says what it guards, `scope` (typically a
 * resolved project root) which instance, and `directory` where a Unix socket
 * lives when its path is short enough (else the system temp directory).
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
    : paths.join(tmpdir(), `harnery-${name}-${hash}.sock`);
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
  overrides: Partial<InstanceLockDependencies> = {},
): Promise<InstanceLock | null> {
  const deps: InstanceLockDependencies = {
    platform: process.platform,
    listen: listenOnce,
    probe: probeEndpoint,
    unlink: (path) => rmSync(path, { force: true }),
    ...overrides,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") return null;
      // A named pipe disappears with its last holder; in use means held.
      if (deps.platform === "win32" || attempt > 0) return null;
      if ((await deps.probe(endpoint)) === "live") return null;
      try {
        deps.unlink(endpoint);
      } catch {
        return null;
      }
    }
  }
  return null;
}
