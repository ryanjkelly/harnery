import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";

import { resolveCoordRoot } from "../core/agents/coord-client.ts";
import { resolveBinName } from "../core/config.ts";
import {
  tryRegisterServer,
  tunnelServerId,
  tunnelServerInput,
  unregisterServer,
} from "../core/servers/index.ts";
import {
  processLogDestination,
  runProcessLogWorker,
  runRotatingProcessSync,
  spawnRotatingProcess,
} from "../core/storage/process-log.ts";
import { normalizeAllowEntry } from "../lib/tunnel/allowlist.ts";
import {
  type DetectOptions,
  detectPublicAddresses,
  planCurrentAddresses,
} from "../lib/tunnel/current-address.ts";
import { ALLOW_PATHS_ENV, normalizeAllowPaths } from "../lib/tunnel/path-scope.ts";
import {
  connectProbe,
  findPidsByCommandLine,
  listeningPorts,
  portListening,
} from "../lib/tunnel/processes.ts";
import {
  clearState,
  DEFAULT_INSTANCE,
  ensureCloudflared,
  gateLogFile,
  isProcessAlive,
  isTunnelStateLive,
  listStates,
  providerLogFile,
  readConfig,
  readState,
  type TailscaleMode,
  type TunnelProvider,
  type TunnelState,
  writeConfig,
  writeState,
} from "../lib/tunnel/state.ts";

/**
 * `tunnel`: provider-backed tunnel in front of a local upstream.
 *
 * A Bun reverse-proxy worker (lib/tunnel/gate.ts) rewrites Host for the
 * upstream. Cloudflare quick tunnels add an IP allowlist at the gate via the
 * Cloudflare-set `CF-Connecting-IP` header; Tailscale Serve/Funnel exposes the
 * same gate through tailscaled, with Tailscale owning the access boundary.
 * Every provider also passes through a path scope: `up` requires at least one
 * `--allow-path <prefix>`, and the gate refuses any request outside it.
 *
 * State + config persisted under `.cache/tunnel/` (or `$HARNERY_TUNNEL_DIR`).
 * cloudflared comes from `$HARNERY_CLOUDFLARED` / the config's `cloudflared_path`
 * when set, else PATH, else auto-installs to ~/.local/bin/ on Linux (macOS and
 * Windows hosts install it themselves); Tailscale requires an installed and
 * authenticated `tailscale` CLI.
 */

const DEFAULT_TARGET = "127.0.0.1:8001";
const DEFAULT_VHOST = "localhost";
const DEFAULT_GATE_PORT = 9001;
const MAX_GATE_PORT = DEFAULT_GATE_PORT + 99; // auto-allocation scan ceiling

interface UpOpts {
  name?: string;
  provider?: string;
  target?: string;
  vhost?: string;
  gatePort?: string;
  visibility?: string;
  path?: string;
  httpsPort?: string;
  allowPath?: string[];
}

interface DownOpts {
  name?: string;
  all?: boolean;
}

interface ReloadOpts {
  name?: string;
  all?: boolean;
}

interface StatusOpts {
  name?: string;
}

interface LogsOpts {
  name?: string;
  follow?: boolean;
  gate?: boolean;
  provider?: boolean;
}

export function tunnelLogDestinations(
  name: string,
  provider: TunnelProvider,
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
): { gate: string; provider: string } {
  const destination = (filename: string) =>
    processLogDestination({
      coord_root: root,
      project_root: root,
      family_id: "tunnel-process-log",
      filename,
      legacy_path: resolve(root, ".cache", "tunnel", filename),
      env,
    });
  return {
    gate: destination(gateLogFile(name)),
    provider: destination(providerLogFile(name, provider)),
  };
}

/**
 * Validate + normalize an instance name. Names become filename fragments
 * (state-<name>.json) and pgrep patterns, so they're restricted to a safe
 * charset. Throws a friendly emit.error + exits on a bad name.
 */
function resolveName(raw: string | undefined): string {
  const name = (raw ?? DEFAULT_INSTANCE).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    emit.error({
      code: "tunnel_bad_name",
      message: `Invalid instance name "${name}". Use letters, digits, and dashes (must start alphanumeric).`,
    });
    process.exit(1);
  }
  return name;
}

function resolveProvider(raw: string | undefined): TunnelProvider {
  const provider = (raw ?? "cloudflare").trim().toLowerCase();
  if (provider === "cloudflare" || provider === "cf") return "cloudflare";
  if (provider === "tailscale" || provider === "ts") return "tailscale";
  emit.error({
    code: "tunnel_bad_provider",
    message: `Invalid provider "${raw}". Use cloudflare or tailscale.`,
  });
  process.exit(1);
}

function resolveTailscaleMode(raw: string | undefined): TailscaleMode {
  const visibility = (raw ?? "tailnet").trim().toLowerCase();
  if (visibility === "tailnet" || visibility === "serve") return "serve";
  if (visibility === "public" || visibility === "internet" || visibility === "funnel") {
    return "funnel";
  }
  emit.error({
    code: "tunnel_bad_visibility",
    message: `Invalid Tailscale visibility "${raw}". Use tailnet or public.`,
  });
  process.exit(1);
}

function resolveTailscalePath(raw: string | undefined, name: string): string {
  const fallback = name === DEFAULT_INSTANCE ? "/" : `/${name}`;
  const path = (raw ?? fallback).trim();
  if (!path.startsWith("/")) {
    emit.error({
      code: "tunnel_bad_path",
      message: `Tailscale path "${path}" must start with /.`,
    });
    process.exit(1);
  }
  return path === "" ? "/" : path;
}

function resolveHttpsPort(raw: string | undefined): number {
  const port = raw === undefined ? 443 : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    emit.error({
      code: "tunnel_bad_https_port",
      message: `Invalid HTTPS port "${raw}". Use a number from 1 to 65535.`,
    });
    process.exit(1);
  }
  return port;
}

/**
 * The path scope for `up`. At least one prefix is required: a tunnel forwards
 * to a whole local app, and publishing all of it has to be a stated choice
 * (`--allow-path /`), never the result of leaving a flag off.
 */
