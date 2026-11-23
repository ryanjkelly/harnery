import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Account discovery for `devtools` (ADR 0273): find every Claude Code, Codex
 * and Cursor account signed in anywhere on the machine, group the copies of
 * each account, and expose the access tokens needed to read its plan usage.
 *
 * Discovery reads files only (no network). Tokens stay on the in-memory
 * `StoreCandidate` objects and must never be copied onto a report. Nothing here
 * writes to any tool's store, and nothing here refreshes a token: a token past
 * its expiry is skipped so the caller can fall through to the next source.
 *
 * Also hosts the CLI Proxy API client (configuration resolution, the
 * management `auth-files` listing and `api-call`) and the Codex `app-server`
 * runner, the fallback usage sources the chain in `devtools.ts` uses.
 *
 * Pure toolkit tier: depends only on `node:*` (plus a lazily-required
 * `bun:sqlite`), never on `src/core/`.
 */

export type DevtoolName = "claude-code" | "codex" | "cursor";

export type StoreKind =
  | "claude-dir"
  | "claude-keychain"
  | "codex-home"
  | "cursor-cli"
  | "cursor-ide"
  | "cliproxy-file";

export interface AccountIdentity {
  /** Stable grouping key: `<tool>:<account id>`, else `<tool>:<email>|<org>`, else per store. */
  key: string;
  email: string | null;
  /** Vendor account id (Claude account UUID, ChatGPT account id, Cursor user id). */
  accountId: string | null;
  /** Organization id or name where the store records one. */
  org: string | null;
  plan: string | null;
}

/** One place an account's credential was found. Holds the token in memory only. */
export interface StoreCandidate {
  tool: DevtoolName;
  storeKind: StoreKind;
  /** File or directory the store lives at (a pseudo-path for the macOS Keychain). */
  path: string;
  identity: AccountIdentity;
  /** Access token, never placed on a report. */
  accessToken: string | null;
  /** Access-token expiry, ms epoch, or null when unknown (opaque token). */
  expiresAt: number | null;
  /** A credential is present and its refresh window is still open. */
  loggedIn: boolean;
  rateLimitTier: string | null;
  /** Local client version where the store records one (Cursor IDE). */
  clientVersion: string | null;
  /** Free-form caveats found while reading the store. */
  notes: string[];
}

export interface AccountGroup {
  tool: DevtoolName;
  identity: AccountIdentity;
  /** Own stores first (discovery order), CLI Proxy files last. */
  stores: StoreCandidate[];
}

export interface DiscoverOpts {
  home: string;
  /** Environment for `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Defaults to process.env for the real home, {} otherwise. */
  env?: Record<string, string | undefined>;
  now?: number;
  /** Also look at host-wide locations (WSL Windows homes, Keychain). Defaults to home === os.homedir(). */
  includeHost?: boolean;
  platform?: NodeJS.Platform;
  /** Keychain reader override (tests). Returns the raw credentials JSON or null. */
  keychain?: (() => string | null) | null;
  only?: readonly DevtoolName[];
}

const ALL: readonly DevtoolName[] = ["claude-code", "codex", "cursor"];

/** List every candidate account store without network calls (ADR 0273 §1). */
export function discoverStores(opts: DiscoverOpts): StoreCandidate[] {
  const home = opts.home;
  const includeHost = opts.includeHost ?? home === homedir();
  const env = opts.env ?? (includeHost ? process.env : {});
  const now = opts.now ?? Date.now();
  const only = new Set(opts.only ?? ALL);
  const winHomes = includeHost ? windowsHomes() : [];
  const out: StoreCandidate[] = [];

  if (only.has("claude-code")) {
    out.push(...discoverClaude(home, winHomes, env, now));
    const platform = opts.platform ?? process.platform;
    const keychain =
      opts.keychain !== undefined
        ? opts.keychain
        : includeHost && platform === "darwin"
          ? readMacKeychain
          : null;
    const raw = keychain ? keychain() : null;
    if (raw) {
      const c = claudeFromCreds(
        safeJson(raw),
        "claude-keychain",
        "keychain:Claude Code-credentials",
        claudeConfigFiles(home, join(home, ".claude")),
        now,
      );
      if (c) out.push(c);
    }
  }
  if (only.has("codex")) out.push(...discoverCodex(home, winHomes, env, now));
  if (only.has("cursor")) out.push(...discoverCursor(home, includeHost, now));

  const proxyDirs = cliproxyAuthDirs(home, winHomes);
  for (const dir of proxyDirs) {
    for (const f of safeReaddir(dir)) {
      const m = /^(claude|codex)-.*\.json$/.exec(f);
      if (!m) continue;
      const tool: DevtoolName = m[1] === "claude" ? "claude-code" : "codex";
      if (!only.has(tool)) continue;
      const c = cliproxyFileCandidate(tool, join(dir, f));
      if (c) out.push(c);
    }
  }
  return out;
}

