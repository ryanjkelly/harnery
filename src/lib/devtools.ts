import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
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

export interface ApiEnrichment {
  /** The configured API key authenticated successfully. */
  ok: boolean;
  /** Human name the vendor reports for the key (e.g. Cursor's apiKeyName). */
  keyName: string | null;
  /** Cloud-agent activity (Cursor Cloud Agent API), when available. */
  cloudAgents: { total: number; active: number } | null;
  /** Error message when the key is configured but a call failed. */
  error: string | null;
}

/**
 * Cursor billing-cycle + usage snapshot, fetched from cursor.com's own dashboard
 * API using the IDE's locally-stored session token — the same call Cursor's UI
 * makes for the Spending page. No API key to mint; it reads what's already on
 * disk. Percentages are 0-100; cent amounts are raw (divide by 100 for dollars).
 */
export interface CursorUsage {
  /** ISO start of the current billing cycle. */
  cycleStart: string | null;
  /** ISO end of the current billing cycle (the "resets on …" date). */
  cycleEnd: string | null;
  /** Percent of included total usage consumed this cycle (Cursor's "Total"). */
  totalPercentUsed: number | null;
  /** Percent of included API usage consumed (named-model / "API"). */
  apiPercentUsed: number | null;
  /** Percent of included first-party ("Auto") model usage consumed. */
  firstPartyPercentUsed: number | null;
  /** Included usage allowance in cents (e.g. 7000 = $70). */
  includedLimitCents: number | null;
}

/**
 * Overage / on-demand dollar spend against a cap — Cursor's on-demand usage and
 * Claude's extra-usage credits are the same idea. Cents are raw (÷100 for USD).
 */
export interface SpendStatus {
  /** Human label for what this spend covers (e.g. "On-demand", "Extra usage"). */
  label: string;
  /** Amount spent this cycle in cents. */
  usedCents: number | null;
  /** Spend cap in cents, or null when unset/unlimited. */
  limitCents: number | null;
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
  /**
   * Result of the optional API enrichment (network), populated by
   * `enrichFromApi` when a key is configured. `null` when no enrichment ran.
   */
  api: ApiEnrichment | null;
  /**
   * Cursor billing-cycle + usage, populated by `enrichFromApi` from the IDE's
   * own session token (no API key needed). `null` when no enrichment ran, the
   * token is stale, or the tool isn't Cursor.
   */
  usage: CursorUsage | null;
  /**
   * Overage / on-demand dollar spend, populated by `enrichFromApi` (Cursor's
   * on-demand, Claude's extra-usage credits). `null` when no enrichment ran or
   * the plan has no overage concept.
   */
  spend: SpendStatus | null;
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

// ---------------------------------------------------------------------------
// Network enrichment (opt-in)
//
// `readDevtools` stays pure-local. `enrichFromApi` adds live signals over the
// network, each authenticating with the credential the tool already stores on
// disk — the user's own token reading the user's own data:
//
//   • Claude Code — reads the OAuth token from ~/.claude/.credentials.json and
//     calls api.anthropic.com/api/oauth/usage (the endpoint `/usage` uses) for
//     the 5h + weekly rate-limit windows and extra-usage spend.
//   • Cursor usage + billing (NO key needed) — reads the IDE's session token
//     from state.vscdb and calls cursor.com's dashboard API (the Spending page
//     request) for the billing cycle + total/API/first-party percent-used.
//   • Cursor Cloud Agents (needs an API key) — the public /v0 API. Individual
//     Cursor plans expose no usage/billing there (Team-only), so the key path
//     only adds Cloud Agent runs.
// ---------------------------------------------------------------------------

/** Path of the machine-local Cursor API key file (honors XDG_CONFIG_HOME). */
export function cursorApiKeyPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(configHome, "harnery", "cursor-api-key");
}

