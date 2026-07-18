/**
 * Harnery config reader: the settings the coord/hook layer consults when it
 * can't see the consumer CLI's own process.
 *
 * Two layers, project-over-user (project wins field-by-field):
 *   1. `~/.config/harnery/config.jsonc` — user-global base (optional)
 *   2. `<project-root>/.harnery/config.jsonc` — project override (authoritative)
 *
 * Fields owned here: `binName` (host CLI name for agent-facing strings),
 * `hooksSetupHint`, `tools`, `workflow`, `skills`, `presence`, plus the tunable
 * `coord` (heartbeat freshness), `backup` (restic repo/password/prune policy),
 * and `sync` (rclone remote/prefix) sections. The `files` deny/override section
 * is parsed separately by `web/lib/files.ts`.
 *
 * Env vars and CLI flags override any config value per invocation (each accessor
 * documents its own precedence). Dependency-free (no jsonc npm dep) so it runs on
 * both Bun and Node, and so the ADR-009 vendored copies stay portable.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { coordEnv } from "../lib/env.ts";
import { findCoordRoot } from "./hooks/resolve/coord-root.ts";

/** The standalone CLI's bin name: the resolution floor when nothing else is set. */
export const DEFAULT_BIN_NAME = "harn";

/** Heartbeat-freshness default (seconds): the sweep window when nothing overrides it. */
export const DEFAULT_FRESHNESS_SECS = 600;

interface HarneryConfig {
  /** Host CLI bin name, stamped by `harn init` for a consumer (e.g. "acme"). */
  binName?: string;
  /**
   * Host-specific command that (re)installs the project's git hooks, surfaced
   * verbatim in the "commit guard not wired" nudge. Optional: harnery doesn't
   * own git-hook installation (each host wires its own pre-commit to invoke
   * `agent-coord verdict`), and the path/command is host-specific, so the host
   * declares it here (e.g. "scripts/setup-hooks.sh"). Unset → a generic hint.
   */
  hooksSetupHint?: string;
  /**
   * Managed-tool provisioning consent. `{ ripgrep: { autoInstall: true } }`
   * lets `grep` download the pinned, checksum-verified ripgrep into the
   * harnery tools dir on first miss. Committed by a host repo once; absent →
   * a missing rg only produces a rate-limited install hint.
   */
  tools?: { ripgrep?: { autoInstall?: boolean } };
  /**
   * Workflow-engine defaults. `{ subscriptionOnly: true }` pins every
   * `workflow run` in this repo to subscription billing (API-key vars are
   * scrubbed from child envs) without anyone having to remember the flag.
   */
  workflow?: { subscriptionOnly?: boolean };
  /**
   * Cross-machine presence (ADR 0016). `{ enabled: false }` opts a repo out of
   * the git-refs transport (publishing `refs/harnery/presence/<machine>` to
   * origin + fetching peers'). Default is ON when an origin remote exists —
   * the zero-config story — and every operation is fail-silent.
   *
   * `relay` (optional) is the live upgrade: a wss:// URL of a presence relay
   * (the reference public one is wss://relay.harnery.com; self-hosters run
   * `harn relay serve` or deploy relay/worker/ to their own Cloudflare
   * account). When set, hooks keep a per-machine daemon connected to the
   * relay for seconds-latency presence; the git-refs transport stays on as
   * the floor. Unset → git-refs only.
   */
  presence?: { enabled?: boolean; relay?: string };
  /**
   * Coord-layer tunables. `freshness_seconds` is the heartbeat age above which
   * the sweeper prunes an agent (default 600). Read via `coordFreshnessSeconds()`.
   */
  coord?: { freshness_seconds?: number };
  /**
   * `harn backup` (restic) defaults: `repo` path/URL, `password_file`, and the
   * `keep_daily`/`keep_weekly`/`keep_monthly` prune policy. Read via `backupConfig()`.
   */
  backup?: {
    repo?: string;
    password_file?: string;
    keep_daily?: number;
    keep_weekly?: number;
    keep_monthly?: number;
  };
  /**
   * `harn sync` (rclone) defaults: the `remote` name and `prefix` subpath. Read
   * via `syncJsoncConfig()`. `harn sync init` also persists these to
   * `~/.config/harnery/sync.json`, which is consulted as a lower-precedence fallback.
   */
  sync?: { remote?: string; prefix?: string };
  [k: string]: unknown;
}