function resolveAllowPaths(raw: string[] | undefined): string[] {
  let paths: string[];
  try {
    paths = normalizeAllowPaths(raw ?? []);
  } catch (error) {
    emit.error({
      code: "tunnel_path_scope_invalid",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
  if (paths.length === 0) {
    emit.error({
      code: "tunnel_path_scope_empty",
      message:
        "No path scope; refusing to start. Name what the tunnel shares with --allow-path <prefix> " +
        "(repeatable), or pass --allow-path / to publish the whole upstream.",
    });
    process.exit(1);
  }
  return paths;
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

function formatPaths(paths: readonly string[]): string {
  return paths.length === 0 ? "(none: every path refused)" : paths.join(", ");
}

function collectPath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function gateScriptPath(): string {
  return resolve(import.meta.dirname, "..", "lib", "tunnel", "gate.ts");
}

/** The gate worker's `--name`/`--port` marker, also what the stray sweep matches. */
const GATE_SUBCOMMAND = ["tunnel", "gate"] as const;

export interface GateLaunch {
  command: string;
  /** Arguments before the gate's own `--name` and `--port`. */
  arguments: string[];
}

export interface GateLaunchInputs {
  /** Absolute path of `lib/tunnel/gate.ts` beside this file, whether or not it exists. */
  gateScript: string;
  gateScriptExists: boolean;
  /** True when this process runs on Bun (so `execPath` is a Bun binary). */
  underBun: boolean;
  execPath: string;
  /** The script this process was started with (`argv[1]`): the host CLI's entry or bundle. */
  entryScript: string | undefined;
  entryScriptExists: boolean;
  bunOnPath: boolean;
}

/**
 * How to start the gate worker, which is a `Bun.serve` process (HTTP and
 * WebSocket reverse proxy):
 *   1. From a source or package checkout, `gate.ts` sits beside this module and
 *      runs directly.
 *   2. Inside a single-file bundle there is no such file. The CLI then
 *      re-executes itself with the hidden `tunnel gate` task, which loads the
 *      gate in-process. This uses the running Bun binary, so Bun need not be
 *      on PATH.
 * Null means neither works (a Node host with no Bun, or an unknown entry).
 */
export function resolveGateLaunch(i: GateLaunchInputs): GateLaunch | null {
  if (i.gateScriptExists && (i.underBun || i.bunOnPath)) {
    return {
      command: i.underBun ? i.execPath : "bun",
      arguments: ["run", i.gateScript],
    };
  }
  if (i.underBun && i.entryScript && i.entryScriptExists) {
    return { command: i.execPath, arguments: [i.entryScript, ...GATE_SUBCOMMAND] };
  }
  return null;
}

/**
 * How to start the log wrapper that rotates each process's output. Beside a
 * source or package checkout the default (this package's own wrapper file)
 * works; inside a single-file bundle the CLI re-executes itself with the hidden
 * `tunnel log-worker` task instead.
 */
export function resolveWorkerLaunch(i: GateLaunchInputs): GateLaunch | undefined {
  if (i.gateScriptExists) return undefined;
  if (i.underBun && i.entryScript && i.entryScriptExists) {
    return { command: i.execPath, arguments: [i.entryScript, "tunnel", "log-worker"] };
  }
  return undefined;
}

function currentLaunchInputs(): GateLaunchInputs {
  const gateScript = gateScriptPath();
  const entryScript = process.argv[1] ? resolve(process.argv[1]) : undefined;
  const underBun = typeof process.versions.bun === "string";
  const gateScriptExists = existsSync(gateScript);
  return {
    gateScript,
    gateScriptExists,
    underBun,
    execPath: process.execPath,
    entryScript,
    entryScriptExists: entryScript ? existsSync(entryScript) : false,
    bunOnPath: !underBun && gateScriptExists && bunOnPath(),
  };
}

function currentGateLaunch(): GateLaunch | null {
  return resolveGateLaunch(currentLaunchInputs());
}

function currentWorkerLaunch(): GateLaunch | undefined {
  return resolveWorkerLaunch(currentLaunchInputs());
}

function bunOnPath(): boolean {
  return spawnSync("bun", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
}

const requiresBunMessage = () =>
  `${resolveBinName()} tunnel requires Bun: the gate worker is a Bun.serve process. ` +
  "Install Bun (https://bun.sh) and re-run. (Every other command runs on Node.)";

function tailscaleAvailable(): boolean {
  return spawnSync("tailscale", ["version"], { stdio: "ignore", windowsHide: true }).status === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Kill every process whose command line matches `pattern` (an extended regular
 * expression), skipping our own PID and any already-killed. Returns the count
 * killed. Used as a fallback so orphaned gate/cloudflared processes get cleaned
 * even when the state file was lost (which otherwise left them squatting on the
 * port).
 */
function killByPattern(pattern: string, alreadyKilled: Set<number>): number {
  let killed = 0;
  for (const pid of findPidsByCommandLine(pattern)) {
    if (!pid || pid === process.pid || alreadyKilled.has(pid)) continue;
    try {
      process.kill(pid);
      alreadyKilled.add(pid);
      killed++;
    } catch {
      /* race: already gone */
    }
  }
  return killed;
}

/**
 * Command-line pattern for ONE instance's gate, identified by its port. Matches
 * both launch forms: `bun run .../gate.ts --name N --port P` and a host CLI
 * re-executing itself as `<cli> tunnel gate --name N --port P`. Port boundary is
 * guarded with `( |$)` so port 9001 doesn't match 90011.
 */
function gatePattern(gatePort: number): string {
  return `(gate\\.ts|tunnel gate) .*--port ${gatePort}( |$)`;
}

/**
 * Sweep stray gate + cloudflared processes for ONE instance, identified by its
 * gate port. Both signatures are port-scoped so tearing down one tunnel never
 * touches another:
 *   - gate:        see gatePattern (the port is on the gate's argv)
 *   - cloudflared: `--url http://localhost:<port>` (order-independent, so it
 *     matches regardless of the `--protocol http2` flag we also pass).
 */
function sweepStrays(gatePort: number, alreadyKilled: Set<number>): number {
  return (
    killByPattern(gatePattern(gatePort), alreadyKilled) +
    killByPattern(`--url http://localhost:${gatePort}( |$)`, alreadyKilled)
  );
}

/**
 * Pick a gate port for a new instance. An explicit `--gate-port` is honored
 * (and rejected if it's already taken); otherwise scan upward from 9001 for the
 * first port that's neither held by a live instance nor currently listening.
 */
async function allocateGatePort(preferred: number | undefined): Promise<number> {
  const used = new Set<number>(
    listStates()
      .filter((s) => isProcessAlive(s.gate_pid))
      .map((s) => s.gate_port),
  );
  // No discovery tool (null) is not "every port free": probe candidates by connecting.
  const listening = listeningPorts();
  const taken = async (p: number) =>
    used.has(p) || (listening ? listening.has(p) : await connectProbe(p));

  if (preferred !== undefined) {
    if (await taken(preferred)) {
      emit.error({
        code: "tunnel_port_taken",
        message: `Gate port ${preferred} is already in use. Omit --gate-port to auto-allocate, or pick a free one.`,
      });
      process.exit(1);
    }
    return preferred;
  }
  for (let p = DEFAULT_GATE_PORT; p <= MAX_GATE_PORT; p++) {
    if (!(await taken(p))) return p;
  }
  emit.error({
    code: "tunnel_no_free_port",
    message: `No free gate port in ${DEFAULT_GATE_PORT}-${MAX_GATE_PORT}. Tear down some tunnels first.`,
  });
  process.exit(1);
}

function extractUrl(log: string): string | null {
  const m = log.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : null;
}

/**
 * cloudflared logs "Registered tunnel connection" once the edge is live and
 * routable. Match that exact line only, because earlier lines carry `connIndex=`
 * too (e.g. "Tunnel connection curve preferences … connIndex=0"), which would
 * false-positive readiness before the connection actually registers.
 */
function isRegistered(log: string): boolean {
  return /Registered tunnel connection/.test(log);
}

/**
 * Wait for the tunnel to be genuinely usable. cloudflared prints the
 * `*.trycloudflare.com` URL early (at precheck) but the hostname doesn't route
 * until the edge connection is *registered*, a few seconds later, and
 * occasionally never on a wedged QUIC start. We gate readiness on the
 * registration line, not just the URL, so `up` doesn't hand back a URL that
 * 404s/times out. Returns the URL (if seen at all) plus whether it registered.
 */
async function waitForReady(
  logPath: string,
  timeoutMs: number,
): Promise<{ url: string | null; registered: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let url: string | null = null;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, "utf-8");
      url = url ?? extractUrl(log);
      if (url && isRegistered(log)) return { url, registered: true };
    }
    await sleep(500);
  }
  return { url, registered: false };
}

function tailscaleDnsName(): string {
  const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf-8" });
  if (r.status !== 0) {
    emit.error({
      code: "tunnel_tailscale_status_failed",
      message:
        "Failed to read `tailscale status --json`. Install Tailscale and connect this machine to a tailnet first.",
    });
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(r.stdout) as { Self?: { DNSName?: string } };
    const dns = parsed.Self?.DNSName?.replace(/\.$/, "");
    if (dns) return dns;
  } catch {
    /* handled below */
  }
  emit.error({
    code: "tunnel_tailscale_no_dns",
    message:
      "Tailscale status did not report a MagicDNS name. Enable MagicDNS for the tailnet, then retry.",
  });
  process.exit(1);
}

function tailscaleUrl(path: string, httpsPort: number): string {
  const base = `https://${tailscaleDnsName()}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
  return path === "/" ? `${base}/` : `${base}${path}`;
}

function tailscaleCommand(mode: TailscaleMode): "serve" | "funnel" {
  return mode === "funnel" ? "funnel" : "serve";
}

function runTailscaleShare(
  mode: TailscaleMode,
  targetUrl: string,
  path: string,
  httpsPort: number,
  logPath: string,
): void {
  const args = [
    tailscaleCommand(mode),
    "--bg",
    "--yes",
    `--https=${httpsPort}`,
    `--set-path=${path}`,
    targetUrl,
  ];
  const status = runRotatingProcessSync({
    path: logPath,
    command: "tailscale",
    arguments: args,
  });
  if (status !== 0) {
    emit.error({
      code: "tunnel_tailscale_failed",
      message: `tailscale ${tailscaleCommand(mode)} failed. Check log: ${logPath}`,
    });
    process.exit(status ?? 1);
  }
}

function stopTailscaleShare(state: TunnelState): boolean {
  if (state.provider !== "tailscale" || !state.tailscale_mode) return true;
  const cmd = tailscaleCommand(state.tailscale_mode);
  const logPath = tunnelLogDestinations(state.name, "tailscale").provider;
  const args = [
    cmd,
    `--https=${state.tailscale_https_port ?? 443}`,
    `--set-path=${state.tailscale_path ?? "/"}`,
    "off",
  ];
  const status = runRotatingProcessSync({
    path: logPath,
    command: "tailscale",
    arguments: args,
  });
  if (status !== 0) {
    // The gate is torn down and its port is freed for reuse regardless, so a
    // surviving serve/funnel mapping could later re-expose whatever next binds
    // that port. Surface it loudly so the operator can clear it by hand.
    emit.text(
      `\n  ⚠ Failed to remove the Tailscale ${cmd} mapping (path ${state.tailscale_path ?? "/"}).\n` +
        `    It may still be exposing this machine. Clear it with:\n` +
        `      tailscale ${cmd} --https=${state.tailscale_https_port ?? 443} --set-path=${state.tailscale_path ?? "/"} off\n` +
        `    Log: ${logPath}\n\n`,
    );
    return false;
  }
  return true;
}

/** Resolve the context-supplied default vhost (literal or lazy resolver). */
function contextVhost(): string | null {
  const v = context?.tunnelDefaultVhost;
  const resolved = typeof v === "function" ? v() : v;
  return resolved ?? null;
}

function providerIsAlive(state: TunnelState): boolean {
  if (state.provider === "tailscale") return true;
  const pid = state.cloudflared_pid ?? state.provider_pid;
  return typeof pid === "number" && isProcessAlive(pid);
}

function tunnelIsAlive(state: TunnelState): boolean {
  return isTunnelStateLive(state);
}

interface GateSpawnOpts {
  name: string;
  gatePort: number;
  target: string;
  vhost: string;
  provider: TunnelProvider;
  allowedIps: string[];
  allowPaths: string[];
  gateLogPath: string;
}

/**
 * Spawn the detached gate worker.
 *
 * Shared by `up` (fresh start) and `reload` (in-place restart) so both hand the
 * gate an identical environment and record the same kind of PID. The allowlist
 * is passed as an env var, which the gate snapshots at module load and never
 * re-reads — that snapshot is precisely why `reload` has to exist.
 */
function spawnGate(o: GateSpawnOpts, launch: GateLaunch): ChildProcess {
  // `--name`/`--port` on argv mirror the env vars; they're what makes the gate
  // process distinguishable per-instance in a command-line search (see sweepStrays).
  const gateProc = spawnRotatingProcess({
    path: o.gateLogPath,
    command: launch.command,
    arguments: [...launch.arguments, "--name", o.name, "--port", String(o.gatePort)],
    worker: currentWorkerLaunch(),
    env: {
      ...process.env,
      HARNERY_TUNNEL_ALLOW: o.allowedIps.join(","),
      HARNERY_TUNNEL_ACCESS:
        o.provider === "cloudflare" ? "cloudflare-allowlist" : "trusted-local-proxy",
      HARNERY_TUNNEL_TARGET: o.target,
      HARNERY_TUNNEL_VHOST: o.vhost,
      HARNERY_TUNNEL_PORT: String(o.gatePort),
      [ALLOW_PATHS_ENV]: o.allowPaths.join(","),
    },
  });
  gateProc.unref();
  return gateProc;
}

async function up(opts: UpOpts): Promise<void> {
  const launch = currentGateLaunch();
  if (!launch) {
    emit.error({ code: "tunnel_requires_bun", message: requiresBunMessage() });
    process.exit(1);
  }
  const name = resolveName(opts.name);
  const provider = resolveProvider(opts.provider);
  const target = opts.target ?? DEFAULT_TARGET;
  // Precedence: explicit --vhost > the consumer's configured default (via
  // context.tunnelDefaultVhost) > "localhost".
  const vhost = opts.vhost ?? contextVhost() ?? DEFAULT_VHOST;
  const tailscaleMode =
    provider === "tailscale" ? resolveTailscaleMode(opts.visibility) : undefined;
  const tailscalePath =
    provider === "tailscale" ? resolveTailscalePath(opts.path, name) : undefined;
  const tailscaleHttpsPort =
    provider === "tailscale" ? resolveHttpsPort(opts.httpsPort) : undefined;
  const allowPaths = resolveAllowPaths(opts.allowPath);

  const existing = readState(name);
  if (existing && tunnelIsAlive(existing)) {
    if (existing.provider !== provider) {
      emit.error({
        code: "tunnel_instance_in_use",
        message: `Tunnel [${name}] is already up with provider ${existing.provider}. Stop it before starting ${provider}.`,
      });
      process.exit(1);
    }
    if (!samePaths(existing.allow_paths, allowPaths)) {
      emit.error({
        code: "tunnel_instance_in_use",
        message:
          `Tunnel [${name}] is already up sharing ${formatPaths(existing.allow_paths)}. ` +
          `Stop it before starting it with ${formatPaths(allowPaths)}.`,
      });
      process.exit(1);
    }
    emit.text(`Already up [${name}]: ${existing.url}\n`);
    emit.text(`  Provider:   ${existing.provider}\n`);
    emit.text(`  Forwarding: ${existing.target} (Host: ${existing.vhost})\n`);
    emit.text(`  Paths:      ${formatPaths(existing.allow_paths)}\n`);
    return;
  }
  if (existing) downOne(name, new Set());

  // Allocate the gate port (after clearing dead state so its old port frees up
  // for reuse). Explicit --gate-port is validated; otherwise auto-scan.
  const gatePort = await allocateGatePort(opts.gatePort ? Number(opts.gatePort) : undefined);

  // Self-heal: clear any orphaned gate/cloudflared on THIS instance's port from
  // a prior crashed or state-cleared run so the gate port is free before we bind.
  if (sweepStrays(gatePort, new Set())) await sleep(500);

  const cfg = readConfig();
  if (provider === "cloudflare" && cfg.allowed_ips.length === 0) {
    emit.error({
      code: "tunnel_allowlist_empty",
      message: `Allowlist is empty; refusing to start. Add an IP first: ${resolveBinName()} tunnel allow add <ip> (or --current)`,
    });
    process.exit(1);
  }

  let cloudflaredBin: string | null = null;
  if (provider === "cloudflare") {
    try {
      cloudflaredBin = ensureCloudflared();
    } catch (error) {
      emit.error({
        code: "tunnel_cloudflared_missing",
        message: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  }
  if (provider === "tailscale" && !tailscaleAvailable()) {
    emit.error({
      code: "tunnel_tailscale_missing",
      message: "tailscale CLI not found or unavailable. Install Tailscale and sign in, then retry.",
    });
    process.exit(1);
  }

  const logPaths = tunnelLogDestinations(name, provider);
  const gateLogPath = logPaths.gate;
  const providerLogPath = logPaths.provider;

  const gateProc = spawnGate(
    {
      name,
      gatePort,
      target,
      vhost,
      provider,
      allowedIps: cfg.allowed_ips,
      allowPaths,
      gateLogPath,
    },
    launch,
  );

  await sleep(800);

  // A host CLI that re-executes itself takes longer to load than a bare script,
  // so wait for the gate to actually listen before the provider forwards to it.
  if (!isProcessAlive(gateProc.pid!) || !(await waitForPortBound(gatePort, 15_000))) {
    try {
      process.kill(gateProc.pid!);
    } catch {
      /* already dead */
    }
    sweepStrays(gatePort, new Set());
    emit.error({
      code: "tunnel_gate_failed",
      message: `Gate failed to start. Check log: ${gateLogPath}`,
    });
    process.exit(1);
  }

  let url: string;
  let registered = true;
  let cloudflaredPid: number | undefined;

  if (provider === "cloudflare") {
    // Force HTTP/2 transport. The default QUIC transport wedges at precheck on
    // constrained hosts (e.g. WSL, where UDP receive buffers can't grow and ICMP
    // is restricted): the URL prints but the edge never registers. HTTP/2 is
    // marginally higher-latency but registers reliably, which is what a dev
    // tunnel needs.
    const cfdProc = spawnRotatingProcess({
      path: providerLogPath,
      command: cloudflaredBin!,
      arguments: ["tunnel", "--protocol", "http2", "--url", `http://localhost:${gatePort}`],
      worker: currentWorkerLaunch(),
    });
    cfdProc.unref();
    cloudflaredPid = cfdProc.pid!;

    const ready = await waitForReady(providerLogPath, 30_000);
    registered = ready.registered;
    if (!ready.url) {
      try {
        process.kill(gateProc.pid!);
      } catch {
        /* already dead */
      }
      try {
        process.kill(cloudflaredPid);
      } catch {
        /* already dead */
      }
      emit.error({
        code: "tunnel_url_timeout",
        message: `Failed to obtain tunnel URL within 30s. Check log: ${providerLogPath}`,
      });
      process.exit(1);
    }
    url = ready.url;
  } else {
    // Resolve the public URL (MagicDNS name) BEFORE starting the share.
    // tailscaleUrl -> tailscaleDnsName() hard-exits when MagicDNS is
    // unavailable; doing it first means we fail cleanly rather than leaving a
    // live serve/funnel exposure with no state file — which `down`/`status`/
    // `heal` would then be unable to see or clean up.
    url = tailscaleUrl(tailscalePath!, tailscaleHttpsPort!);
    const gateTarget = `http://127.0.0.1:${gatePort}`;
    runTailscaleShare(
      tailscaleMode!,
      gateTarget,
      tailscalePath!,
      tailscaleHttpsPort!,
      providerLogPath,
    );
  }

  const state: TunnelState = {
    name,
    provider,
    url,
    gate_pid: gateProc.pid!,
    cloudflared_pid: cloudflaredPid,
    started_at: new Date().toISOString(),
    target,
    vhost,
    gate_port: gatePort,
    allow_paths: allowPaths,
    tailscale_mode: tailscaleMode,
    tailscale_path: tailscalePath,
    tailscale_https_port: tailscaleHttpsPort,
  };
  writeState(state);
  recordTunnelServer(state);

  const bin = resolveBinName();
  const stopHint =
    name === DEFAULT_INSTANCE ? `${bin} tunnel down` : `${bin} tunnel down --name ${name}`;
  emit.text(`\n  Instance: ${name}\n`);
  emit.text(`  Provider: ${provider}${tailscaleMode ? ` (${tailscaleMode})` : ""}\n`);
  emit.text(`  URL: ${url}\n\n`);
  emit.text(`  Forwarding: ${target} (Host: ${vhost})\n`);
  emit.text(`  Paths: ${formatPaths(allowPaths)}\n`);
  emit.text(`  Gate port: ${gatePort}\n`);
  if (provider === "cloudflare") {
    emit.text(`  Allowed IPs: ${cfg.allowed_ips.join(", ")}\n\n`);
  } else {
    emit.text(`  Tailscale path: ${tailscalePath}\n`);
    emit.text(
      tailscaleMode === "funnel"
        ? "  Visibility: public internet via Tailscale Funnel\n\n"
        : "  Visibility: tailnet only via Tailscale Serve\n\n",
    );
  }
  if (!registered) {
    emit.text(
      `  ⚠ Edge connection didn't register within 30s (QUIC can wedge on a cold\n    start). If the URL 404s or times out, bounce it: ${stopHint} && ${bin} tunnel up\n\n`,
    );
  }
  emit.text(`  Stop:   ${stopHint}\n`);
  emit.text(`  Status: ${bin} tunnel status\n`);
}

