import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type AccountGroup,
  type AppServerOutcome,
  type CliproxyConfig,
  type CliproxyListing,
  cliproxyApiCall,
  cursorGlobalVscdb,
  type DevtoolName,
  discoverStores,
  groupAccounts,
  listCliproxyAuthFiles,
  matchCliproxyEntry,
  numOr,
  readJson,
  readVscdbItems,
  resolveCliproxyConfigs,
  runCodexAppServer,
  type StoreCandidate,
  type StoreKind,
  safeJson,
  strOr,
  tokenUsable,
  withSqlite,
} from "./devtools-accounts.ts";

export type { DevtoolName, StoreKind } from "./devtools-accounts.ts";

/**
 * `devtools`: read the state of the AI coding agents harnery supports —
 * Claude Code, Codex and Cursor — into one uniform status shape: login state,
 * plan/tier, auth expiry, session counts, and quota / rate-limit windows.
 *
 * Every account signed in anywhere on the machine is reported (ADR 0273):
 * `readDevtools` discovers and groups account stores from local files only,
 * and `enrichFromApi` reads each account's live usage from the first source
 * that answers — the stored token, Codex's own `app-server`, a CLI Proxy API
 * server, and finally the last local snapshot. Token strings are never placed
 * on a report, and no token is ever refreshed here.
 *
 * Pure toolkit tier: depends only on `node:*`, never on `src/core/`.
 */

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
 * Cursor billing-cycle + usage snapshot. Percentages are 0-100; cent amounts
 * are raw (divide by 100 for dollars).
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

/** Codex credit balance (credits beyond the plan's windows). */
export interface CodexCredits {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: number | null;
}

/** Which source produced an account's usage figures (ADR 0273 §3). */
export type UsageSource = "direct" | "codex-app-server" | "cliproxy" | "snapshot";

/** One place an account's credential was found (no token). */
export interface AccountStore {
  kind: StoreKind;
  path: string;
  loggedIn: boolean;
  /** ISO expiry of this store's access token, else null. */
  authExpiresAt: string | null;
}

/** One signed-in (or recently signed-in) account and its usage. */
export interface AccountUsage {
  /** Stable grouping key (`<tool>:<account id>` or `<tool>:<email>|<org>`). */
  id: string;
  email: string | null;
  org: string | null;
  plan: string | null;
  rateLimitTier: string | null;
  /** Any of the account's stores holds a live credential. */
  loggedIn: boolean;
  /** ISO expiry of the first live store's access token, else null. */
  authExpiresAt: string | null;
  /** Every store the account was found in, own stores first. */
  stores: AccountStore[];
  /** The source that answered, or null when none has (yet). */
  source: UsageSource | null;
  /** Which store or server answered, e.g. "claude-dir /home/u/.claude_work". */
  sourceDetail: string | null;
  /** Figures are older than a live read: a local snapshot or last-known-good cache. */
  stale: boolean;
  /** ISO time the figures were read, else null. */
  asOf: string | null;
  quota: QuotaWindow[] | null;
  usage: CursorUsage | null;
  spend: SpendStatus | null;
  credits: CodexCredits | null;
  /** Caveats and per-source failures for this account. */
  notes: string[];
}

export interface ToolStatus {
  tool: DevtoolName;
  /** The tool's config directory or an account store exists on this machine. */
  installed: boolean;
  /** Any account holds a live credential. null when undeterminable. */
  loggedIn: boolean | null;
  /** First signed-in account's email, else null. */
  account: string | null;
  /** First signed-in account's plan / seat tier. */
  plan: string | null;
  /** First signed-in account's rate-limit tier, else null. */
  rateLimitTier: string | null;
  /** First signed-in account's access-credential expiry, else null. */
  authExpiresAt: string | null;
  /** Count of local session transcripts, else null. */
  sessions: number | null;
  /** ISO timestamp of the most recent local session activity, else null. */
  lastActivity: string | null;
  /** First signed-in account's quota windows, else null. */
  quota: QuotaWindow[] | null;
  /**
   * Total tokens observed in local transcripts within the scan window
   * (`windowDays`). Codex always reports it — its per-session cumulative total
   * is one tail-read per rollout, cheap enough for every render. Claude Code's
   * is memoized per transcript; `--usage` forces an exact recount. Cursor keeps
   * token counts server-side, so it stays null.
   */
  tokensUsed: number | null;
  /** Cursor Cloud Agent API enrichment (needs an API key), else null. */
  api: ApiEnrichment | null;
  /** First signed-in account's Cursor billing-cycle usage, else null. */
  usage: CursorUsage | null;
  /** First signed-in account's overage spend, else null. */
  spend: SpendStatus | null;
  /** Every account found for this tool, signed-in first. */
  accounts: AccountUsage[];
  /** Tool-level caveats (per-account caveats live on each account). */
  notes: string[];
}

export interface DevtoolsReport {
  generatedAt: string;
  windowDays: number | null;
  tools: ToolStatus[];
}

/** One source's health, from `probeEndpoints` (the `devtools doctor` check). */
export interface ProbeResult {
  tool: DevtoolName;
  source: "direct" | "codex-app-server" | "cliproxy";
  endpoint: string;
  /** Client version we put in the request's User-Agent, else null. */
  clientVersion: string | null;
  /** HTTP status, or null when no call was made / the request threw. */
  status: number | null;
  outcome:
    | "ok" // 200 with the expected shape
    | "rate_limited" // 429 — back off, not a defect
    | "auth_rejected" // 401/403 — our auth or required headers may have changed
    | "shape_changed" // 200 but the expected fields are gone
    | "unreachable" // network error / other non-2xx
    | "no_credential"; // nothing to authenticate with locally
  detail: string;
}

export interface ReadDevtoolsOpts {
  /** Home directory to resolve tool config against. Defaults to os.homedir(). */
  home?: string;
  /** Force an exact, cache-bypassing Claude transcript recount. Default false. */
  usage?: boolean;
  /** Token totals only include transcripts modified within N days. Default 7. */
  windowDays?: number;
  /** Clock injection for tests. Default Date.now(). */
  now?: number;
  /** Restrict to a subset of tools. Default all three. */
  only?: readonly DevtoolName[];
}

const ALL_TOOLS: readonly DevtoolName[] = ["claude-code", "codex", "cursor"];

// ---------------------------------------------------------------------------
// Cursor API key (Cloud Agents)
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

// So our requests blend in with the tool's own traffic rather than looking like
// a scraper (a bare fetch would carry a "Bun/…" or "node" User-Agent, which is
// the anomaly). We send the same first-party client identity the tool sends for
// the same call — the user's own machine reaching the user's own account.

/** Last-resort Claude Code version when no live source is readable. */
const CLAUDE_CLI_FALLBACK_VERSION = "2.1.0";

/**
 * The Claude Code version actually running, most-authoritative source first:
 *   1. the `version` field the running client stamps into its newest session
 *      transcript (reflects auto-updates immediately),
 *   2. the updater's last-result marker,
 *   3. a constant.
 */
function claudeCodeVersion(dirs: string[]): string {
  const newest = newestFile(dirs.flatMap((d) => listFilesRecursive(join(d, "projects"), ".jsonl")));
  if (newest) {
    // The version rides every event, so the head of the file is plenty.
    for (const line of readHead(newest, 65_536).split("\n")) {
      if (!line.trim()) continue;
      try {
        const v = strOr((JSON.parse(line) as { version?: unknown }).version);
        if (v) return v;
      } catch {
        // partial line at the buffer edge — skip
      }
    }
  }
  for (const d of dirs) {
    const marker = readJson<{ version_to?: string }>(join(d, ".last-update-result.json"));
    const v = strOr(marker?.version_to);
    if (v) return v;
  }
  return CLAUDE_CLI_FALLBACK_VERSION;
}

