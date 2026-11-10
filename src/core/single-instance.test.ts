/**
 * The instance lock has no stale state to recover: binding a named pipe or a
 * loopback TCP port is atomic, and the kernel releases it with its holder.
 * The earlier socket-file design needed probe-then-unlink recovery, and a
 * starter that paused between its probe and its unlink could displace a live
 * holder; with nothing to unlink, that interleaving cannot occur, so it has
 * no test here. These tests run the real TCP path on every platform by
 * computing a POSIX endpoint, and the real named pipe on Windows.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import {
  acquireInstanceLock,
  INSTANCE_LOCK_PORT_MAX,
  INSTANCE_LOCK_PORT_MIN,
  type InstanceLockEndpoint,
  instanceLockEndpoint,
  probeInstanceEndpoint,
} from "./single-instance.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  for (const root of roots.splice(0)) removeDir(root);
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

/** The real TCP endpoint, usable on this machine whatever its platform. */
function tcpEndpoint(): Extract<InstanceLockEndpoint, { kind: "tcp" }> {
  const endpoint = instanceLockEndpoint("test", scope(), "linux");
  if (endpoint.kind !== "tcp") throw new Error("expected a tcp endpoint");
  return endpoint;
}

function occupy(port: number, reply: string | null): Promise<void> {
  return new Promise((done, fail) => {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      if (reply !== null) socket.end(reply);
    });
    servers.push(server);
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port }, () => done());
  });
}

const endpoints: Array<[string, () => InstanceLockEndpoint]> = [["loopback tcp", tcpEndpoint]];
if (process.platform === "win32") {
  endpoints.push(["named pipe", () => instanceLockEndpoint("test", scope(), "win32")]);
}

describe("instanceLockEndpoint", () => {
  test("case is kept on POSIX, so distinct roots on a case-sensitive volume stay distinct", () => {
    expect(instanceLockEndpoint("relay", "/Volumes/Work/Repo", "darwin")).not.toEqual(
      instanceLockEndpoint("relay", "/Volumes/Work/repo", "darwin"),
    );
    expect(instanceLockEndpoint("relay", "/srv/Repo", "linux")).not.toEqual(
      instanceLockEndpoint("relay", "/srv/repo", "linux"),
    );
  });

  test("an existing root spelled in another case maps to its on-disk name where paths ignore case", () => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;
    const real = join(scope(), "Repo");
    mkdirSync(real);
    const respelled = join(real, "..", "REPO");
    let sameDirectory = true;
    try {
      sameDirectory = realpathSync.native(respelled) === realpathSync.native(real);
    } catch {
      sameDirectory = false;
    }
    // A case-sensitive volume has no such alias; nothing to compare there.
    if (!sameDirectory) return;
    expect(instanceLockEndpoint("relay", respelled)).toEqual(instanceLockEndpoint("relay", real));
  });

  test("a symlink or junction to the project root picks the same endpoint as the real path", () => {
    const base = scope();
    const real = join(base, "repo");
    mkdirSync(real);
    const alias = join(base, "repo-link");
    // A junction needs no privilege on Windows; elsewhere it is an ordinary directory symlink.
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    expect(instanceLockEndpoint("relay", alias)).toEqual(instanceLockEndpoint("relay", real));
    expect(instanceLockEndpoint("relay", join(alias, "."))).toEqual(
      instanceLockEndpoint("relay", real),
    );
  });

  test("is a named pipe on Windows and one loopback port on every POSIX system", () => {
    const pipe = instanceLockEndpoint("relay", "C:\\Work\\Repo", "win32");
    expect(pipe.kind).toBe("pipe");
    if (pipe.kind === "pipe")
      expect(pipe.path).toMatch(/^\\\\\.\\pipe\\harnery-relay-[0-9a-f]{24}$/);
    // Windows paths compare without regard to case.
    expect(instanceLockEndpoint("relay", "c:\\work\\repo", "win32")).toEqual(pipe);
    const linux = instanceLockEndpoint("relay", "/srv/repo", "linux");
    expect(linux).toMatchObject({ kind: "tcp", host: "127.0.0.1" });
    if (linux.kind === "tcp") {
      expect(linux.port).toBeGreaterThanOrEqual(INSTANCE_LOCK_PORT_MIN);
      expect(linux.port).toBeLessThanOrEqual(INSTANCE_LOCK_PORT_MAX);
    }
    // Every POSIX system and runtime derives the same port for the same lock.
    expect(instanceLockEndpoint("relay", "/srv/repo", "darwin")).toEqual(linux);
    expect(instanceLockEndpoint("relay", "/srv/other", "linux")).not.toEqual(linux);
  });
});