/** The server registry lists tunnels beside every other local server. */
function registryRoot(): string {
  return resolveCoordRoot() ?? process.cwd();
}

function recordTunnelServer(state: TunnelState): void {
  const coordRoot = registryRoot();
  tryRegisterServer(tunnelServerInput(state, coordRoot), { coordRoot });
}

/** Tear down a single instance by name. Returns the number of processes killed. */
function downOne(name: string, killed: Set<number>): number {
  const before = killed.size;
  const state = readState(name);
  if (state) {
    if (state.provider === "tailscale") stopTailscaleShare(state);
    for (const pid of [state.gate_pid, state.cloudflared_pid, state.provider_pid]) {
      if (typeof pid !== "number") continue;
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid);
          killed.add(pid);
        } catch {
          /* race: already gone */
        }
      }
    }
  }
  // Fallback: sweep orphans on this instance's gate port, even when state was
  // lost; they'd otherwise squat on the port and break the next `up`.
  sweepStrays(state?.gate_port ?? DEFAULT_GATE_PORT, killed);
  clearState(name);
  unregisterServer(tunnelServerId(name), { coordRoot: registryRoot() });
  return killed.size - before;
}

function down(opts: DownOpts): void {
  const killed = new Set<number>();

  if (opts.all) {
    const states = listStates();
    if (states.length === 0) {
      emit.text("No tunnels up. Nothing to stop.\n");
      return;
    }
    for (const s of states) downOne(s.name, killed);
    emit.text(
      `Stopped ${states.length} tunnel(s) [${states.map((s) => s.name).join(", ")}], ${killed.size} process(es).\n`,
    );
    return;
  }

  const name = resolveName(opts.name);
  // Bare `down` targets the default instance. If it's not up but named ones
  // are, don't silently no-op; point the operator at them.
  if (name === DEFAULT_INSTANCE && !readState(DEFAULT_INSTANCE)) {
    const others = listStates();
    if (others.length > 0) {
      emit.text(
        `No default tunnel running. Other tunnels up: ${others.map((s) => s.name).join(", ")}.\nUse \`${resolveBinName()} tunnel down --name <name>\` or \`${resolveBinName()} tunnel down --all\`.\n`,
      );
      return;
    }
  }

  downOne(name, killed);
  emit.text(
    killed.size === 0
      ? `No tunnel processes found for [${name}]. Nothing to stop.\n`
      : `Stopped ${killed.size} process(es). Tunnel [${name}] down.\n`,
  );
}

