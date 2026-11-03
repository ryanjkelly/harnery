/**
 * An operating-system-held, single-instance lock (ADR 0232).
 *
 * The lock is a local listener on a per-scope endpoint: a named pipe on
 * Windows, and elsewhere a TCP listener on 127.0.0.1 at a port derived from
 * the lock's name and scope. Binding either is atomic, only one process can
 * hold it, and the operating system releases it when that process exits or
 * crashes. There is no file to go stale, nothing to unlink, and every
 * runtime on the machine computes the same endpoint.
 *
 * Every holder answers each connection with a banner carrying the lock's id
 * (a hash of its name and scope) and a random per-process nonce, nothing
 * else. A starter that finds the endpoint taken reads the banner: the same
 * lock id means a live peer holds it; anything else (another program, or
 * another harnery lock whose port collided) makes the lock unavailable, and
 * the caller must not proceed as if it held it. Ports are never retried
 * elsewhere, because a second port would be a second lock.
 */

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { posix, win32 } from "node:path";

export type InstanceLockEndpoint =
  | { kind: "pipe"; id: string; path: string }
  | { kind: "tcp"; id: string; host: "127.0.0.1"; port: number };

export interface InstanceLock {
  readonly endpoint: InstanceLockEndpoint;
  /** This holder's banner nonce. */
  readonly nonce: string;
  /** Release the lock. Process exit releases it as well. */
  close(): Promise<void>;
}

export type InstanceLockUnavailableReason =
  | "port_in_use_by_other_program"
  | "port_in_use_by_other_lock"
  | "listen_failed";

export type InstanceLockResult =
  | { status: "acquired"; lock: InstanceLock }
  /** A live holder of this same lock answered. */
  | { status: "busy" }
  /** The endpoint is taken by something that is not this lock, or unusable. */
  | { status: "unavailable"; reason: InstanceLockUnavailableReason; port?: number };

/** What answered on the endpoint. */
export type InstanceProbe =
  | { kind: "refused" }
  | { kind: "banner"; id: string; nonce: string }
  | { kind: "foreign" };

export interface InstanceLockDependencies {
  listen: (
    endpoint: InstanceLockEndpoint,
    banner: string,
  ) => Promise<{ close: () => Promise<void> }>;
  probe: (endpoint: InstanceLockEndpoint) => Promise<InstanceProbe>;
  nonce: () => string;
}

const BANNER_PREFIX = "harnery-lock:";
/** Below the Linux (32768+) and macOS/Windows (49152+) ephemeral ranges. */
export const INSTANCE_LOCK_PORT_MIN = 20_000;
export const INSTANCE_LOCK_PORT_MAX = 32_767;

/**
 * The endpoint for one lock: `name` says what it guards, `scope` (typically
 * a resolved project root) which instance.
 */
export function instanceLockEndpoint(
  name: string,
  scope: string,
  platform: NodeJS.Platform = process.platform,
): InstanceLockEndpoint {
  const paths = platform === "win32" ? win32 : posix;
  // One lock per directory, however it is spelled: a symlink, junction or
  // differently cased path to the same root must pick the same endpoint, or
  // two daemons could each hold a lock for one project.
  const resolved = canonicalScope(paths.resolve(scope), platform);
  const normalized =
    platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
  const hash = createHash("sha256").update(`${name}\0${normalized}`).digest("hex");
  const id = hash.slice(0, 16);
  if (platform === "win32") {
    return { kind: "pipe", id, path: `\\\\.\\pipe\\harnery-${name}-${hash.slice(0, 24)}` };
  }
  const span = INSTANCE_LOCK_PORT_MAX - INSTANCE_LOCK_PORT_MIN + 1;
  const port = INSTANCE_LOCK_PORT_MIN + (Number.parseInt(hash.slice(16, 24), 16) % span);
  return { kind: "tcp", id, host: "127.0.0.1", port };
}