/** Read up to `maxBytes` from the start of a file as UTF-8, "" on any error. */
function readHead(path: string, maxBytes: number): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = readSync(fd, buf, 0, maxBytes, 0);
      return buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Read up to the last `maxBytes` of a file (for a bounded tail scan). */
function readTail(path: string, maxBytes: number): string {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, start);
      return buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Usage fetch plumbing
// ---------------------------------------------------------------------------

/**
 * Outcome of a usage fetch. `cooldown` (a 429) tells the cache to back off for
 * `retryAfterMs` so a rate limit can never cascade into repeated hits — the
 * failure mode that starves the tool's own client.
 */
type FetchOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "cooldown"; retryAfterMs: number }
  | { kind: "fail"; reason: string };

/** Usage figures one source returns (cached as-is). */
interface UsageData {
  quota?: QuotaWindow[] | null;
  spend?: SpendStatus | null;
  usage?: CursorUsage | null;
  plan?: string | null;
  credits?: CodexCredits | null;
  notes?: string[];
}

/** Short, non-reversible fingerprint of a token, for per-account cache keys. */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** GET/POST returning parsed JSON as a FetchOutcome (429 → cooldown). */
async function httpJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchOutcome<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (res.status === 429) return { kind: "cooldown", retryAfterMs: retryAfterMs(res) };
    if (!res.ok) return { kind: "fail", reason: `HTTP ${res.status}` };
    try {
      return { kind: "ok", data: await res.json() };
    } catch {
      return { kind: "fail", reason: "response was not JSON" };
    }
  } catch (err) {
    return { kind: "fail", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Map a raw outcome through a parser; a null parse is a shape change. */
async function parsed<T>(
  raw: Promise<FetchOutcome<unknown>>,
  parse: (json: unknown) => T | null,
): Promise<FetchOutcome<T>> {
  const o = await raw;
  if (o.kind !== "ok") return o;
  const data = parse(o.data);
  return data ? { kind: "ok", data } : { kind: "fail", reason: "unexpected response shape" };
}

/** Make a vendor request through CLI Proxy's management `api-call`. */
async function viaCliproxy(
  listing: Extract<CliproxyListing, { ok: true }>,
  cfg: CliproxyConfig,
  authIndex: string,
  req: { method: string; url: string; header: Record<string, string> },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<FetchOutcome<unknown>> {
  const r = await cliproxyApiCall(listing.baseUrl, cfg.key, authIndex, req, fetchImpl, timeoutMs);
  if (!r.ok) return { kind: "fail", reason: r.reason };
  const sc = r.result.statusCode;
  if (sc === 429) return { kind: "cooldown", retryAfterMs: r.result.retryAfterMs ?? 60_000 };
  if (sc < 200 || sc >= 300) return { kind: "fail", reason: `vendor HTTP ${sc} via CLI Proxy` };
  return { kind: "ok", data: r.result.body };
}

interface CacheRead<T> {
  data: T | null;
  /** Fresh within the TTL or just fetched. */
  live: boolean;
  /** When `data` was fetched (ms epoch), else null. */
  at: number | null;
  /** Why no live data, when not live. */
  reason: string | null;
}

interface UsageCacheEntry<T> {
  /** When `data` was last fetched (ms epoch). */
  at: number;
  /** Last-known-good result, or null if a fetch never succeeded. */
  data: T | null;
  /** If set and still in the future, do not call the endpoint (rate-limit backoff). */
  cooldownUntil?: number;
}

/**
 * Wrap a usage fetch in an on-disk cache under `<home>/.cache/harnery/devtools/
 * <name>.json`, protecting rate-limited endpoints on three fronts:
 *
 *   • Fresh success (`< ttlMs` old) short-circuits the network entirely.
 *   • A 429 records a `cooldownUntil` from the server's retry-after, and no call
 *     is made until it passes — so a rate limit can't cascade into a hammer loop.
 *   • Any other failure keeps the last-known-good value for the caller to fall
 *     back on (marked not live), and retries next time.
 *
 * Best-effort: read/write errors fall back to a live fetch. `ttlMs <= 0` fetches
 * every call (still honoring a cooldown) and skips writes.
 */
async function cachedUsage<T>(
  home: string,
  name: string,
  ttlMs: number,
  fetcher: () => Promise<FetchOutcome<T>>,
): Promise<CacheRead<T>> {
  const now = Date.now();
  const dir = join(home, ".cache", "harnery", "devtools");
  const file = join(dir, `${name}.json`);

  let entry: UsageCacheEntry<T> | null = null;
  try {
    entry = JSON.parse(readFileSync(file, "utf8")) as UsageCacheEntry<T>;
  } catch {
    // no cache / unreadable
  }
  const stale = (reason: string): CacheRead<T> => ({
    data: entry?.data ?? null,
    live: false,
    at: entry?.data != null ? entry.at : null,
    reason,
  });
  if (entry?.data != null && ttlMs > 0 && now - entry.at < ttlMs) {
    return { data: entry.data, live: true, at: entry.at, reason: null };
  }
  if (entry?.cooldownUntil != null && now < entry.cooldownUntil) {
    return stale(`rate-limited; retry in ${Math.ceil((entry.cooldownUntil - now) / 1000)}s`);
  }

  const outcome = await fetcher();
  const write = (e: UsageCacheEntry<T>) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(e));
    } catch {
      // cache write is best-effort
    }
  };

  if (outcome.kind === "ok") {
    if (ttlMs > 0) write({ at: now, data: outcome.data });
    return { data: outcome.data, live: true, at: now, reason: null };
  }
  if (outcome.kind === "cooldown") {
    write({
      at: entry?.at ?? now,
      data: entry?.data ?? null,
      cooldownUntil: now + outcome.retryAfterMs,
    });
    return stale(`rate-limited (429); retry in ${Math.round(outcome.retryAfterMs / 1000)}s`);
  }
  return stale(outcome.reason);
}

/** Parse a `Retry-After` header (seconds) to ms; default 60s when absent/unparseable. */
function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  const secs = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
  return (Number.isFinite(secs) && secs > 0 ? secs : 60) * 1000;
}

// ---------------------------------------------------------------------------
// Claude Code usage endpoint
// ---------------------------------------------------------------------------

/** Statuses in the oauth/usage `limits[]` array, mapped to quota-window labels. */
const CLAUDE_LIMIT_LABELS: Record<string, string> = {
  session: "5h",
  weekly_all: "weekly",
  weekly_scoped: "weekly",
};

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Headers the `/usage` command sends (token substituted by the caller or the proxy). */
function claudeUsageHeaders(bearer: string, version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": "2023-06-01",
    "User-Agent": `claude-cli/${version} (external, cli)`,
    "x-app": "cli",
  };
}

type FlatWindow = { utilization?: number; resets_at?: string } | null | undefined;