/** Resolve a Cursor API key: env `CURSOR_API_KEY` first, then the key file. */
export function resolveCursorApiKey(): string | null {
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const v = readFileSync(cursorApiKeyPath(), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Statuses that mean a cloud agent is still doing work (everything else is done/gone). */
const CURSOR_AGENT_INACTIVE = new Set(["EXPIRED", "FINISHED", "DELETED", "FAILED", "CANCELLED"]);

/**
 * Enrich a report's entries over the network with live usage each tool keeps
 * server-side, authenticating with the credential already on disk. Best-effort
 * and network-guarded: every failure degrades to a note, never throws. No-op
 * for a tool that isn't installed / present in the report.
 */
export async function enrichFromApi(
  report: DevtoolsReport,
  opts: {
    cursorKey?: string | null;
    timeoutMs?: number;
    home?: string;
    /** Cache TTL for the usage endpoints (ms). 0 disables caching. Default 120s. */
    cacheTtlMs?: number;
  } = {},
): Promise<DevtoolsReport> {
  const home = opts.home ?? homedir();
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const cacheTtlMs = opts.cacheTtlMs ?? 120_000;

  // Claude Code — 5h + weekly windows and extra-usage spend from oauth/usage.
  // Cached, because that endpoint is aggressively rate-limited and Claude Code's
  // OWN "Account & Usage" panel hits it too — a chatty dashboard would starve it.
  const claude = report.tools.find((t) => t.tool === "claude-code");
  if (claude?.installed) {
    const token = readClaudeOauthToken(home);
    if (token) {
      const live = await cachedUsage(home, "claude-usage", cacheTtlMs, () =>
        fetchClaudeUsage(token, timeoutMs),
      );
      if (live) {
        claude.quota = live.quota;
        claude.spend = live.spend;
        // Drop the pure-local "quota is server-side" caveat now that it's filled.
        claude.notes = claude.notes.filter((n) => !n.includes("server-side via /usage"));
      } else {
        claude.notes.push("live usage unavailable (rate-limited or token stale; retries shortly)");
      }
    }
  }

  const cursor = report.tools.find((t) => t.tool === "cursor");
  if (!cursor?.installed) return report;

  // Cursor usage + billing from the IDE's own session token (no API key needed).
  const auth = readCursorSessionAuth(home);
  if (auth) {
    const usage = await cachedUsage(home, "cursor-usage", cacheTtlMs, () =>
      fetchCursorUsage(auth, timeoutMs),
    );
    if (usage) {
      cursor.usage = usage.usage;
      cursor.spend = usage.spend;
    } else {
      cursor.notes.push("Cursor usage unavailable (session token may be stale — reopen Cursor)");
    }
  }

  // Cursor Cloud Agent activity from a configured API key (optional, separate auth).
  const key = opts.cursorKey !== undefined ? opts.cursorKey : resolveCursorApiKey();
  if (key) {
    cursor.api = await fetchCursorApi(key, timeoutMs);
    // On success the structured `api` fields carry the signal; only note a break.
    if (!cursor.api.ok) {
      cursor.notes.unshift(`API key configured but not usable: ${cursor.api.error ?? "unknown"}`);
    }
  }
  return report;
}

/**
 * Wrap a usage fetch in a short on-disk cache under `<home>/.cache/harnery/
 * devtools/<name>.json`. A fresh cached value short-circuits the network call;
 * only successful (non-null) fetches are written, so a rate-limited failure
 * neither poisons the cache nor blocks the next attempt. Cache is best-effort —
 * any read/write error falls back to a live fetch. `ttlMs <= 0` disables it.
 */
async function cachedUsage<T>(
  home: string,
  name: string,
  ttlMs: number,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  const now = Date.now();
  const file = join(home, ".cache", "harnery", "devtools", `${name}.json`);
  if (ttlMs > 0) {
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as { at?: number; data?: T };
      if (entry.at != null && now - entry.at < ttlMs && entry.data != null) return entry.data;
    } catch {
      // no cache / unreadable — fall through to fetch
    }
  }
  const fresh = await fetcher();
  if (fresh != null && ttlMs > 0) {
    try {
      mkdirSync(join(home, ".cache", "harnery", "devtools"), { recursive: true });
      writeFileSync(file, JSON.stringify({ at: now, data: fresh }));
    } catch {
      // cache write is best-effort
    }
  }
  return fresh;
}

/**
 * Read Claude Code's OAuth access token from ~/.claude/.credentials.json.
 * Returns null when absent or expired (both the access and refresh windows are
 * past, so a call would 401). The token is used only to build the request and
 * is never stored on the report.
 */
function readClaudeOauthToken(home: string): string | null {
  const oauth = readJson<Record<string, unknown>>(join(home, ".claude", ".credentials.json"))
    ?.claudeAiOauth as Record<string, unknown> | undefined;
  const token = strOr(oauth?.accessToken);
  if (!token) return null;
  const accessExp = numOr(oauth?.expiresAt);
  const refreshExp = numOr(oauth?.refreshTokenExpiresAt);
  // If both windows are past, the token is dead — skip the doomed call.
  if ((refreshExp ?? accessExp ?? Number.POSITIVE_INFINITY) < Date.now()) return null;
  return token;
}

/** Statuses in the oauth/usage `limits[]` array, mapped to quota-window labels. */
const CLAUDE_LIMIT_LABELS: Record<string, string> = {
  session: "5h",
  weekly_all: "weekly",
  weekly_scoped: "weekly",
};

/**
 * Fetch Claude Code's live usage from api.anthropic.com/api/oauth/usage — the
 * same endpoint the `/usage` command hits — with the local OAuth token. Returns
 * the 5h + weekly rate-limit windows and extra-usage spend, or null on failure.
 */
async function fetchClaudeUsage(
  token: string,
  timeoutMs: number,
): Promise<{ quota: QuotaWindow[]; spend: SpendStatus | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as {
      limits?: Array<{
        kind?: string;
        percent?: number;
        resets_at?: string;
        scope?: { model?: { display_name?: string } } | null;
      }>;
      five_hour?: { utilization?: number; resets_at?: string };
      seven_day?: { utilization?: number; resets_at?: string };
      spend?: {
        used?: { amount_minor?: number; exponent?: number };
        limit?: { amount_minor?: number; exponent?: number };
        enabled?: boolean;
      };
    };

    // Prefer the structured limits[] array (carries model-scoped windows); fall
    // back to the flat five_hour / seven_day pair.
    let quota: QuotaWindow[] = [];
    if (Array.isArray(raw.limits) && raw.limits.length) {
      quota = raw.limits.map((l) => {
        const model = strOr(l.scope?.model?.display_name);
        const base = l.kind ? (CLAUDE_LIMIT_LABELS[l.kind] ?? l.kind) : "quota";
        return {
          window: model ? `${base} · ${model}` : base,
          usedPercent: roundPct(l.percent),
          resetsAt: isoOrNull(l.resets_at),
        };
      });
    } else {
      const flat: Array<[string, { utilization?: number; resets_at?: string } | undefined]> = [
        ["5h", raw.five_hour],
        ["weekly", raw.seven_day],
      ];
      quota = flat
        .filter(([, w]) => w?.utilization != null)
        .map(([label, w]) => ({
          window: label,
          usedPercent: roundPct(w?.utilization),
          resetsAt: isoOrNull(w?.resets_at),
        }));
    }

    let spend: SpendStatus | null = null;
    const sp = raw.spend;
    if (sp?.enabled && (minorToCents(sp.used) != null || minorToCents(sp.limit) != null)) {
      spend = {
        label: "Extra usage",
        usedCents: minorToCents(sp.used),
        limitCents: minorToCents(sp.limit),
      };
    }
    return { quota, spend };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Convert an {amount_minor, exponent} money value to cents (exponent 2 = already cents). */
function minorToCents(m: { amount_minor?: number; exponent?: number } | undefined): number | null {
  const minor = numOr(m?.amount_minor);
  if (minor == null) return null;
  const exp = numOr(m?.exponent) ?? 2;
  return Math.round(minor * 10 ** (2 - exp));
}

/** Normalize an ISO-ish timestamp (may carry a +00:00 offset) to a Z-suffixed ISO, or null. */
function isoOrNull(s: string | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

interface CursorSessionAuth {
  token: string;
  userId: string;
}

/**
 * Read Cursor's locally-stored session token from state.vscdb and derive the
 * WorkOS user id from its JWT `sub` claim. Returns null when the DB is
 * unreadable, no token is present, or the token has expired (so we skip a
 * doomed call). The token string is used only to build the request and is
 * never stored on the report.
 */
function readCursorSessionAuth(home: string): CursorSessionAuth | null {
  const vscdb = cursorGlobalVscdb(home);
  if (!vscdb) return null;
  const items = readVscdbItems(vscdb, ["cursorAuth/accessToken"]);
  const token = strOr(items?.["cursorAuth/accessToken"]);
  if (!token) return null;
  const claims = decodeJwtClaims(token);
  const sub = strOr(claims?.sub);
  if (!sub) return null;
  // Skip an obviously-expired token (exp is seconds since epoch).
  const exp = numOr(claims?.exp);
  if (exp != null && exp * 1000 < Date.now()) return null;
  // sub looks like "auth0|user_01J…"; the WorkOS cookie wants the id after the "|".
  const userId = sub.includes("|") ? (sub.split("|").pop() ?? sub) : sub;
  return { token, userId };
}

/**
 * Fetch the current-period usage the Cursor UI shows on its Spending page. Auth
 * is the WorkOS session cookie (`<userId>::<token>`); cursor.com rejects the
 * POST without a matching `Origin`, so we send one. Returns null on any failure.
 */
async function fetchCursorUsage(
  auth: CursorSessionAuth,
  timeoutMs: number,
): Promise<{ usage: CursorUsage; spend: SpendStatus | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${auth.userId}::${auth.token}`)}`;
    const res = await fetch("https://cursor.com/api/dashboard/get-current-period-usage", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: "https://cursor.com",
        Referer: "https://cursor.com/dashboard/spending",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as {
      billingCycleStart?: string | number;
      billingCycleEnd?: string | number;
      planUsage?: {
        totalPercentUsed?: number;
        apiPercentUsed?: number;
        autoPercentUsed?: number;
        limit?: number;
      };
      spendLimitUsage?: { individualLimit?: number; individualRemaining?: number };
    };
    const pu = raw.planUsage ?? {};
    const sl = raw.spendLimitUsage ?? {};
    const spendLimit = numOr(sl.individualLimit);
    const spendRemaining = numOr(sl.individualRemaining);
    const usage: CursorUsage = {
      cycleStart: msToIso(raw.billingCycleStart),
      cycleEnd: msToIso(raw.billingCycleEnd),
      totalPercentUsed: roundPct(pu.totalPercentUsed),
      apiPercentUsed: roundPct(pu.apiPercentUsed),
      firstPartyPercentUsed: roundPct(pu.autoPercentUsed),
      includedLimitCents: numOr(pu.limit),
    };
    const spend: SpendStatus | null =
      spendLimit != null
        ? {
            label: "On-demand",
            usedCents: spendRemaining != null ? spendLimit - spendRemaining : null,
            limitCents: spendLimit,
          }
        : null;
    return { usage, spend };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a ms-epoch value (string or number) to ISO, or null. */
function msToIso(v: string | number | undefined): string | null {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : v;
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

/** Clamp a percentage to one decimal place, or null. */
function roundPct(v: number | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * 10) / 10;
}

async function fetchCursorApi(key: string, timeoutMs: number): Promise<ApiEnrichment> {
  const out: ApiEnrichment = { ok: false, keyName: null, cloudAgents: null, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`https://api.cursor.com${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  };
  try {
    const me = (await get("/v0/me")) as { apiKeyName?: string; userEmail?: string };
    out.ok = true;
    out.keyName = strOr(me.apiKeyName);
    try {
      const data = (await get("/v0/agents")) as { agents?: Array<{ status?: string }> };
      const list = Array.isArray(data.agents) ? data.agents : [];
      out.cloudAgents = {
        total: list.length,
        active: list.filter((a) => a.status && !CURSOR_AGENT_INACTIVE.has(a.status)).length,
      };
    } catch {
      // /v0/me worked but agents listing failed; key is still valid
    }
  } catch (err) {
    out.ok = false;
    out.error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

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
  // 5-hour / weekly figures come from the `/usage` server call, which the
  // enrichment step fetches with the local OAuth token. Without it (--no-api),
  // quota stays blank.
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

  // Usage + billing live on cursor.com, not on disk. The enrichment step fetches
  // them with the IDE's session token; without it (--no-api / non-Bun), the card
  // shows local signals only.
  status.quota = null;
  status.tokensUsed = null;
  status.notes.push("usage + billing come from cursor.com (fetched during the enrichment step)");

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
    api: null,
    usage: null,
    spend: null,
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