/** Group copies of the same account (ADR 0273 §2): same account id, or same email + org. */
export function groupAccounts(stores: StoreCandidate[]): AccountGroup[] {
  const parent = stores.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let i = 0; i < stores.length; i++) {
    for (let j = i + 1; j < stores.length; j++) {
      const a = stores[i] as StoreCandidate;
      const b = stores[j] as StoreCandidate;
      if (a.tool !== b.tool) continue;
      if (sameAccount(a.identity, b.identity)) union(i, j);
    }
  }
  const groups = new Map<number, StoreCandidate[]>();
  stores.forEach((s, i) => {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(s);
    groups.set(r, list);
  });
  const out: AccountGroup[] = [];
  for (const [, list] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
    const ordered = [
      ...list.filter((s) => s.storeKind !== "cliproxy-file"),
      ...list.filter((s) => s.storeKind === "cliproxy-file"),
    ];
    const first = ordered[0] as StoreCandidate;
    const pick = <K extends keyof AccountIdentity>(k: K) =>
      ordered.map((s) => s.identity[k]).find((v) => v != null) ?? null;
    const accountId = pick("accountId");
    const email = pick("email");
    const org = pick("org");
    out.push({
      tool: first.tool,
      identity: {
        key: identityKey(first.tool, accountId, email, org, first.path),
        email,
        accountId,
        org,
        plan: pick("plan"),
      },
      stores: ordered,
    });
  }
  return out;
}

function sameAccount(a: AccountIdentity, b: AccountIdentity): boolean {
  if (a.accountId && b.accountId) return a.accountId === b.accountId;
  if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) {
    return !a.org || !b.org || a.org === b.org;
  }
  return false;
}

function identityKey(
  tool: DevtoolName,
  accountId: string | null,
  email: string | null,
  org: string | null,
  path: string,
): string {
  if (accountId) return `${tool}:${accountId}`;
  if (email) return `${tool}:${email.toLowerCase()}|${org ?? ""}`;
  return `${tool}:store:${path}`;
}

