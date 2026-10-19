import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport } from "../../commands/servers.ts";
import { processStartToken } from "../agents/state/proc-start.ts";
import { serverGcConfig, serverPortRange } from "../config.ts";
import {
  adoptServer,
  allocateServerPort,
  establishedConnectionCounts,
  findUnregisteredListeners,
  listServers,
  lsofConnectionCounts,
  lsofListeningSockets,
  parseElapsed,
  parseLsofListen,
  parseProcNetTcp,
  planServerGc,
  psProcessInfo,
  readProcessInfo,
  readServer,
  registerServer,
  type ServerView,
  scanSupport,
  serverId,
  serverState,
  serversDir,
  stopServer,
  touchServer,
  tunnelServerInput,
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
  test("tunnel registration does not attest saved helper pids", () => {
    const input = tunnelServerInput(
      {
        name: "default",
        provider: "cloudflare",
        url: "https://example.test",
        gate_pid: process.pid,
        gate_start_token: processStartToken(process.pid)!,
        cloudflared_pid: process.pid + 1,
        provider_pid: process.pid + 2,
        started_at: new Date().toISOString(),
        target: "http://127.0.0.1:3000",
        vhost: "localhost",
        gate_port: 4999,
        allow_paths: ["/"],
      },
      root,
    );
    expect(input.pid).toBe(process.pid);
    expect(input.pids).toBeUndefined();
    const record = registerServer(input, { coordRoot: root })!;
    expect(record.pids).toBeUndefined();
    expect(record.pids_start_tokens).toBeUndefined();
  });

  test("round-trips a record and honors the pid guard", () => {
    const record = registerServer(
      { kind: "session", type: "preview", scope: root, port: 4999, owner: null },
      { coordRoot: root },
    );
    expect(record?.pid).toBe(process.pid);
    expect(existsSync(join(serversDir(root), `${record!.id}.json`))).toBe(true);
    expect(readServer(record!.id, { coordRoot: root })?.port).toBe(4999);
    expect(unregisterServer({ ...record!, pid: process.pid + 1 }, { coordRoot: root })).toBe(false);
    expect(unregisterServer(record!, { coordRoot: root })).toBe(true);
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
  test("retains unknown auxiliary authority when its leader has exited", async () => {
    const leader = await startChildServer(root);
    const auxiliary = await startChildServer(root);
    const record = registerServer(
      {
        id: "orphaned",
        kind: "session",
        type: "preview",
        pid: leader.pid,
        pids: [auxiliary.pid],
        owner: null,
      },
      { coordRoot: root },
    )!;
    delete record.pids_start_tokens;
    const path = join(serversDir(root), `${record.id}.json`);
    writeFileSync(path, JSON.stringify(record));
    const before = readFileSync(path, "utf8");
    const leaderExited = new Promise<void>((resolve) => {
      children.find((child) => child.pid === leader.pid)!.once("exit", () => resolve());
    });
    process.kill(-leader.pid, "SIGKILL");
    await leaderExited;
    const report = listServers({ coordRoot: root, scan: false });
    expect(report.servers[0]?.state).toBe("unknown");
    expect(report.pruned).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
    const signals: number[] = [];
    const result = await stopServer(record, {
      coordRoot: root,
      signalDependencies: {
        signalProcess: (pid) => {
          signals.push(pid);
          return { sent: true, verdict: "same" };
        },
      },
    });
    expect(result).toMatchObject({ method: "refused", generation: "unknown", stopped: false });
    expect(signals).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(
      serverState(record, undefined, (pid) => {
        if (pid === auxiliary.pid) throw Object.assign(new Error("read failed"), { code: "EIO" });
        return false;
      }),
    ).toBe("unknown");
  });

  test("shows an unknown generation without pruning it or renewing its authority", async () => {
    const { pid, port } = await startChildServer(root);
    const record = registerServer(
      { id: "unknown", kind: "session", type: "preview", pid, port, owner: null },
      { coordRoot: root },
    )!;
    delete record.start_token;
    const path = join(serversDir(root), `${record.id}.json`);
    writeFileSync(path, JSON.stringify(record));
    const before = readFileSync(path, "utf8");
    const report = listServers({ coordRoot: root, sample: false });
    expect(report.servers[0]?.state).toBe("unknown");
    expect(report.pruned).toEqual([]);
    expect(report.unregistered.some((item) => item.pid === pid)).toBe(false);
    expect(renderReport(report, "harn")).toContain("unknown [unknown]");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("keeps a mismatched live pid record and does not expose it as unregistered", async () => {
    const { pid, port } = await startChildServer(root);
    const record = registerServer(
      { id: "different", kind: "session", type: "preview", pid, port, owner: null },
      { coordRoot: root },
    )!;
    record.start_token = "different-generation";
    const path = join(serversDir(root), `${record.id}.json`);
    writeFileSync(path, JSON.stringify(record));
    const before = readFileSync(path, "utf8");
    const report = listServers({ coordRoot: root, sample: false });
    expect(report.servers[0]?.state).toBe("dead");
    expect(report.pruned).toEqual([]);
    expect(report.unregistered.some((item) => item.pid === pid)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("an unreadable process token is unknown", () => {
    const record = registerServer(
      { id: "unreadable", kind: "session", type: "preview", owner: null },
      { coordRoot: root },
    )!;
    expect(serverState(record, () => null)).toBe("unknown");
    expect(
      serverState(record, () => {
        throw new Error("probe failed");
      }),
    ).toBe("unknown");
  });

  test("does not turn saved tunnel pids into fresh ownership", async () => {
    const { pid, port } = await startChildServer(root);
    const dir = join(root, ".cache", "tunnel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        name: "default",
        provider: "cloudflare",
        gate_pid: pid,
        gate_port: port,
        target: "http://127.0.0.1:3000",
        url: "https://example.test",
        started_at: new Date().toISOString(),
      }),
    );
    const report = listServers({ coordRoot: root, scan: false });
    expect(report.servers).toEqual([]);
    expect(readServer("tunnel-default", { coordRoot: root })).toBeNull();
  });

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
  test("an unclassified liveness failure sends nothing and retains the record", async () => {
    const record = registerServer(
      { id: "probe-error", kind: "session", type: "preview", owner: null },
      { coordRoot: root },
    )!;
    const path = join(serversDir(root), `${record.id}.json`);
    const before = readFileSync(path, "utf8");
    const probePid = () => {
      throw Object.assign(new Error("read failed"), { code: "EIO" });
    };
    const signals: number[] = [];
    expect(serverState(record, undefined, probePid)).toBe("unknown");
    const result = await stopServer(record, {
      coordRoot: root,
      signalDependencies: {
        probePid,
        signalProcess: (pid) => {
          signals.push(pid);
          return { sent: true, verdict: "same" };
        },
      },
    });
    expect(result).toMatchObject({ method: "refused", generation: "unknown", stopped: false });
    expect(signals).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("signals the exact process handle and removes the record", async () => {
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
    const signals: number[] = [];
    const result = await stopServer(
      { ...record, start_token: "l0.0" },
      {
        coordRoot: root,
        signalDependencies: {
          signalProcess: (pid) => {
            signals.push(pid);
            return { sent: true, verdict: "same" };
          },
        },
      },
    );
    expect(result).toMatchObject({ method: "refused", generation: "different", stopped: false });
    expect(signals).toEqual([]);
    expect(readServer(record.id, { coordRoot: root })).toEqual(record);
  });

  for (const unreadable of ["missing", "null", "throws"] as const) {
    test(`refuses an ${unreadable} token without changing the record`, async () => {
      const record = registerServer(
        { id: "unreadable", kind: "session", type: "preview", owner: null },
        { coordRoot: root },
      )!;
      const signals: number[] = [];
      const result = await stopServer(
        { ...record, ...(unreadable === "missing" ? { start_token: undefined } : {}) },
        {
          coordRoot: root,
          signalDependencies: {
            readToken:
              unreadable === "throws"
                ? () => {
                    throw new Error("probe failed");
                  }
                : () => null,
            signalProcess: (pid) => {
              signals.push(pid);
              return { sent: true, verdict: "same" };
            },
          },
        },
      );
      expect(result).toMatchObject({ method: "refused", generation: "unknown", stopped: false });
      expect(signals).toEqual([]);
      expect(readServer(record.id, { coordRoot: root })).toEqual(record);
    });
  }

  test("rechecks after observation and before the first signal", async () => {
    const record = registerServer(
      { id: "changed", kind: "session", type: "preview", owner: null },
      { coordRoot: root },
    )!;
    let reads = 0;
    const signals: number[] = [];
    const result = await stopServer(record, {
      coordRoot: root,
      signalDependencies: {
        readToken: () => (++reads === 1 ? record.start_token! : "different-generation"),
        signalProcess: (pid) => {
          signals.push(pid);
          return { sent: true, verdict: "same" };
        },
      },
    });
    expect(result.generation).toBe("different");
    expect(signals).toEqual([]);
    expect(readServer(record.id, { coordRoot: root })).toEqual(record);
  });

  for (const nextToken of [null, "different-generation"]) {
    test(`rechecks before SIGKILL when the token becomes ${nextToken ?? "unreadable"}`, async () => {
      const record = registerServer(
        { id: "escalate", kind: "session", type: "preview", owner: null },
        { coordRoot: root },
      )!;
      let reads = 0;
      const signals: Array<{ pid: number; name: NodeJS.Signals | number }> = [];
      const result = await stopServer(record, {
        coordRoot: root,
        graceMs: 0,
        signalDependencies: {
          readToken: () => (++reads < 4 ? record.start_token! : nextToken),
          signalProcess: (pid, _token, name) => {
            signals.push({ pid, name });
            return { sent: true, verdict: "same" };
          },
        },
      });
      expect(result).toMatchObject({
        method: "refused",
        generation: nextToken ? "different" : "unknown",
      });
      expect(signals).toEqual([{ pid: record.pid, name: "SIGTERM" }]);
      expect(readServer(record.id, { coordRoot: root })).toEqual(record);
    });
  }

  test("a failed retained handle never falls back to numeric signaling", async () => {
    const record = registerServer(
      { id: "fallback", kind: "session", type: "preview", owner: null },
      { coordRoot: root },
    )!;
    let failed = false;
    const signals: number[] = [];
    const result = await stopServer(record, {
      coordRoot: root,
      signalDependencies: {
        readToken: () => (failed ? "different-generation" : record.start_token!),
        signalProcess: (pid) => {
          signals.push(pid);
          failed = true;
          return { sent: false, verdict: "unknown" };
        },
      },
    });
    expect(result.generation).toBe("unknown");
    expect(signals).toEqual([record.pid]);
  });

  test("records auxiliary tokens and refuses any unverified live auxiliary", async () => {
    const { pid } = await startChildServer(root);
    const record = registerServer(
      { id: "helpers", kind: "session", type: "preview", pids: [pid], owner: null },
      { coordRoot: root },
    )!;
    expect(record.pids_start_tokens?.[pid]).toBe(processStartToken(pid) ?? undefined);
    const signals: number[] = [];
    for (const token of [undefined, "different-generation"]) {
      const result = await stopServer(
        { ...record, pids_start_tokens: token ? { [pid]: token } : undefined },
        {
          coordRoot: root,
          signalDependencies: {
            signalProcess: (target) => {
              signals.push(target);
              return { sent: true, verdict: "same" };
            },
          },
        },
      );
      expect(result).toMatchObject({
        method: "refused",
        generation: token ? "different" : "unknown",
      });
      expect(signals).toEqual([]);
      expect(readServer(record.id, { coordRoot: root })).toEqual(record);
    }
  });

  test("stops a verified leader and individually verified auxiliary process", async () => {
    const leader = await startChildServer(root);
    const auxiliary = await startChildServer(root);
    const record = registerServer(
      {
        id: "verified-helpers",
        kind: "session",
        type: "preview",
        pid: leader.pid,
        pids: [auxiliary.pid],
        owner: null,
      },
      { coordRoot: root },
    )!;
    const result = await stopServer(record, { coordRoot: root, graceMs: 3_000 });
    expect(result).toMatchObject({ stopped: true, method: "signal", generation: "same" });
    expect(readServer(record.id, { coordRoot: root })).toBeNull();
  });
});

function view(partial: Partial<ServerView> & { kind?: "session" | "service" }): ServerView {
  return {
    record: {
      schema_version: 2,
      registration_id: "00000000-0000-4000-8000-000000000000",
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
    expect(decide({ state: "unknown" })).toBe("keep");
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

  test("decode ps elapsed time", () => {
    expect(parseElapsed("05:07")).toBe(307);
    expect(parseElapsed(" 02:05:07")).toBe(7507);
    expect(parseElapsed("3-02:05:07")).toBe(266_707);
    expect(parseElapsed("")).toBeNull();
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
  test("reserves ports claimed by unknown registered processes", () => {
    writeConfig(root, { port_ranges: { p: [51000, 51002] } });
    const record = registerServer(
      { id: "unknown-port", kind: "session", type: "p", port: 51000, owner: null },
      { coordRoot: root },
    )!;
    delete record.start_token;
    writeFileSync(join(serversDir(root), `${record.id}.json`), JSON.stringify(record));
    expect(allocateServerPort("p", { coordRoot: root })).toBe(51001);
  });

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
  for (const token of [undefined, "different-generation"]) {
    test(`refuses a scan witness that is ${token ? "different" : "unknown"}`, async () => {
      const { pid, port } = await startChildServer(root);
      const currentToken = processStartToken(pid);
      expect(currentToken).toBeTruthy();
      expect(() =>
        adoptServer(pid, {
          coordRoot: root,
          owner: "none",
          dependencies: {
            listServers: () => ({
              schema_version: 1,
              coord_root: root,
              scan: "procfs",
              servers: [],
              pruned: [],
              unregistered: [
                {
                  pid,
                  port,
                  address: "127.0.0.1",
                  command: "server",
                  cwd: root,
                  start_token: token,
                },
              ],
            }),
            readToken: () => currentToken,
          },
        }),
      ).toThrow(/adoption refused/);
      expect(listServers({ coordRoot: root, scan: false }).servers).toEqual([]);
    });
  }

  test("registration preserves an observed witness and refuses a changed one before writing", () => {
    const token = processStartToken(process.pid)!;
    const input = {
      id: "observed",
      kind: "session" as const,
      type: "preview",
      owner: null,
      start_token: token,
    };
    const record = registerServer(input, { coordRoot: root })!;
    expect(record.start_token).toBe(token);
    const path = join(serversDir(root), `${record.id}.json`);
    const before = readFileSync(path, "utf8");
    expect(() =>
      registerServer({ ...input, start_token: "different-generation" }, { coordRoot: root }),
    ).toThrow(/generation could not be verified/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test.skipIf(scanSupport() === "unsupported")(
    "registers an unregistered listener and refuses anything else",
    async () => {
      const { pid, port } = await startChildServer(root);
      const record = adoptServer(pid, { coordRoot: root, type: "preview", owner: "none" });
      expect(record).toMatchObject({ pid, port, type: "preview", kind: "session" });
      expect(Date.parse(record.started_at)).toBeLessThanOrEqual(Date.parse(record.registered_at));
      expect(record.owner).toBeUndefined();
      expect(() => adoptServer(pid, { coordRoot: root })).toThrow(/not an unregistered listener/);
      expect(() => adoptServer(process.pid, { coordRoot: root })).toThrow(
        /not an unregistered listener/,
      );
    },
  );
});

const hasLsof =
  spawnSync("lsof", ["-v"], { stdio: "ignore" }).status === 0 && process.platform !== "win32";

describe("macOS scan path (lsof and ps)", () => {
  test.skipIf(!hasLsof)(
    "finds the same listener, process, and connection as the native path",
    async () => {
      const { pid, port } = await startChildServer(root);
      expect(lsofListeningSockets().some((s) => s.pid === pid && s.port === port)).toBe(true);
      const viaPs = psProcessInfo(pid);
      const native = readProcessInfo(pid);
      expect(viaPs?.cwd).toBe(native?.cwd ?? null);
      expect(viaPs?.ppid).toBe(native?.ppid ?? null);
      expect(viaPs?.command).toContain("Bun.serve");
      const socket: Socket = connect(port, "127.0.0.1");
      await new Promise((resolve) => socket.once("connect", resolve));
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
      try {
        await Bun.sleep(150);
        expect(lsofConnectionCounts(new Set([port])).get(port) ?? 0).toBeGreaterThan(0);
      } finally {
        socket.destroy();
      }
    },
  );
});
