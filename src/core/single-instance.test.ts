import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireInstanceLock,
  type InstanceProbe,
  instanceLockEndpoint,
  probeInstanceEndpoint,
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
  test("is a named pipe on Windows and one socket file on every POSIX system (F3)", () => {
    const pipe = instanceLockEndpoint(
      "relay",
      "C:\\Work\\Repo",
      "C:\\Work\\Repo\\.harnery",
      "win32",
    );
    expect(pipe).toMatch(/^\\\\\.\\pipe\\harnery-relay-[0-9a-f]{24}$/);
    // Windows paths compare without regard to case.
    expect(instanceLockEndpoint("relay", "c:\\work\\repo", "x", "win32")).toBe(pipe);
    // Linux and macOS, under any runtime, use the same socket file.
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
      expect(instanceLockEndpoint("relay", "/srv/repo", "/srv/repo/.harnery", platform)).toBe(
        "/srv/repo/.harnery/relay.sock",
      );
    }
    // A path too long for a socket moves to a fixed directory, never the
    // runtime's own temp directory, so every runtime agrees on it.
    const deep = `/${"d".repeat(120)}`;
    const linux = instanceLockEndpoint("relay", deep, `${deep}/.harnery`, "linux");
    expect(linux).toMatch(/^\/tmp\/harnery-relay-[0-9a-f]{24}\.sock$/);
    expect(instanceLockEndpoint("relay", deep, `${deep}/.harnery`, "darwin")).toBe(linux);
  });
});

describe("acquireInstanceLock", () => {
  test("admits one holder at a time, identifies it to probes, and frees on close", async () => {
    const endpoint = instanceLockEndpoint("test", scope(), scope());
    expect(await probeInstanceEndpoint(endpoint)).toEqual({ kind: "stale" });
    const first = await acquireInstanceLock(endpoint);
    expect(first).not.toBeNull();
    expect(await probeInstanceEndpoint(endpoint)).toEqual({ kind: "held", nonce: first?.nonce });
    expect(await first?.verify()).toBe(true);
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

  test("treats an in-use named pipe as held without probing", async () => {
    let probes = 0;
    const lock = await acquireInstanceLock("\\\\.\\pipe\\x", {
      platform: "win32",
      listen: async () => {
        throw addressInUse();
      },
      probe: async () => {
        probes += 1;
        return { kind: "stale" };
      },
    });
    expect(lock).toBeNull();
    expect(probes).toBe(0);
  });
});

/**
 * An in-memory socket-file table with real POSIX semantics: listen fails
 * while a file exists at the path, unlinking a file does not close the
 * listener bound to it, and a probe reaches whoever is bound to the path now.
 */
function socketTable() {
  const bound = new Map<string, { banner: string; open: boolean } | "stale">();
  const listeners: Array<{ banner: string; open: boolean }> = [];
  let unlinks = 0;
  const starter = (nonce: string) => ({
    platform: "darwin" as const,
    nonce: () => nonce,
    settle: () => sleep(1),
    listen: async (path: string, banner: string) => {
      if (bound.has(path)) throw addressInUse();
      const listener = { banner, open: true };
      listeners.push(listener);
      bound.set(path, listener);
      return {
        close: async () => {
          listener.open = false;
        },
      };
    },
    probe: async (path: string): Promise<InstanceProbe> => {
      const entry = bound.get(path);
      if (!entry || entry === "stale" || !entry.open) return { kind: "stale" };
      return { kind: "held", nonce: entry.banner.slice("harnery-lock:".length) };
    },
    unlink: (path: string) => {
      unlinks += 1;
      bound.delete(path);
    },
  });
  return {
    bound,
    starter,
    openListeners: () => listeners.filter((listener) => listener.open).length,
    unlinks: () => unlinks,
  };
}

describe("POSIX double bind resolves by self-verification (F2)", () => {
  test("two starters recovering one crash-left socket end with one verified holder", async () => {
    const table = socketTable();
    table.bound.set("/p/relay.sock", "stale");
    // Both fail to listen and both probe the file stale before either
    // unlinks; then both unlink and bind in turn. B's unlink displaces A's
    // socket without closing A's listener.
    const a = table.starter("A");
    const b = table.starter("B");
    let probes = 0;
    let release: () => void = () => {};
    const bothProbed = new Promise<void>((done) => {
      release = done;
    });
    const gatedProbe = (base: typeof a.probe) => async (path: string) => {
      const result = await base(path);
      if (result.kind === "stale" && probes < 2) {
        probes += 1;
        if (probes === 2) release();
        await bothProbed;
      }
      return result;
    };
    const [lockA, lockB] = await Promise.all([
      acquireInstanceLock("/p/relay.sock", { ...a, probe: gatedProbe(a.probe) }),
      acquireInstanceLock("/p/relay.sock", { ...b, probe: gatedProbe(b.probe) }),
    ]);
    expect(table.unlinks()).toBe(2);
    const holders = [lockA, lockB].filter((lock) => lock !== null);
    expect(holders).toHaveLength(1);
    // The displaced starter closed its listener instead of keeping the lock.
    expect(table.openListeners()).toBe(1);
    expect(await holders[0]?.verify()).toBe(true);
  });

  test("a holder displaced later sees verify() fail", async () => {
    const table = socketTable();
    const lock = await acquireInstanceLock("/p/relay.sock", table.starter("A"));
    expect(await lock?.verify()).toBe(true);
    // A stalled starter unlinks the file and binds its own socket.
    table.bound.delete("/p/relay.sock");
    const intruder = await acquireInstanceLock("/p/relay.sock", table.starter("B"));
    expect(intruder).not.toBeNull();
    expect(await lock?.verify()).toBe(false);
  });

  test("a socket that answers without a harnery banner is held and never unlinked", async () => {
    const table = socketTable();
    table.bound.set("/p/relay.sock", "stale");
    const lock = await acquireInstanceLock("/p/relay.sock", {
      ...table.starter("A"),
      probe: async () => ({ kind: "held" }),
    });
    expect(lock).toBeNull();
    expect(table.unlinks()).toBe(0);
  });
});
