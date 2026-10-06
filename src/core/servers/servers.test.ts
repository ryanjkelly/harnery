import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport } from "../../commands/servers.ts";
import { serverGcConfig, serverPortRange } from "../config.ts";
import {
  adoptServer,
  allocateServerPort,
  establishedConnectionCounts,
  findUnregisteredListeners,
  listServers,
  parseLsofListen,
  parseProcNetTcp,
  planServerGc,
  readServer,
  registerServer,
  type ServerView,
  scanSupport,
  serverId,
  serversDir,
  stopServer,
  touchServer,
  unregisterServer,
} from "./index.ts";

let root: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-servers-")));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Start a detached Bun HTTP server in `cwd`; resolves with its pid and port. */
async function startChildServer(cwd: string): Promise<{ pid: number; port: number }> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') }); console.log(s.port); setInterval(() => {}, 1000);",
    ],
    { cwd, detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout?.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim())));
    child.once("exit", () => reject(new Error("child exited before listening")));
  });
  return { pid: child.pid!, port };
}

describe("server ids", () => {
  test("derive a stable, valid id from type and scope", () => {
    const a = serverId("tune", "/work/projects/Scene One");
    expect(a).toBe(serverId("tune", "/work/projects/Scene One"));
    expect(a).toMatch(/^tune-scene-one-[0-9a-f]{6}$/);
    expect(serverId("tune", "/other/Scene One")).not.toBe(a);
    expect(serverId("Dash Board")).toBe("dash-board");
  });
});

describe("register, read, unregister", () => {
  test("round-trips a record and honors the pid guard", () => {
    const record = registerServer(
      { kind: "session", type: "preview", scope: root, port: 4999, owner: null },
      { coordRoot: root },
    );
    expect(record?.pid).toBe(process.pid);
    expect(existsSync(join(serversDir(root), `${record!.id}.json`))).toBe(true);
    expect(readServer(record!.id, { coordRoot: root })?.port).toBe(4999);
    expect(unregisterServer(record!.id, { coordRoot: root, pid: process.pid + 1 })).toBe(false);
    expect(unregisterServer(record!.id, { coordRoot: root, pid: process.pid })).toBe(true);
    expect(readServer(record!.id, { coordRoot: root })).toBeNull();
  });

  test("returns null outside a project and rejects bad input", () => {
    expect(registerServer({ kind: "session", type: "x" }, { coordRoot: null })).toBeNull();
    expect(() =>
      registerServer({ kind: "session", type: "x", port: 70000, owner: null }, { coordRoot: root }),
    ).toThrow(/port/);
  });

  test("touch moves last activity forward", () => {
    const record = registerServer(
      { kind: "session", type: "preview", owner: null },
      { coordRoot: root },
    )!;
    const later = new Date(Date.parse(record.registered_at) + 3_600_000);
    touchServer(record.id, { coordRoot: root, now: later });
    expect(readServer(record.id, { coordRoot: root })?.last_active_at).toBe(later.toISOString());
  });
});

