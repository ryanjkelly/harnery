import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireInstanceLock,
  instanceLockEndpoint,
  instanceLockFileEndpoint,
  RECOVERY_GUARD_STALE_MS,
} from "./single-instance.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scope(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-instance-lock-"));
  roots.push(root);
  return root;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function addressInUse(): Error {
  return Object.assign(new Error("in use"), { code: "EADDRINUSE" });
}

describe("instanceLockEndpoint", () => {
  test("is a named pipe on Windows and a short local socket elsewhere", () => {
    const pipe = instanceLockEndpoint(
      "relay",
      "C:\\Work\\Repo",
      "C:\\Work\\Repo\\.harnery",
      "win32",
    );
    expect(pipe).toMatch(/^\\\\\.\\pipe\\harnery-relay-[0-9a-f]{24}$/);
    // Windows paths compare without regard to case.
    expect(instanceLockEndpoint("relay", "c:\\work\\repo", "x", "win32")).toBe(pipe);
    // Linux uses the abstract namespace: no file, nothing to go stale.
    expect(instanceLockEndpoint("relay", "/srv/repo", "/srv/repo/.harnery", "linux")).toMatch(
      /^\0harnery-relay-[0-9a-f]{24}$/,
    );
    expect(instanceLockEndpoint("relay", "/srv/repo", "/srv/repo/.harnery", "darwin")).toBe(
      "/srv/repo/.harnery/relay.sock",
    );
    expect(instanceLockFileEndpoint("relay", "/srv/repo", "/srv/repo/.harnery", "linux")).toBe(
      "/srv/repo/.harnery/relay.sock",
    );
    const deep = `/${"d".repeat(120)}`;
    const long = instanceLockEndpoint("relay", deep, `${deep}/.harnery`, "darwin");
    expect(long.startsWith(tmpdir())).toBe(true);
    expect(long).toMatch(/harnery-relay-[0-9a-f]{24}\.sock$/);
  });
});

/**
 * An in-memory socket table with real exclusivity semantics: listen fails
 * while any file (stale or bound) exists at the path, unlinking a bound
 * file does not close its listener, and a probe succeeds only against a
 * live listener.
 */
function fakeSockets() {
  const files = new Map<string, "stale" | string>();
  const listeners = new Map<string, string>();
  const guards = new Set<string>();
  let unlinks = 0;
  const forStarter = (who: string, hooks: { beforeGuard?: () => Promise<void> } = {}) => ({
    platform: "darwin" as const,
    listen: async (path: string) => {
      if (files.has(path)) throw addressInUse();
      files.set(path, who);
      listeners.set(who, path);
      return {
        close: async () => {
          listeners.delete(who);
        },
      };
    },
    probe: async (path: string): Promise<"live" | "stale"> => {
      const owner = files.get(path);
      return owner && owner !== "stale" && listeners.get(owner) === path ? "live" : "stale";
    },
    unlink: (path: string) => {
      unlinks += 1;
      files.delete(path);
    },
    acquireGuard: async (path: string) => {
      await hooks.beforeGuard?.();
      if (guards.has(path)) return false;
      guards.add(path);
      return true;
    },
    releaseGuard: (path: string) => {
      guards.delete(path);
    },
  });
  return {
    files,
    listeners,
    forStarter,
    unlinks: () => unlinks,
  };
}

