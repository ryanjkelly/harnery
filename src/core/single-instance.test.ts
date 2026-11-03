import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireInstanceLock, instanceLockEndpoint } from "./single-instance.ts";

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
    expect(instanceLockEndpoint("relay", "/srv/repo", "/srv/repo/.harnery", "linux")).toBe(
      "/srv/repo/.harnery/relay.sock",
    );
    const deep = `/${"d".repeat(120)}`;
    const long = instanceLockEndpoint("relay", deep, `${deep}/.harnery`, "linux");
    expect(long.startsWith(tmpdir())).toBe(true);
    expect(long).toMatch(/harnery-relay-[0-9a-f]{24}\.sock$/);
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

  test("clears a stale POSIX socket left by a crashed holder, once", async () => {
    let listens = 0;
    const unlinked: string[] = [];
    const lock = await acquireInstanceLock("/run/x.sock", {
      platform: "linux",
      listen: async () => {
        listens += 1;
        if (listens === 1) throw addressInUse();
        return { close: async () => {} };
      },
      probe: async () => "stale",
      unlink: (path) => unlinked.push(path),
    });
    expect(lock).not.toBeNull();
    expect(unlinked).toEqual(["/run/x.sock"]);
    expect(listens).toBe(2);
  });

  test("never unlinks a POSIX socket a live process answers on", async () => {
    const unlinked: string[] = [];
    const lock = await acquireInstanceLock("/run/x.sock", {
      platform: "linux",
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
