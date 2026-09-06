import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLiveTunnelForPort, isTunnelStateLive, type TunnelState } from "./state.ts";

function state(overrides: Partial<TunnelState> = {}): TunnelState {
  return {
    name: "harnery-web",
    provider: "cloudflare",
    url: "https://public.example",
    gate_pid: 10,
    cloudflared_pid: 20,
    started_at: "2026-09-06T12:00:00.000Z",
    target: "127.0.0.1:4276",
    vhost: "localhost:4276",
    gate_port: 9001,
    ...overrides,
  };
}

describe("findLiveTunnelForPort", () => {
  test("returns the newest live tunnel that fronts the requested port", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-tunnel-state-"));
    try {
      const dir = join(root, ".cache", "tunnel");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state-old.json"), JSON.stringify(state({ name: "old" })));
      writeFileSync(
        join(dir, "state-new.json"),
        JSON.stringify(
          state({
            name: "new",
            url: "https://new.example",
            gate_pid: 30,
            cloudflared_pid: 40,
            started_at: "2026-09-06T13:00:00.000Z",
          }),
        ),
      );
      writeFileSync(
        join(dir, "state-other.json"),
        JSON.stringify(state({ name: "other", target: "127.0.0.1:3000" })),
      );

      const live = new Set([10, 20, 30, 40]);
      expect(findLiveTunnelForPort(4276, root, (pid) => live.has(pid))?.url).toBe(
        "https://new.example",
      );
      expect(findLiveTunnelForPort(3000, root, (pid) => live.has(pid))?.name).toBe("other");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores stale gates and stale provider processes", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-tunnel-state-stale-"));
    try {
      const dir = join(root, ".cache", "tunnel");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify(state()));

      expect(findLiveTunnelForPort(4276, root, (pid) => pid === 10)).toBeNull();
      expect(findLiveTunnelForPort(4276, root, (pid) => pid === 20)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isTunnelStateLive", () => {
  test("accepts a live Tailscale gate without a separate provider PID", () => {
    expect(
      isTunnelStateLive(
        state({ provider: "tailscale", cloudflared_pid: undefined, gate_pid: 10 }),
        (pid) => pid === 10,
      ),
    ).toBe(true);
  });

  test("accepts the generic provider PID used by older Cloudflare state", () => {
    expect(
      isTunnelStateLive(
        state({ cloudflared_pid: undefined, provider_pid: 20 }),
        (pid) => pid === 10 || pid === 20,
      ),
    ).toBe(true);
  });
});
