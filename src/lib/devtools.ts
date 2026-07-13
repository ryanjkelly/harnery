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
import { join } from "node:path";

/**
 * `devtools`: read locally-stored state of the AI coding agents harnery
 * supports — Claude Code (`~/.claude`), Codex (`~/.codex`), and Cursor
 * (`~/.cursor`) — into one uniform status shape: login state, plan/tier,
 * auth expiry, session counts, and (where the tool stores them locally)
 * rate-limit / quota windows.
 *
 * Everything here reads files on disk — no network, no vendor API, no
 * credentials leave the machine (auth tokens are inspected for their
 * non-secret claims only; the token strings themselves are never returned).
 * The signals a tool keeps server-side (Cursor usage + billing, Claude's live
 * rate-limit windows) surface as `null` with a note rather than a guess.
 *
 * Pure toolkit tier: depends only on `node:*`, never on `src/core/`.
 */

export type DevtoolName = "claude-code" | "codex" | "cursor";

export interface QuotaWindow {
  /** Human label for the reset window (e.g. "5h", "weekly", "45m"). */
  window: string;
  /** Percent of the window's allowance consumed, 0-100, or null if unknown. */
  usedPercent: number | null;
  /** ISO timestamp when the window resets, or null if unknown. */
  resetsAt: string | null;
}

export interface ToolStatus {
  tool: DevtoolName;
  /** The tool's config directory exists on this machine. */
  installed: boolean;
  /** A credential is present and not obviously expired. null when undeterminable. */
  loggedIn: boolean | null;
  /** Account identifier (email where the tool exposes one), else null. */
  account: string | null;
  /** Plan / seat tier as the tool records it locally (e.g. "team", "team_tier_1"). */
  plan: string | null;
  /** Rate-limit tier string where the tool records one, else null. */
  rateLimitTier: string | null;
  /** ISO expiry of the active access credential, else null. */
  authExpiresAt: string | null;
  /** Count of local session transcripts, else null. */
  sessions: number | null;
  /** ISO timestamp of the most recent local session activity, else null. */
  lastActivity: string | null;
  /** Locally-known quota/rate-limit windows, or null when the tool keeps them server-side. */
  quota: QuotaWindow[] | null;
  /**
   * Approximate total tokens observed in local transcripts within the scan
   * window. Only populated when `readDevtools({ usage: true })`; null otherwise
   * (the scan is opt-in because transcripts can be gigabytes).
   */
  tokensUsed: number | null;
  /** Caveats about what is and isn't derivable locally for this tool. */
  notes: string[];
}

export interface DevtoolsReport {
  generatedAt: string;
  windowDays: number | null;
  tools: ToolStatus[];
}

export interface ReadDevtoolsOpts {
  /** Home directory to resolve tool config against. Defaults to os.homedir(). */
  home?: string;
  /** Scan transcripts for token totals (opt-in; can be slow). Default false. */
  usage?: boolean;
  /** When scanning usage, only include transcripts modified within N days. Default 7. */
  windowDays?: number;
  /** Clock injection for tests. Default Date.now(). */
  now?: number;
  /** Restrict to a subset of tools. Default all three. */
  only?: readonly DevtoolName[];
}

const ALL_TOOLS: readonly DevtoolName[] = ["claude-code", "codex", "cursor"];

export function readDevtools(opts: ReadDevtoolsOpts = {}): DevtoolsReport {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const usage = opts.usage ?? false;
  const windowDays = opts.windowDays ?? 7;
  const only = new Set(opts.only ?? ALL_TOOLS);

  const tools: ToolStatus[] = [];
  if (only.has("claude-code")) tools.push(readClaudeCode(home, now, usage, windowDays));
  if (only.has("codex")) tools.push(readCodex(home, now, usage, windowDays));
  if (only.has("cursor")) tools.push(readCursor(home));

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: usage ? windowDays : null,
    tools,
  };
}

// ---------------------------------------------------------------------------
// Claude Code (~/.claude)
// ---------------------------------------------------------------------------

