import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";

// Inline cachePath; see lib/tunnel/state.ts for rationale.
function cachePath(tool: string, filename: string): string {
  const dir = resolve(process.cwd(), ".cache", tool);
  return resolve(dir, filename);
}

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveBinName } from "../core/config.ts";
import {
  clearState,
  DEFAULT_INSTANCE,
  ensureCloudflared,
  gateLogFile,
  isProcessAlive,
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
 *
 * State + config persisted under `.cache/tunnel/`. cloudflared auto-installs
 * to ~/.local/bin/ on first run (Linux only; macOS users `brew install`);
 * Tailscale requires an installed/authenticated `tailscale` CLI.
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
  cloudflared?: boolean;
  provider?: boolean;
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

function gateScriptPath(): string {
  return resolve(import.meta.dirname, "..", "lib", "tunnel", "gate.ts");
}

/**
 * `harn tunnel` is the one command that hard-requires Bun: the gate worker is a
 * `Bun.serve` process (HTTP + WebSocket reverse proxy), spawned as `bun run
 * gate.ts`. Everything else in harnery runs on Node, but this can't until the
 * gate is ported off `Bun.serve` (node:http + `ws`). Detect Bun up front so the
 * failure is a clear message rather than an opaque ENOENT from the gate spawn.
 */
function bunAvailable(): boolean {
  return spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
}

function tailscaleAvailable(): boolean {
  return spawnSync("tailscale", ["version"], { stdio: "ignore" }).status === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Kill every process whose command line matches `pattern` (via `pgrep -f`),
 * skipping our own PID and any already-killed. Returns the count killed. Used
 * as a fallback so orphaned gate/cloudflared processes get cleaned even when
 * the state file was lost (which otherwise left them squatting on the port).
 */
function killByPattern(pattern: string, alreadyKilled: Set<number>): number {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf-8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return 0;
  let killed = 0;
  for (const line of r.stdout.split("\n")) {
    const pid = Number(line.trim());
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
 * Sweep stray gate + cloudflared processes for ONE instance, identified by its
 * gate port. Both signatures are port-scoped so tearing down one tunnel never
 * touches another:
 *   - gate:        `gate.ts ... --port <port>` (the port is on the gate's argv)
 *   - cloudflared: `--url http://localhost:<port>` (order-independent, so it
 *     matches regardless of the `--protocol http2` flag we also pass).
 * Port boundary is guarded with `( |$)` so port 9001 doesn't match 90011.
 */
function sweepStrays(gatePort: number, alreadyKilled: Set<number>): number {
  return (
    killByPattern(`gate\\.ts.*--port ${gatePort}( |$)`, alreadyKilled) +
    killByPattern(`--url http://localhost:${gatePort}( |$)`, alreadyKilled)
  );
}

/**
 * Ports currently bound by a LISTEN socket (best-effort, platform-dependent).
 *
 * `ss` (iproute2) is Linux-only. Without the lsof fallback this returns an empty
 * set on macOS/BSD. That does not fail loudly. It reports every port as free, so
 * `allocateGatePort` can hand out an occupied port and the reload port-release
 * check becomes inert.
 */
function listeningPorts(): Set<number> {
  const ports = new Set<number>();
  const ss = spawnSync("ss", ["-tlnH"], { encoding: "utf-8" });
  if (ss.status === 0 && typeof ss.stdout === "string") {
    for (const m of ss.stdout.matchAll(/:(\d+)\s/g)) ports.add(Number(m[1]));
    return ports;
  }
  // Rows look like: `bun 123 user 4u IPv4 0x… 0t0 TCP 127.0.0.1:58055 (LISTEN)`.
  // Status can be nonzero while stdout still holds usable rows (lsof reports a
  // failure when any single process is unreadable), so judge it on the output.
  const lsof = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf-8" });
  if (typeof lsof.stdout === "string") {
    for (const m of lsof.stdout.matchAll(/:(\d+) \(LISTEN\)$/gm)) ports.add(Number(m[1]));
  }
  return ports;
}

/**
 * Pick a gate port for a new instance. An explicit `--gate-port` is honored
 * (and rejected if it's already taken); otherwise scan upward from 9001 for the
 * first port that's neither held by a live instance nor currently listening.
 */
function allocateGatePort(preferred: number | undefined): number {
  const used = new Set<number>(
    listStates()
      .filter((s) => isProcessAlive(s.gate_pid))
      .map((s) => s.gate_port),
  );
  const listening = listeningPorts();
  const taken = (p: number) => used.has(p) || listening.has(p);

  if (preferred !== undefined) {
    if (taken(preferred)) {
      emit.error({
        code: "tunnel_port_taken",
        message: `Gate port ${preferred} is already in use. Omit --gate-port to auto-allocate, or pick a free one.`,
      });
      process.exit(1);
    }
    return preferred;
  }
  for (let p = DEFAULT_GATE_PORT; p <= MAX_GATE_PORT; p++) {
    if (!taken(p)) return p;
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
  const fd = openSync(logPath, "a");
  const args = [
    tailscaleCommand(mode),
    "--bg",
    "--yes",
    `--https=${httpsPort}`,
    `--set-path=${path}`,
    targetUrl,
  ];
  const r = spawnSync("tailscale", args, {
    stdio: ["ignore", fd, fd],
  });
  if (r.status !== 0) {
    emit.error({
      code: "tunnel_tailscale_failed",
      message: `tailscale ${tailscaleCommand(mode)} failed. Check log: ${logPath}`,
    });
    process.exit(r.status ?? 1);
  }
}

function stopTailscaleShare(state: TunnelState): boolean {
  if (state.provider !== "tailscale" || !state.tailscale_mode) return true;
  const cmd = tailscaleCommand(state.tailscale_mode);
  const logPath = cachePath("tunnel", providerLogFile(state.name, "tailscale"));
  const fd = openSync(logPath, "a");
  const args = [
    cmd,
    `--https=${state.tailscale_https_port ?? 443}`,
    `--set-path=${state.tailscale_path ?? "/"}`,
    "off",
  ];
  const r = spawnSync("tailscale", args, { stdio: ["ignore", fd, fd] });
  if (r.status !== 0) {
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
  return isProcessAlive(state.gate_pid) && providerIsAlive(state);
}

interface GateSpawnOpts {
  name: string;
  gatePort: number;
  target: string;
  vhost: string;
  provider: TunnelProvider;
  allowedIps: string[];
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
function spawnGate(o: GateSpawnOpts): ChildProcess {
  const gateFd = openSync(o.gateLogPath, "a");
  // `--name`/`--port` on argv mirror the env vars; they're what makes the gate
  // process distinguishable per-instance in `pgrep -f` (see sweepStrays).
  const gateProc = spawn(
    "bun",
    ["run", gateScriptPath(), "--name", o.name, "--port", String(o.gatePort)],
    {
      detached: true,
      stdio: ["ignore", gateFd, gateFd],
      env: {
        ...process.env,
        HARNERY_TUNNEL_ALLOW: o.allowedIps.join(","),
        HARNERY_TUNNEL_ACCESS:
          o.provider === "cloudflare" ? "cloudflare-allowlist" : "trusted-local-proxy",
        HARNERY_TUNNEL_TARGET: o.target,
        HARNERY_TUNNEL_VHOST: o.vhost,
        HARNERY_TUNNEL_PORT: String(o.gatePort),
      },
    },
  );
  gateProc.unref();
  return gateProc;
}

async function up(opts: UpOpts): Promise<void> {
  if (!bunAvailable()) {
    emit.error({
      code: "tunnel_requires_bun",
      message:
        "harn tunnel requires Bun: the gate worker is a Bun.serve process. " +
        "Install Bun (https://bun.sh) and re-run. (Every other harn command runs on Node.)",
    });
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

  const existing = readState(name);
  if (existing && tunnelIsAlive(existing)) {
    if (existing.provider !== provider) {
      emit.error({
        code: "tunnel_instance_in_use",
        message: `Tunnel [${name}] is already up with provider ${existing.provider}. Stop it before starting ${provider}.`,
      });
      process.exit(1);
    }
    emit.text(`Already up [${name}]: ${existing.url}\n`);
    emit.text(`  Provider:   ${existing.provider}\n`);
    emit.text(`  Forwarding: ${existing.target} (Host: ${existing.vhost})\n`);
    return;
  }
  if (existing) downOne(name, new Set());

  // Allocate the gate port (after clearing dead state so its old port frees up
  // for reuse). Explicit --gate-port is validated; otherwise auto-scan.
  const gatePort = allocateGatePort(opts.gatePort ? Number(opts.gatePort) : undefined);

  // Self-heal: clear any orphaned gate/cloudflared on THIS instance's port from
  // a prior crashed or state-cleared run so the gate port is free before we bind.
  if (sweepStrays(gatePort, new Set())) await sleep(500);

  const cfg = readConfig();
  if (provider === "cloudflare" && cfg.allowed_ips.length === 0) {
    emit.error({
      code: "tunnel_allowlist_empty",
      message: "Allowlist is empty; refusing to start. Add an IP first: harn tunnel allow add <ip>",
    });
    process.exit(1);
  }

  const cloudflaredBin = provider === "cloudflare" ? ensureCloudflared() : null;
  if (provider === "tailscale" && !tailscaleAvailable()) {
    emit.error({
      code: "tunnel_tailscale_missing",
      message: "tailscale CLI not found or unavailable. Install Tailscale and sign in, then retry.",
    });
    process.exit(1);
  }

  const gateLogPath = cachePath("tunnel", gateLogFile(name));
  const providerLogPath = cachePath("tunnel", providerLogFile(name, provider));
  writeFileSync(gateLogPath, "");
  writeFileSync(providerLogPath, "");

  const gateProc = spawnGate({
    name,
    gatePort,
    target,
    vhost,
    provider,
    allowedIps: cfg.allowed_ips,
    gateLogPath,
  });

  await sleep(800);

  if (!isProcessAlive(gateProc.pid!)) {
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
    const cfdFd = openSync(providerLogPath, "a");
    // Force HTTP/2 transport. The default QUIC transport wedges at precheck on
    // constrained hosts (e.g. WSL, where UDP receive buffers can't grow and ICMP
    // is restricted): the URL prints but the edge never registers. HTTP/2 is
    // marginally higher-latency but registers reliably, which is what a dev
    // tunnel needs.
    const cfdProc = spawn(
      cloudflaredBin!,
      ["tunnel", "--protocol", "http2", "--url", `http://localhost:${gatePort}`],
      {
        detached: true,
        stdio: ["ignore", cfdFd, cfdFd],
      },
    );
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
    tailscale_mode: tailscaleMode,
    tailscale_path: tailscalePath,
    tailscale_https_port: tailscaleHttpsPort,
  };
  writeState(state);

  const stopHint =
    name === DEFAULT_INSTANCE ? "harn tunnel down" : `harn tunnel down --name ${name}`;
  emit.text(`\n  Instance: ${name}\n`);
  emit.text(`  Provider: ${provider}${tailscaleMode ? ` (${tailscaleMode})` : ""}\n`);
  emit.text(`  URL: ${url}\n\n`);
  emit.text(`  Forwarding: ${target} (Host: ${vhost})\n`);
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
      `  ⚠ Edge connection didn't register within 30s (QUIC can wedge on a cold\n    start). If the URL 404s or times out, bounce it: ${stopHint} && harn tunnel up\n\n`,
    );
  }
  emit.text(`  Stop:   ${stopHint}\n`);
  emit.text("  Status: harn tunnel status\n");
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
        `No default tunnel running. Other tunnels up: ${others.map((s) => s.name).join(", ")}.\nUse \`harn tunnel down --name <name>\` or \`harn tunnel down --all\`.\n`,
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
    if (!listeningPorts().has(port)) return true;
    await sleep(100);
  }
  return !listeningPorts().has(port);
}

/** Poll until `port` has a LISTEN socket (or the deadline passes). */
async function waitForPortBound(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listeningPorts().has(port)) return true;
    await sleep(100);
  }
  return listeningPorts().has(port);
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
  if (!bunAvailable()) {
    return { ok: false, message: `[${name}] bun is not on PATH, so the gate can't be respawned.` };
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
  killByPattern(`gate\\.ts.*--port ${gatePort}( |$)`, killed);

  if (!(await waitForPortFree(gatePort, 5_000))) {
    return {
      ok: false,
      message:
        `[${name}] port ${gatePort} never released, so the old gate looks wedged. ` +
        `Tunnel is down; check \`${bin} tunnel status\`.`,
    };
  }

  const cfg = readConfig();
  const gateProc = spawnGate({
    name,
    gatePort,
    target: state.target,
    vhost: state.vhost,
    provider: state.provider,
    allowedIps: cfg.allowed_ips,
    gateLogPath: cachePath("tunnel", gateLogFile(name)),
  });

  await sleep(800);
  const pid = gateProc.pid;
  if (
    typeof pid !== "number" ||
    !isProcessAlive(pid) ||
    !(await waitForPortBound(gatePort, 5_000))
  ) {
    return {
      ok: false,
      message:
        `[${name}] the gate did not come back on port ${gatePort}. ` +
        `Tunnel is down; check \`${bin} tunnel logs --name ${name}\`.`,
    };
  }

  writeState({ ...state, gate_pid: pid });
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
    // Single tunnel: show the full detail block (backward-compatible).
    statusDetail(states[0]);
    return;
  }

  const rows = states.map((s) => ({
    name: s.name,
    provider: s.provider,
    state: instanceState(s),
    url: s.url,
    fwd: `${s.target} (${s.vhost})`,
    port: String(s.gate_port),
    up: fmtUptime(s.started_at),
  }));
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    provider: Math.max(8, ...rows.map((r) => r.provider.length)),
    state: 5,
    url: Math.max(3, ...rows.map((r) => r.url.length)),
    fwd: Math.max(10, ...rows.map((r) => r.fwd.length)),
    port: 4,
  };
  const pad = (s: string, n: number) => s.padEnd(n);
  emit.text(
    `${pad("NAME", w.name)}  ${pad("PROVIDER", w.provider)}  ${pad("STATE", w.state)}  ${pad("URL", w.url)}  ${pad("FORWARDING", w.fwd)}  ${pad("PORT", w.port)}  UPTIME\n`,
  );
  for (const r of rows) {
    emit.text(
      `${pad(r.name, w.name)}  ${pad(r.provider, w.provider)}  ${pad(r.state, w.state)}  ${pad(r.url, w.url)}  ${pad(r.fwd, w.fwd)}  ${pad(r.port, w.port)}  ${r.up}\n`,
    );
  }
}

function logs(opts: LogsOpts): void {
  const name = resolveName(opts.name);
  const state = readState(name);
  const provider = state?.provider ?? "cloudflare";
  const which =
    opts.cloudflared || opts.provider ? providerLogFile(name, provider) : gateLogFile(name);
  const path = cachePath("tunnel", which);
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
  for (const ip of cfg.allowed_ips) emit.text(`${ip}\n`);
}

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

function allowAdd(ip: string): void {
  const cfg = readConfig();
  if (cfg.allowed_ips.includes(ip)) {
    emit.text(`${ip} already in allowlist.\n`);
    return;
  }
  cfg.allowed_ips.push(ip);
  writeConfig(cfg);
  emit.text(`Added ${ip}.\n`);
  allowChangedHint();
}

function allowRm(ip: string): void {
  const cfg = readConfig();
  const idx = cfg.allowed_ips.indexOf(ip);
  if (idx === -1) {
    emit.text(`${ip} not in allowlist.\n`);
    return;
  }
  cfg.allowed_ips.splice(idx, 1);
  writeConfig(cfg);
  emit.text(`Removed ${ip}.\n`);
  allowChangedHint();
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
    .option("--cloudflared", "tail the Cloudflare provider log instead (legacy alias)")
    .action(logs);

  const allow = cmd
    .command("allow")
    .description("Manage the Cloudflare CF-Connecting-IP allowlist")
    .action(allowList);
  allow.command("add <ip>").description("Add an IP to the allowlist").action(allowAdd);
  allow.command("rm <ip>").description("Remove an IP from the allowlist").action(allowRm);
  allow.command("list").description("List allowed IPs (default action)").action(allowList);
}