describe("acquireInstanceLock", () => {
  for (const [label, make] of endpoints) {
    test(`admits exactly one of three concurrent acquirers (${label})`, async () => {
      const endpoint = make();
      expect(await probeInstanceEndpoint(endpoint)).toEqual({ kind: "refused" });
      const results = await Promise.all([
        acquireInstanceLock(endpoint),
        acquireInstanceLock(endpoint),
        acquireInstanceLock(endpoint),
      ]);
      const held = results.filter((result) => result.status === "acquired");
      expect(held).toHaveLength(1);
      expect(results.filter((result) => result.status === "busy")).toHaveLength(2);
      const lock = held[0]?.status === "acquired" ? held[0].lock : undefined;
      // The banner names the lock and its holder, nothing else.
      expect(await probeInstanceEndpoint(endpoint)).toEqual({
        kind: "banner",
        id: endpoint.id,
        nonce: lock?.nonce ?? "",
      });
      await lock?.close();
      const again = await acquireInstanceLock(endpoint);
      expect(again.status).toBe("acquired");
      if (again.status === "acquired") await again.lock.close();
    });

    test(`is released when the holding process is killed (${label})`, async () => {
      const endpoint = make();
      const moduleUrl = pathToFileURL(join(import.meta.dir, "single-instance.ts")).href;
      const script = `
        const { acquireInstanceLock } = await import(${JSON.stringify(moduleUrl)});
        const result = await acquireInstanceLock(${JSON.stringify(endpoint)});
        console.log(result.status);
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
        expect(first).toBe("acquired");
        expect((await acquireInstanceLock(endpoint)).status).toBe("busy");
        child.kill("SIGKILL");
        await new Promise((done) => child.once("exit", done));
        let result = await acquireInstanceLock(endpoint);
        for (let attempt = 0; attempt < 50 && result.status !== "acquired"; attempt += 1) {
          await sleep(100);
          result = await acquireInstanceLock(endpoint);
        }
        expect(result.status).toBe("acquired");
        if (result.status === "acquired") await result.lock.close();
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    });
  }

  test("a foreign program on the port makes the lock unavailable", async () => {
    const endpoint = tcpEndpoint();
    await occupy(endpoint.port, "HTTP/1.1 400 Bad Request\r\n\r\n");
    expect(await acquireInstanceLock(endpoint)).toEqual({
      status: "unavailable",
      reason: "port_in_use_by_other_program",
      port: endpoint.port,
    });
    // A silent listener is foreign too.
    const silent = tcpEndpoint();
    await occupy(silent.port, null);
    expect((await acquireInstanceLock(silent)).status).toBe("unavailable");
  });

  test("another project's lock on a colliding port makes this one unavailable", async () => {
    const endpoint = tcpEndpoint();
    await occupy(endpoint.port, "harnery-lock:0123456789abcdef:other-holder\n");
    expect(await acquireInstanceLock(endpoint)).toEqual({
      status: "unavailable",
      reason: "port_in_use_by_other_lock",
      port: endpoint.port,
    });
  });

  test("a holder that exits between the failed listen and the probe frees the port", async () => {
    let listens = 0;
    const result = await acquireInstanceLock(tcpEndpoint(), {
      listen: async () => {
        listens += 1;
        if (listens === 1) throw addressInUse();
        return { close: async () => {} };
      },
      probe: async () => ({ kind: "refused" }),
    });
    expect(result.status).toBe("acquired");
    expect(listens).toBe(2);
  });

  test("a port the system refuses to bind is unavailable, never retried elsewhere", async () => {
    const tried: number[] = [];
    const endpoint = tcpEndpoint();
    const result = await acquireInstanceLock(endpoint, {
      listen: async (target) => {
        if (target.kind === "tcp") tried.push(target.port);
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });
    expect(result).toEqual({ status: "unavailable", reason: "listen_failed", port: endpoint.port });
    expect(tried).toEqual([endpoint.port]);
  });
});
