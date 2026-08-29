import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram } from "../commander.ts";
import type { TunnelState } from "../lib/tunnel/state.ts";
import { reloadOne, tunnelLogDestinations } from "./tunnel.ts";

function tunnelCommand() {
  const program = createHarneryProgram();
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
  test("exposes reload alongside the rest of the lifecycle", () => {
    const names = tunnelCommand()?.commands.map((c) => c.name());
    expect(names).toContain("reload");
  });

  test("reload takes --name and --all", () => {
    const reload = tunnelCommand()?.commands.find((c) => c.name() === "reload");
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