/** Parse an oauth/usage body into quota windows + extra-usage spend; null on a foreign shape. */
function parseClaudeUsage(json: unknown): UsageData | null {
  const raw = json as {
    limits?: Array<{
      kind?: string;
      percent?: number;
      resets_at?: string;
      scope?: { model?: { display_name?: string } } | null;
    }>;
    five_hour?: FlatWindow;
    seven_day?: FlatWindow;
    seven_day_opus?: FlatWindow;
    seven_day_sonnet?: FlatWindow;
    spend?: {
      used?: { amount_minor?: number; exponent?: number };
      limit?: { amount_minor?: number; exponent?: number };
      enabled?: boolean;
    };
  } | null;
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.limits) && raw.five_hour == null && raw.seven_day == null) return null;

  // Prefer the structured limits[] array (carries model-scoped windows); fall
  // back to the flat five_hour / seven_day pair plus any named weekly windows.
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
    const flat: Array<[string, FlatWindow]> = [
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
  const named: Array<[string, FlatWindow]> = [
    ["Opus", raw.seven_day_opus],
    ["Sonnet", raw.seven_day_sonnet],
  ];
  for (const [model, w] of named) {
    if (w?.utilization == null) continue;
    if (quota.some((q) => q.window.includes(model))) continue;
    quota.push({
      window: `weekly · ${model}`,
      usedPercent: roundPct(w.utilization),
      resetsAt: isoOrNull(w.resets_at),
    });
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

// ---------------------------------------------------------------------------
// Codex usage
// ---------------------------------------------------------------------------

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function codexUsageHeaders(bearer: string, accountId: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "User-Agent": "codex_cli_rs",
    originator: "codex_cli_rs",
  };
  if (accountId) h["ChatGPT-Account-Id"] = accountId;
  return h;
}

/** Parse `wham/usage` into quota windows, plan and credits; null on a foreign shape. */
function parseCodexUsage(json: unknown): UsageData | null {
  type Win = { used_percent?: number; limit_window_seconds?: number; reset_at?: number } | null;
  const raw = json as {
    plan_type?: string;
    rate_limit?: { primary_window?: Win; secondary_window?: Win } | null;
    credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | number } | null;
    rate_limit_reached_type?: string | null;
  } | null;
  if (!raw || typeof raw !== "object" || !("rate_limit" in raw)) return null;
  const win = (w: Win | undefined): QuotaWindow | null => {
    if (!w) return null;
    const secs = numOr(w.limit_window_seconds);
    const reset = numOr(w.reset_at);
    return {
      window: windowLabel(secs != null ? Math.round(secs / 60) : null),
      usedPercent: roundPct(w.used_percent),
      resetsAt: reset ? new Date(reset * 1000).toISOString() : null,
    };
  };
  const quota = [win(raw.rate_limit?.primary_window), win(raw.rate_limit?.secondary_window)].filter(
    (q): q is QuotaWindow => q !== null,
  );
  const reached = strOr(raw.rate_limit_reached_type);
  return {
    quota,
    plan: strOr(raw.plan_type),
    credits: raw.credits
      ? {
          hasCredits: typeof raw.credits.has_credits === "boolean" ? raw.credits.has_credits : null,
          unlimited: typeof raw.credits.unlimited === "boolean" ? raw.credits.unlimited : null,
          balance: toNum(raw.credits.balance),
        }
      : null,
    notes: reached ? [`rate limit reached (${reached} window)`] : [],
  };
}

/** Parse the `account/rateLimits/read` result of `codex app-server`. */
function parseAppServerLimits(json: unknown): UsageData | null {
  type Win = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null;
  const rl = (json as { rateLimits?: Record<string, unknown> } | null)?.rateLimits as
    | {
        primary?: Win;
        secondary?: Win;
        planType?: string;
        credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | number } | null;
        rateLimitReachedType?: string | null;
      }
    | undefined;
  if (!rl) return null;
  const win = (w: Win | undefined): QuotaWindow | null => {
    if (!w) return null;
    const reset = numOr(w.resetsAt);
    return {
      window: windowLabel(numOr(w.windowDurationMins)),
      usedPercent: roundPct(w.usedPercent),
      resetsAt: reset ? new Date(reset * 1000).toISOString() : null,
    };
  };
  const reached = strOr(rl.rateLimitReachedType);
  return {
    quota: [win(rl.primary), win(rl.secondary)].filter((q): q is QuotaWindow => q !== null),
    plan: strOr(rl.planType),
    credits: rl.credits
      ? {
          hasCredits: typeof rl.credits.hasCredits === "boolean" ? rl.credits.hasCredits : null,
          unlimited: typeof rl.credits.unlimited === "boolean" ? rl.credits.unlimited : null,
          balance: toNum(rl.credits.balance),
        }
      : null,
    notes: reached ? [`rate limit reached (${reached} window)`] : [],
  };
}

// ---------------------------------------------------------------------------
// Cursor usage
// ---------------------------------------------------------------------------

// Cursor is an Electron app; its embedded browser presents a VS Code-style UA.
// The Chromium/Electron pair is cosmetic (tracks Cursor's VS Code base); the
// identifying `Cursor/<version>` part is the live local version.
const CURSOR_CHROMIUM = "132.0.6834.210";
const CURSOR_ELECTRON = "34.5.8";

/** Cursor Electron client User-Agent, embedding the live app version. */
function cursorUserAgent(version: string | null): string {
  const ver = version ?? "0.0.0";
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/${ver} Chrome/${CURSOR_CHROMIUM} Electron/${CURSOR_ELECTRON} Safari/537.36`;
}

/** Cursor's API usage route (bearer token; the IDE's opaque token and the CLI JWT both work). */
const CURSOR_API_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
/** cursor.com's dashboard route (session cookie). Kept as the secondary path. */
const CURSOR_USAGE_URL = "https://cursor.com/api/dashboard/get-current-period-usage";

function cursorApiRequest(token: string, version: string | null): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "User-Agent": cursorUserAgent(version),
    },
    body: "{}",
  };
}

/**
 * The cursor.com request: the WorkOS session cookie (`<userId>::<token>`) plus
 * the browser-consistent Origin/Referer cursor.com requires.
 */
function cursorCookieRequest(userId: string, token: string, version: string | null): RequestInit {
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`;
  return {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: "https://cursor.com",
      Referer: "https://cursor.com/dashboard/spending",
      "User-Agent": cursorUserAgent(version),
    },
    body: "{}",
  };
}