/** Poll until `port` has no LISTEN socket (or the deadline passes). */
async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portListening(port))) return true;
    await sleep(100);
  }
  return !(await portListening(port));
}

/** Poll until `port` has a LISTEN socket (or the deadline passes). */
async function waitForPortBound(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portListening(port)) return true;
    await sleep(100);
  }
  return portListening(port);
}

/**
 * Restart ONE instance's gate in place, deliberately leaving the provider
 * process running.
 *
 * That asymmetry is the whole point. A Cloudflare quick tunnel's hostname is
 * minted by cloudflared at startup, so a full `down`/`up` hands back a NEW
 * random *.trycloudflare.com URL and breaks every link already shared — a
 * miserable trade for adding one IP. cloudflared only ever forwards to
 * `localhost:<gate_port>`, so the gate beneath it can be swapped out and the
 * edge reconnects without noticing.
 */
export async function reloadOne(state: TunnelState): Promise<{ ok: boolean; message: string }> {
  const bin = resolveBinName();
  const name = state.name;
  const gatePort = state.gate_port;

  if (!providerIsAlive(state)) {
    return {
      ok: false,
      message:
        `[${name}] the provider process is gone, so the public URL is already dead. ` +
        `Reloading the gate can't bring it back — run \`${bin} tunnel up --name ${name}\`.`,
    };
  }
  const launch = currentGateLaunch();
  if (!launch) {
    return {
      ok: false,
      message: `[${name}] Bun is not available, so the gate can't be respawned.`,
    };
  }
  if (state.allow_paths.length === 0) {
    return {
      ok: false,
      message:
        `[${name}] has no recorded path scope, so a reloaded gate would refuse every request. ` +
        `Restart it with \`${bin} tunnel down --name ${name}\` and ` +
        `\`${bin} tunnel up --name ${name} --allow-path <prefix>\`.`,
    };
  }

  // Kill ONLY the gate. sweepStrays() is deliberately avoided here: it also
  // matches `--url http://localhost:<port>`, which is the provider process we
  // are going out of our way to keep alive.
  const killed = new Set<number>();
  if (isProcessAlive(state.gate_pid)) {
    try {
      process.kill(state.gate_pid);
      killed.add(state.gate_pid);
    } catch {
      /* race: already gone */
    }
  }
  killByPattern(gatePattern(gatePort), killed);

  if (!(await waitForPortFree(gatePort, 5_000))) {
    return {
      ok: false,
      message:
        `[${name}] port ${gatePort} never released, so the old gate looks wedged. ` +
        `Tunnel is down; check \`${bin} tunnel status\`.`,
    };
  }

  const cfg = readConfig();
  const gateProc = spawnGate(
    {
      name,
      gatePort,
      target: state.target,
      vhost: state.vhost,
      provider: state.provider,
      allowedIps: cfg.allowed_ips,
      allowPaths: state.allow_paths,
      gateLogPath: tunnelLogDestinations(name, state.provider).gate,
    },
    launch,
  );

  await sleep(800);
  const pid = gateProc.pid;
  if (
    typeof pid !== "number" ||
    !isProcessAlive(pid) ||
    !(await waitForPortBound(gatePort, 15_000))
  ) {
    return {
      ok: false,
      message:
        `[${name}] the gate did not come back on port ${gatePort}. ` +
        `Tunnel is down; check \`${bin} tunnel logs --name ${name}\`.`,
    };
  }

  writeState({ ...state, gate_pid: pid });
  recordTunnelServer({ ...state, gate_pid: pid });
  const allowNote =
    state.provider === "cloudflare" ? ` Allowlist: ${cfg.allowed_ips.length} IP(s).` : "";
  return { ok: true, message: `[${name}] gate reloaded, URL unchanged: ${state.url}.${allowNote}` };
}

