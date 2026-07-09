// Tunnel config + state persistence + provider helpers. Lives under
// <cwd>/.cache/tunnel/; gitignored, so the allowlist is per-machine.

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

// Inline cachePath: tunnel state under <cwd>/.cache/tunnel/.
function cachePath(tool: string, filename: string): string {
  const dir = resolve(process.cwd(), ".cache", tool);
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
  allowed_ips: string[];
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
  tailscale_mode?: TailscaleMode;
  tailscale_path?: string;
  tailscale_https_port?: number;
}

/** Normalize a parsed state blob; supply `name` for pre-multi-instance files. */
function normalizeState(raw: TunnelState, fallbackName: string): TunnelState {
  return { ...raw, name: raw.name ?? fallbackName, provider: raw.provider ?? "cloudflare" };
}

export function readConfig(): TunnelConfig {
  const p = cachePath("tunnel", CONFIG_FILE);
  if (!existsSync(p)) {
    writeConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG, allowed_ips: [...DEFAULT_CONFIG.allowed_ips] };
  }
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TunnelConfig;
  } catch {
    return { ...DEFAULT_CONFIG, allowed_ips: [...DEFAULT_CONFIG.allowed_ips] };
  }
}

export function writeConfig(cfg: TunnelConfig): void {
  writeFileSync(cachePath("tunnel", CONFIG_FILE), JSON.stringify(cfg, null, 2));
}

export function readState(name: string = DEFAULT_INSTANCE): TunnelState | null {
  const p = cachePath("tunnel", stateFile(name));
  if (!existsSync(p)) return null;
  try {
    return normalizeState(JSON.parse(readFileSync(p, "utf-8")) as TunnelState, name);
  } catch {
    return null;
  }
}

export function writeState(state: TunnelState): void {
  writeFileSync(cachePath("tunnel", stateFile(state.name)), JSON.stringify(state, null, 2));
}

export function clearState(name: string = DEFAULT_INSTANCE): void {
  const p = cachePath("tunnel", stateFile(name));
  if (existsSync(p)) unlinkSync(p);
}

/**
 * Every persisted tunnel instance, newest-started first. Reads every
 * `state*.json` under `.cache/tunnel/`; tolerates missing/corrupt files.
 */
export function listStates(): TunnelState[] {
  const dir = resolve(process.cwd(), ".cache", "tunnel");
  if (!existsSync(dir)) return [];
  const out: TunnelState[] = [];
  for (const file of readdirSync(dir)) {
    const name = nameFromStateFile(file);
    if (name === null) continue;
    const state = readState(name);
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

/**
 * Ensure cloudflared is on PATH or installed at ~/.local/bin/cloudflared.
 * Auto-downloads on Linux; throws on other platforms with brew hint.
 */
export function ensureCloudflared(): string {
  try {
    execSync("command -v cloudflared", { stdio: "ignore" });
    return "cloudflared";
  } catch {
    /* not on PATH; fall through */
  }
  const local = `${process.env.HOME}/.local/bin/cloudflared`;
  if (existsSync(local)) return local;

  if (process.platform !== "linux") {
    throw new Error(
      "cloudflared not installed. On macOS: `brew install cloudflared`. " +
        "On Linux it auto-installs to ~/.local/bin/cloudflared.",
    );
  }

  process.stderr.write("Installing cloudflared to ~/.local/bin/...\n"); // lint-ok-emission: sync setup phase before structured output; pairs with the inherited stdio of the curl below
  execSync(
    `curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ${local} && chmod +x ${local}`,
    { stdio: "inherit" },
  );
  return local;
}
