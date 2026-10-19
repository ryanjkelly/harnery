import { afterEach, expect, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { processStartToken } from "../core/agents/state/proc-start.ts";
import { readServer, registerServer, unregisterServer } from "../core/servers/index.ts";
import * as processLog from "../core/storage/process-log.ts";
import * as stateModule from "../lib/tunnel/state.ts";
import { readState, TUNNEL_DIR_ENV, writeState } from "../lib/tunnel/state.ts";
import {
  beginTailscaleRoute,
  downOne,
  publishTunnelState,
  recordRefusedTunnelLaunch,
  registerTunnelCommand,
  withTunnelLifecycleCustody,
} from "./tunnel.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const originalTunnelDir = process.env[TUNNEL_DIR_ENV];
const originalCoordRoot = process.env.HARNERY_COORD_ROOT_OVERRIDE;
afterEach(() => {
  if (originalCoordRoot === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
  else process.env.HARNERY_COORD_ROOT_OVERRIDE = originalCoordRoot;
  if (originalTunnelDir === undefined) delete process.env[TUNNEL_DIR_ENV];
  else process.env[TUNNEL_DIR_ENV] = originalTunnelDir;
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function childProcess() {
  const child = spawn(
    process.execPath,
    ["-e", "console.log('ready');process.stdin.on('data',()=>console.log('alive'))"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  children.push(child);
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  return child;
}
test.each([
  undefined,
  "different-generation",
])("cached tunnel PID with token %s cannot authorize termination", async (token) => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-custody-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  const child = await childProcess();
  writeState({
    name: "custody",
    provider: "cloudflare",
    url: "https://example.invalid",
    gate_pid: child.pid!,
    cloudflared_pid: child.pid!,
    gate_start_token: token,
    cloudflared_start_token: token,
    target: "127.0.0.1:1",
    vhost: "localhost",
    gate_port: 49999,
    allow_paths: ["/"],
    started_at: new Date().toISOString(),
  });
  const saved = readFileSync(join(root, "state-custody.json"), "utf8");
  const killed = new Set<number>();
  expect(downOne("custody", killed)).toBe(0);
  expect(killed.size).toBe(0);
  const acknowledgment = new Promise<string>((resolve, reject) => {
    child.stdout!.once("data", (data) => resolve(String(data).trim()));
    child.once("exit", () => reject(new Error("cached PID was terminated")));
  });
  child.stdin!.write("check\n");
  expect(await acknowledgment).toBe("alive");
  expect(readState("custody")).not.toBeNull();
  expect(readFileSync(join(root, "state-custody.json"), "utf8")).toBe(saved);
});

test("the original tunnel receipt stops its owned child and removes state after verified exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-receipt-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  const child = await childProcess();
  const token = processStartToken(child.pid!)!;
  const receipt = registerServer(
    {
      id: "tunnel-custody",
      kind: "service",
      type: "tunnel",
      pid: child.pid!,
      start_token: token,
      owner: null,
    },
    { coordRoot: root },
  )!;
  writeState({
    name: "custody",
    provider: "cloudflare",
    url: "https://example.invalid",
    gate_pid: child.pid!,
    gate_start_token: token,
    cloudflared_pid: child.pid!,
    cloudflared_start_token: token,
    registration_id: receipt.registration_id,
    target: "127.0.0.1:1",
    vhost: "localhost",
    gate_port: 49999,
    allow_paths: ["/"],
    started_at: new Date().toISOString(),
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const killed = new Set<number>();
  expect(downOne("custody", killed)).toBe(1);
  await exited;
  downOne("custody", killed);
  expect(readState("custody")).toBeNull();
  expect(readServer(receipt.id, { coordRoot: root })).toBeNull();
});

test("a stale tunnel registration receipt cannot signal the current process", async () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-old-receipt-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  const child = await childProcess();
  const token = processStartToken(child.pid!)!;
  registerServer(
    {
      id: "tunnel-custody",
      kind: "service",
      type: "tunnel",
      pid: child.pid!,
      start_token: token,
      owner: null,
    },
    { coordRoot: root },
  );
  writeState({
    name: "custody",
    provider: "cloudflare",
    url: "https://example.invalid",
    gate_pid: child.pid!,
    gate_start_token: token,
    registration_id: "stale-receipt",
    target: "127.0.0.1:1",
    vhost: "localhost",
    gate_port: 49999,
    allow_paths: ["/"],
    started_at: new Date().toISOString(),
  });
  expect(downOne("custody", new Set())).toBe(0);
  const acknowledgment = new Promise<string>((resolve) =>
    child.stdout!.once("data", (data) => resolve(String(data).trim())),
  );
  child.stdin!.write("check\n");
  expect(await acknowledgment).toBe("alive");
  expect(readState("custody")?.registration_id).toBe("stale-receipt");
});

test("a refused tunnel launch preserves the winning canonical state", () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-refused-launch-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  const winner = {
    name: "custody",
    provider: "cloudflare" as const,
    url: "https://example.invalid",
    gate_pid: 123,
    gate_start_token: "winning-generation",
    registration_id: "winning-registration",
    target: "127.0.0.1:1",
    vhost: "localhost",
    gate_port: 49999,
    allow_paths: ["/"],
    started_at: new Date().toISOString(),
  };
  writeState(winner);
  const refused = {
    ...winner,
    gate_pid: 456,
    gate_start_token: "refused-generation",
    registration_id: undefined,
  };
  const evidence = recordRefusedTunnelLaunch(refused);
  expect(readState("custody")).toEqual(winner);
  expect(JSON.parse(readFileSync(evidence, "utf8"))).toEqual(JSON.parse(JSON.stringify(refused)));
});

function routeFixture(name: string, path = "/shared") {
  return {
    name,
    provider: "tailscale" as const,
    provider_state: "pending" as const,
    url: "https://example.invalid",
    gate_pid: 2147483000,
    target: "127.0.0.1:1",
    vhost: "localhost",
    gate_port: 49999,
    allow_paths: ["/"],
    started_at: new Date().toISOString(),
    tailscale_mode: "serve" as const,
    tailscale_path: path,
    tailscale_https_port: 443,
  };
}

test("a held lifecycle prevents a competing provider effect for the same instance", async () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-instance-effect-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  let finish!: () => void;
  let effects = 0;
  const first = withTunnelLifecycleCustody(
    "first",
    null,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  expect(() => withTunnelLifecycleCustody("first", null, () => effects++)).toThrow(/lease/);
  expect(effects).toBe(0);
  finish();
  await first;
  expect(withTunnelLifecycleCustody("first", null, () => ++effects)).toBe(1);
});

test("distinct names cannot mutate one held Tailscale route", async () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-route-effect-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  let finish!: () => void;
  let effects = 0;
  const route = { path: "/shared", httpsPort: 443 };
  const first = withTunnelLifecycleCustody(
    "first",
    route,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  expect(() => withTunnelLifecycleCustody("second", route, () => effects++)).toThrow(/lease/);
  expect(effects).toBe(0);
  expect(
    withTunnelLifecycleCustody("third", { path: "/different", httpsPort: 443 }, () => ++effects),
  ).toBe(1);
  finish();
  await first;
});

test("an unresolved provider route intent blocks another named launch", () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-pending-route-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  writeState(routeFixture("first"));
  let effects = 0;
  expect(() =>
    withTunnelLifecycleCustody("second", { path: "/shared", httpsPort: 443 }, () => effects++),
  ).toThrow(/retained by tunnel first/);
  expect(effects).toBe(0);
});

test("malformed state cannot be interpreted as a free provider route", () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-malformed-route-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  writeFileSync(join(root, "state-first.json"), "unreadable");
  let effects = 0;
  expect(() =>
    withTunnelLifecycleCustody("second", { path: "/shared", httpsPort: 443 }, () => effects++),
  ).toThrow(/unreadable.*custody/);
  expect(effects).toBe(0);
});

test("an older registration cannot publish over the current tunnel winner", () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-publish-winner-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  const input = {
    id: "tunnel-review",
    kind: "service" as const,
    type: "tunnel",
    owner: null,
    pid: process.pid,
  };
  const old = registerServer(input, { coordRoot: root })!;
  unregisterServer(old, { coordRoot: root });
  const winner = registerServer(input, { coordRoot: root })!;
  const state = {
    ...routeFixture("review"),
    provider: "cloudflare" as const,
    gate_pid: process.pid,
    gate_start_token: winner.start_token,
    registration_id: winner.registration_id,
  };
  publishTunnelState(state, winner);
  expect(() => publishTunnelState({ ...state, registration_id: old.registration_id }, old)).toThrow(
    /custody changed/,
  );
  expect(readState("review")?.registration_id).toBe(winner.registration_id);
});

test("canonical cleanup holds the original receipt against a replacement registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-clear-winner-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  const child = await childProcess();
  const token = processStartToken(child.pid!)!;
  const receipt = registerServer(
    {
      id: "tunnel-review",
      kind: "service",
      type: "tunnel",
      owner: null,
      pid: child.pid!,
      start_token: token,
    },
    { coordRoot: root },
  )!;
  const state = {
    ...routeFixture("review"),
    provider: "cloudflare" as const,
    gate_pid: child.pid!,
    gate_start_token: token,
    registration_id: receipt.registration_id,
  };
  writeState(state);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  const clear = stateModule.clearState;
  let denied = false;
  const interception = spyOn(stateModule, "clearState").mockImplementation((name, atRoot) => {
    try {
      registerServer(
        { id: receipt.id, kind: "service", type: "tunnel", owner: null, pid: process.pid },
        { coordRoot: root },
      );
    } catch {
      denied = true;
    }
    clear(name, atRoot);
  });
  try {
    downOne("review", new Set());
    expect(denied).toBe(true);
  } finally {
    interception.mockRestore();
  }
});

