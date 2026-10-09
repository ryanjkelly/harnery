import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, loadLazyCommand } from "../commander.ts";
import { readConfig, TUNNEL_DIR_ENV, type TunnelState, writeConfig } from "../lib/tunnel/state.ts";
import {
  refreshCurrentAddress,
  reloadOne,
  resolveGateLaunch,
  resolveWorkerLaunch,
  tunnelLogDestinations,
} from "./tunnel.ts";

async function tunnelCommand() {
  const program = createHarneryProgram();
  await loadLazyCommand(program, "tunnel");
  return program.commands.find((candidate) => candidate.name() === "tunnel");
}

function state(overrides: Partial<TunnelState> = {}): TunnelState {
  return {
    name: "spec",
    provider: "cloudflare",
    url: "https://example-quick-tunnel.invalid",
    gate_pid: 1,
    cloudflared_pid: 1,
    started_at: new Date(0).toISOString(),
    target: "127.0.0.1:9999",
    vhost: "localhost:9999",
    gate_port: 9099,
    allow_paths: ["/"],
    ...overrides,
  };
}

/** A PID that is guaranteed dead: spawn something trivial and reap it. */
async function deadPid(): Promise<number> {
  const p = spawn("true", [], { stdio: "ignore" });
  await new Promise((r) => p.once("exit", r));
  return p.pid as number;
}

/** A PID that is guaranteed alive for the life of the test, plus its killer. */
function livePid(): { pid: number; kill: () => void } {
  const p = spawn("sleep", ["30"], { stdio: "ignore" });
  return { pid: p.pid as number, kill: () => p.kill() };
}

