// Tunnel config + state persistence + provider helpers. Commands default to
// <cwd>/.cache/tunnel/; gitignored, so the allowlist is per-machine.

import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isPathAllowed } from "./path-scope.ts";

/** Overrides the directory that holds tunnel state and config (a host keeps it out of `.cache/`). */
export const TUNNEL_DIR_ENV = "HARNERY_TUNNEL_DIR";
/** Explicit cloudflared binary, for a host that ships a managed copy. */
export const CLOUDFLARED_ENV = "HARNERY_CLOUDFLARED";

/**
 * Where tunnel state lives: `$HARNERY_TUNNEL_DIR` when set, else
 * `<root>/.cache/tunnel/`. Root defaults to cwd for the command surface and can
 * be supplied by callers that already resolved a repo.
 */
export function tunnelDir(
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[TUNNEL_DIR_ENV]?.trim();
  return override ? resolve(override) : resolve(root, ".cache", "tunnel");
}

function cachePath(filename: string, root: string = process.cwd()): string {
  const dir = tunnelDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, filename);
}

const CONFIG_FILE = "config.json";

/** The default instance name when `--name` is omitted. */
export const DEFAULT_INSTANCE = "default";

// Per-instance file naming. The default instance keeps the original
// unsuffixed filenames (`state.json`, `gate.log`, `cloudflared.log`) so a
// pre-multi-instance tunnel keeps working untouched across the upgrade; named
// instances get a `-<name>` suffix. Names are validated upstream (tunnel.ts)
// to `[a-z0-9][a-z0-9-]*`, so they're always safe as filename fragments.
function stateFile(name: string): string {
  return name === DEFAULT_INSTANCE ? "state.json" : `state-${name}.json`;
}

export function gateLogFile(name: string): string {
  return name === DEFAULT_INSTANCE ? "gate.log" : `gate-${name}.log`;
}

export function cfdLogFile(name: string): string {
  return name === DEFAULT_INSTANCE ? "cloudflared.log" : `cloudflared-${name}.log`;
}

export function providerLogFile(name: string, provider: TunnelProvider): string {
  if (provider === "cloudflare") return cfdLogFile(name);
  return name === DEFAULT_INSTANCE ? "tailscale.log" : `tailscale-${name}.log`;
}

/** Map a state filename back to its instance name (inverse of stateFile). */
function nameFromStateFile(file: string): string | null {
  if (file === "state.json") return DEFAULT_INSTANCE;
  const m = file.match(/^state-(.+)\.json$/);
  return m ? m[1] : null;
}

// Empty by default; `tunnel up` refuses to start until the operator adds
// their own IP (`tunnel allow add <ip>`). No address is baked in, so the
// public package ships nobody's IP.
const DEFAULT_CONFIG: TunnelConfig = {
  allowed_ips: [],
};

export interface TunnelConfig {
  /** Exact addresses and CIDR ranges the gate admits (Cloudflare provider). */
  allowed_ips: string[];
  /**
   * Entries `allow add --current` added for this machine's own public
   * addresses. They are a subset of `allowed_ips`; the next refresh replaces
   * exactly these and never touches an entry added by hand.
   */
  auto_allowed?: string[];
  /** Explicit cloudflared binary; `$HARNERY_CLOUDFLARED` wins over this. */
  cloudflared_path?: string;
}

export type TunnelProvider = "cloudflare" | "tailscale";
export type TailscaleMode = "serve" | "funnel";

export interface TunnelState {
  name: string;
  provider: TunnelProvider;
  url: string;
  gate_pid: number;
  /** Present for Cloudflare quick tunnels; absent for Tailscale Serve/Funnel. */
  cloudflared_pid?: number;
  /** Optional provider-side process when a provider owns one. */
  provider_pid?: number;
  started_at: string;
  target: string;
  vhost: string;
  gate_port: number;
  /** URL path prefixes the gate forwards; every other path is refused. */
  allow_paths: string[];
  tailscale_mode?: TailscaleMode;
  tailscale_path?: string;
  tailscale_https_port?: number;
}

/**
 * Normalize a parsed state blob; supply `name` for pre-multi-instance files.
 * A state written before path scopes existed reads as an empty scope, which
 * the gate treats as "refuse every path".
 */
function normalizeState(raw: TunnelState, fallbackName: string): TunnelState {
  return {
    ...raw,
    name: raw.name ?? fallbackName,
    provider: raw.provider ?? "cloudflare",
    allow_paths: Array.isArray(raw.allow_paths) ? raw.allow_paths : [],
  };
}

export function readConfig(): TunnelConfig {
  const p = cachePath(CONFIG_FILE);
  if (!existsSync(p)) {
    writeConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG, allowed_ips: [...DEFAULT_CONFIG.allowed_ips] };
  }
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<TunnelConfig>;
    return {
      ...parsed,
      allowed_ips: Array.isArray(parsed.allowed_ips) ? parsed.allowed_ips : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG, allowed_ips: [...DEFAULT_CONFIG.allowed_ips] };
  }
}

export function writeConfig(cfg: TunnelConfig): void {
  writeFileSync(cachePath(CONFIG_FILE), JSON.stringify(cfg, null, 2));
}

export function readState(
  name: string = DEFAULT_INSTANCE,
  root: string = process.cwd(),
): TunnelState | null {
  const p = cachePath(stateFile(name), root);
  if (!existsSync(p)) return null;
  try {
    return normalizeState(JSON.parse(readFileSync(p, "utf-8")) as TunnelState, name);
  } catch {
    return null;
  }
}