/** Strip `//` and `/* *​/` comments from JSONC, ignoring comment-like runs inside strings. */
export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The user-global config file, the lower-precedence base under the project file.
 * Honors `XDG_CONFIG_HOME` (falling back to `~/.config`) per the XDG base-dir spec.
 */
function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg?.trim() ? xdg : join(homedir(), ".config");
  return join(base, "harnery", "config.jsonc");
}

/** File mtime in ms, or -1 when the file can't be stat'd (missing). */
function statMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

/** Parse one JSONC config file to an object; missing/unparseable → `{}`. */
function parseConfigFile(p: string): HarneryConfig {
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(p, "utf8"))) as HarneryConfig | null;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* missing or unparseable → defaults (files-section resolver fails loud; the rest is non-critical) */
  }
  return {};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `override` onto `base` (override wins), recursing into plain
 * objects only so a project that sets just `web.port` doesn't wipe a
 * user-global `web.bind`. Arrays + scalars replace wholesale.
 */
function mergeConfig(base: HarneryConfig, override: HarneryConfig): HarneryConfig {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? mergeConfig(prev, v) : v;
  }
  return out as HarneryConfig;
}

// mtime-keyed per-process cache (both layers): a stat is cheap, a parse on every render isn't.
let cache: { root: string; projMtime: number; userMtime: number; cfg: HarneryConfig } | null = null;

/**
 * The effective config for `root`: user-global (`~/.config/harnery/config.jsonc`)
 * as the base, the project file (`<root>/.harnery/config.jsonc`) merged on top.
 * Project values win field-by-field.
 */
function readConfig(root: string): HarneryConfig {
  const projPath = join(root, ".harnery", "config.jsonc");
  const userPath = userConfigPath();
  const projMtime = statMtime(projPath);
  const userMtime = statMtime(userPath);
  if (
    cache &&
    cache.root === root &&
    cache.projMtime === projMtime &&
    cache.userMtime === userMtime
  ) {
    return cache.cfg;
  }
  const user = userMtime === -1 ? {} : parseConfigFile(userPath);
  const project = projMtime === -1 ? {} : parseConfigFile(projPath);
  const cfg = mergeConfig(user, project);
  cache = { root, projMtime, userMtime, cfg };
  return cfg;
}

/**
 * The PROJECT config file only — no user-global merge. `pinnedBinName` uses this
 * so a user-global `binName` can never masquerade as a deliberate project pin
 * (the pin guards committed, public surfaces; see `pinnedBinName`).
 */
function readProjectConfig(root: string): HarneryConfig {
  const p = join(root, ".harnery", "config.jsonc");
  return statMtime(p) === -1 ? {} : parseConfigFile(p);
}

/**
 * Resolve the host CLI's bin name for user-facing strings. Precedence:
 *   1. `HARNERY_BIN` env (explicit per-process override)
 *   2. `.harnery/config.jsonc` `binName` (stamped by `harn init`)
 *   3. `"harn"` (standalone default)
 *
 * `coordRoot` is resolved via `findCoordRoot()` when not passed.
 */
export function resolveBinName(coordRoot?: string | null): string {
  const env = coordEnv("BIN");
  if (env?.trim()) return env.trim();
  const root = coordRoot ?? findCoordRoot();
  if (root) {
    const binName = readConfig(root).binName;
    if (typeof binName === "string" && binName.trim()) return binName.trim();
  }
  return DEFAULT_BIN_NAME;
}