describe("tunnel command registration", () => {
  test("exposes reload alongside the rest of the lifecycle", async () => {
    const names = (await tunnelCommand())?.commands.map((c) => c.name());
    expect(names).toContain("reload");
  });

  test("up takes a repeatable --allow-path with no default scope", async () => {
    const up = (await tunnelCommand())?.commands.find((c) => c.name() === "up");
    const option = up?.options.find((o) => o.long === "--allow-path");
    expect(option).toBeDefined();
    expect(option?.defaultValue).toEqual([]);
  });

  test("reload takes --name and --all", async () => {
    const reload = (await tunnelCommand())?.commands.find((c) => c.name() === "reload");
    const flags = reload?.options.map((o) => o.long);
    expect(flags).toContain("--name");
    expect(flags).toContain("--all");
  });

  test("routes new process logs only to the catalog partition unless rollback is explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-tunnel-logs-"));
    const legacyGate = join(root, ".cache", "tunnel", "gate.log");
    try {
      mkdirSync(join(root, ".cache", "tunnel"), { recursive: true });
      writeFileSync(legacyGate, "legacy");
      const shared = tunnelLogDestinations("default", "cloudflare", {}, root);
      expect(shared).toEqual({
        gate: join(root, ".harnery", "logs", "tunnel-process", "gate.log"),
        provider: join(root, ".harnery", "logs", "tunnel-process", "cloudflared.log"),
      });
      expect(readFileSync(legacyGate, "utf8")).toBe("legacy");
      expect(
        tunnelLogDestinations("default", "cloudflare", { HARNERY_SHARED_LOGS: "0" }, root),
      ).toEqual({
        gate: legacyGate,
        provider: join(root, ".cache", "tunnel", "cloudflared.log"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("reloadOne", () => {
  test("refuses when the provider process is gone, and says to run up instead", async () => {
    const gone = await deadPid();
    const result = await reloadOne(state({ cloudflared_pid: gone, gate_pid: gone }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("provider process is gone");
    expect(result.message).toContain("tunnel up");
  }, 15_000);

  /**
   * The refusal must be inert. reloadOne kills the gate before it can know
   * whether the respawn will succeed, so if the provider check came second a
   * dead-provider instance would lose its gate for nothing — turning a broken
   * URL into a broken URL AND a stopped proxy.
   */
  test("does not touch the gate process when it refuses", async () => {
    const gate = livePid();
    try {
      const result = await reloadOne(
        state({ gate_pid: gate.pid, cloudflared_pid: await deadPid() }),
      );
      expect(result.ok).toBe(false);
      // Still alive: process.kill(pid, 0) throws only when the pid is gone.
      expect(() => process.kill(gate.pid, 0)).not.toThrow();
    } finally {
      gate.kill();
    }
  });

  test("refuses a state with no path scope without touching the gate", async () => {
    // A state written before path scopes existed has none. Respawning its gate
    // would refuse every request, so reload must send the operator to `up`.
    const gate = livePid();
    const provider = livePid();
    try {
      const result = await reloadOne(
        state({ gate_pid: gate.pid, cloudflared_pid: provider.pid, allow_paths: [] }),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("no recorded path scope");
      expect(result.message).toContain("--allow-path");
      expect(() => process.kill(gate.pid, 0)).not.toThrow();
    } finally {
      gate.kill();
      provider.kill();
    }
  });

  /**
   * Tailscale hands access control to tailscaled rather than the gate, and
   * providerIsAlive() reports true unconditionally for it — so the refusal
   * branch must not fire on a Tailscale instance merely because there is no
   * cloudflared PID to check.
   *
   * Held at the port gate on purpose: past that point reloadOne spawns a real
   * gate and rewrites state under the cwd, which a unit test must not do. An
   * occupied gate_port stops it one step earlier while still proving the
   * provider check let it through.
   */
  test("does not use the cloudflared-absent path to refuse a Tailscale instance", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await reloadOne(
        state({
          provider: "tailscale",
          cloudflared_pid: undefined,
          gate_pid: await deadPid(),
          gate_port: port,
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain("provider process is gone");
      expect(result.message).toContain("never released");
    } finally {
      server.close();
    }
  }, 15_000);
});

describe("resolveGateLaunch", () => {
  const base = {
    gateScript: "/pkg/src/lib/tunnel/gate.ts",
    gateScriptExists: true,
    underBun: true,
    execPath: "/home/u/.bun/bin/bun",
    entryScript: "/kit/bpc.mjs",
    entryScriptExists: true,
    bunOnPath: false,
  };

  test("a source checkout runs gate.ts beside the command with the running Bun", () => {
    expect(resolveGateLaunch(base)).toEqual({
      command: "/home/u/.bun/bin/bun",
      arguments: ["run", "/pkg/src/lib/tunnel/gate.ts"],
    });
  });

  test("a Node host with gate.ts on disk and bun on PATH uses bun from PATH", () => {
    expect(resolveGateLaunch({ ...base, underBun: false, bunOnPath: true })).toEqual({
      command: "bun",
      arguments: ["run", "/pkg/src/lib/tunnel/gate.ts"],
    });
  });

  test("inside a single-file bundle the CLI re-executes itself with the hidden gate task", () => {
    expect(resolveGateLaunch({ ...base, gateScriptExists: false })).toEqual({
      command: "/home/u/.bun/bin/bun",
      arguments: ["/kit/bpc.mjs", "tunnel", "gate"],
    });
  });

  test("returns null when no Bun can run the gate", () => {
    expect(resolveGateLaunch({ ...base, underBun: false, gateScriptExists: false })).toBeNull();
    expect(resolveGateLaunch({ ...base, underBun: false })).toBeNull();
    expect(
      resolveGateLaunch({ ...base, gateScriptExists: false, entryScriptExists: false }),
    ).toBeNull();
    expect(
      resolveGateLaunch({ ...base, gateScriptExists: false, entryScript: undefined }),
    ).toBeNull();
  });
});

describe("resolveWorkerLaunch", () => {
  const inputs = {
    gateScript: "/pkg/src/lib/tunnel/gate.ts",
    gateScriptExists: false,
    underBun: true,
    execPath: "/home/u/.bun/bin/bun",
    entryScript: "/kit/bpc.mjs",
    entryScriptExists: true,
    bunOnPath: false,
  };

  test("a source checkout keeps the package's own wrapper", () => {
    expect(resolveWorkerLaunch({ ...inputs, gateScriptExists: true })).toBeUndefined();
  });

  test("a single-file bundle re-executes itself with the hidden log-worker task", () => {
    expect(resolveWorkerLaunch(inputs)).toEqual({
      command: "/home/u/.bun/bin/bun",
      arguments: ["/kit/bpc.mjs", "tunnel", "log-worker"],
    });
  });

  test("falls back to the default when the entry script is unknown", () => {
    expect(resolveWorkerLaunch({ ...inputs, entryScript: undefined })).toBeUndefined();
    expect(resolveWorkerLaunch({ ...inputs, underBun: false })).toBeUndefined();
  });
});

describe("tunnel hidden tasks", () => {
  test("gate and log-worker are registered but hidden from help", async () => {
    const tunnel = await tunnelCommand();
    for (const name of ["gate", "log-worker"]) {
      const task = tunnel?.commands.find((c) => c.name() === name);
      expect(task).toBeDefined();
      expect((task as unknown as { _hidden: boolean })._hidden).toBe(true);
    }
    expect(tunnel?.helpInformation()).not.toMatch(/^\s+log-worker\b/m);
    expect(tunnel?.helpInformation()).not.toMatch(/^\s+gate\b/m);
  });
});

describe("allowlist commands", () => {
  async function inTempConfig<T>(body: (output: string[]) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "harnery-tunnel-allow-"));
    const before = process.env[TUNNEL_DIR_ENV];
    process.env[TUNNEL_DIR_ENV] = dir;
    try {
      return await body([]);
    } finally {
      if (before === undefined) delete process.env[TUNNEL_DIR_ENV];
      else process.env[TUNNEL_DIR_ENV] = before;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function run(output: string[], ...args: string[]): Promise<void> {
    const program = createHarneryProgram({
      emit: {
        config() {},
        data() {},
        rows() {},
        text: (s) => void output.push(s),
        file() {},
        error: (e) => void output.push(`ERROR ${JSON.stringify(e)}`),
        log() {},
        setExitCode() {},
      },
    });
    program.exitOverride();
    await program.parseAsync(["node", "harn", "tunnel", ...args]);
  }

  test("add normalizes IPv6 spellings and ranges, and rejects what is not an address", () =>
    inTempConfig(async (out) => {
      await run(out, "allow", "add", "2601:DB8:0:0::1");
      await run(out, "allow", "add", "2601:db8::1");
      await run(out, "allow", "add", "203.0.113.77/24");
      expect(readConfig().allowed_ips).toEqual(["2601:db8::1", "203.0.113.0/24"]);
      expect(out.join("")).toContain("already in allowlist");
      const exit = process.exit;
      let code: number | undefined;
      process.exit = ((c?: number) => {
        code = c;
        throw new Error("exit");
      }) as never;
      try {
        await expect(run(out, "allow", "add", "not-an-ip")).rejects.toThrow("exit");
      } finally {
        process.exit = exit;
      }
      expect(code).toBe(1);
      expect(readConfig().allowed_ips).toHaveLength(2);
    }));

  test("rm accepts any spelling and forgets an automatic entry's mark", () =>
    inTempConfig(async (out) => {
      writeConfig({
        allowed_ips: ["2601:db8:1:2::/64", "198.51.100.1"],
        auto_allowed: ["2601:db8:1:2::/64"],
      });
      await run(out, "allow", "rm", "2601:0db8:1:2:0::/64");
      expect(readConfig()).toEqual({ allowed_ips: ["198.51.100.1"], auto_allowed: [] });
    }));

  test("adding by hand an automatic entry adopts it", () =>
    inTempConfig(async (out) => {
      writeConfig({ allowed_ips: ["203.0.113.8/32"], auto_allowed: ["203.0.113.8/32"] });
      await run(out, "allow", "add", "203.0.113.8");
      expect(readConfig().auto_allowed).toEqual([]);
      expect(readConfig().allowed_ips).toEqual(["203.0.113.8/32"]);
    }));

  test("list marks automatic entries", () =>
    inTempConfig(async (out) => {
      writeConfig({
        allowed_ips: ["198.51.100.1", "203.0.113.8/32"],
        auto_allowed: ["203.0.113.8/32"],
      });
      await run(out, "allow", "list");
      expect(out.join("")).toBe("198.51.100.1\n203.0.113.8/32  (automatic)\n");
    }));

  test("refreshCurrentAddress records what it added and keeps the list on a failed lookup", () =>
    inTempConfig(async (out) => {
      const emit = {
        config() {},
        data() {},
        rows() {},
        text: (s: string) => void out.push(s),
        file() {},
        error() {},
        log() {},
        setExitCode() {},
      };
      writeConfig({ allowed_ips: ["198.51.100.1"] });
      const first = await refreshCurrentAddress({
        emit,
        reload: false,
        detect: async () => ({ v4: "203.0.113.8", v6: "2601:db8:1:2::9", failures: [] }),
      });
      expect(first.changed).toBe(true);
      expect(readConfig()).toEqual({
        allowed_ips: ["198.51.100.1", "203.0.113.8/32", "2601:db8:1:2::/64"],
        auto_allowed: ["203.0.113.8/32", "2601:db8:1:2::/64"],
      });
      const failed = await refreshCurrentAddress({
        emit,
        reload: false,
        detect: async () => ({ failures: ["IPv4: down", "IPv6: down"] }),
      });
      expect(failed.ok).toBe(true);
      expect(failed.warnings[0]).toContain("Could not detect");
      expect(readConfig().allowed_ips).toHaveLength(3);
    }));
});