test("a provider effect cannot precede durable pending route intent", () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-route-intent-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  const receipt = registerServer(
    { id: "tunnel-first", kind: "service", type: "tunnel", owner: null, pid: process.pid },
    { coordRoot: root },
  )!;
  const state = {
    ...routeFixture("first"),
    gate_pid: process.pid,
    gate_start_token: receipt.start_token,
    registration_id: receipt.registration_id,
  };
  let observed: string | undefined;
  expect(() =>
    withTunnelLifecycleCustody("first", { path: "/shared", httpsPort: 443 }, () =>
      beginTailscaleRoute(state, receipt, () => {
        observed = readState("first")?.provider_state;
        throw new Error("provider outcome unknown");
      }),
    ),
  ).toThrow("provider outcome unknown");
  expect(observed).toBe("pending");
  expect(readState("first")?.provider_state).toBe("pending");
  expect(() =>
    withTunnelLifecycleCustody("second", { path: "/shared", httpsPort: 443 }, () => {
      throw new Error("provider must not run");
    }),
  ).toThrow(/retained by tunnel first/);
});

test("a failed provider cleanup retains its original route intent and server receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-provider-cleanup-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  const child = await childProcess();
  const token = processStartToken(child.pid!)!;
  const receipt = registerServer(
    {
      id: "tunnel-first",
      kind: "service",
      type: "tunnel",
      owner: null,
      pid: child.pid!,
      start_token: token,
    },
    { coordRoot: root },
  )!;
  const state = {
    ...routeFixture("first"),
    gate_pid: child.pid!,
    gate_start_token: token,
    registration_id: receipt.registration_id,
  };
  writeState(state);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  const output: string[] = [];
  registerTunnelCommand(new Command(), {
    text: (value: string) => {
      output.push(value);
    },
    config: () => {},
    data: () => {},
    rows: () => {},
    file: () => {},
    error: () => {},
    log: () => {},
    setExitCode: () => {},
  } satisfies EmitContext);
  const provider = spyOn(processLog, "runRotatingProcessSync").mockReturnValue(1);
  try {
    downOne("first", new Set());
    expect(provider).toHaveBeenCalledTimes(1);
    expect(output.join("")).toContain("Failed to remove");
    expect(readState("first")).toEqual(state);
    expect(readServer(receipt.id, { coordRoot: root })).toEqual(receipt);
  } finally {
    provider.mockRestore();
  }
});

test("a second case spelling cannot bypass a retained tunnel instance", () => {
  const root = mkdtempSync(join(tmpdir(), "tunnel-name-custody-"));
  roots.push(root);
  process.env[TUNNEL_DIR_ENV] = root;
  writeState(routeFixture("Original"));
  let effects = 0;
  expect(() =>
    withTunnelLifecycleCustody("original", { path: "/different", httpsPort: 443 }, () => effects++),
  ).toThrow(/aliases retained spelling Original/);
  expect(effects).toBe(0);
});