/**
 * The binName explicitly pinned in `<projectRoot>/.harnery/config.jsonc`, or
 * null when absent. Unlike `resolveBinName()` this ignores `HARNERY_BIN` and
 * never falls back to the default — it answers "did someone deliberately pin
 * a name for THIS project?". `init` uses it so a re-run from a different host
 * CLI can't silently re-stamp its own name over a committed pin (the harnery
 * repo itself pins `"harn"` while living embedded in a host monorepo whose
 * CLI would otherwise stamp the host's name into public, committed surfaces).
 */
export function pinnedBinName(projectRoot: string): string | null {
  const binName = readProjectConfig(projectRoot).binName;
  return typeof binName === "string" && binName.trim() ? binName.trim() : null;
}

/**
 * The host's git-hook (re)install command, for the "commit guard not wired"
 * nudge. Returns the configured `hooksSetupHint` (e.g. "scripts/setup-hooks.sh")
 * or null when unset — callers fall back to a generic, host-agnostic message.
 * `coordRoot` is resolved via `findCoordRoot()` when not passed.
 */
export function resolveHooksSetupHint(coordRoot?: string | null): string | null {
  const root = coordRoot ?? findCoordRoot();
  if (!root) return null;
  const hint = readConfig(root).hooksSetupHint;
  return typeof hint === "string" && hint.trim() ? hint.trim() : null;
}

/**
 * Whether the host project consented to automatic ripgrep provisioning:
 * `.harnery/config.jsonc` `{ "tools": { "ripgrep": { "autoInstall": true } } }`.
 * A repo commits that once and every clone self-heals on first `grep`; without
 * it, a missing rg only produces a rate-limited hint (`doctor --fix` installs
 * explicitly). `HARNERY_TOOLS_AUTOINSTALL=1|0` overrides per process.
 * `coordRoot` is resolved via `findCoordRoot()` when not passed.
 */
export function ripgrepAutoInstall(coordRoot?: string | null): boolean {
  const env = coordEnv("TOOLS_AUTOINSTALL");
  if (env === "1") return true;
  if (env === "0") return false;
  const root = coordRoot ?? findCoordRoot();
  if (!root) return false;
  return readConfig(root).tools?.ripgrep?.autoInstall === true;
}

/**
 * Whether this repo pins workflow runs to subscription billing:
 * `.harnery/config.jsonc` `{ "workflow": { "subscriptionOnly": true } }`.
 * The `workflow run --subscription-only` flag turns it on per invocation;
 * `HARNERY_WORKFLOW_SUBSCRIPTION_ONLY=1|0` overrides per process (the `0`
 * escape hatch exists for a key-only CI job inside a pinned repo).
 * `coordRoot` is resolved via `findCoordRoot()` when not passed.
 */
export function workflowSubscriptionOnly(coordRoot?: string | null): boolean {
  const env = coordEnv("WORKFLOW_SUBSCRIPTION_ONLY");
  if (env === "1") return true;
  if (env === "0") return false;
  const root = coordRoot ?? findCoordRoot();
  if (!root) return false;
  return readConfig(root).workflow?.subscriptionOnly === true;
}

/**
 * Whether cross-machine presence (ADR 0016) is enabled for this repo.
 * Default ON — the transport itself additionally gates on an origin remote
 * existing and fails silent everywhere. Opt out via
 * `.harnery/config.jsonc` `{ "presence": { "enabled": false } }`;
 * `HARNERY_PRESENCE=1|0` overrides per process.
 */
export function presenceEnabled(coordRoot?: string | null): boolean {
  const env = coordEnv("PRESENCE");
  if (env === "1") return true;
  if (env === "0") return false;
  const root = coordRoot ?? findCoordRoot();
  if (!root) return false;
  return readConfig(root).presence?.enabled !== false;
}

/**
 * The presence relay URL for this repo, or null when the relay transport is
 * not configured (git-refs only). `HARNERY_PRESENCE_RELAY` overrides per
 * process (empty string or "0" disables). Requires `presenceEnabled()` to be
 * true — a disabled presence section disables the relay too.
 */