describe("stale socket recovery", () => {
  test("two starters recovering one crash-left socket yield exactly one holder (F5)", async () => {
    const sockets = fakeSockets();
    sockets.files.set("/run/relay.sock", "stale");
    // A and B both fail to listen and both probe the socket stale. A then
    // recovers and binds before B reaches the guard: B must not unlink A's
    // fresh socket and bind beside it.
    let aDone: () => void = () => {};
    const aFinished = new Promise<void>((done) => {
      aDone = done;
    });
    const a = acquireInstanceLock("/run/relay.sock", sockets.forStarter("A")).then((lock) => {
      aDone();
      return lock;
    });
    const b = acquireInstanceLock(
      "/run/relay.sock",
      sockets.forStarter("B", { beforeGuard: () => aFinished }),
    );
    const [lockA, lockB] = await Promise.all([a, b]);
    expect(lockA).not.toBeNull();
    expect(lockB).toBeNull();
    expect([...sockets.listeners.keys()]).toEqual(["A"]);
    expect(sockets.unlinks()).toBe(1);

    // Racing for the guard at the same moment also leaves one holder.
    const racing = fakeSockets();
    racing.files.set("/run/relay.sock", "stale");
    const locks = await Promise.all(
      ["C", "D", "E"].map((who) => acquireInstanceLock("/run/relay.sock", racing.forStarter(who))),
    );
    expect(locks.filter((lock) => lock !== null)).toHaveLength(1);
    expect(racing.listeners.size).toBe(1);
  });

  test("an abstract socket in use is held, and an unsupported one falls back to the file", async () => {
    let probes = 0;
    const held = await acquireInstanceLock("\0harnery-relay-x", {
      platform: "linux",
      listen: async () => {
        throw addressInUse();
      },
      probe: async () => {
        probes += 1;
        return "stale";
      },
    });
    expect(held).toBeNull();
    expect(probes).toBe(0);

    const listened: string[] = [];
    const fallback = await acquireInstanceLock("\0harnery-relay-x", {
      platform: "linux",
      fallback: "/run/relay.sock",
      listen: async (path) => {
        listened.push(path);
        if (path.startsWith("\0")) throw Object.assign(new Error("bad"), { code: "EINVAL" });
        return { close: async () => {} };
      },
    });
    expect(fallback?.endpoint).toBe("/run/relay.sock");
    expect(listened).toEqual(["\0harnery-relay-x", "/run/relay.sock"]);
  });

  test("a held guard means held; a crashed recoverer guard expires", async () => {
    const sockets = fakeSockets();
    sockets.files.set("/run/relay.sock", "stale");
    const blocked = await acquireInstanceLock("/run/relay.sock", {
      ...sockets.forStarter("A"),
      acquireGuard: async () => false,
    });
    expect(blocked).toBeNull();
    expect(sockets.unlinks()).toBe(0);

    // The default guard is a directory: a fresh one blocks recovery, one
    // older than RECOVERY_GUARD_STALE_MS (its recoverer crashed) is removed.
    const socket = join(scope(), "relay.sock");
    const files = fakeSockets();
    files.files.set(socket, "stale");
    const { acquireGuard: _a, releaseGuard: _r, ...realGuard } = files.forStarter("F");
    mkdirSync(`${socket}.recover`);
    expect(await acquireInstanceLock(socket, realGuard)).toBeNull();
    const old = (Date.now() - RECOVERY_GUARD_STALE_MS - 5_000) / 1_000;
    utimesSync(`${socket}.recover`, old, old);
    expect(await acquireInstanceLock(socket, realGuard)).not.toBeNull();
    expect(existsSync(`${socket}.recover`)).toBe(false);
  });
});

describe("acquireInstanceLock", () => {
  test("admits one holder at a time and frees on close", async () => {
    const endpoint = instanceLockEndpoint("test", scope(), scope());
    const first = await acquireInstanceLock(endpoint);
    expect(first).not.toBeNull();
    const second = await Promise.all([
      acquireInstanceLock(endpoint),
      acquireInstanceLock(endpoint),
    ]);
    expect(second).toEqual([null, null]);
    await first?.close();
    const third = await acquireInstanceLock(endpoint);
    expect(third).not.toBeNull();
    await third?.close();
  });

  test("is released when the holding process is killed", async () => {
    const endpoint = instanceLockEndpoint("crash", scope(), scope());
    const moduleUrl = pathToFileURL(join(import.meta.dir, "single-instance.ts")).href;
    const script = `
      const { acquireInstanceLock } = await import(${JSON.stringify(moduleUrl)});
      const lock = await acquireInstanceLock(${JSON.stringify(endpoint)});
      console.log(lock ? "held" : "busy");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      const first = await new Promise<string>((done) => {
        child.stdout?.once("data", (chunk) => done(String(chunk).trim()));
      });
      expect(first).toBe("held");
      expect(await acquireInstanceLock(endpoint)).toBeNull();
      child.kill("SIGKILL");
      await new Promise((done) => child.once("exit", done));
      let lock = null;
      for (let attempt = 0; attempt < 50 && lock === null; attempt += 1) {
        lock = await acquireInstanceLock(endpoint);
        if (lock === null) await sleep(100);
      }
      expect(lock).not.toBeNull();
      await lock?.close();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  test("clears a stale socket file left by a crashed holder, once, under the guard", async () => {
    let listens = 0;
    const unlinked: string[] = [];
    const guards: string[] = [];
    const lock = await acquireInstanceLock("/run/x.sock", {
      platform: "darwin",
      listen: async () => {
        listens += 1;
        if (listens === 1) throw addressInUse();
        return { close: async () => {} };
      },
      probe: async () => "stale",
      unlink: (path) => unlinked.push(path),
      acquireGuard: async (path) => {
        guards.push(`take ${path}`);
        return true;
      },
      releaseGuard: (path) => guards.push(`release ${path}`),
    });
    expect(lock).not.toBeNull();
    expect(unlinked).toEqual(["/run/x.sock"]);
    expect(listens).toBe(2);
    expect(guards).toEqual(["take /run/x.sock.recover", "release /run/x.sock.recover"]);
  });

  test("never unlinks a socket file a live process answers on", async () => {
    const unlinked: string[] = [];
    const lock = await acquireInstanceLock("/run/x.sock", {
      platform: "darwin",
      listen: async () => {
        throw addressInUse();
      },
      probe: async () => "live",
      unlink: (path) => unlinked.push(path),
    });
    expect(lock).toBeNull();
    expect(unlinked).toEqual([]);
  });

  test("treats an in-use named pipe as held without probing", async () => {
    let probes = 0;
    const lock = await acquireInstanceLock("\\\\.\\pipe\\x", {
      platform: "win32",
      listen: async () => {
        throw addressInUse();
      },
      probe: async () => {
        probes += 1;
        return "stale";
      },
    });
    expect(lock).toBeNull();
    expect(probes).toBe(0);
  });
});