export function writeState(state: TunnelState, root: string = process.cwd()): void {
  writeFileSync(cachePath(stateFile(state.name), root), JSON.stringify(state, null, 2));
}

export function clearState(name: string = DEFAULT_INSTANCE, root: string = process.cwd()): void {
  const p = cachePath(stateFile(name), root);
  if (existsSync(p)) unlinkSync(p);
}

/**
 * Every persisted tunnel instance, newest-started first. Reads every
 * `state*.json` under `.cache/tunnel/`; tolerates missing/corrupt files.
 */
export function listStates(root: string = process.cwd()): TunnelState[] {
  const dir = tunnelDir(root);
  if (!existsSync(dir)) return [];
  const out: TunnelState[] = [];
  for (const file of readdirSync(dir)) {
    const name = nameFromStateFile(file);
    if (name === null) continue;
    const state = readState(name, root);
    if (state) out.push(state);
  }
  return out.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ProcessAliveCheck = (pid: number) => boolean;

/** True when both the local gate and its provider-side process are live. */
export function isTunnelStateLive(
  state: TunnelState,
  processAlive: ProcessAliveCheck = isProcessAlive,
): boolean {
  if (!processAlive(state.gate_pid)) return false;
  if (state.provider === "tailscale") return true;
  const providerPid = state.cloudflared_pid ?? state.provider_pid;
  return typeof providerPid === "number" && processAlive(providerPid);
}

export function tunnelTargetPort(state: TunnelState): number | null {
  const value = /^[a-z][a-z\d+.-]*:\/\//i.test(state.target)
    ? state.target
    : `http://${state.target}`;
  try {
    const url = new URL(value);
    if (url.port) return Number.parseInt(url.port, 10);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Newest live tunnel that serves `vhost` on the requested local web port.
 *
 * The port alone does not identify a tunnel. Several tunnels can forward to one
 * upstream port and be told apart only by the Host header they send, and a
 * server that routes on Host then serves each of them a different site. Picking
 * by port alone returns whichever such tunnel started last, so a caller that
 * builds a URL for one site can hand back a host that serves another and every
 * link 400s. Matching the vhost too keeps the returned tunnel the one that
 * actually serves the caller's origin.
 */
export function findLiveTunnelForOrigin(
  port: number,
  vhost: string,
  root: string = process.cwd(),
  processAlive: ProcessAliveCheck = isProcessAlive,
): TunnelState | null {
  return (
    listStates(root).find(
      (state) =>
        tunnelTargetPort(state) === port &&
        state.vhost === vhost &&
        isTunnelStateLive(state, processAlive),
    ) ?? null
  );
}

/** True when the tunnel's path scope forwards every one of `paths`. */
export function tunnelServesPaths(state: TunnelState, paths: readonly string[]): boolean {
  return paths.every((path) => isPathAllowed(path, state.allow_paths));
}

function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First `name` on PATH (honoring `.exe` on Windows), or null. Needs no shell. */
function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      if (isRunnableFile(full)) return full;
    }
  }
  return null;
}

/**
 * Resolve the cloudflared binary:
 *   1. `$HARNERY_CLOUDFLARED`, then `cloudflared_path` in the tunnel config: an
 *      explicit choice, so a missing or non-runnable file is an error, never a
 *      silent fall-through to some other copy.
 *   2. `cloudflared` on PATH.
 *   3. `~/.local/bin/cloudflared`.
 *   4. Linux x86-64 and arm64: download the latest release to (3).
 * Elsewhere it throws with install guidance.
 */
export function ensureCloudflared(
  env: NodeJS.ProcessEnv = process.env,
  configuredPath: string | undefined = readConfig().cloudflared_path,
): string {
  const explicit = env[CLOUDFLARED_ENV]?.trim();
  const fromConfig = configuredPath?.trim();
  for (const [source, path] of [
    [CLOUDFLARED_ENV, explicit],
    ["cloudflared_path in the tunnel config", fromConfig],
  ] as const) {
    if (!path) continue;
    if (isRunnableFile(path)) return path;
    throw new Error(
      `cloudflared is set by ${source} to ${path}, but that file is missing or not runnable.`,
    );
  }

  const onPath = findOnPath("cloudflared", env);
  if (onPath) return onPath;
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const local = join(homedir(), ".local", "bin", exe);
  if (isRunnableFile(local)) return local;

  const asset =
    process.platform === "linux"
      ? (
          { x64: "cloudflared-linux-amd64", arm64: "cloudflared-linux-arm64" } as Record<
            string,
            string
          >
        )[process.arch]
      : undefined;
  if (!asset) {
    throw new Error(
      "cloudflared not installed. Install it (macOS: `brew install cloudflared`; Windows: " +
        "`winget install Cloudflare.cloudflared`), or point `$HARNERY_CLOUDFLARED` at a binary. " +
        "On Linux it auto-installs to ~/.local/bin/cloudflared.",
    );
  }

  process.stderr.write("Installing cloudflared to ~/.local/bin/...\n"); // lint-ok-emission: sync setup phase before structured output; pairs with the inherited stdio of the curl below
  mkdirSync(join(homedir(), ".local", "bin"), { recursive: true });
  const download = spawnSync(
    "curl",
    [
      "-fsSL",
      `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
      "-o",
      local,
    ],
    { stdio: "inherit" },
  );
  if (download.status !== 0) throw new Error("Downloading cloudflared failed; install it by hand.");
  chmodSync(local, 0o755);
  return local;
}