/** Parse the current-period usage body (same shape on both routes). */
function parseCursorUsage(json: unknown): UsageData | null {
  const raw = json as {
    billingCycleStart?: string | number;
    billingCycleEnd?: string | number;
    planUsage?: {
      totalPercentUsed?: number;
      apiPercentUsed?: number;
      autoPercentUsed?: number;
      limit?: number;
    };
    spendLimitUsage?: { individualLimit?: number; individualRemaining?: number };
  } | null;
  if (!raw || typeof raw !== "object") return null;
  if (raw.planUsage == null && raw.billingCycleEnd == null) return null;
  const pu = raw.planUsage ?? {};
  const sl = raw.spendLimitUsage ?? {};
  const spendLimit = numOr(sl.individualLimit);
  const spendRemaining = numOr(sl.individualRemaining);
  return {
    usage: {
      cycleStart: msToIso(raw.billingCycleStart),
      cycleEnd: msToIso(raw.billingCycleEnd),
      totalPercentUsed: roundPct(pu.totalPercentUsed),
      apiPercentUsed: roundPct(pu.apiPercentUsed),
      firstPartyPercentUsed: roundPct(pu.autoPercentUsed),
      includedLimitCents: numOr(pu.limit),
    },
    spend:
      spendLimit != null
        ? {
            label: "On-demand",
            usedCents: spendRemaining != null ? spendLimit - spendRemaining : null,
            limitCents: spendLimit,
          }
        : null,
  };
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

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function fetchCursorApi(
  key: string,
  userAgent: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ApiEnrichment> {
  const out: ApiEnrichment = { ok: false, keyName: null, cloudAgents: null, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(`https://api.cursor.com${path}`, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": userAgent },
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

// ---------------------------------------------------------------------------
// Network enrichment: the per-account source chain (ADR 0273 §3)
// ---------------------------------------------------------------------------

export interface EnrichOpts {
  /** Cursor API key for the Cloud Agent enrichment; undefined resolves it, null skips. */
  cursorKey?: string | null;
  timeoutMs?: number;
  home?: string;
  /** Cache TTL for the usage endpoints (ms). 0 disables caching. Default 5 min. */
  cacheTtlMs?: number;
  /** fetch implementation (tests). Defaults to the global fetch at call time. */
  fetch?: typeof fetch;
  /**
   * Codex app-server runner. Defaults to launching `codex app-server` for the
   * real home only, so a synthetic test home never starts a process. null skips.
   */
  codexAppServer?: ((codexHome: string) => Promise<AppServerOutcome>) | null;
  /** CLI Proxy settings; undefined resolves them (env, file, app settings), null skips. */
  cliproxy?: CliproxyConfig[] | null;
}

interface ChainContext {
  home: string;
  timeoutMs: number;
  ttl: number;
  fetchImpl: typeof fetch;
  appServer: ((codexHome: string) => Promise<AppServerOutcome>) | null;
  proxies: CliproxyConfig[];
  listings: () => Promise<Array<{ cfg: CliproxyConfig; listing: CliproxyListing }>>;
  claudeVersion: () => string;
}

/**
 * Enrich a report with each account's live usage, trying the sources in order
 * and stopping at the first that answers: the account's stored tokens (own
 * stores first, then CLI Proxy files; expired tokens skipped), Codex's own
 * `app-server`, CLI Proxy's management `api-call`, and finally the local
 * snapshot or last-known-good cache. Every failure degrades to a note, never
 * throws. Tokens are never refreshed and never placed on the report.
 */
export async function enrichFromApi(
  report: DevtoolsReport,
  opts: EnrichOpts = {},
): Promise<DevtoolsReport> {
  const home = opts.home ?? homedir();
  const includeHost = home === homedir();
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const tools = report.tools.filter((t) => t.installed).map((t) => t.tool);
  if (!tools.length) return report;

  const stores = discoverStores({ home, includeHost, only: tools });
  const groups = new Map(groupAccounts(stores).map((g) => [g.identity.key, g]));
  const proxies =
    opts.cliproxy === undefined
      ? resolveCliproxyConfigs({ home, includeHost })
      : (opts.cliproxy ?? []);
  let listingsP: Promise<Array<{ cfg: CliproxyConfig; listing: CliproxyListing }>> | null = null;
  let claudeVer: string | null = null;
  const ctx: ChainContext = {
    home,
    timeoutMs,
    ttl: opts.cacheTtlMs ?? 300_000,
    fetchImpl: fetchImpl as typeof fetch,
    appServer:
      opts.codexAppServer !== undefined
        ? opts.codexAppServer
        : includeHost
          ? (codexHome) => runCodexAppServer(codexHome)
          : null,
    proxies,
    listings: () => {
      listingsP ??= Promise.all(
        proxies.map(async (cfg) => ({
          cfg,
          listing: await listCliproxyAuthFiles(
            cfg,
            fetchImpl as typeof fetch,
            Math.min(timeoutMs, 4_000),
          ),
        })),
      );
      return listingsP;
    },
    claudeVersion: () => {
      claudeVer ??= claudeCodeVersion(
        stores
          .filter((s) => s.storeKind === "claude-dir" && !onWindowsMount(s.path))
          .map((s) => s.path),
      );
      return claudeVer;
    },
  };

  const jobs: Promise<void>[] = [];
  for (const t of report.tools) {
    if (!t.installed) continue;
    for (const acct of t.accounts) {
      const g = groups.get(acct.id);
      if (g) jobs.push(resolveAccountUsage(t.tool, acct, g, ctx));
    }
  }
  await Promise.all(jobs);

  for (const t of report.tools) {
    if (!t.installed) continue;
    rollUp(t);
    const primary = primaryAccount(t);
    if (t.tool === "claude-code" && primary) {
      if (primary.quota != null) {
        // Drop the pure-local "quota is server-side" caveat now that it's filled.
        t.notes = t.notes.filter((n) => !n.includes("server-side via /usage"));
      } else if (primary.stores.some((s) => s.loggedIn)) {
        t.notes.push("live usage unavailable (rate-limited or token stale; retries shortly)");
      }
    }
    if (t.tool === "codex" && primary?.quota?.length) {
      t.notes = t.notes.filter((n) => !n.startsWith("no local rate-limit snapshot"));
    }
    if (t.tool === "cursor" && primary && primary.usage == null) {
      t.notes.push("Cursor usage unavailable (no usable token answered; sign in to Cursor again)");
    }
  }

  // Cursor Cloud Agent activity from a configured API key (optional, separate auth).
  const cursor = report.tools.find((t) => t.tool === "cursor");
  if (cursor?.installed) {
    const key = opts.cursorKey !== undefined ? opts.cursorKey : resolveCursorApiKey();
    if (key) {
      const version = stores.find((s) => s.tool === "cursor" && s.clientVersion)?.clientVersion;
      cursor.api = await fetchCursorApi(
        key,
        cursorUserAgent(version ?? null),
        timeoutMs,
        fetchImpl as typeof fetch,
      );
      if (!cursor.api.ok) {
        cursor.notes.unshift(`API key configured but not usable: ${cursor.api.error ?? "unknown"}`);
      }
    }
  }
  return report;
}

/** True when a path sits on the Windows side of a WSL machine. */
function onWindowsMount(p: string): boolean {
  return /^\/mnt\/[a-z]\//.test(p);
}

async function resolveAccountUsage(
  tool: DevtoolName,
  acct: AccountUsage,
  group: AccountGroup,
  ctx: ChainContext,
): Promise<void> {
  const now = Date.now();
  const attempts: string[] = [];
  let fallback: { data: UsageData; source: UsageSource; detail: string; at: number } | null = null;

  const tryOne = async (
    source: UsageSource,
    detail: string,
    cacheName: string,
    fetcher: () => Promise<FetchOutcome<UsageData>>,
  ): Promise<boolean> => {
    const r = await cachedUsage(ctx.home, cacheName, ctx.ttl, fetcher);
    if (r.live && r.data) {
      applyUsage(acct, r.data, source, detail, r.at ?? now, false);
      return true;
    }
    if (r.data && r.at != null && (!fallback || r.at > fallback.at)) {
      fallback = { data: r.data, source, detail, at: r.at };
    }
    attempts.push(`${source} (${detail}): ${r.reason ?? "no data"}`);
    return false;
  };
  const done = () => {
    if (attempts.length) acct.notes.push(...attempts);
  };

  // 1. Direct, with each stored token that has not expired.
  for (const s of group.stores) {
    if (!s.accessToken) continue;
    const label = storeLabel(s);
    if (!tokenUsable(s, now)) {
      attempts.push(`direct (${label}): token expired, skipped`);
      continue;
    }
    const token = s.accessToken;
    const fp = tokenFingerprint(token);
    let ok = false;
    if (tool === "claude-code") {
      ok = await tryOne("direct", label, `claude-usage-${fp}`, () =>
        parsed(
          httpJson(
            ctx.fetchImpl,
            CLAUDE_USAGE_URL,
            { headers: claudeUsageHeaders(token, ctx.claudeVersion()) },
            ctx.timeoutMs,
          ),
          parseClaudeUsage,
        ),
      );
    } else if (tool === "codex") {
      ok = await tryOne("direct", label, `codex-usage-${fp}`, () =>
        parsed(
          httpJson(
            ctx.fetchImpl,
            CODEX_USAGE_URL,
            { headers: codexUsageHeaders(token, group.identity.accountId) },
            ctx.timeoutMs,
          ),
          parseCodexUsage,
        ),
      );
    } else {
      ok = await tryOne("direct", label, `cursor-api-usage-${fp}`, () =>
        parsed(
          httpJson(
            ctx.fetchImpl,
            CURSOR_API_USAGE_URL,
            cursorApiRequest(token, s.clientVersion),
            ctx.timeoutMs,
          ),
          parseCursorUsage,
        ),
      );
    }
    if (ok) return done();
  }

  // Cursor's secondary direct route: the cursor.com session cookie.
  if (tool === "cursor" && group.identity.accountId) {
    const userId = group.identity.accountId;
    for (const s of group.stores) {
      if (!s.accessToken || !tokenUsable(s, now)) continue;
      const token = s.accessToken;
      const ok = await tryOne(
        "direct",
        `${storeLabel(s)}, cursor.com cookie`,
        `cursor-usage-${tokenFingerprint(token)}`,
        () =>
          parsed(
            httpJson(
              ctx.fetchImpl,
              CURSOR_USAGE_URL,
              cursorCookieRequest(userId, token, s.clientVersion),
              ctx.timeoutMs,
            ),
            parseCursorUsage,
          ),
      );
      if (ok) return done();
    }
  }

  // 2. Codex's own usage command, with CODEX_HOME set to the account's store.
  // Only stores on this side of a WSL machine: a Linux Codex must not rewrite a
  // Windows-side store.
  if (tool === "codex" && ctx.appServer) {
    const run = ctx.appServer;
    for (const s of group.stores) {
      if (s.storeKind !== "codex-home" || onWindowsMount(s.path)) continue;
      const ok = await tryOne(
        "codex-app-server",
        s.path,
        `codex-app-server-${tokenFingerprint(resolve(s.path))}`,
        async () => {
          const o = await run(s.path);
          if (!o.ok) return { kind: "fail", reason: o.reason };
          const data = parseAppServerLimits(o.result);
          return data ? { kind: "ok", data } : { kind: "fail", reason: "unexpected result shape" };
        },
      );
      if (ok) return done();
    }
  }

  // 3. CLI Proxy management api-call.
  if (tool !== "cursor") {
    if (!ctx.proxies.length) attempts.push("cliproxy: not configured");
    for (const { cfg, listing } of await ctx.listings()) {
      if (!listing.ok) {
        attempts.push(`cliproxy: ${listing.reason}`);
        continue;
      }
      const entry = matchCliproxyEntry(group, listing.files);
      if (!entry) {
        attempts.push(`cliproxy (${listing.baseUrl}): account not proxied`);
        continue;
      }
      const req =
        tool === "claude-code"
          ? {
              method: "GET",
              url: CLAUDE_USAGE_URL,
              header: claudeUsageHeaders("$TOKEN$", ctx.claudeVersion()),
            }
          : {
              method: "GET",
              url: CODEX_USAGE_URL,
              header: codexUsageHeaders("$TOKEN$", entry.accountId ?? group.identity.accountId),
            };
      const ok = await tryOne(
        "cliproxy",
        listing.baseUrl,
        `cliproxy-${tool}-${entry.authIndex}`,
        () =>
          parsed(
            viaCliproxy(listing, cfg, entry.authIndex, req, ctx.fetchImpl, ctx.timeoutMs),
            tool === "claude-code" ? parseClaudeUsage : parseCodexUsage,
          ),
      );
      if (ok) return done();
    }
  }

  // 4. Last known figures: the newer of a cached answer and the local snapshot.
  const fb = fallback as {
    data: UsageData;
    source: UsageSource;
    detail: string;
    at: number;
  } | null;
  const snapAt = acct.source === "snapshot" && acct.asOf ? Date.parse(acct.asOf) : null;
  if (fb && (snapAt == null || fb.at > snapAt)) {
    applyUsage(acct, fb.data, fb.source, fb.detail, fb.at, true);
  }
  done();
}

function storeLabel(s: StoreCandidate): string {
  return `${s.storeKind} ${s.path}`;
}

function applyUsage(
  acct: AccountUsage,
  data: UsageData,
  source: UsageSource,
  detail: string,
  at: number,
  stale: boolean,
): void {
  if (data.quota !== undefined) acct.quota = data.quota;
  if (data.usage !== undefined) acct.usage = data.usage;
  if (data.spend !== undefined) acct.spend = data.spend;
  if (data.credits !== undefined) acct.credits = data.credits;
  if (data.plan) acct.plan = data.plan; // live plan wins over the stored one
  // Replace snapshot-derived throttle notes with the live source's.
  acct.notes = acct.notes.filter((n) => !n.startsWith("rate limit reached"));
  if (data.notes?.length) acct.notes.push(...data.notes);
  acct.source = source;
  acct.sourceDetail = detail;
  acct.stale = stale;
  acct.asOf = new Date(at).toISOString();
}

/** The account the tool-level fields describe: first signed-in, else first. */
function primaryAccount(t: ToolStatus): AccountUsage | null {
  return t.accounts.find((a) => a.loggedIn) ?? t.accounts[0] ?? null;
}

/** Copy the primary account's fields onto the tool-level status. */
function rollUp(t: ToolStatus): void {
  const p = primaryAccount(t);
  if (!p) return;
  t.loggedIn = t.accounts.some((a) => a.loggedIn);
  t.account = p.email;
  t.plan = p.plan;
  t.rateLimitTier = p.rateLimitTier;
  t.authExpiresAt = p.authExpiresAt;
  t.quota = p.quota;
  t.usage = p.usage;
  t.spend = p.spend;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export interface ProbeOpts {
  home?: string;
  timeoutMs?: number;
  only?: readonly DevtoolName[];
  fetch?: typeof fetch;
  codexAppServer?: ((codexHome: string) => Promise<AppServerOutcome>) | null;
  cliproxy?: CliproxyConfig[] | null;
}

/**
 * Probe each usage source once per tool (cache-bypassing) to check the
 * integrations still work: the direct vendor endpoint with the first usable
 * stored token, Codex's `app-server`, and the CLI Proxy management API. It
 * exercises the same request builders production uses, so `auth_rejected`
 * means our headers/token stopped being accepted and `shape_changed` means the
 * response schema drifted. Run it by hand; it is not scheduled.
 */
export async function probeEndpoints(opts: ProbeOpts = {}): Promise<ProbeResult[]> {
  const home = opts.home ?? homedir();
  const includeHost = home === homedir();
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const fetchImpl = (opts.fetch ??
    ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))) as typeof fetch;
  const only = ALL_TOOLS.filter((t) => (opts.only ?? ALL_TOOLS).includes(t));
  const stores = discoverStores({ home, includeHost, only });
  const now = Date.now();
  const out: ProbeResult[] = [];
  const claudeVersion = claudeCodeVersion(
    stores
      .filter((s) => s.storeKind === "claude-dir" && !onWindowsMount(s.path))
      .map((s) => s.path),
  );
  const proxies =
    opts.cliproxy === undefined
      ? resolveCliproxyConfigs({ home, includeHost })
      : (opts.cliproxy ?? []);
  const appServer =
    opts.codexAppServer !== undefined
      ? opts.codexAppServer
      : includeHost
        ? (h: string) => runCodexAppServer(h)
        : null;

  for (const tool of only) {
    // Own stores first, then CLI Proxy files.
    const usable = [
      ...stores.filter((s) => s.tool === tool && s.storeKind !== "cliproxy-file"),
      ...stores.filter((s) => s.tool === tool && s.storeKind === "cliproxy-file"),
    ].find((s) => tokenUsable(s, now));

    // direct
    if (tool === "claude-code") {
      out.push(
        usable?.accessToken
          ? await probeOne(
              tool,
              "direct",
              CLAUDE_USAGE_URL,
              { headers: claudeUsageHeaders(usable.accessToken, claudeVersion) },
              claudeVersion,
              timeoutMs,
              fetchImpl,
              (j) => parseClaudeUsage(j) != null,
            )
          : noCred(
              tool,
              "direct",
              CLAUDE_USAGE_URL,
              claudeVersion,
              "no unexpired OAuth token found",
            ),
      );
    } else if (tool === "codex") {
      out.push(
        usable?.accessToken
          ? await probeOne(
              tool,
              "direct",
              CODEX_USAGE_URL,
              { headers: codexUsageHeaders(usable.accessToken, usable.identity.accountId) },
              null,
              timeoutMs,
              fetchImpl,
              (j) => parseCodexUsage(j) != null,
            )
          : noCred(tool, "direct", CODEX_USAGE_URL, null, "no unexpired Codex token found"),
      );
    } else {
      out.push(
        usable?.accessToken
          ? await probeOne(
              tool,
              "direct",
              CURSOR_API_USAGE_URL,
              cursorApiRequest(usable.accessToken, usable.clientVersion),
              usable.clientVersion,
              timeoutMs,
              fetchImpl,
              (j) => parseCursorUsage(j) != null,
            )
          : noCred(tool, "direct", CURSOR_API_USAGE_URL, null, "no unexpired Cursor token found"),
      );
    }

    // codex app-server
    if (tool === "codex") {
      const store = stores.find(
        (s) => s.tool === "codex" && s.storeKind === "codex-home" && !onWindowsMount(s.path),
      );
      const endpoint = "codex app-server · account/rateLimits/read";
      if (!store) out.push(noCred(tool, "codex-app-server", endpoint, null, "no Codex home found"));
      else if (!appServer)
        out.push(noCred(tool, "codex-app-server", endpoint, null, "app-server disabled"));
      else {
        const o = await appServer(store.path);
        out.push({
          tool,
          source: "codex-app-server",
          endpoint,
          clientVersion: null,
          status: null,
          outcome: !o.ok ? "unreachable" : parseAppServerLimits(o.result) ? "ok" : "shape_changed",
          detail: !o.ok ? o.reason : `answered for ${store.path}`,
        });
      }
    }

    // CLI Proxy
    if (tool !== "cursor") {
      const endpoint = "CLI Proxy /v0/management/api-call";
      if (!proxies.length) {
        out.push(noCred(tool, "cliproxy", endpoint, null, "no CLI Proxy server configured"));
        continue;
      }
      const cfg = proxies[0] as CliproxyConfig;
      const listing = await listCliproxyAuthFiles(cfg, fetchImpl, Math.min(timeoutMs, 4_000));
      if (!listing.ok) {
        out.push({
          tool,
          source: "cliproxy",
          endpoint,
          clientVersion: null,
          status: listing.status,
          outcome:
            listing.status === 401 || listing.status === 403 ? "auth_rejected" : "unreachable",
          detail: listing.reason,
        });
        continue;
      }
      const type = tool === "claude-code" ? "claude" : "codex";
      const entry = listing.files.find((f) => f.type === type && !f.disabled);
      if (!entry) {
        out.push(
          noCred(tool, "cliproxy", listing.baseUrl, null, `no ${type} account in CLI Proxy`),
        );
        continue;
      }
      const req =
        tool === "claude-code"
          ? {
              method: "GET",
              url: CLAUDE_USAGE_URL,
              header: claudeUsageHeaders("$TOKEN$", claudeVersion),
            }
          : {
              method: "GET",
              url: CODEX_USAGE_URL,
              header: codexUsageHeaders("$TOKEN$", entry.accountId),
            };
      const r = await viaCliproxy(listing, cfg, entry.authIndex, req, fetchImpl, timeoutMs);
      const shapeOk = tool === "claude-code" ? parseClaudeUsage : parseCodexUsage;
      out.push({
        tool,
        source: "cliproxy",
        endpoint: `${listing.baseUrl}/v0/management/api-call → ${req.url}`,
        clientVersion: null,
        status: r.kind === "ok" ? 200 : r.kind === "cooldown" ? 429 : null,
        outcome:
          r.kind === "cooldown"
            ? "rate_limited"
            : r.kind === "fail"
              ? /HTTP 40[13]/.test(r.reason)
                ? "auth_rejected"
                : "unreachable"
              : shapeOk(r.data)
                ? "ok"
                : "shape_changed",
        detail: r.kind === "fail" ? r.reason : r.kind === "cooldown" ? "429" : "200 via CLI Proxy",
      });
    }
  }
  return out;
}

function noCred(
  tool: DevtoolName,
  source: ProbeResult["source"],
  endpoint: string,
  clientVersion: string | null,
  detail: string,
): ProbeResult {
  return { tool, source, endpoint, clientVersion, status: null, outcome: "no_credential", detail };
}

async function probeOne(
  tool: DevtoolName,
  source: ProbeResult["source"],
  url: string,
  init: RequestInit,
  clientVersion: string | null,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  shapeOk: (json: unknown) => boolean,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const base = { tool, source, endpoint: url, clientVersion };
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const status = res.status;
    if (status === 429) {
      return {
        ...base,
        status,
        outcome: "rate_limited",
        detail: `429; retry after ${Math.round(retryAfterMs(res) / 1000)}s`,
      };
    }
    if (status === 401 || status === 403) {
      return {
        ...base,
        status,
        outcome: "auth_rejected",
        detail: `HTTP ${status} — auth or required headers may have changed`,
      };
    }
    if (!res.ok) return { ...base, status, outcome: "unreachable", detail: `HTTP ${status}` };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ...base, status, outcome: "shape_changed", detail: "200 but body was not JSON" };
    }
    if (!shapeOk(json)) {
      return {
        ...base,
        status,
        outcome: "shape_changed",
        detail: "200 but expected fields absent — schema may have changed",
      };
    }
    return { ...base, status, outcome: "ok", detail: "200, expected shape present" };
  } catch (err) {
    return {
      ...base,
      status: null,
      outcome: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Local read
// ---------------------------------------------------------------------------

export function readDevtools(opts: ReadDevtoolsOpts = {}): DevtoolsReport {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const usage = opts.usage ?? false;
  const windowDays = opts.windowDays ?? 7;
  const only = ALL_TOOLS.filter((t) => (opts.only ?? ALL_TOOLS).includes(t));

  const stores = discoverStores({ home, now, only });
  const groups = groupAccounts(stores);
  const forTool = (t: DevtoolName) => groups.filter((g) => g.tool === t);

  const tools: ToolStatus[] = [];
  if (only.includes("claude-code"))
    tools.push(readClaudeCode(home, now, usage, windowDays, forTool("claude-code")));
  if (only.includes("codex")) tools.push(readCodex(home, now, windowDays, forTool("codex")));
  if (only.includes("cursor")) tools.push(readCursor(home, now, forTool("cursor")));

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays,
    tools,
  };
}

/**
 * Build the report's accounts from grouped stores. A store with no identity
 * and no credential (a signed-out directory) is not an account; it becomes a
 * tool-level note instead.
 */
function buildAccounts(status: ToolStatus, groups: AccountGroup[]): void {
  for (const g of groups) {
    const loggedIn = g.stores.some((s) => s.loggedIn);
    const anonymous = !g.identity.accountId && !g.identity.email;
    if (anonymous && !loggedIn && !g.stores.some((s) => s.accessToken)) {
      for (const s of g.stores)
        status.notes.push(...(s.notes.length ? s.notes : [`${s.path}: signed out`]));
      continue;
    }
    const live = g.stores.find((s) => s.loggedIn) ?? g.stores[0];
    const notes: string[] = [];
    for (const s of g.stores) for (const n of s.notes) if (!notes.includes(n)) notes.push(n);
    status.accounts.push({
      id: g.identity.key,
      email: g.identity.email,
      org: g.identity.org,
      plan: g.identity.plan,
      rateLimitTier: g.stores.map((s) => s.rateLimitTier).find((v) => v != null) ?? null,
      loggedIn,
      authExpiresAt: live?.expiresAt ? new Date(live.expiresAt).toISOString() : null,
      stores: g.stores.map((s) => ({
        kind: s.storeKind,
        path: s.path,
        loggedIn: s.loggedIn,
        authExpiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
      })),
      source: null,
      sourceDetail: null,
      stale: false,
      asOf: null,
      quota: null,
      usage: null,
      spend: null,
      credits: null,
      notes,
    });
  }
  // Signed-in accounts first; discovery order otherwise.
  status.accounts.sort((a, b) => Number(b.loggedIn) - Number(a.loggedIn));
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function readClaudeCode(
  home: string,
  now: number,
  usage: boolean,
  windowDays: number,
  groups: AccountGroup[],
): ToolStatus {
  const dir = join(home, ".claude");
  const status: ToolStatus = base("claude-code");
  const dirs = new Set<string>();
  if (existsSync(dir)) dirs.add(resolve(dir));
  // Transcripts are read from this side of a WSL machine only: a Windows-side
  // install is another client, and scanning it over the 9p mount costs seconds.
  for (const g of groups)
    for (const s of g.stores)
      if (s.storeKind === "claude-dir" && !onWindowsMount(s.path)) dirs.add(resolve(s.path));
  status.installed = dirs.size > 0 || groups.length > 0;
  if (!status.installed) {
    status.notes.push("~/.claude not found");
    return status;
  }

  buildAccounts(status, groups);
  rollUp(status);
  if (!status.accounts.length) {
    status.loggedIn = false;
    status.notes.push("no credential found (not logged in)");
  }

  // Sessions: one .jsonl transcript per session under <dir>/projects/<slug>/.
  const files = [...dirs].flatMap((d) => listFilesRecursive(join(d, "projects"), ".jsonl"));
  status.sessions = files.length || null;
  status.lastActivity = latestMtimeIso(files);

  // Claude Code does not persist its rate-limit windows locally; the live
  // figures come from the enrichment step.
  status.quota = null;
  status.notes.push("live quota (5h/weekly resets) is server-side via /usage");

  status.tokensUsed = sumClaudeTokensCached(home, files, now, windowDays, usage);
  return status;
}

/** Sum the four token fields across every assistant message in one transcript. */
function sumFileTokens(file: string): number {
  let total = 0;
  for (const line of readJsonlSync(file)) {
    const usage = (line as { message?: { usage?: Record<string, number> } }).message?.usage;
    if (!usage) continue;
    total +=
      (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
  }
  return total;
}

interface TokenCacheEntry {
  mtime: number;
  size: number;
  tokens: number;
}

/**
 * Windowed Claude token total, memoized per transcript. Unlike Codex, a Claude
 * transcript has no per-session cumulative field, so the total is the sum of
 * every message — a full read of each in-window file. Each file's sum is cached
 * by (path, mtime, size) at `~/.cache/harnery/devtools/claude-tokens.json`: an
 * unchanged transcript is never re-read. `fresh` (from `--usage`) bypasses the
 * cache for an exact recompute.
 */
function sumClaudeTokensCached(
  home: string,
  files: string[],
  now: number,
  windowDays: number,
  fresh: boolean,
): number {
  const cutoff = now - windowDays * 86_400_000;
  const inWindow = files.filter((f) => safeMtime(f) >= cutoff);
  const cacheFile = join(home, ".cache", "harnery", "devtools", "claude-tokens.json");

  let cache: Record<string, TokenCacheEntry> = {};
  if (!fresh) {
    try {
      cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, TokenCacheEntry>;
    } catch {
      // no cache / unreadable — cold start
    }
  }

  const next: Record<string, TokenCacheEntry> = {};
  let total = 0;
  let changed = false;
  for (const f of inWindow) {
    let mtime: number;
    let size: number;
    try {
      const st = statSync(f);
      mtime = st.mtimeMs;
      size = st.size;
    } catch {
      continue; // vanished mid-scan
    }
    const hit = cache[f];
    const tokens = hit && hit.mtime === mtime && hit.size === size ? hit.tokens : sumFileTokens(f);
    if (!hit || hit.mtime !== mtime || hit.size !== size) changed = true;
    next[f] = { mtime, size, tokens };
    total += tokens;
  }

  if (!fresh && (changed || Object.keys(next).length !== Object.keys(cache).length)) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next));
      renameSync(tmp, cacheFile); // atomic swap — no torn reads for a concurrent reader
    } catch {
      // cache write is best-effort
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function readCodex(
  home: string,
  now: number,
  windowDays: number,
  groups: AccountGroup[],
): ToolStatus {
  const dir = join(home, ".codex");
  const status: ToolStatus = base("codex");
  const globbed = codexRollouts(home);
  status.installed = existsSync(dir) || globbed.length > 0 || groups.length > 0;
  if (!status.installed) {
    status.notes.push("~/.codex not found");
    return status;
  }

  // Codex can have more than one install on a machine (e.g. a WSL CLI and the
  // Windows desktop app, each its own account). Session counts and token totals
  // describe the install actually in use: the one that owns the newest rollout.
  const newestRollout = newestFile(globbed);
  const activeRoot = newestRollout ? codexRootOf(newestRollout) : dir;

  buildAccounts(status, groups);

  // Each Codex home's newest rollout carries that account's last rate-limit
  // snapshot; it is shown (marked stale) until a live source answers.
  const rolloutsFor = (root: string): string[] => {
    const own = globbed.filter((f) => resolve(codexRootOf(f)) === resolve(root));
    if (own.length) return own;
    return listFilesRecursive(join(root, "sessions"), ".jsonl").filter((f) =>
      f.includes("rollout-"),
    );
  };
  for (const acct of status.accounts) {
    for (const s of acct.stores) {
      if (s.kind !== "codex-home") continue;
      const newest = newestFile(rolloutsFor(s.path));
      if (!newest) continue;
      const rl = lastRateLimits(newest);
      if (!rl) continue;
      acct.quota = [rl.primary, rl.secondary].filter((q): q is QuotaWindow => q !== null);
      if (rl.planType) acct.plan = rl.planType; // live plan wins over the id_token
      if (rl.reachedType) acct.notes.push(`rate limit reached (${rl.reachedType} window)`);
      acct.source = "snapshot";
      acct.sourceDetail = newest;
      acct.stale = true;
      acct.asOf = new Date(safeMtime(newest)).toISOString();
      break;
    }
  }
  // The active install's account leads, so the tool-level fields describe it.
  const activeIdx = status.accounts.findIndex(
    (a) => a.loggedIn && a.stores.some((s) => resolve(s.path) === resolve(activeRoot)),
  );
  if (activeIdx > 0) status.accounts.unshift(...status.accounts.splice(activeIdx, 1));
  rollUp(status);
  if (!status.accounts.length) {
    status.loggedIn = false;
    status.notes.push("no auth.json found (not logged in)");
    // Sessions without a sign-in still carry the last snapshot the install saw.
    const rl = newestRollout ? lastRateLimits(newestRollout) : null;
    if (rl) {
      status.quota = [rl.primary, rl.secondary].filter((q): q is QuotaWindow => q !== null);
      status.plan = rl.planType;
      if (rl.reachedType) status.notes.push(`rate limit reached (${rl.reachedType} window)`);
    }
  }

  // Activity: prefer the active install's state_5.sqlite (`threads`) for exact
  // counts, else that install's rollout files.
  const state = readCodexState(join(activeRoot, "sqlite", "state_5.sqlite"));
  const activeRollouts = globbed.filter((f) => codexRootOf(f) === activeRoot);
  if (state) {
    status.sessions = state.sessions;
    if (state.lastMs) status.lastActivity = new Date(state.lastMs).toISOString();
  } else {
    status.sessions = activeRollouts.length || null;
    status.lastActivity = latestMtimeIso(activeRollouts);
  }

  status.tokensUsed = sumCodexTokens(activeRollouts, now, windowDays);

  if (!status.quota?.length) status.notes.push("no local rate-limit snapshot in latest session");
  return status;
}

/** The Codex install root that owns a rollout path (the part before `/sessions/`). */
function codexRootOf(rolloutPath: string): string {
  const parts = rolloutPath.split(/[/\\]sessions[/\\]/);
  return parts.length > 1 ? (parts[0] as string) : rolloutPath;
}

interface CodexState {
  sessions: number;
  lastMs: number | null;
  newestRollout: string | null;
}

/** Read Codex's `state_5.sqlite` threads table for session count, recency, newest rollout. */
function readCodexState(dbPath: string): CodexState | null {
  if (!existsSync(dbPath)) return null;
  return withSqlite(dbPath, (db) => {
    const agg = db.query("SELECT count(*) c, max(updated_at_ms) mx FROM threads").get() as
      | { c: number; mx: number | null }
      | undefined;
    const newest = db
      .query("SELECT rollout_path FROM threads ORDER BY updated_at_ms DESC LIMIT 1")
      .get() as { rollout_path: string | null } | undefined;
    return {
      sessions: agg?.c ?? 0,
      lastMs: numOr(agg?.mx),
      newestRollout: strOr(newest?.rollout_path),
    };
  });
}

/** All Codex rollout files across the home and (real-home only) the Windows-side home. */
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
  /** Non-null only when a limit was actually hit (e.g. "primary"/"secondary"). */
  reachedType: string | null;
}

function lastRateLimits(file: string): RateLimitsSnapshot | null {
  let found: RateLimitsSnapshot | null = null;
  for (const line of readJsonlSync(file)) {
    const payload = (line as { type?: string; payload?: Record<string, unknown> }).payload;
    if (!payload) continue;
    if (payload.type !== "token_count") continue;
    const rl = payload.rate_limits as Record<string, unknown> | undefined;
    if (!rl) continue;
    found = {
      primary: quotaFromWindow(rl.primary as Record<string, unknown> | undefined),
      secondary: quotaFromWindow(rl.secondary as Record<string, unknown> | undefined),
      planType: strOr(rl.plan_type),
      reachedType: strOr(rl.rate_limit_reached_type),
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

/** Bytes tail-read per rollout when summing tokens. */
const CODEX_TAIL_BYTES = 131_072;

/**
 * Windowed token total across the in-window rollouts. Each `token_count` event
 * carries a *cumulative* `info.total_token_usage`, so the session total is the
 * last such event — found by scanning only the file's tail.
 */
function sumCodexTokens(files: string[], now: number, windowDays: number): number {
  const cutoff = now - windowDays * 86_400_000;
  let total = 0;
  for (const f of files) {
    if (safeMtime(f) < cutoff) continue;
    total += lastCumulativeTokens(readTail(f, CODEX_TAIL_BYTES));
  }
  return total;
}

/** Last cumulative `total_token_usage.total_tokens` in a rollout tail, or 0. */
function lastCumulativeTokens(tail: string): number {
  let last = 0;
  for (const line of tail.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      continue; // a partial first line from the tail cut — skip it
    }
    const payload = (parsedLine as { payload?: Record<string, unknown> }).payload;
    if (!payload) continue;
    if (payload.type !== "token_count") continue;
    const info = payload.info as Record<string, unknown> | undefined;
    const totals = info?.total_token_usage as Record<string, unknown> | undefined;
    const t = numOr(totals?.total_tokens);
    if (t) last = t; // cumulative — the last reading wins
  }
  return last;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function readCursor(home: string, _now: number, groups: AccountGroup[]): ToolStatus {
  const dir = join(home, ".cursor");
  // Cursor's IDE state DB (state.vscdb) lives under the OS app-support dir
  // (Linux ~/.config, macOS ~/Library, WSL the Windows-side path), separate
  // from ~/.cursor (the agent-CLI config).
  const vscdb = cursorGlobalVscdb(home);
  const status: ToolStatus = base("cursor");
  status.installed = existsSync(dir) || vscdb != null || groups.length > 0;
  if (!status.installed) {
    status.notes.push("Cursor not found (no ~/.cursor and no state.vscdb)");
    return status;
  }

  buildAccounts(status, groups);
  rollUp(status);

  const items = vscdb
    ? readVscdbItems(vscdb, ["cursorAuth/stripeSubscriptionStatus", "composer.composerHeaders"])
    : null;
  if (items) {
    const subStatus = strOr(items["cursorAuth/stripeSubscriptionStatus"]);
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
  }
  if (!status.accounts.length) {
    // Fallback: remote-server tokens + statsig id only prove a login exists.
    const serverDir = join(home, ".cursor-server");
    const tokenFiles = existsSync(serverDir)
      ? readdirSync(serverDir).filter((f) => f.endsWith(".token"))
      : [];
    const statsig = readJson<Record<string, unknown>>(join(dir, "statsig-cache.json"));
    status.account = strOr(statsig?.userID); // opaque statsig id, not an email
    status.loggedIn = tokenFiles.length > 0 || status.account ? true : null;
    if (!items)
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

  // Usage + billing live server-side; the enrichment step fetches them.
  status.quota = null;
  status.tokensUsed = null;
  status.notes.push(
    "usage + billing come from Cursor's servers (api2.cursor.sh / cursor.com), fetched during the enrichment step",
  );
  return status;
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
    accounts: [],
    notes: [],
  };
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