async function reload(opts: ReloadOpts): Promise<void> {
  const bin = resolveBinName();

  if (opts.all) {
    const all = listStates();
    // Only live tunnels are reloadable, and a box commonly accumulates stale
    // state files from long-dead runs. Reporting those as failures would make
    // the common post-`allow add` path exit non-zero for no real reason.
    const live = all.filter((s) => providerIsAlive(s));
    const stale = all.length - live.length;
    if (live.length === 0) {
      emit.text(
        all.length === 0
          ? "No tunnels up. Nothing to reload.\n"
          : `No live tunnels to reload (${all.length} stale). Start one with \`${bin} tunnel up\`.\n`,
      );
      return;
    }
    let failed = 0;
    for (const s of live) {
      const r = await reloadOne(s);
      emit.text(`${r.ok ? "ok  " : "FAIL"} ${r.message}\n`);
      if (!r.ok) failed++;
    }
    emit.text(
      `Reloaded ${live.length - failed} of ${live.length} live tunnel(s)` +
        (stale > 0 ? `; skipped ${stale} stale.\n` : ".\n"),
    );
    if (failed > 0) process.exitCode = 1;
    return;
  }

  const name = resolveName(opts.name);
  const state = readState(name);
  if (!state) {
    emit.error({
      code: "tunnel_not_found",
      message: `No tunnel state for [${name}]. Start it with \`${bin} tunnel up --name ${name}\`.`,
    });
    process.exit(1);
    return;
  }
  const r = await reloadOne(state);
  emit.text(`${r.message}\n`);
  if (!r.ok) process.exit(1);
}