/** A token is usable when present and not past its known expiry. */
export function tokenUsable(s: StoreCandidate, now = Date.now()): boolean {
  return Boolean(s.accessToken) && (s.expiresAt == null || s.expiresAt > now);
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function discoverClaude(
  home: string,
  winHomes: string[],
  env: Record<string, string | undefined>,
  now: number,
): StoreCandidate[] {
  const dirs: Array<{ dir: string; owner: string }> = [];
  const add = (dir: string, owner: string) => {
    const r = resolve(dir);
    if (!dirs.some((d) => d.dir === r)) dirs.push({ dir: r, owner });
  };
  const envDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (envDir && existsSync(envDir)) add(envDir, home);
  for (const h of [home, ...winHomes]) {
    if (existsSync(join(h, ".claude"))) add(join(h, ".claude"), h);
    for (const name of safeReaddir(h)) {
      if (!name.startsWith(".claude") || name === ".claude") continue;
      const p = join(h, name);
      if (isDir(p) && existsSync(join(p, ".credentials.json"))) add(p, h);
    }
  }
  const out: StoreCandidate[] = [];
  for (const { dir, owner } of dirs) {
    const creds = readJson<Record<string, unknown>>(join(dir, ".credentials.json"));
    const c = claudeFromCreds(creds, "claude-dir", dir, claudeConfigFiles(owner, dir), now);
    if (c) out.push(c);
  }
  return out;
}

/** `.claude.json` locations for a store: the home-level file for the default dir, then the dir's own. */
function claudeConfigFiles(owner: string, dir: string): string[] {
  const own = join(dir, ".claude.json");
  return resolve(dir) === resolve(join(owner, ".claude"))
    ? [join(owner, ".claude.json"), own]
    : [own];
}

function claudeFromCreds(
  creds: unknown,
  kind: StoreKind,
  path: string,
  configFiles: string[],
  now: number,
): StoreCandidate | null {
  const oauth = (creds as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  let acct: Record<string, unknown> | undefined;
  for (const f of configFiles) {
    acct = readJson<{ oauthAccount?: Record<string, unknown> }>(f)?.oauthAccount;
    if (acct) break;
  }
  if (!oauth && !acct) return null;
  const token = strOr(oauth?.accessToken);
  const accessExp = numOr(oauth?.expiresAt);
  const refreshExp = numOr(oauth?.refreshTokenExpiresAt);
  const loggedIn = Boolean(token) && (refreshExp ?? accessExp ?? 0) > now;
  const notes: string[] = [];
  if (!token) notes.push(`${kind === "claude-dir" ? path : "Keychain"}: signed out`);
  else if (accessExp && accessExp <= now && loggedIn)
    notes.push("access token expired; Claude Code refreshes it on next use");
  const accountId = strOr(acct?.accountUuid) ?? strOr(oauth?.accountUuid);
  const email = strOr(acct?.emailAddress);
  const org = strOr(acct?.organizationUuid) ?? strOr(oauth?.organizationUuid);
  return {
    tool: "claude-code",
    storeKind: kind,
    path,
    identity: {
      key: identityKey("claude-code", accountId, email, org, path),
      email,
      accountId,
      org,
      plan: strOr(acct?.seatTier) ?? strOr(oauth?.subscriptionType),
    },
    accessToken: token,
    expiresAt: accessExp,
    loggedIn,
    rateLimitTier: strOr(acct?.userRateLimitTier) ?? strOr(oauth?.rateLimitTier),
    clientVersion: null,
    notes,
  };
}

let keychainMemo: { value: string | null } | null = null;

/**
 * macOS: Claude Code keeps its OAuth credentials in the login Keychain rather
 * than `.credentials.json`. Best-effort and untested off macOS: one
 * `security find-generic-password -w` call per process (memoized, so an access
 * prompt can never loop), with stdin closed and a short timeout.
 */
function readMacKeychain(): string | null {
  if (keychainMemo) return keychainMemo.value;
  let value: string | null = null;
  try {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    value = r.status === 0 ? strOr(r.stdout?.trim()) : null;
  } catch {
    value = null;
  }
  keychainMemo = { value };
  return value;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function discoverCodex(
  home: string,
  winHomes: string[],
  env: Record<string, string | undefined>,
  now: number,
): StoreCandidate[] {
  const dirs: string[] = [];
  const add = (d: string) => {
    const r = resolve(d);
    if (!dirs.includes(r) && existsSync(join(r, "auth.json"))) dirs.push(r);
  };
  const envHome = env.CODEX_HOME?.trim();
  if (envHome) add(envHome);
  for (const h of [home, ...winHomes]) {
    add(join(h, ".codex"));
    for (const name of safeReaddir(h)) {
      if (name.startsWith(".codex") && name !== ".codex" && isDir(join(h, name)))
        add(join(h, name));
    }
  }
  const out: StoreCandidate[] = [];
  for (const dir of dirs) {
    const auth = readJson<Record<string, unknown>>(join(dir, "auth.json"));
    if (!auth) continue;
    const tokens = auth.tokens as Record<string, unknown> | undefined;
    const idToken = strOr(tokens?.id_token);
    const accessToken = strOr(tokens?.access_token);
    const idClaims = idToken ? decodeJwtClaims(idToken) : null;
    const authClaim = idClaims?.["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const accessExp = numOr(accessToken ? decodeJwtClaims(accessToken)?.exp : undefined);
    const exp = accessExp ?? numOr(idClaims?.exp);
    const accountId = strOr(tokens?.account_id) ?? strOr(authClaim?.chatgpt_account_id);
    const email = strOr(idClaims?.email);
    const notes: string[] = [];
    const hasToken = Boolean(accessToken || idToken);
    const loggedIn = hasToken && (exp == null || exp * 1000 > now);
    if (!hasToken && strOr(auth.OPENAI_API_KEY)) notes.push("API-key sign-in (no plan usage)");
    if (exp && exp * 1000 <= now) notes.push("token expired; refreshes via stored refresh token");
    out.push({
      tool: "codex",
      storeKind: "codex-home",
      path: dir,
      identity: {
        key: identityKey("codex", accountId, email, null, dir),
        email,
        accountId,
        org: null,
        plan: strOr(authClaim?.chatgpt_plan_type),
      },
      accessToken,
      expiresAt: exp != null ? exp * 1000 : null,
      loggedIn: loggedIn || (!hasToken && Boolean(strOr(auth.OPENAI_API_KEY))),
      rateLimitTier: null,
      clientVersion: null,
      notes,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function discoverCursor(home: string, includeHost: boolean, now: number): StoreCandidate[] {
  const out: StoreCandidate[] = [];
  // The Cursor CLI keeps a JWT the usage endpoints accept.
  const cliPath = join(home, ".config", "cursor", "auth.json");
  const cli = readJson<Record<string, unknown>>(cliPath);
  const cliToken = strOr(cli?.accessToken);
  if (cliToken) {
    const claims = decodeJwtClaims(cliToken);
    const userId = userIdFrom(strOr(claims?.sub));
    const exp = numOr(claims?.exp);
    out.push({
      tool: "cursor",
      storeKind: "cursor-cli",
      path: cliPath,
      identity: {
        key: identityKey("cursor", userId, null, null, cliPath),
        email: null,
        accountId: userId,
        org: null,
        plan: null,
      },
      accessToken: cliToken,
      expiresAt: exp != null ? exp * 1000 : null,
      loggedIn: exp == null || exp * 1000 > now,
      rateLimitTier: null,
      clientVersion: null,
      notes: [],
    });
  }

  // The IDE's state.vscdb: an opaque access token (no longer a JWT), with the
  // user id in `cachedScopedProfile` rather than in the token.
  const vscdb = cursorGlobalVscdb(home, includeHost);
  if (vscdb) {
    const items = readVscdbItems(vscdb, [
      "cursorAuth/accessToken",
      "cursorAuth/cachedScopedProfile",
      "cursorAuth/cachedEmail",
      "cursorAuth/stripeMembershipType",
      "cursorAuth/stripeSubscriptionStatus",
      "cursor.startupMetrics.lastVersion",
    ]);
    if (items) {
      const token = strOr(items["cursorAuth/accessToken"]);
      const email = strOr(items["cursorAuth/cachedEmail"]);
      const profile = safeJson(items["cursorAuth/cachedScopedProfile"]) as {
        authId?: unknown;
      } | null;
      const claims = token ? decodeJwtClaims(token) : null;
      const userId = userIdFrom(strOr(profile?.authId)) ?? userIdFrom(strOr(claims?.sub));
      const exp = numOr(claims?.exp);
      const subStatus = strOr(items["cursorAuth/stripeSubscriptionStatus"]);
      if (token || email) {
        out.push({
          tool: "cursor",
          storeKind: "cursor-ide",
          path: vscdb,
          identity: {
            key: identityKey("cursor", userId, email, null, vscdb),
            email,
            accountId: userId,
            org: null,
            plan: strOr(items["cursorAuth/stripeMembershipType"]),
          },
          accessToken: token,
          expiresAt: exp != null ? exp * 1000 : null,
          loggedIn: (Boolean(email) || subStatus === "active") && (exp == null || exp * 1000 > now),
          rateLimitTier: null,
          clientVersion: strOr(items["cursor.startupMetrics.lastVersion"]),
          notes: [],
        });
      }
    }
  }
  return out;
}

/** "auth0|user_01J…" → "user_01J…"; a bare id passes through. */
function userIdFrom(sub: string | null): string | null {
  if (!sub) return null;
  return sub.includes("|") ? (sub.split("|").pop() ?? sub) : sub;
}

/** First existing Cursor global `state.vscdb` across native / macOS / WSL-Windows roots. */
export function cursorGlobalVscdb(home: string, includeHost = home === homedir()): string | null {
  const candidates = [
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  // WSL: Cursor's GUI runs on Windows, so the live DB is under /mnt/c/Users/<u>/.
  // Gated on the real home so a test with a synthetic `home` never reaches out
  // to the host's actual Windows-side Cursor install.
  if (includeHost) {
    for (const h of windowsHomes()) {
      candidates.push(
        join(h, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
      );
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ---------------------------------------------------------------------------
// CLI Proxy API: auth files on disk
// ---------------------------------------------------------------------------

/** CLI Proxy auth directories: `~/.cli-proxy-api` (per home) plus each `config.yaml`'s `auth-dir`. */
export function cliproxyAuthDirs(home: string, winHomes: string[]): string[] {
  const out: string[] = [];
  const add = (d: string) => {
    const r = resolve(d);
    if (!out.includes(r) && isDir(r)) out.push(r);
  };
  for (const h of [home, ...winHomes]) {
    const base = join(h, ".cli-proxy-api");
    add(base);
    let yaml = "";
    try {
      yaml = readFileSync(join(base, "config.yaml"), "utf8");
    } catch {
      continue;
    }
    const m = /^auth-dir:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m.exec(yaml);
    const raw = m?.[1]?.trim();
    if (!raw) continue;
    if (raw.startsWith("~")) add(join(h, raw.slice(1).replace(/^[/\\]/, "")));
    else if (/^[A-Za-z]:[\\/]/.test(raw)) {
      // A Windows drive path seen from WSL: C:\x → /mnt/c/x.
      add(`/mnt/${raw[0]?.toLowerCase()}/${raw.slice(3).replace(/\\/g, "/")}`);
    } else add(raw);
  }
  return out;
}

function cliproxyFileCandidate(tool: DevtoolName, file: string): StoreCandidate | null {
  const j = readJson<Record<string, unknown>>(file);
  if (!j) return null;
  const token = strOr(j.access_token);
  const expMs = typeof j.expired === "string" ? Date.parse(j.expired) : Number.NaN;
  const expiresAt = Number.isNaN(expMs) ? null : expMs;
  const disabled = j.disabled === true;
  const email = strOr(j.email);
  let accountId: string | null;
  let org: string | null = null;
  let plan: string | null = null;
  if (tool === "claude-code") {
    accountId = strOr(j.account_uuid);
    org = strOr(j.organization_uuid);
  } else {
    const idClaims = typeof j.id_token === "string" ? decodeJwtClaims(j.id_token) : null;
    const authClaim = idClaims?.["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    accountId = strOr(j.account_id) ?? strOr(authClaim?.chatgpt_account_id);
    plan = strOr(j.plan_type) ?? strOr(authClaim?.chatgpt_plan_type);
  }
  return {
    tool,
    storeKind: "cliproxy-file",
    path: file,
    identity: { key: identityKey(tool, accountId, email, org, file), email, accountId, org, plan },
    accessToken: disabled ? null : token,
    expiresAt,
    // CLI Proxy refreshes these itself; the file counts as signed in while enabled.
    loggedIn: Boolean(token) && !disabled,
    rateLimitTier: null,
    clientVersion: null,
    notes: disabled ? ["disabled in CLI Proxy"] : [],
  };
}

// ---------------------------------------------------------------------------
// CLI Proxy API: management client
// ---------------------------------------------------------------------------

export interface CliproxyConfig {
  /** Base URLs to try in order (e.g. the saved one, then a WSL host-IP rewrite). */
  urls: string[];
  /** Management key. Never placed on a report. */
  key: string;
  /** Where the setting came from. */
  source: "env" | "file" | "app-settings";
}

/** Harnery's own CLI Proxy setting file (honors XDG_CONFIG_HOME). */
export function cliproxyConfigPath(
  env: Record<string, string | undefined> = process.env,
  home = env.HOME ?? env.USERPROFILE ?? homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(configHome, "harnery", "cliproxy.json");
}

export interface ResolveCliproxyOpts {
  home: string;
  env?: Record<string, string | undefined>;
  includeHost?: boolean;
  /** Windows host addresses to try for a loopback URL under WSL (tests inject). */
  hostIps?: string[];
}

/**
 * Resolve CLI Proxy management settings, most explicit first:
 *   1. env `HARNERY_CLIPROXY_URL` + `HARNERY_CLIPROXY_KEY`,
 *   2. `$XDG_CONFIG_HOME/harnery/cliproxy.json` `{ url, key }`,
 *   3. an agent desktop app's saved usage-limit source
 *      (`~/.t3/userdata/settings.json` `usageLimitSources.<id>` of kind
 *      `cliproxy`; its key sits in the sibling `secrets/` folder).
 * Configs sharing a key are merged, since they name the same server.
 */
export function resolveCliproxyConfigs(opts: ResolveCliproxyOpts): CliproxyConfig[] {
  const includeHost = opts.includeHost ?? opts.home === homedir();
  const env = opts.env ?? (includeHost ? process.env : {});
  const hostIps = opts.hostIps ?? (includeHost && isWsl() ? wslHostIps() : []);
  const raw: Array<{ url: string; key: string; source: CliproxyConfig["source"] }> = [];

  const envUrl = env.HARNERY_CLIPROXY_URL?.trim();
  const envKey = env.HARNERY_CLIPROXY_KEY?.trim();
  if (envUrl && envKey) raw.push({ url: envUrl, key: envKey, source: "env" });

  const file = readJson<{ url?: unknown; key?: unknown }>(cliproxyConfigPath(env, opts.home));
  if (strOr(file?.url) && strOr(file?.key)) {
    raw.push({ url: file?.url as string, key: (file?.key as string).trim(), source: "file" });
  }

  const userdataDirs = [join(opts.home, ".t3", "userdata")];
  if (includeHost) for (const h of windowsHomes()) userdataDirs.push(join(h, ".t3", "userdata"));
  for (const dir of userdataDirs) {
    const settings = readJson<{ usageLimitSources?: Record<string, unknown> }>(
      join(dir, "settings.json"),
    );
    for (const [id, v] of Object.entries(settings?.usageLimitSources ?? {})) {
      const src = v as {
        kind?: unknown;
        url?: unknown;
        managementKey?: unknown;
        enabled?: unknown;
      };
      if (src.kind !== "cliproxy" || src.enabled === false) continue;
      const url = strOr(src.url);
      if (!url) continue;
      let key = strOr(src.managementKey);
      if (!key || /^[•*]+$/.test(key)) {
        const secret = join(
          dir,
          "secrets",
          `usage-limit-source-${Buffer.from(id).toString("base64url")}.bin`,
        );
        try {
          key = strOr(readFileSync(secret, "utf8").trim());
        } catch {
          key = null;
        }
      }
      if (key) raw.push({ url, key, source: "app-settings" });
    }
  }

  const out: CliproxyConfig[] = [];
  for (const r of raw) {
    const urls = [r.url.replace(/\/+$/, "")];
    try {
      const u = new URL(urls[0] as string);
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
        for (const ip of hostIps) {
          u.hostname = ip;
          urls.push(u.toString().replace(/\/+$/, ""));
        }
      }
    } catch {
      continue; // not a URL
    }
    const existing = out.find((c) => c.key === r.key);
    if (existing) {
      for (const u of urls) if (!existing.urls.includes(u)) existing.urls.push(u);
    } else out.push({ urls, key: r.key, source: r.source });
  }
  return out;
}

export interface CliproxyAuthFile {
  authIndex: string;
  /** "claude" | "codex" | … */
  type: string;
  email: string | null;
  /** Auth file name (matches a `claude-*.json` / `codex-*.json` on disk). */
  name: string | null;
  /** ChatGPT account id for Codex entries, when the listing exposes it. */
  accountId: string | null;
  plan: string | null;
  disabled: boolean;
  status: string | null;
}

export type CliproxyListing =
  | { ok: true; baseUrl: string; files: CliproxyAuthFile[] }
  | { ok: false; reason: string; status: number | null };

/** GET `/v0/management/auth-files`, trying each candidate base URL. */
export async function listCliproxyAuthFiles(
  cfg: CliproxyConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<CliproxyListing> {
  let last: CliproxyListing = { ok: false, reason: "no URL", status: null };
  for (const baseUrl of cfg.urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/v0/management/auth-files`, {
        headers: { Authorization: `Bearer ${cfg.key}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Reachable but refused: another URL is the same server, so stop here.
        return { ok: false, reason: `HTTP ${res.status} from ${baseUrl}`, status: res.status };
      }
      const j = (await res.json()) as { files?: Array<Record<string, unknown>> };
      const files = (Array.isArray(j.files) ? j.files : []).map((f) => {
        const idt = f.id_token as Record<string, unknown> | undefined;
        return {
          authIndex: String(f.auth_index ?? ""),
          type: String(f.type ?? f.provider ?? ""),
          email: strOr(f.email) ?? strOr(f.account),
          name: strOr(f.name),
          accountId: strOr(idt?.chatgpt_account_id) ?? strOr(f.account_id),
          plan: strOr(idt?.plan_type),
          disabled: f.disabled === true,
          status: strOr(f.status),
        };
      });
      return { ok: true, baseUrl, files: files.filter((f) => f.authIndex) };
    } catch (err) {
      last = {
        ok: false,
        reason: `${baseUrl} unreachable (${err instanceof Error ? err.message : String(err)})`,
        status: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/** Find the CLI Proxy auth entry for an account group. */
export function matchCliproxyEntry(
  group: AccountGroup,
  files: CliproxyAuthFile[],
): CliproxyAuthFile | null {
  const type = group.tool === "claude-code" ? "claude" : group.tool;
  const candidates = files.filter((f) => f.type === type && !f.disabled);
  const names = new Set(
    group.stores.filter((s) => s.storeKind === "cliproxy-file").map((s) => basename(s.path)),
  );
  const email = group.identity.email?.toLowerCase();
  return (
    candidates.find((f) => f.name != null && names.has(f.name)) ??
    candidates.find(
      (f) => group.identity.accountId != null && f.accountId === group.identity.accountId,
    ) ??
    candidates.find((f) => email != null && f.email?.toLowerCase() === email) ??
    null
  );
}

export interface ApiCallResult {
  statusCode: number;
  body: unknown;
  retryAfterMs: number | null;
}

/**
 * POST `/v0/management/api-call`: CLI Proxy makes the vendor request with the
 * account's own token (substituted for `$TOKEN$`). The proxy's management key
 * goes only to the configured server.
 */
export async function cliproxyApiCall(
  baseUrl: string,
  key: string,
  authIndex: string,
  req: { method: string; url: string; header: Record<string, string> },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: true; result: ApiCallResult } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/v0/management/api-call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ auth_index: authIndex, ...req }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `api-call HTTP ${res.status}` };
    const j = (await res.json()) as {
      status_code?: number;
      header?: Record<string, string[] | string>;
      body?: unknown;
    };
    let body: unknown = j.body;
    if (typeof body === "string") body = safeJson(body);
    const ra = j.header?.["Retry-After"] ?? j.header?.["retry-after"];
    const raStr = Array.isArray(ra) ? ra[0] : ra;
    const secs = raStr != null ? Number.parseInt(raStr, 10) : Number.NaN;
    return {
      ok: true,
      result: {
        statusCode: numOr(j.status_code) ?? 0,
        body,
        retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null,
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Codex app-server
// ---------------------------------------------------------------------------

export type AppServerOutcome = { ok: true; result: unknown } | { ok: false; reason: string };

/**
 * Ask Codex itself for an account's rate limits: start `codex app-server` with
 * `CODEX_HOME` pointed at the account's store and send `initialize`,
 * `initialized`, then `account/rateLimits/read` over JSON-RPC on stdio. Codex
 * refreshes its own token here with its own code (ADR 0273 §4). The process is
 * killed as soon as the answer arrives or `timeoutMs` passes.
 */
export function runCodexAppServer(
  codexHome: string,
  opts: { timeoutMs?: number; clientVersion?: string; command?: string } = {},
): Promise<AppServerOutcome> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolvePromise) => {
    let settled = false;
    let proc: ReturnType<typeof spawn>;
    const done = (o: AppServerOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc?.kill();
      } catch {
        // already gone
      }
      resolvePromise(o);
    };
    const timer = setTimeout(() => done({ ok: false, reason: "app-server timed out" }), timeoutMs);
    try {
      proc = spawn(opts.command ?? "codex", ["app-server"], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (err) {
      done({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    proc.on("error", (err) =>
      done({
        ok: false,
        reason:
          (err as NodeJS.ErrnoException).code === "ENOENT" ? "codex not on PATH" : err.message,
      }),
    );
    proc.on("exit", (code) => done({ ok: false, reason: `app-server exited (${code})` }));
    const send = (m: unknown) => {
      try {
        proc.stdin?.write(`${JSON.stringify(m)}\n`);
      } catch {
        // stdin closed; the exit handler reports it
      }
    };
    let buf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = safeJson(line) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        } | null;
        if (!msg) continue;
        if (msg.id === 1) {
          if (msg.error)
            return done({ ok: false, reason: msg.error.message ?? "initialize failed" });
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (msg.id === 2) {
          if (msg.error)
            return done({ ok: false, reason: msg.error.message ?? "rateLimits failed" });
          return done({ ok: true, result: msg.result });
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "harnery", version: opts.clientVersion ?? packageVersion() } },
    });
  });
}

let pkgVersionMemo: string | null = null;

/** This package's version, for client identification. */
export function packageVersion(): string {
  if (pkgVersionMemo) return pkgVersionMemo;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    pkgVersionMemo = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    pkgVersionMemo = "0.0.0";
  }
  return pkgVersionMemo as string;
}

// ---------------------------------------------------------------------------
// host helpers
// ---------------------------------------------------------------------------

/** Windows user homes visible from WSL (`/mnt/c/Users/<name>`). */
export function windowsHomes(): string[] {
  const root = "/mnt/c/Users";
  const skip = new Set(["All Users", "Default", "Default User", "Public", "desktop.ini"]);
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((u) => !skip.has(u))
      .map((u) => join(root, u))
      .filter(isDir);
  } catch {
    return [];
  }
}

function isWsl(): boolean {
  try {
    if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) return true;
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Addresses of the Windows host as seen from WSL: the default gateway from
 * `/proc/net/route`, then the `resolv.conf` nameserver. A server bound on the
 * Windows side is unreachable at 127.0.0.1 from inside WSL (NAT mode).
 */
export function wslHostIps(): string[] {
  const out: string[] = [];
  try {
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] !== "00000000" || !f[2] || f[2] === "00000000") continue;
      const n = Number.parseInt(f[2], 16);
      const ip = [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join(".");
      if (!out.includes(ip)) out.push(ip);
    }
  } catch {
    // no /proc/net/route
  }
  try {
    const m = /^nameserver\s+(\d+\.\d+\.\d+\.\d+)/m.exec(readFileSync("/etc/resolv.conf", "utf8"));
    if (m?.[1] && !out.includes(m[1])) out.push(m[1]);
  } catch {
    // no resolv.conf
  }
  return out;
}

// ---------------------------------------------------------------------------
// shared readers (also used by devtools.ts)
// ---------------------------------------------------------------------------

/** vscdb copy fallback is skipped above this size (bytes). Cursor's global DB can be 3GB+. */
const VSCDB_COPY_MAX_BYTES = 256 * 1024 * 1024;

export interface VscdbHandle {
  query(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * Open a SQLite DB read-only and run `fn` against it, returning fn's result or
 * null. Uses `bun:sqlite`, lazily required so non-Bun runtimes degrade to null
 * rather than crashing at import.
 *
 * These DBs (Cursor's `state.vscdb`, Codex's `state_5.sqlite`) are usually
 * WAL-locked because their app is running, and over the WSL 9p mount a plain
 * open throws "disk I/O error". The fast path is SQLite immutable mode
 * (`file:...?immutable=1` with the URI open flag): it ignores the lock and the
 * WAL and reads only the btree pages the query touches, so lookups cost ~10ms
 * even on a multi-GB file. The tradeoff is it reads the committed main DB and
 * skips the newest uncommitted WAL frames, which is fine for a status snapshot.
 * Only if immutable fails AND the file is small do we snapshot-copy it (copying
 * a 3GB DB is never worth it).
 */
export function withSqlite<T>(dbPath: string, fn: (db: VscdbHandle) => T): T | null {
  let Database: unknown;
  let constants: { SQLITE_OPEN_READONLY: number; SQLITE_OPEN_URI: number } | undefined;
  try {
    const mod = require("bun:sqlite");
    Database = mod.Database;
    constants = mod.constants;
  } catch {
    return null; // no SQLite engine (plain Node runtime)
  }

  if (constants) {
    try {
      const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;
      const uri = `file:${encodeURI(dbPath)}?immutable=1`;
      const db = new (Database as new (path: string, flags: number) => VscdbHandle)(uri, flags);
      const out = fn(db);
      db.close();
      return out;
    } catch {
      // fall through to the size-guarded snapshot fallback
    }
  }

  let size = Number.POSITIVE_INFINITY;
  try {
    size = statSync(dbPath).size;
  } catch {
    // stat failed; treat as too-large and skip the copy
  }
  if (size > VSCDB_COPY_MAX_BYTES) return null;

  let tmp: string | null = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), "harn-sqlite-"));
    const dst = join(tmp, "copy.sqlite");
    copyFileSync(dbPath, dst);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(dbPath + ext)) {
        try {
          copyFileSync(dbPath + ext, dst + ext);
        } catch {
          // sidecar missing/locked — main file alone is still queryable
        }
      }
    }
    const db = new (Database as new (path: string, opts: { readonly: boolean }) => VscdbHandle)(
      dst,
      { readonly: true },
    );
    const out = fn(db);
    db.close();
    return out;
  } catch {
    return null;
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** Read specific keys from a Cursor `state.vscdb` (VS Code ItemTable). */
export function readVscdbItems(dbPath: string, keys: string[]): Record<string, string> | null {
  return withSqlite(dbPath, (db) => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get(k) as
        | { value: string | Uint8Array }
        | undefined;
      if (row?.value != null)
        out[k] =
          typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
    }
    return out;
  });
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Parse a JSON string that may be undefined; null on absence or parse error. */
export function safeJson(s: string | undefined | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Decode the (non-secret) claims payload of a JWT. Never returns the token. */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function strOr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function numOr(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