describe("listing", () => {
  test("prunes records whose process exited", async () => {
    const { pid } = await startChildServer(root);
    registerServer(
      { id: "gone", kind: "session", type: "preview", pid, owner: null },
      { coordRoot: root },
    );
    process.kill(-pid, "SIGKILL");
    await Bun.sleep(150);
    const report = listServers({ coordRoot: root, scan: false });
    expect(report.pruned).toEqual(["gone"]);
    expect(report.servers).toEqual([]);
    expect(readServer("gone", { coordRoot: root })).toBeNull();
  });

  test.skipIf(scanSupport() === "unsupported")(
    "flags an unregistered listener inside the project until it registers",
    async () => {
      const { pid, port } = await startChildServer(root);
      const before = findUnregisteredListeners(root, []);
      expect(before.some((item) => item.pid === pid && item.port === port)).toBe(true);
      registerServer(
        { id: "child", kind: "session", type: "preview", pid, port, owner: null },
        { coordRoot: root },
      );
      const report = listServers({ coordRoot: root });
      expect(report.unregistered.some((item) => item.pid === pid)).toBe(false);
      expect(report.servers.map((view) => view.record.id)).toEqual(["child"]);
    },
  );

  test.skipIf(scanSupport() === "unsupported")("counts open connections as activity", async () => {
    const { pid, port } = await startChildServer(root);
    const socket: Socket = connect(port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
    try {
      await Bun.sleep(100);
      expect(establishedConnectionCounts([port]).get(port) ?? 0).toBeGreaterThan(0);
      const old = new Date(Date.now() - 5 * 3_600_000);
      registerServer(
        { id: "busy", kind: "session", type: "preview", pid, port, owner: null },
        { coordRoot: root },
      );
      touchServer("busy", { coordRoot: root, now: old });
      const view = listServers({ coordRoot: root, scan: false }).servers[0]!;
      expect(view.connections).toBeGreaterThan(0);
      expect(view.idle_ms).toBeLessThan(60_000);
    } finally {
      socket.destroy();
    }
  });
});

describe("stopping", () => {
  test("signals the process group and removes the record", async () => {
    const { pid } = await startChildServer(root);
    const record = registerServer(
      { id: "stop-me", kind: "session", type: "preview", pid, owner: null },
      { coordRoot: root },
    )!;
    const result = await stopServer(record, { coordRoot: root, graceMs: 3_000 });
    expect(result).toMatchObject({ stopped: true, method: "signal" });
    expect(readServer("stop-me", { coordRoot: root })).toBeNull();
  });

  test("refuses a recycled pid instead of signalling it", async () => {
    const record = registerServer(
      { id: "recycled", kind: "session", type: "preview", owner: null },
      { coordRoot: root },
    )!;
    const result = await stopServer({ ...record, start_token: "l0.0" }, { coordRoot: root });
    expect(result.method).toBe("not-running");
  });
});

function view(partial: Partial<ServerView> & { kind?: "session" | "service" }): ServerView {
  return {
    record: {
      schema_version: 1,
      id: "s",
      kind: partial.kind ?? "session",
      type: "preview",
      label: "s",
      pid: 1,
      host: "h",
      started_at: "",
      registered_at: "",
    },
    state: "running",
    owner_state: "ended",
    connections: 0,
    last_active_at: "",
    idle_ms: 3 * 3_600_000,
    ...partial,
  };
}

describe("gc policy", () => {
  test("stops only idle session servers whose agent is gone", () => {
    const decide = (partial: Parameters<typeof view>[0]) =>
      planServerGc([view(partial)])[0]!.action;
    expect(decide({})).toBe("stop");
    expect(decide({ owner_state: "abandoned" })).toBe("stop");
    expect(decide({ kind: "service" })).toBe("keep");
    expect(decide({ owner_state: "live" })).toBe("keep");
    expect(decide({ owner_state: "unknown" })).toBe("keep");
    expect(decide({ owner_state: "none" })).toBe("keep");
    expect(decide({ idle_ms: 30 * 60_000 })).toBe("keep");
    expect(decide({ state: "other-host" })).toBe("keep");
    expect(planServerGc([view({ idle_ms: 30 * 60_000 })], { idleHours: 0.25 })[0]!.action).toBe(
      "stop",
    );
  });
});

describe("parsers", () => {
  test("decode /proc/net/tcp rows", () => {
    const rows = parseProcNetTcp(
      [
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
        "   0: 0100007F:1309 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0",
        "   1: 0100007F:1309 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 100 0 0 10 0",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { localAddress: "127.0.0.1", localPort: 4873, state: "0A", inode: "12345" },
      { localAddress: "127.0.0.1", localPort: 4873, state: "01", inode: "12346" },
    ]);
  });

  test("decode lsof listening output", () => {
    expect(parseLsofListen("p42\nn127.0.0.1:4873\nn[::1]:4873\np7\nn*:3000\n")).toEqual([
      { pid: 7, port: 3000, address: "*" },
      { pid: 42, port: 4873, address: "127.0.0.1" },
    ]);
  });
});

describe("rendering", () => {
  test("groups by kind and names the control commands with the host bin", () => {
    const text = renderReport(
      {
        schema_version: 1,
        coord_root: "/p",
        scan: "procfs",
        servers: [view({ kind: "service" }), view({})],
        unregistered: [{ pid: 9, port: 1, address: "127.0.0.1", command: "node x", cwd: "/p" }],
        pruned: [],
      },
      "mybin",
    );
    expect(text).toContain("Services (stopped only by hand)");
    expect(text).toContain("Session servers");
    expect(text).toContain("mybin servers stop --pid <pid>");
    expect(text).toContain("mybin servers gc");
  });
});

function writeConfig(dir: string, servers: unknown): void {
  mkdirSync(join(dir, ".harnery"), { recursive: true });
  writeFileSync(join(dir, ".harnery", "config.jsonc"), JSON.stringify({ servers }));
}

describe("port ranges", () => {
  test("read valid ranges and ignore malformed ones", () => {
    writeConfig(root, {
      port_ranges: { a: [5100, 5109], bad: [10, 5], worse: "x" },
      idle_hours: 4,
    });
    expect(serverPortRange("a", root)).toEqual([5100, 5109]);
    expect(serverPortRange("bad", root)).toBeNull();
    expect(serverPortRange("worse", root)).toBeNull();
    expect(serverPortRange("missing", root)).toBeNull();
    expect(serverGcConfig(root)).toEqual({ idle_hours: 4 });
  });

  test("skip listening and registered ports", async () => {
    const { pid, port } = await startChildServer(root);
    writeConfig(root, { port_ranges: { p: [port, port + 2] } });
    registerServer(
      { id: "claims-next", kind: "session", type: "p", pid, port: port + 1, owner: null },
      { coordRoot: root },
    );
    expect(allocateServerPort("p", { coordRoot: root })).toBe(port + 2);
    expect(allocateServerPort("none", { coordRoot: root })).toBeNull();
  });
});

describe("adoption", () => {
  test.skipIf(scanSupport() === "unsupported")(
    "registers an unregistered listener and refuses anything else",
    async () => {
      const { pid, port } = await startChildServer(root);
      const record = adoptServer(pid, { coordRoot: root, type: "preview", owner: "none" });
      expect(record).toMatchObject({ pid, port, type: "preview", kind: "session" });
      expect(record.owner).toBeUndefined();
      expect(() => adoptServer(pid, { coordRoot: root })).toThrow(/not an unregistered listener/);
      expect(() => adoptServer(process.pid, { coordRoot: root })).toThrow(
        /not an unregistered listener/,
      );
    },
  );
});