function instanceState(state: TunnelState): "up" | "stale" {
  return tunnelIsAlive(state) ? "up" : "stale";
}

function fmtUptime(startedAt: string): string {
  const secs = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (!Number.isFinite(secs) || secs < 0) return "?";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}

/** Detailed single-instance block (the pre-multi-instance format). */
function statusDetail(state: TunnelState): void {
  const gateAlive = isProcessAlive(state.gate_pid);
  const providerAlive = providerIsAlive(state);
  const providerPid = state.cloudflared_pid ?? state.provider_pid;
  const cfg = readConfig();
  emit.text(`${gateAlive && providerAlive ? "up" : "stale"} [${state.name}]\n`);
  emit.text(
    `  Provider:    ${state.provider}${state.tailscale_mode ? ` (${state.tailscale_mode})` : ""}\n`,
  );
  emit.text(`  URL:         ${state.url}\n`);
  emit.text(`  Forwarding:  ${state.target} (Host: ${state.vhost})\n`);
  emit.text(`  Paths:       ${formatPaths(state.allow_paths)}\n`);
  emit.text(`  Gate port:   ${state.gate_port}\n`);
  if (state.provider === "cloudflare") {
    emit.text(`  Allowed IPs: ${cfg.allowed_ips.join(", ")}\n`);
  } else {
    emit.text(`  TS path:     ${state.tailscale_path ?? "/"}\n`);
  }
  emit.text(`  Gate PID:    ${state.gate_pid}${gateAlive ? "" : " (DEAD)"}\n`);
  if (state.provider === "cloudflare") {
    emit.text(`  CFD PID:     ${providerPid ?? "?"}${providerAlive ? "" : " (DEAD)"}\n`);
  }
  emit.text(`  Uptime:      ${fmtUptime(state.started_at)}\n`);
}