function readClaudeCode(home: string, now: number, usage: boolean, windowDays: number): ToolStatus {
  const dir = join(home, ".claude");
  const status: ToolStatus = base("claude-code");
  status.installed = existsSync(dir);
  if (!status.installed) {
    status.notes.push("~/.claude not found");
    return status;
  }

  // Auth: ~/.claude/.credentials.json -> claudeAiOauth (non-secret fields only).
  const oauth = readJson<Record<string, unknown>>(join(dir, ".credentials.json"))?.claudeAiOauth as
    | Record<string, unknown>
    | undefined;
  if (oauth) {
    const accessExp = numOr(oauth.expiresAt);
    const refreshExp = numOr(oauth.refreshTokenExpiresAt);
    status.loggedIn = (refreshExp ?? accessExp ?? 0) > now;
    status.authExpiresAt = accessExp ? new Date(accessExp).toISOString() : null;
    status.plan = strOr(oauth.subscriptionType);
    status.rateLimitTier = strOr(oauth.rateLimitTier);
    if (accessExp && accessExp <= now && refreshExp && refreshExp > now) {
      status.notes.push("access token expired; refreshes on next use");
    }
  } else {
    status.loggedIn = false;
    status.notes.push("no credential found (not logged in)");
  }

  // Richer account/plan metadata lives in ~/.claude.json (sibling of the dir).
  const cfg = readJson<Record<string, unknown>>(join(home, ".claude.json"));
  const acct = cfg?.oauthAccount as Record<string, unknown> | undefined;
  if (acct) {
    status.account = strOr(acct.emailAddress);
    // Prefer the seat tier as the human "plan" when present.
    status.plan = strOr(acct.seatTier) ?? status.plan;
    status.rateLimitTier = strOr(acct.userRateLimitTier) ?? status.rateLimitTier;
  }

  // Sessions: one .jsonl transcript per session under projects/<slug>/.
  const projects = join(dir, "projects");
  const files = listFilesRecursive(projects, ".jsonl");
  status.sessions = files.length || null;
  status.lastActivity = latestMtimeIso(files);

  // Claude Code does not persist its rate-limit windows locally; the live
  // 5-hour / weekly figures come from the `/usage` server call.
  status.quota = null;
  status.notes.push("live quota (5h/weekly resets) is server-side via /usage");

  if (usage) {
    status.tokensUsed = sumClaudeTokens(files, now, windowDays);
  }

  return status;
}