export function presenceRelayUrl(coordRoot?: string | null): string | null {
  const root = coordRoot ?? findCoordRoot();
  if (!presenceEnabled(root)) return null;
  const env = coordEnv("PRESENCE_RELAY");
  if (env !== undefined && env !== null) {
    const t = env.trim();
    return t && t !== "0" ? t : null;
  }
  if (!root) return null;
  const relay = readConfig(root).presence?.relay;
  return typeof relay === "string" && relay.trim() ? relay.trim() : null;
}

/** A positive integer from `v`, else `fallback`. Floors non-integer numbers. */
function posIntOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The heartbeat-freshness window (seconds): the age above which the sweeper
 * prunes an agent, and the cutoff the `agents` surface uses to fold stale peers.
 * Precedence:
 *   1. `HARNERY_AGENT_COORD_FRESHNESS` env (canonical), or `HARNERY_AGENT_FRESHNESS` (legacy alias)
 *   2. `.harnery/config.jsonc` `coord.freshness_seconds`
 *   3. `600` (10 minutes)
 * `coordRoot` is resolved via `findCoordRoot()` when not passed.
 */
export function coordFreshnessSeconds(coordRoot?: string | null): number {
  const env = coordEnv("AGENT_COORD_FRESHNESS") ?? coordEnv("AGENT_FRESHNESS");
  if (env !== undefined) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const root = coordRoot ?? findCoordRoot();
  if (root) return posIntOr(readConfig(root).coord?.freshness_seconds, DEFAULT_FRESHNESS_SECS);
  return DEFAULT_FRESHNESS_SECS;
}

/** Resolved `harn backup` defaults (restic repo/password + prune policy). */
export interface BackupConfig {
  repo: string;
  passwordFile: string;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

/**
 * `harn backup` (restic) defaults. Per field, precedence is env → config → built-in:
 *   repo:          `HARNERY_RESTIC_REPO` → `backup.repo` → `~/.cache/harnery/restic-repo`
 *   passwordFile:  `HARNERY_RESTIC_PASSWORD_FILE` → `backup.password_file` → `~/.config/harnery/restic-password`
 *   keepDaily/Weekly/Monthly: `backup.keep_*` → 7 / 4 / 6
 * `coordRoot` is resolved via `findCoordRoot()` when not passed.
 */
export function backupConfig(coordRoot?: string | null): BackupConfig {
  const home = homedir();
  const root = coordRoot ?? findCoordRoot();
  const b = root ? (readConfig(root).backup ?? {}) : {};
  const cfgStr = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const repo =
    coordEnv("RESTIC_REPO") ?? cfgStr(b.repo) ?? join(home, ".cache", "harnery", "restic-repo");
  const passwordFile =
    coordEnv("RESTIC_PASSWORD_FILE") ??
    cfgStr(b.password_file) ??
    join(home, ".config", "harnery", "restic-password");
  return {
    repo,
    passwordFile,
    keepDaily: posIntOr(b.keep_daily, 7),
    keepWeekly: posIntOr(b.keep_weekly, 4),
    keepMonthly: posIntOr(b.keep_monthly, 6),
  };
}

/**
 * `harn sync` (rclone) remote/prefix from `.harnery/config.jsonc` `sync`, or null
 * when unset. This is the config-file layer only; `harn sync` consults env
 * (`HARNERY_SYNC_REMOTE`/`_PREFIX`) first and the `~/.config/harnery/sync.json`
 * file (written by `harn sync init`) as a lower-precedence fallback.
 * `coordRoot` is resolved via `findCoordRoot()` when not passed.
 */
export function syncJsoncConfig(
  coordRoot?: string | null,
): { remote: string; prefix: string } | null {
  const root = coordRoot ?? findCoordRoot();
  if (!root) return null;
  const s = readConfig(root).sync ?? {};
  if (typeof s.remote === "string" && s.remote.trim()) {
    const prefix = typeof s.prefix === "string" && s.prefix.trim() ? s.prefix.trim() : "harnery";
    return { remote: s.remote.trim(), prefix };
  }
  return null;
}