function status(opts: StatusOpts): void {
  // Named → detailed single block.
  if (opts.name) {
    const state = readState(resolveName(opts.name));
    if (!state) {
      emit.text(`down [${resolveName(opts.name)}]\n`);
      return;
    }
    statusDetail(state);
    return;
  }

  // No name → table of every instance.
  const states = listStates();
  if (states.length === 0) {
    emit.text("down\n");
    return;
  }
  if (states.length === 1) {
    // A single tunnel is clearer as a detail block than as a one-row table.
    statusDetail(states[0]);
    return;
  }

  const rows = states.map((s) => ({
    name: s.name,
    provider: s.provider,
    state: instanceState(s),
    url: s.url,
    fwd: `${s.target} (${s.vhost})`,
    paths: formatPaths(s.allow_paths),
    port: String(s.gate_port),
    up: fmtUptime(s.started_at),
  }));
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    provider: Math.max(8, ...rows.map((r) => r.provider.length)),
    state: 5,
    url: Math.max(3, ...rows.map((r) => r.url.length)),
    fwd: Math.max(10, ...rows.map((r) => r.fwd.length)),
    paths: Math.max(5, ...rows.map((r) => r.paths.length)),
    port: 4,
  };
  const pad = (s: string, n: number) => s.padEnd(n);
  emit.text(
    `${pad("NAME", w.name)}  ${pad("PROVIDER", w.provider)}  ${pad("STATE", w.state)}  ${pad("URL", w.url)}  ${pad("FORWARDING", w.fwd)}  ${pad("PATHS", w.paths)}  ${pad("PORT", w.port)}  UPTIME\n`,
  );
  for (const r of rows) {
    emit.text(
      `${pad(r.name, w.name)}  ${pad(r.provider, w.provider)}  ${pad(r.state, w.state)}  ${pad(r.url, w.url)}  ${pad(r.fwd, w.fwd)}  ${pad(r.paths, w.paths)}  ${pad(r.port, w.port)}  ${r.up}\n`,
    );
  }
}

function logs(opts: LogsOpts): void {
  const name = resolveName(opts.name);
  const state = readState(name);
  const provider = state?.provider ?? "cloudflare";
  const destinations = tunnelLogDestinations(name, provider);
  const path = opts.provider ? destinations.provider : destinations.gate;
  if (!existsSync(path)) {
    emit.error({ code: "tunnel_no_log", message: `No log file at ${path}` });
    process.exit(1);
  }
  const args = opts.follow ? ["-f", path] : [path];
  const r = spawnSync("tail", args, { stdio: "inherit" });
  if (r.status !== null && r.status !== 0) process.exit(r.status);
}

function allowList(): void {
  const cfg = readConfig();
  if (cfg.allowed_ips.length === 0) {
    emit.text("(empty)\n");
    return;
  }
  const automatic = cfg.auto_allowed ?? [];
  for (const ip of cfg.allowed_ips) {
    emit.text(`${ip}${sameEntryIn(automatic, ip) ? "  (automatic)" : ""}\n`);
  }
}

const canonicalEntry = (entry: string) => normalizeAllowEntry(entry) ?? entry;
const sameEntryIn = (list: readonly string[], entry: string) =>
  list.some((e) => canonicalEntry(e) === canonicalEntry(entry));

/**
 * Trailer for `allow add`/`allow rm`. Each gate snapshots the allowlist at
 * spawn, so a config edit alone changes nothing until the gates restart.
 * Only LIVE tunnels are listed — stale state files pile up on a long-running
 * box, and naming nine dead instances made the old hint read like nine
 * restarts were owed.
 */
function allowChangedHint(): void {
  const live = listStates().filter((s) => s.provider === "cloudflare" && providerIsAlive(s));
  if (live.length === 0) return;
  emit.text(
    `Each gate reads the allowlist once at start, so this applies on reload ` +
      `(${live.map((s) => s.name).join(", ")}):\n` +
      `  ${resolveBinName()} tunnel reload --all\n`,
  );
}

interface AllowAddOpts {
  current?: boolean;
}

async function allowAdd(entry: string | undefined, opts: AllowAddOpts = {}): Promise<void> {
  if (opts.current) {
    if (entry) {
      emit.error({
        code: "tunnel_allow_current_with_entry",
        message: "Pass either an address or --current, not both.",
      });
      process.exit(1);
    }
    const result = await refreshCurrentAddress({ emit, reload: true });
    if (!result.ok) process.exit(1);
    return;
  }
  if (!entry) {
    emit.error({
      code: "tunnel_allow_entry_missing",
      message: `Name an address or range to allow, or use --current: ${resolveBinName()} tunnel allow add <ip|cidr>`,
    });
    process.exit(1);
  }
  const canonical = normalizeAllowEntry(entry);
  if (!canonical) {
    emit.error({
      code: "tunnel_allow_entry_invalid",
      message:
        `"${entry}" is not an IP address or CIDR range. ` +
        "Examples: 203.0.113.8, 203.0.113.0/24, 2601:db8:1:2::/64.",
    });
    process.exit(1);
  }
  const cfg = readConfig();
  if (sameEntryIn(cfg.allowed_ips, canonical)) {
    // Adding by hand an entry the refresh owns adopts it: later refreshes keep it.
    if (cfg.auto_allowed && sameEntryIn(cfg.auto_allowed, canonical)) {
      cfg.auto_allowed = cfg.auto_allowed.filter((e) => canonicalEntry(e) !== canonical);
      writeConfig(cfg);
      emit.text(`${canonical} is now a manual entry; automatic refreshes will keep it.\n`);
      return;
    }
    emit.text(`${canonical} already in allowlist.\n`);
    return;
  }
  cfg.allowed_ips.push(canonical);
  writeConfig(cfg);
  emit.text(`Added ${canonical}.\n`);
  allowChangedHint();
}

function allowRm(entry: string): void {
  const cfg = readConfig();
  const wanted = canonicalEntry(entry);
  const idx = cfg.allowed_ips.findIndex((e) => e === entry || canonicalEntry(e) === wanted);
  if (idx === -1) {
    emit.text(`${entry} not in allowlist.\n`);
    return;
  }
  const [removed] = cfg.allowed_ips.splice(idx, 1);
  if (cfg.auto_allowed) {
    cfg.auto_allowed = cfg.auto_allowed.filter(
      (e) => canonicalEntry(e) !== canonicalEntry(removed as string),
    );
  }
  writeConfig(cfg);
  emit.text(`Removed ${removed}.\n`);
  allowChangedHint();
}

export interface RefreshCurrentOptions {
  emit?: EmitContext;
  /** Reload running Cloudflare gates after an allowlist change, keeping their URLs. */
  reload: boolean;
  /** Speak only when the allowlist changed or no address could be detected. */
  quiet?: boolean;
  /** Lookup timeout and retries; a sync that must not stall offline passes small ones. */
  detectOptions?: DetectOptions;
  /** Replaces the lookup (tests). */
  detect?: typeof detectPublicAddresses;
}

export interface RefreshCurrentResult {
  /** False only when a requested reload of a live gate failed. A failed lookup is a warning, not a failure. */
  ok: boolean;
  /** The allowlist gained or lost an entry. */
  changed: boolean;
  /** Entries newly allowed. */
  added: string[];
  removed: string[];
  warnings: string[];
}