function sumClaudeTokens(files: string[], now: number, windowDays: number): number {
  const cutoff = now - windowDays * 86_400_000;
  let total = 0;
  for (const f of files) {
    if (safeMtime(f) < cutoff) continue;
    for (const line of readJsonlSync(f)) {
      const usage = (line as { message?: { usage?: Record<string, number> } }).message?.usage;
      if (!usage) continue;
      total +=
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Codex (~/.codex)
// ---------------------------------------------------------------------------

function readCodex(home: string, now: number, usage: boolean, windowDays: number): ToolStatus {
  const dir = join(home, ".codex");
  const status: ToolStatus = base("codex");
  status.installed = existsSync(dir);
  if (!status.installed) {
    status.notes.push("~/.codex not found");
    return status;
  }

  // Auth: ~/.codex/auth.json. Decode the id_token's non-secret claims only. The
  // plan here can be stale (the token is minted infrequently); the live plan
  // comes from the freshest rollout's rate_limits below and overrides it.
  const auth = readJson<Record<string, unknown>>(join(dir, "auth.json"));
  if (auth) {
    const tokens = auth.tokens as Record<string, unknown> | undefined;
    const idToken = strOr(tokens?.id_token);
    status.loggedIn = Boolean(strOr(tokens?.access_token) || idToken);
    const claims = idToken ? decodeJwtClaims(idToken) : null;
    if (claims) {
      status.account = strOr(claims.email);
      const authClaim = claims["https://api.openai.com/auth"] as
        | Record<string, unknown>
        | undefined;
      status.plan = strOr(authClaim?.chatgpt_plan_type);
      const exp = numOr(claims.exp);
      if (exp) {
        status.authExpiresAt = new Date(exp * 1000).toISOString();
        if (exp * 1000 <= now)
          status.notes.push("token expired; refreshes via stored refresh token");
      }
    }
  } else {
    status.loggedIn = false;
    status.notes.push("no auth.json found (not logged in)");
  }

  // Activity: sqlite/state_5.sqlite (the `threads` table) is Codex's authoritative
  // live store. The JSONL rollouts under sessions/ can lag it (and on WSL the
  // live app writes them Windows-side), so prefer the DB for counts + recency.
  const state = readCodexState(join(dir, "sqlite", "state_5.sqlite"), usage);
  if (state) {
    status.sessions = state.sessions;
    if (state.lastMs) status.lastActivity = new Date(state.lastMs).toISOString();
    if (usage && state.tokens != null) status.tokensUsed = state.tokens;
  }

  // Freshest rollout → current rate-limit windows + live plan_type. Prefer the
  // newest thread's rollout_path from the DB (it points at the live sessions
  // dir, Windows-side on WSL); otherwise glob the known sessions roots.
  const globbed = codexRollouts(home);
  if (!state) {
    // No SQLite engine: fall back to the rollout files for counts + recency.
    status.sessions = globbed.length || null;
    status.lastActivity = latestMtimeIso(globbed);
    if (usage) status.tokensUsed = sumCodexTokens(globbed, now, windowDays);
  }
  const newest =
    (state?.newestRollout && existsSync(state.newestRollout) ? state.newestRollout : null) ??
    newestFile(globbed);
  if (newest) {
    const rl = lastRateLimits(newest);
    if (rl) {
      status.quota = [rl.primary, rl.secondary].filter((q): q is QuotaWindow => q !== null);
      if (rl.planType) status.plan = rl.planType; // live plan wins over the id_token
    }
  }
  if (!status.quota?.length) status.notes.push("no local rate-limit snapshot in latest session");

  return status;
}

interface CodexState {
  sessions: number;
  tokens: number | null;
  lastMs: number | null;
  newestRollout: string | null;
}

/** Read Codex's `state_5.sqlite` threads table for session count, token sum, recency, newest rollout. */
function readCodexState(dbPath: string, usage: boolean): CodexState | null {
  if (!existsSync(dbPath)) return null;
  return withSqlite(dbPath, (db) => {
    const agg = db
      .query("SELECT count(*) c, sum(tokens_used) tok, max(updated_at_ms) mx FROM threads")
      .get() as { c: number; tok: number | null; mx: number | null } | undefined;
    const newest = db
      .query("SELECT rollout_path FROM threads ORDER BY updated_at_ms DESC LIMIT 1")
      .get() as { rollout_path: string | null } | undefined;
    return {
      sessions: agg?.c ?? 0,
      tokens: usage ? (numOr(agg?.tok) ?? 0) : null,
      lastMs: numOr(agg?.mx),
      newestRollout: strOr(newest?.rollout_path),
    };
  });
}

/** All Codex rollout files across the WSL home and (real-home only) the Windows-side home. */
function codexRollouts(home: string): string[] {
  const roots = [join(home, ".codex", "sessions")];
  if (home === homedir()) {
    try {
      if (existsSync("/mnt/c/Users")) {
        for (const u of readdirSync("/mnt/c/Users"))
          roots.push(`/mnt/c/Users/${u}/.codex/sessions`);
      }
    } catch {
      // not WSL
    }
  }
  return roots
    .flatMap((r) => listFilesRecursive(r, ".jsonl"))
    .filter((f) => f.includes("rollout-"));
}

interface RateLimitsSnapshot {
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
  planType: string | null;
}

function lastRateLimits(file: string): RateLimitsSnapshot | null {
  let found: RateLimitsSnapshot | null = null;
  for (const line of readJsonlSync(file)) {
    const payload = (line as { type?: string; payload?: Record<string, unknown> }).payload;
    if (!payload || payload.type !== "token_count") continue;
    const rl = payload.rate_limits as Record<string, unknown> | undefined;
    if (!rl) continue;
    found = {
      primary: quotaFromWindow(rl.primary as Record<string, unknown> | undefined),
      secondary: quotaFromWindow(rl.secondary as Record<string, unknown> | undefined),
      planType: strOr(rl.plan_type),
    };
  }
  return found;
}

function quotaFromWindow(w: Record<string, unknown> | undefined): QuotaWindow | null {
  if (!w) return null;
  const resets = numOr(w.resets_at);
  return {
    window: windowLabel(numOr(w.window_minutes)),
    usedPercent: numOr(w.used_percent),
    resetsAt: resets ? new Date(resets * 1000).toISOString() : null,
  };
}

function windowLabel(minutes: number | null): string {
  if (minutes == null) return "unknown";
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function sumCodexTokens(files: string[], now: number, windowDays: number): number {
  const cutoff = now - windowDays * 86_400_000;
  let total = 0;
  for (const f of files) {
    if (safeMtime(f) < cutoff) continue;
    // token_count events carry a cumulative info.total_token_usage; take the
    // max seen in each rollout (the last reading is the session total).
    let sessionMax = 0;
    for (const line of readJsonlSync(f)) {
      const payload = (line as { payload?: Record<string, unknown> }).payload;
      if (!payload || payload.type !== "token_count") continue;
      const info = payload.info as Record<string, unknown> | undefined;
      const totals = info?.total_token_usage as Record<string, unknown> | undefined;
      const t = numOr(totals?.total_tokens);
      if (t && t > sessionMax) sessionMax = t;
    }
    total += sessionMax;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Cursor (~/.cursor) — most usage/billing is server-side.
// ---------------------------------------------------------------------------

function readCursor(home: string): ToolStatus {
  const dir = join(home, ".cursor");
  // Cursor's IDE state DB (state.vscdb) holds the account email, Stripe
  // membership + subscription status, and per-chat activity — all token-free
  // and the richest local signal. It lives under the OS app-support dir
  // (Linux ~/.config, macOS ~/Library, WSL the Windows-side path), separate
  // from ~/.cursor (the agent-CLI config). Treat Cursor as installed if either
  // exists, so a macOS GUI user who never ran the CLI still resolves.
  const vscdb = cursorGlobalVscdb(home);
  const status: ToolStatus = base("cursor");
  status.installed = existsSync(dir) || vscdb != null;
  if (!status.installed) {
    status.notes.push("Cursor not found (no ~/.cursor and no state.vscdb)");
    return status;
  }

  // Read the state DB when a SQLite engine is available (bun:sqlite); otherwise
  // fall back to login-presence signals from the remote-server tokens / statsig id.
  const items = vscdb
    ? readVscdbItems(vscdb, [
        "cursorAuth/cachedEmail",
        "cursorAuth/stripeMembershipType",
        "cursorAuth/stripeSubscriptionStatus",
        "composer.composerHeaders",
      ])
    : null;

  if (items) {
    const email = strOr(items["cursorAuth/cachedEmail"]);
    const membership = strOr(items["cursorAuth/stripeMembershipType"]);
    const subStatus = strOr(items["cursorAuth/stripeSubscriptionStatus"]);
    status.account = email;
    status.plan = membership;
    status.loggedIn = Boolean(email) || subStatus === "active";
    if (subStatus) status.notes.push(`subscription ${subStatus}`);

    // Per-chat activity from composer headers (session count + last active).
    const headers = safeJson(items["composer.composerHeaders"]) as {
      allComposers?: Array<{ lastUpdatedAt?: number; createdAt?: number }>;
    } | null;
    const composers = headers?.allComposers ?? [];
    if (composers.length) {
      status.sessions = composers.length;
      let last = 0;
      for (const c of composers) last = Math.max(last, c.lastUpdatedAt ?? c.createdAt ?? 0);
      if (last > 0) status.lastActivity = new Date(last).toISOString();
    }
  } else {
    // Fallback: remote-server tokens + statsig id only prove a login exists.
    const serverDir = join(home, ".cursor-server");
    const tokenFiles = existsSync(serverDir)
      ? readdirSync(serverDir).filter((f) => f.endsWith(".token"))
      : [];
    const statsig = readJson<Record<string, unknown>>(join(dir, "statsig-cache.json"));
    status.account = strOr(statsig?.userID); // opaque statsig id, not an email
    status.loggedIn = tokenFiles.length > 0 || status.account ? true : null;
    status.notes.push("state.vscdb unreadable (needs a SQLite engine); login-presence only");
  }

  // Session count fallback: per-project workspace dirs.
  if (status.sessions == null) {
    const projects = join(dir, "projects");
    const entries = existsSync(projects)
      ? readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory())
      : [];
    status.sessions = entries.length || null;
    if (!status.lastActivity)
      status.lastActivity = latestMtimeIso(entries.map((d) => join(projects, d.name)));
  }

  // Token cost + quota are genuinely server-side for individual Cursor plans.
  status.quota = null;
  status.tokensUsed = null;
  status.notes.push("token cost + quota are server-side (cursor.com); not exposed locally");

  return status;
}

/** First existing Cursor global `state.vscdb` across native / macOS / WSL-Windows roots. */
function cursorGlobalVscdb(home: string): string | null {
  const candidates = [
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  // WSL: Cursor's GUI runs on Windows, so the live DB is under /mnt/c/Users/<u>/.
  // Gated on the real home so a test with a synthetic `home` never reaches out
  // to the host's actual Windows-side Cursor install.
  if (home === homedir()) {
    try {
      if (existsSync("/mnt/c/Users")) {
        for (const u of readdirSync("/mnt/c/Users")) {
          candidates.push(
            `/mnt/c/Users/${u}/AppData/Roaming/Cursor/User/globalStorage/state.vscdb`,
          );
        }
      }
    } catch {
      // no /mnt/c — not WSL
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** vscdb copy fallback is skipped above this size (bytes). Cursor's global DB can be 3GB+. */
const VSCDB_COPY_MAX_BYTES = 256 * 1024 * 1024;

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
function withSqlite<T>(dbPath: string, fn: (db: VscdbHandle) => T): T | null {
  let Database: unknown;
  let constants: { SQLITE_OPEN_READONLY: number; SQLITE_OPEN_URI: number } | undefined;
  try {
    // biome-ignore lint/style/useNodejsImportProtocol: bun:sqlite is a Bun builtin, not a node: module
    const mod = require("bun:sqlite");
    Database = mod.Database;
    constants = mod.constants;
  } catch {
    return null; // no SQLite engine (plain Node runtime)
  }

  // Fast path: open immutable + read-only, no copy. Encode the path into a file:
  // URI (leaves "/" intact, escapes spaces in Windows paths).
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

  // Fallback: snapshot the DB (+ sidecars) and read the copy, only when small.
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
function readVscdbItems(dbPath: string, keys: string[]): Record<string, string> | null {
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

interface VscdbHandle {
  query(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function base(tool: DevtoolName): ToolStatus {
  return {
    tool,
    installed: false,
    loggedIn: null,
    account: null,
    plan: null,
    rateLimitTier: null,
    authExpiresAt: null,
    sessions: null,
    lastActivity: null,
    quota: null,
    tokensUsed: null,
    notes: [],
  };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Parse a JSON string that may be undefined; null on absence or parse error. */
function safeJson(s: string | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Yield parsed JSON objects from a .jsonl file, skipping unparseable lines. */
function* readJsonlSync(path: string): Generator<unknown> {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // partial/corrupt line — skip
    }
  }
}

/** Decode the (non-secret) claims payload of a JWT. Never returns the token. */
function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listFilesRecursive(root: string, ext: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
    }
  }
  return out;
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function newestFile(paths: string[]): string | null {
  let best: string | null = null;
  let bestM = -1;
  for (const p of paths) {
    const m = safeMtime(p);
    if (m > bestM) {
      bestM = m;
      best = p;
    }
  }
  return best;
}

function latestMtimeIso(paths: string[]): string | null {
  let m = 0;
  for (const p of paths) m = Math.max(m, safeMtime(p));
  return m > 0 ? new Date(m).toISOString() : null;
}

function strOr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numOr(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