/** The real path of an existing scope on this platform; the resolved spelling otherwise. */
function canonicalScope(resolved: string, platform: NodeJS.Platform): string {
  if (platform !== process.platform) return resolved;
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function bannerFor(endpoint: InstanceLockEndpoint, nonce: string): string {
  return `${BANNER_PREFIX}${endpoint.id}:${nonce}`;
}

function listenOn(
  endpoint: InstanceLockEndpoint,
  banner: string,
): Promise<{ close: () => Promise<void> }> {
  return new Promise((done, fail) => {
    const server: Server = createServer((socket) => {
      socket.on("error", () => {});
      socket.end(`${banner}\n`);
    });
    server.once("error", fail);
    const ready = () => {
      server.off("error", fail);
      // The lock never keeps a process alive on its own.
      server.unref();
      done({
        close: () =>
          new Promise<void>((closed) => {
            try {
              server.close(() => closed());
            } catch {
              closed();
            }
          }),
      });
    };
    if (endpoint.kind === "pipe") server.listen(endpoint.path, ready);
    // Loopback only: the lock is never reachable from another machine.
    else server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true }, ready);
  });
}

/**
 * Ask whoever holds the endpoint who it is. A refused connection means
 * nobody; a harnery banner names the lock and holder; silence, other data,
 * or another error is foreign.
 */
export function probeInstanceEndpoint(endpoint: InstanceLockEndpoint): Promise<InstanceProbe> {
  return new Promise((done) => {
    let settled = false;
    let received = "";
    const socket =
      endpoint.kind === "pipe"
        ? createConnection(endpoint.path)
        : createConnection({ host: endpoint.host, port: endpoint.port });
    const finish = (result: InstanceProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(result);
    };
    const parse = (): InstanceProbe => {
      const line = received.split("\n")[0] ?? "";
      if (!line.startsWith(BANNER_PREFIX)) return { kind: "foreign" };
      const [id, nonce] = line.slice(BANNER_PREFIX.length).split(":");
      return id && nonce ? { kind: "banner", id, nonce } : { kind: "foreign" };
    };
    const timer = setTimeout(() => finish({ kind: "foreign" }), 1_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\n") || received.length > 256) finish(parse());
    });
    socket.once("end", () => finish(parse()));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ECONNREFUSED" || error.code === "ENOENT"
          ? { kind: "refused" }
          : { kind: "foreign" },
      ),
    );
  });
}

/**
 * Take the lock. Never waits: `busy` means a live peer holds it (callers
 * that must wait poll), `unavailable` that something else occupies the
 * endpoint and the lock cannot be taken at all until it goes away.
 */
export async function acquireInstanceLock(
  endpoint: InstanceLockEndpoint,
  overrides: Partial<InstanceLockDependencies> = {},
): Promise<InstanceLockResult> {
  const deps: InstanceLockDependencies = {
    listen: listenOn,
    probe: probeInstanceEndpoint,
    nonce: randomUUID,
    ...overrides,
  };
  const nonce = deps.nonce();
  const banner = bannerFor(endpoint, nonce);
  const port = endpoint.kind === "tcp" ? { port: endpoint.port } : {};
  // A holder that exited between a failed listen and its probe frees the
  // endpoint; one more listen covers that.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const server = await deps.listen(endpoint, banner);
      let closed = false;
      const lock: InstanceLock = {
        endpoint,
        nonce,
        close: async () => {
          if (closed) return;
          closed = true;
          await server.close();
        },
      };
      return { status: "acquired", lock };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        return { status: "unavailable", reason: "listen_failed", ...port };
      }
    }
    // A named pipe in use is held by a process that can only be a peer: no
    // other program uses harnery's pipe names.
    if (endpoint.kind === "pipe") return { status: "busy" };
    const found = await deps.probe(endpoint);
    if (found.kind === "refused") continue;
    if (found.kind === "banner" && found.id === endpoint.id) return { status: "busy" };
    return {
      status: "unavailable",
      reason:
        found.kind === "banner" ? "port_in_use_by_other_lock" : "port_in_use_by_other_program",
      ...port,
    };
  }
  return { status: "unavailable", reason: "listen_failed", ...port };
}
