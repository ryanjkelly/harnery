import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOUDFLARED_ENV,
  ensureCloudflared,
  findLiveTunnelForOrigin,
  isTunnelStateLive,
  readConfig,
  TUNNEL_DIR_ENV,
  type TunnelState,
  tunnelDir,
  writeConfig,
} from "./state.ts";

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
    allow_paths: ["/"],
    ...overrides,
  };
}

describe("findLiveTunnelForOrigin", () => {
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
      expect(
        findLiveTunnelForOrigin(4276, "localhost:4276", root, (pid) => live.has(pid))?.url,
      ).toBe("https://new.example");
      expect(
        findLiveTunnelForOrigin(3000, "localhost:4276", root, (pid) => live.has(pid))?.name,
      ).toBe("other");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips a same-port tunnel that serves a different Host", () => {
    // Two tunnels can forward to one upstream port and differ only by the Host
    // header they send. The dashboard tunnel is the older of the two here, so a
    // port-only match would return the newer files tunnel and every dashboard
    // route built on it would fail.
    const root = mkdtempSync(join(tmpdir(), "harnery-tunnel-state-vhost-"));
    try {
      const dir = join(root, ".cache", "tunnel");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "state-harnery-web.json"),
        JSON.stringify(
          state({
            name: "harnery-web",
            url: "https://dashboard.example",
            vhost: "localhost:4276",
            started_at: "2026-09-06T10:00:00.000Z",
          }),
        ),
      );
      writeFileSync(
        join(dir, "state-harnery-files.json"),
        JSON.stringify(
          state({
            name: "harnery-files",
            url: "https://files.example",
            vhost: "harnery-files.localhost",
            started_at: "2026-09-06T20:00:00.000Z",
          }),
        ),
      );

      const live = new Set([10, 20]);
      expect(
        findLiveTunnelForOrigin(4276, "localhost:4276", root, (pid) => live.has(pid))?.url,
      ).toBe("https://dashboard.example");
      expect(
        findLiveTunnelForOrigin(4276, "harnery-files.localhost", root, (pid) => live.has(pid))?.url,
      ).toBe("https://files.example");
      expect(
        findLiveTunnelForOrigin(4276, "nothing.serves.this", root, (pid) => live.has(pid)),
      ).toBeNull();
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

      expect(findLiveTunnelForOrigin(4276, "localhost:4276", root, (pid) => pid === 10)).toBeNull();
      expect(findLiveTunnelForOrigin(4276, "localhost:4276", root, (pid) => pid === 20)).toBeNull();
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

describe("tunnelDir", () => {
  test("defaults to <root>/.cache/tunnel and honors the directory override", () => {
    expect(tunnelDir("/work/repo", {})).toBe("/work/repo/.cache/tunnel");
    expect(tunnelDir("/work/repo", { [TUNNEL_DIR_ENV]: "/kit/.harnery/tunnel" })).toBe(
      "/kit/.harnery/tunnel",
    );
    expect(tunnelDir("/work/repo", { [TUNNEL_DIR_ENV]: "  " })).toBe("/work/repo/.cache/tunnel");
  });

  test("config round-trips the automatic-entry and cloudflared fields, and survives a bad file", () => {
    const dir = mkdtempSync(join(tmpdir(), "harnery-tunnel-config-"));
    const before = process.env[TUNNEL_DIR_ENV];
    process.env[TUNNEL_DIR_ENV] = dir;
    try {
      writeConfig({
        allowed_ips: ["203.0.113.8/32"],
        auto_allowed: ["203.0.113.8/32"],
        cloudflared_path: "/opt/cf",
      });
      expect(readConfig()).toEqual({
        allowed_ips: ["203.0.113.8/32"],
        auto_allowed: ["203.0.113.8/32"],
        cloudflared_path: "/opt/cf",
      });
      writeFileSync(join(dir, "config.json"), JSON.stringify({ cloudflared_path: "/opt/cf" }));
      expect(readConfig().allowed_ips).toEqual([]);
      writeFileSync(join(dir, "config.json"), "{ not json");
      expect(readConfig().allowed_ips).toEqual([]);
    } finally {
      if (before === undefined) delete process.env[TUNNEL_DIR_ENV];
      else process.env[TUNNEL_DIR_ENV] = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureCloudflared with an explicit binary", () => {
  function fakeBinary(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "harnery-cloudflared-"));
    const path = join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
    return { dir, path };
  }

  test("$HARNERY_CLOUDFLARED wins over the config path and PATH", () => {
    const env = fakeBinary();
    const cfg = fakeBinary();
    try {
      expect(ensureCloudflared({ [CLOUDFLARED_ENV]: env.path, PATH: cfg.dir }, cfg.path)).toBe(
        env.path,
      );
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
      rmSync(cfg.dir, { recursive: true, force: true });
    }
  });

  test("the config path is used when the environment names none", () => {
    const cfg = fakeBinary();
    try {
      expect(ensureCloudflared({}, cfg.path)).toBe(cfg.path);
    } finally {
      rmSync(cfg.dir, { recursive: true, force: true });
    }
  });

  test("an explicit path that is missing is an error, never a silent fall-through", () => {
    const onPath = fakeBinary();
    try {
      expect(() =>
        ensureCloudflared({ [CLOUDFLARED_ENV]: "/nope/cloudflared", PATH: onPath.dir }, undefined),
      ).toThrow(/HARNERY_CLOUDFLARED.*missing or not runnable/);
      expect(() => ensureCloudflared({ PATH: onPath.dir }, "/nope/cloudflared")).toThrow(
        /tunnel config.*missing or not runnable/,
      );
    } finally {
      rmSync(onPath.dir, { recursive: true, force: true });
    }
  });

  test("falls back to cloudflared on PATH, as a full path", () => {
    const onPath = fakeBinary();
    try {
      expect(ensureCloudflared({ PATH: onPath.dir }, undefined)).toBe(onPath.path);
    } finally {
      rmSync(onPath.dir, { recursive: true, force: true });
    }
  });
});
