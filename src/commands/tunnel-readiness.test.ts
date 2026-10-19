import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import * as registry from "../core/servers/index.ts";
import * as processLog from "../core/storage/process-log.ts";
import * as processes from "../lib/tunnel/processes.ts";
import { TUNNEL_DIR_ENV, type TunnelState, writeState } from "../lib/tunnel/state.ts";
import {
  beginTailscaleRoute,
  downOne,
  registerTunnelCommand,
  reloadOne,
  withTunnelLifecycleCustody,
} from "./tunnel.ts";

let root: string;
let state: TunnelState;
let priorTunnel: string | undefined;
let priorRoot: string | undefined;
let program: Command;
let output: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tunnel-ready-command-"));
  priorTunnel = process.env[TUNNEL_DIR_ENV];
  priorRoot = process.env.HARNERY_COORD_ROOT_OVERRIDE;
  process.env[TUNNEL_DIR_ENV] = join(root, ".cache", "tunnel");
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  const token = registry.processStartToken(process.pid)!;
  state = {
    name: "readiness",
    provider: "cloudflare",
    url: "https://saved.example",
    gate_pid: process.pid,
    gate_start_token: token,
    cloudflared_pid: process.pid,
    cloudflared_start_token: token,
    started_at: "2026-10-19T00:00:00Z",
    target: "127.0.0.1:4276",
    vhost: "localhost",
    gate_port: 9001,
    allow_paths: ["/"],
  };
  const receipt = registry.registerServer(registry.tunnelServerInput(state, root), {
    coordRoot: root,
  })!;
  state.registration_id = receipt.registration_id;
  output = [];
  program = new Command();
  registerTunnelCommand(program, {
    text: (value: string) => output.push(value),
    error: (value: { code: string; message: string }) => {
      throw Object.assign(new Error(value.message), { code: value.code });
    },
    config() {},
    data() {},
    rows() {},
    file() {},
    log() {},
    setExitCode() {},
  });
});
afterEach(() => {
  if (priorTunnel === undefined) delete process.env[TUNNEL_DIR_ENV];
  else process.env[TUNNEL_DIR_ENV] = priorTunnel;
  if (priorRoot === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
  else process.env.HARNERY_COORD_ROOT_OVERRIDE = priorRoot;
  rmSync(root, { recursive: true, force: true });
});
const path = () => join(root, ".cache", "tunnel", "state-readiness.json");

describe("tunnel command readiness authority", () => {
  test("incomplete Tailscale route inventory refuses a competing provider effect", () => {
    writeState({
      ...state,
      provider: "tailscale",
      provider_state: "pending",
      cloudflared_pid: undefined,
      cloudflared_start_token: undefined,
      tailscale_path: "/shared",
      tailscale_https_port: 443,
    });
    const before = readFileSync(path(), "utf8");
    let effects = 0;
    expect(() =>
      withTunnelLifecycleCustody("other", { path: "/shared", httpsPort: 443 }, () => {
        effects++;
      }),
    ).toThrow(/custody/);
    expect(effects).toBe(0);
    expect(readFileSync(path(), "utf8")).toBe(before);
  });

  for (const field of ["tailscale_mode", "tailscale_path", "tailscale_https_port"] as const) {
    test(`down retains missing original ${field} before pending route cleanup`, () => {
      const pending: TunnelState = {
        ...state,
        provider: "tailscale",
        provider_state: "pending",
        cloudflared_pid: undefined,
        cloudflared_start_token: undefined,
        tailscale_mode: "serve",
        tailscale_path: "/original",
        tailscale_https_port: 8443,
        [field]: undefined,
      };
      writeState(pending);
      const before = readFileSync(path(), "utf8");
      const signal = spyOn(registry, "signalIfSameGeneration").mockReturnValue({
        sent: false,
        verdict: "unknown",
      });
      try {
        expect(downOne(state.name, new Set())).toBe(0);
        expect(signal).not.toHaveBeenCalled();
        expect(readFileSync(path(), "utf8")).toBe(before);
      } finally {
        signal.mockRestore();
      }
    });
  }

  test("Tailscale ready publication retains its original pending receipt after replacement", async () => {
    registry.unregisterServer(
      registry.readServer(registry.tunnelServerId(state.name), { coordRoot: root })!,
      { coordRoot: root },
    );
    const child = childProcess.spawn(
      process.execPath,
      ["-e", "console.log('ready');process.stdin.resume()"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    const token = registry.processStartToken(child.pid!)!;
    const spawn = spyOn(processLog, "spawnRotatingProcess").mockReturnValue(child);
    const nativeSpawn = childProcess.spawnSync;
    const cli = spyOn(childProcess, "spawnSync").mockImplementation(((
      command: string,
      ...args: unknown[]
    ) =>
      command === "tailscale"
        ? {
            status: 0,
            stdout: JSON.stringify({ Self: { DNSName: "saved.example." } }),
            stderr: "",
            pid: 0,
            signal: null,
            output: [],
          }
        : nativeSpawn(command, ...(args as []))) as typeof childProcess.spawnSync);
    const ports = spyOn(processes, "listeningPorts").mockReturnValue(new Set());
    const bound = spyOn(processes, "portListening").mockResolvedValue(true);
    let effects = 0;
    const provider = spyOn(processLog, "runRotatingProcessSync").mockImplementation(() => {
      effects++;
      return 0;
    });
    const nativeTimer = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 800) {
        queueMicrotask(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return nativeTimer(callback, delay, ...args);
    }) as typeof setTimeout);
    const custody = registry.withServerRegistrationCustody;
    let original: registry.ServerRecord | undefined;
    let winner: registry.ServerRecord | undefined;
    const lease = spyOn(registry, "withServerRegistrationCustody").mockImplementation(((
      receipt: registry.ServerRecord,
      options: registry.ServerOptions,
      effect: () => unknown,
    ) => {
      const result = custody(receipt, options, effect);
      if (effects === 1 && !winner) {
        original = receipt;
        registry.unregisterServer(receipt, options);
        winner = registry.registerServer(
          { ...receipt, registration_id: undefined } as unknown as registry.RegisterServerInput,
          options,
        )!;
      }
      return result;
    }) as typeof registry.withServerRegistrationCustody);
    try {
      const error = await program
        .parseAsync(
          ["tunnel", "up", "--name", state.name, "--provider", "tailscale", "--allow-path", "/"],
          { from: "user" },
        )
        .then(
          () => null,
          (value) => value,
        );
      expect(error).toMatchObject({ code: "tunnel_registration_refused" });
      expect(effects).toBe(1);
      expect(original?.registration_id).not.toBe(winner?.registration_id);
      expect(JSON.parse(readFileSync(path(), "utf8"))).toMatchObject({
        provider_state: "pending",
        registration_id: original!.registration_id,
      });
      expect(
        registry.readServer(registry.tunnelServerId(state.name), { coordRoot: root })
          ?.registration_id,
      ).toBe(winner!.registration_id);
    } finally {
      lease.mockRestore();
      timer.mockRestore();
      provider.mockRestore();
      bound.mockRestore();
      ports.mockRestore();
      cli.mockRestore();
      spawn.mockRestore();
      registry.signalIfSameGeneration(child.pid!, token, "SIGKILL");
      await new Promise<void>((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
      );
    }
  });

  for (const action of ["up", "down", "reload"] as const) {
    test(`${action} refuses a selected filename containing another instance's frame`, async () => {
      writeState(state);
      const selected = join(root, ".cache", "tunnel", "state-selected.json");
      const bytes = JSON.stringify(state);
      writeFileSync(selected, bytes);
      const signal = spyOn(registry, "signalIfSameGeneration").mockReturnValue({
        sent: false,
        verdict: "unknown",
      });
      const exit = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("fixture exit");
      });
      const launch = spyOn(processLog, "spawnRotatingProcess").mockImplementation(() => {
        throw new Error("fixture forbids launch");
      });
      try {
        if (action === "down") downOne("selected", new Set());
        else {
          const error = await program
            .parseAsync(
              [
                "tunnel",
                action,
                "--name",
                "selected",
                ...(action === "up" ? ["--allow-path", "/"] : []),
              ],
              { from: "user" },
            )
            .then(
              () => null,
              (value) => value,
            );
          if (action === "up") expect(error).toMatchObject({ code: "tunnel_custody_unknown" });
        }
        expect(signal).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
        expect(readFileSync(selected, "utf8")).toBe(bytes);
      } finally {
        signal.mockRestore();
        exit.mockRestore();
        launch.mockRestore();
      }
    });
  }

  test("up retains an unreadable existing frame as unknown before launch", async () => {
    writeState(state);
    writeFileSync(path(), "{unfinished");
    const launch = spyOn(processLog, "spawnRotatingProcess").mockImplementation(() => {
      throw new Error("fixture forbids launch");
    });
    try {
      const error = await program
        .parseAsync(["tunnel", "up", "--name", state.name, "--allow-path", "/"], { from: "user" })
        .then(
          () => null,
          (value) => value,
        );
      expect(error).toMatchObject({ code: "tunnel_custody_unknown" });
      expect(launch).not.toHaveBeenCalled();
      expect(readFileSync(path(), "utf8")).toBe("{unfinished");
    } finally {
      launch.mockRestore();
    }
  });

  for (const field of ["url", "port", "host", "kind", "type"] as const) {
    test(`publication refuses changed ${field} before a pending provider effect`, () => {
      const pending: TunnelState = {
        ...state,
        provider: "tailscale",
        provider_state: "pending",
        tailscale_mode: "serve",
        tailscale_path: "/original",
        tailscale_https_port: 8443,
        cloudflared_pid: undefined,
        cloudflared_start_token: undefined,
      };
      writeState(pending);
      const before = readFileSync(path(), "utf8");
      const original = registry.readServer(registry.tunnelServerId(state.name), {
        coordRoot: root,
      })!;
      const receipt = { ...original };
      if (field === "url") pending.url = "https://retargeted.example";
      else if (field === "port") pending.gate_port = 9002;
      else {
        Object.assign(receipt, {
          [field]:
            field === "host" ? "another-host" : field === "kind" ? "session" : "another-service",
        });
        writeFileSync(
          join(registry.serversDir(root), `${receipt.id}.json`),
          JSON.stringify(receipt),
        );
      }
      let effects = 0;
      expect(() =>
        beginTailscaleRoute(pending, receipt, () => {
          effects++;
        }),
      ).toThrow(/custody/);
      expect(effects).toBe(0);
      expect(readFileSync(path(), "utf8")).toBe(before);
    });
  }

  for (const field of ["cloudflared_pid", "cloudflared_start_token"] as const) {
    test(`down retains missing original ${field} before signaling its gate`, async () => {
      const child = Bun.spawn(
        [process.execPath, "-e", "console.log('ready');setInterval(()=>{},100000)"],
        { stdout: "pipe" },
      );
      const reader = child.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      const token = registry.processStartToken(child.pid)!;
      registry.signalIfSameGeneration(child.pid, token, "SIGKILL");
      await child.exited;
      state.cloudflared_pid = child.pid;
      state.cloudflared_start_token = token;
      state = { ...state, [field]: undefined };
      writeState(state);
      const before = readFileSync(path(), "utf8");
      const signal = spyOn(registry, "signalIfSameGeneration").mockReturnValue({
        sent: false,
        verdict: "unknown",
      });
      try {
        expect(downOne(state.name, new Set())).toBe(0);
        expect(signal).not.toHaveBeenCalled();
        expect(readFileSync(path(), "utf8")).toBe(before);
      } finally {
        signal.mockRestore();
        registry.signalIfSameGeneration(child.pid, token, "SIGKILL");
        await child.exited;
      }
    });
  }

  test("reload without its original receipt retains an absent gate before a new launch", async () => {
    const child = Bun.spawn(
      [process.execPath, "-e", "console.log('ready');setInterval(()=>{},100000)"],
      { stdout: "pipe" },
    );
    const reader = child.stdout.getReader();
    await reader.read();
    reader.releaseLock();
    const token = registry.processStartToken(child.pid)!;
    const original = registry.readServer(registry.tunnelServerId(state.name), { coordRoot: root })!;
    registry.unregisterServer(original, { coordRoot: root });
    state.gate_pid = child.pid;
    state.gate_start_token = token;
    registry.signalIfSameGeneration(child.pid, token, "SIGKILL");
    await child.exited;
    writeState(state);
    const before = readFileSync(path(), "utf8");
    const port = spyOn(processes, "portListening").mockResolvedValue(false);
    const launch = spyOn(processLog, "spawnRotatingProcess").mockImplementation(() => {
      throw new Error("fixture forbids a new provider or gate launch");
    });
    try {
      expect(await reloadOne(state)).toMatchObject({ ok: false });
      expect(launch).not.toHaveBeenCalled();
      expect(readFileSync(path(), "utf8")).toBe(before);
    } finally {
      port.mockRestore();
      launch.mockRestore();
      registry.signalIfSameGeneration(child.pid, token, "SIGKILL");
      await child.exited;
    }
  });

  test("up refuses unknown before attempting the cleanup path", async () => {
    state.cloudflared_start_token = "another-generation";
    writeState(state);
    const before = readFileSync(path(), "utf8");
    const verify = registry.verifyProcessGeneration;
    const observed: number[] = [];
    const probe = spyOn(registry, "verifyProcessGeneration").mockImplementation((pid, token) => {
      observed.push(pid);
      return verify(pid, token);
    });
    try {
      const error = await program
        .parseAsync(["tunnel", "up", "--name", state.name, "--allow-path", "/"], { from: "user" })
        .then(
          () => null,
          (value) => value,
        );
      expect(error).toMatchObject({ code: "tunnel_custody_unknown" });
      expect(observed).toHaveLength(2);
      expect(readFileSync(path(), "utf8")).toBe(before);
      expect(output.join("")).not.toContain("Already up");
    } finally {
      probe.mockRestore();
    }
  });

  test("status labels uncertain original generations unknown", async () => {
    state.cloudflared_start_token = "another-generation";
    writeState(state);
    await program.parseAsync(["tunnel", "status", "--name", state.name], { from: "user" });
    expect(output.join("")).toContain("unknown [readiness]");
  });

  for (const field of ["provider_pid", "provider_start_token"] as const) {
    test(`down retains obsolete ${field} before signaling`, () => {
      const obsolete = JSON.parse(
        JSON.stringify({
          ...state,
          [field]: field.endsWith("pid") ? process.pid : state.gate_start_token,
        }),
      ) as TunnelState;
      writeState(obsolete);
      const before = readFileSync(path(), "utf8");
      const signal = spyOn(registry, "signalIfSameGeneration").mockReturnValue({
        sent: false,
        verdict: "unknown",
      });
      try {
        expect(downOne(state.name, new Set())).toBe(0);
        expect(signal).not.toHaveBeenCalled();
        expect(readFileSync(path(), "utf8")).toBe(before);
      } finally {
        signal.mockRestore();
      }
    });

    test(`reload retains obsolete ${field} before provider effects`, async () => {
      const obsolete = JSON.parse(
        JSON.stringify({
          ...state,
          [field]: field.endsWith("pid") ? process.pid : state.gate_start_token,
        }),
      ) as TunnelState;
      writeState(obsolete);
      const before = readFileSync(path(), "utf8");
      const signal = spyOn(registry, "signalIfSameGeneration").mockReturnValue({
        sent: false,
        verdict: "unknown",
      });
      try {
        expect(await reloadOne(obsolete)).toMatchObject({ ok: false });
        expect(signal).not.toHaveBeenCalled();
        expect(readFileSync(path(), "utf8")).toBe(before);
      } finally {
        signal.mockRestore();
      }
    });
  }
});