/**
 * `tunnel allow add --current`: allow this machine's own public addresses, as
 * Cloudflare sees them, and drop the ones allowed by the previous refresh.
 * Exported so a host CLI can run it before `tunnel up` and from its own sync.
 */
export async function refreshCurrentAddress(
  options: RefreshCurrentOptions,
): Promise<RefreshCurrentResult> {
  if (options.emit) emit = options.emit;
  const detected = await (options.detect ?? detectPublicAddresses)(options.detectOptions);
  const cfg = readConfig();
  const plan = planCurrentAddresses(cfg, detected);
  const noAddress = !detected.v4 && !detected.v6;
  // Quiet runs (a host's sync) speak only when something changed or nothing
  // could be detected; "no IPv6 on this network" is not news every time.
  if (!options.quiet || noAddress || plan.changed) {
    for (const warning of plan.warnings) emit.text(`  ⚠ ${warning}\n`);
  }
  const result: RefreshCurrentResult = {
    ok: true,
    changed: plan.changed,
    added: plan.added,
    removed: plan.removed,
    warnings: plan.warnings,
  };
  if (noAddress) return result;

  writeConfig(plan.config);
  if (!options.quiet || plan.changed) {
    const found = [detected.v4, detected.v6].filter(Boolean).join(", ");
    emit.text(`This machine reaches Cloudflare as ${found}.\n`);
    emit.text(
      plan.changed
        ? `Allowlist updated${plan.added.length ? `: added ${plan.added.join(", ")}` : ""}${plan.removed.length ? `; removed ${plan.removed.join(", ")}` : ""}.\n`
        : "Allowlist already covers this machine.\n",
    );
  }
  if (!plan.changed || !options.reload) return result;

  const live = listStates().filter((s) => s.provider === "cloudflare" && providerIsAlive(s));
  for (const s of live) {
    const r = await reloadOne(s);
    emit.text(`${r.ok ? "ok  " : "FAIL"} ${r.message}\n`);
    if (!r.ok) result.ok = false;
  }
  return result;
}

/** Hidden task: run the gate worker in this process (the self-launch form of the gate). */
async function runGateInProcess(): Promise<void> {
  await import("../lib/tunnel/gate.ts");
  // The gate's server keeps the process alive. Never resolve, so a host's
  // post-command exit or output finalization cannot end the worker.
  await new Promise<never>(() => {});
}

let emit: EmitContext;
let context: HarneryProgramContext | undefined;

export function registerTunnelCommand(
  program: Command,
  emitParam: EmitContext,
  contextParam?: HarneryProgramContext,
): void {
  emit = emitParam;
  context = contextParam;
  const cmd = program
    .command("tunnel")
    .description(
      "Provider-backed tunnel(s) in front of a local upstream (default upstream: 127.0.0.1:8001). " +
        "Run several at once with --name <instance>.",
    );

  cmd
    .command("up")
    .description("Start a gate + provider tunnel (one per --name instance)")
    .option("--name <name>", "instance name; run multiple tunnels side by side", DEFAULT_INSTANCE)
    .option("--provider <provider>", "provider: cloudflare (default) or tailscale", "cloudflare")
    .option("--target <addr>", "upstream to forward to", DEFAULT_TARGET)
    .option(
      "--vhost <host>",
      "Host header sent to the upstream (default: the consumer's configured " +
        "default, else localhost).",
    )
    .option(
      "--gate-port <port>",
      "local port the gate binds to (default: auto-allocate the first free port from 9001)",
    )
    .option(
      "--visibility <visibility>",
      "Tailscale only: tailnet (Serve, default) or public (Funnel)",
      "tailnet",
    )
    .option(
      "--path <path>",
      "Tailscale only: URL path mount (default: / for default, /<name> for named instances)",
    )
    .option("--https-port <port>", "Tailscale only: HTTPS listen port (default: 443)", "443")
    .option(
      "--allow-path <prefix>",
      "URL path prefix the tunnel shares (repeatable, required). Every other path is refused; " +
        "pass / to publish the whole upstream.",
      collectPath,
      [],
    )
    .action(up);

  cmd
    .command("down")
    .description("Stop a tunnel (default instance, --name <instance>, or --all)")
    .option("--name <name>", "instance to stop", DEFAULT_INSTANCE)
    .option("--all", "stop every running tunnel")
    .action(down);

  cmd
    .command("reload")
    .description(
      "Restart an instance's gate in place to pick up allowlist changes, keeping the public URL",
    )
    .option("--name <name>", "instance to reload", DEFAULT_INSTANCE)
    .option("--all", "reload every live tunnel")
    .action(reload);

  cmd
    .command("status")
    .description("Show tunnel state: a table of all instances, or detail for one via --name")
    .option("--name <name>", "show detail for a single instance")
    .action(status);

  cmd
    .command("logs")
    .description("Tail the gate log (default) or provider log for an instance")
    .option("--name <name>", "instance whose log to tail", DEFAULT_INSTANCE)
    .option("-f, --follow", "follow the log")
    .option("--gate", "tail the gate log (default)")
    .option("--provider", "tail the provider log instead")
    .action(logs);

  const allow = cmd
    .command("allow")
    .description(
      "Manage the Cloudflare CF-Connecting-IP allowlist (addresses and CIDR ranges, IPv4 and IPv6)",
    )
    .action(allowList);
  allow
    .command("add [entry]")
    .description(
      "Add an IP address or CIDR range (203.0.113.0/24, 2601:db8:1:2::/64), or --current for this machine",
    )
    .option(
      "--current",
      "allow this machine's public addresses as Cloudflare sees them (IPv4 /32 and IPv6 /64), " +
        "replace the ones the previous --current added, and reload running gates",
    )
    .action(allowAdd);
  allow
    .command("rm <entry>")
    .description("Remove an address or range from the allowlist")
    .action(allowRm);
  allow.command("list").description("List allowed entries (default action)").action(allowList);

  cmd
    .command("log-worker <specification>", { hidden: true })
    .description("Internal: run the output-rotating wrapper for one tunnel process")
    .action(async (specification: string) => {
      await runProcessLogWorker(specification);
    });

  cmd
    .command("gate", { hidden: true })
    .description("Internal: run the gate worker in this process")
    .option("--name <name>", "instance name")
    .option("--port <port>", "port to listen on")
    .action(runGateInProcess);
}
