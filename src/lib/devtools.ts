import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
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
   * Total tokens observed in local transcripts within the scan window
   * (`windowDays`). Codex always reports it — its per-session cumulative total
   * is one tail-read per rollout, cheap enough for every render. Claude Code's
   * is `--usage`-gated (a full transcript scan, potentially gigabytes) and null
   * otherwise. Cursor keeps token counts server-side, so it stays null.
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

/** One endpoint's health, from `probeEndpoints` (the `devtools doctor` check). */
export interface ProbeResult {
  tool: DevtoolName;
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

// So our requests blend in with the tool's own traffic rather than looking like
// a scraper (a bare fetch would carry a "Bun/…" or "node" User-Agent, which is
// the anomaly). We send the same first-party client identity the tool sends for
// the same call — the user's own machine reaching the user's own account. Claude
// uses a claude-cli UA (built below); Cursor uses its Electron UA (see
// cursorUserAgent), both embedding the live local version.

/** Last-resort Claude Code version when no live source is readable. */
const CLAUDE_CLI_FALLBACK_VERSION = "2.1.0";

/**
 * The Claude Code version actually running, most-authoritative source first:
 *   1. the `version` field the running client stamps into its newest session
 *      transcript (reflects auto-updates immediately),
 *   2. the updater's last-result marker,
 *   3. a constant.
 * Claude Code auto-updates into a versioned install, so the transcript can be
 * ahead of both the bootstrap `package.json` and the updater marker — which is
 * why we read what the client itself reports, not what's on the install path.
 */
function claudeCodeVersion(home: string): string {
  const fromTranscript = newestTranscriptVersion(home);
  if (fromTranscript) return fromTranscript;
  const marker = readJson<{ version_to?: string }>(
    join(home, ".claude", ".last-update-result.json"),
  );
  return strOr(marker?.version_to) ?? CLAUDE_CLI_FALLBACK_VERSION;
}

/** Pull the `version` field from the head of the newest session transcript. */
function newestTranscriptVersion(home: string): string | null {
  const newest = newestFile(listFilesRecursive(join(home, ".claude", "projects"), ".jsonl"));
  if (!newest) return null;
  // The version rides every event, so the head of the file is plenty — avoids
  // reading a multi-MB transcript in full just to read one field.
  for (const line of readHead(newest, 65_536).split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = strOr((JSON.parse(line) as { version?: unknown }).version);
      if (v) return v;
    } catch {
      // partial line at the buffer edge — skip
    }
  }
  return null;
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

/**
 * Outcome of a usage fetch. `cooldown` (a 429) tells the cache to back off for
 * `retryAfterMs` so a rate limit can never cascade into repeated hits — the
 * failure mode that starves the tool's own client.
 */
type FetchOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "cooldown"; retryAfterMs: number }
  | { kind: "fail" };

/** Short, non-reversible fingerprint of a token, for per-account cache keys. */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

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
  // 5-minute cache. The usage windows move slowly, and this is the hard cap on
  // how often we touch a rate-limited endpoint no matter how often the dashboard
  // re-renders — the page can refresh every couple seconds and still hit the
  // network at most once per tool per 5 minutes.
  const cacheTtlMs = opts.cacheTtlMs ?? 300_000;

  // Claude Code — 5h + weekly windows and extra-usage spend from oauth/usage.
  // Cached per-account, because that endpoint is aggressively rate-limited and
  // Claude Code's OWN "Account & Usage" panel hits it too — a chatty dashboard
  // would starve it. Keying by token fingerprint means switching accounts shows
  // the new account's numbers at once instead of the previous account's cache.
  const claude = report.tools.find((t) => t.tool === "claude-code");
  if (claude?.installed) {
    const token = readClaudeOauthToken(home);
    if (token) {
      const live = await cachedUsage(
        home,
        `claude-usage-${tokenFingerprint(token)}`,
        cacheTtlMs,
        () => fetchClaudeUsage(token, claudeCodeVersion(home), timeoutMs),
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
    const usage = await cachedUsage(
      home,
      `cursor-usage-${tokenFingerprint(auth.token)}`,
      cacheTtlMs,
      () => fetchCursorUsage(auth, timeoutMs),
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
    cursor.api = await fetchCursorApi(key, cursorUserAgent(auth?.version ?? null), timeoutMs);
    // On success the structured `api` fields carry the signal; only note a break.
    if (!cursor.api.ok) {
      cursor.notes.unshift(`API key configured but not usable: ${cursor.api.error ?? "unknown"}`);
    }
  }
  return report;
}

/**
 * One live call per usage endpoint (cache-bypassing) to check the integration
 * still works — the occasional "did a client change its headers?" test. It
 * exercises the EXACT request builders production uses, so an `auth_rejected`
 * result means our headers/token stopped being accepted, and `shape_changed`
 * means the response schema drifted. Rate-limited results are reported as such,
 * not as failures. Makes at most one request per tool; run it by hand (it is not
 * scheduled) so it can't itself cause a rate limit.
 */
export async function probeEndpoints(
  opts: { home?: string; timeoutMs?: number; only?: readonly DevtoolName[] } = {},
): Promise<ProbeResult[]> {
  const home = opts.home ?? homedir();
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const only = new Set(opts.only ?? ALL_TOOLS);
  const out: ProbeResult[] = [];

  if (only.has("claude-code")) {
    const version = claudeCodeVersion(home);
    const token = readClaudeOauthToken(home);
    if (!token) {
      out.push(
        noCred("claude-code", CLAUDE_USAGE_URL, version, "no usable OAuth token in ~/.claude"),
      );
    } else {
      const { url, headers } = claudeUsageRequest(token, version);
      out.push(
        await probeOne("claude-code", url, { headers }, version, timeoutMs, (j) => {
          const o = j as { limits?: unknown; five_hour?: unknown };
          return Array.isArray(o.limits) || o.five_hour != null;
        }),
      );
    }
  }

  if (only.has("cursor")) {
    const auth = readCursorSessionAuth(home);
    if (!auth) {
      out.push(noCred("cursor", CURSOR_USAGE_URL, null, "no usable session token in state.vscdb"));
    } else {
      const { url, init } = cursorUsageRequest(auth);
      out.push(
        await probeOne("cursor", url, init, auth.version, timeoutMs, (j) => {
          const o = j as { planUsage?: unknown; billingCycleEnd?: unknown };
          return o.planUsage != null || o.billingCycleEnd != null;
        }),
      );
    }
  }

  // Codex is read from local files only (no endpoint to probe), so it's omitted.
  return out;
}

function noCred(
  tool: DevtoolName,
  endpoint: string,
  clientVersion: string | null,
  detail: string,
): ProbeResult {
  return { tool, endpoint, clientVersion, status: null, outcome: "no_credential", detail };
}

async function probeOne(
  tool: DevtoolName,
  url: string,
  init: RequestInit,
  clientVersion: string | null,
  timeoutMs: number,
  shapeOk: (json: unknown) => boolean,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const base = { tool, endpoint: url, clientVersion };
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
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
 *     is made until it passes — so a rate limit can't cascade into a hammer loop
 *     (the failure mode that starved Claude Code's own usage panel). During the
 *     cooldown the last-known-good value is served, so the card stays populated.
 *   • Any other failure serves last-known-good and retries next time.
 *
 * Best-effort: read/write errors fall back to a live fetch. `ttlMs <= 0` fetches
 * every call (still honoring a cooldown) and skips writes.
 */
async function cachedUsage<T>(
  home: string,
  name: string,
  ttlMs: number,
  fetcher: () => Promise<FetchOutcome<T>>,
): Promise<T | null> {
  const now = Date.now();
  const dir = join(home, ".cache", "harnery", "devtools");
  const file = join(dir, `${name}.json`);

  let entry: UsageCacheEntry<T> | null = null;
  try {
    entry = JSON.parse(readFileSync(file, "utf8")) as UsageCacheEntry<T>;
  } catch {
    // no cache / unreadable
  }
  // Fresh cached success.
  if (entry?.data != null && ttlMs > 0 && now - entry.at < ttlMs) return entry.data;
  // In a rate-limit cooldown — do not call; serve last-known-good (may be null).
  if (entry?.cooldownUntil != null && now < entry.cooldownUntil) return entry.data ?? null;

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
    return outcome.data;
  }
  if (outcome.kind === "cooldown") {
    // Record the backoff, preserving any last-known-good data to keep serving it.
    write({
      at: entry?.at ?? now,
      data: entry?.data ?? null,
      cooldownUntil: now + outcome.retryAfterMs,
    });
    return entry?.data ?? null;
  }
  // Plain failure: leave the cache as-is (retry next call), serve any stale data.
  return entry?.data ?? null;
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

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * The request we send to Claude's usage endpoint — the same URL + headers the
 * `/usage` command sends, so the call is indistinguishable from Claude Code's
 * own (Bearer token, the oauth beta, and the `claude-cli/<version> (external,
 * cli)` UA + `x-app: cli`). Extracted so the doctor probe exercises the exact
 * headers we use in production.
 */
function claudeUsageRequest(token: string, version: string): { url: string; headers: HeadersInit } {
  return {
    url: CLAUDE_USAGE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "User-Agent": `claude-cli/${version} (external, cli)`,
      "x-app": "cli",
    },
  };
}

/**
 * Fetch Claude Code's live usage from api.anthropic.com/api/oauth/usage with the
 * local OAuth token. Returns a `FetchOutcome`: `ok` with quota + spend,
 * `cooldown` on a 429 (with the server's retry-after), or `fail`.
 */
async function fetchClaudeUsage(
  token: string,
  version: string,
  timeoutMs: number,
): Promise<FetchOutcome<{ quota: QuotaWindow[]; spend: SpendStatus | null }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { url, headers } = claudeUsageRequest(token, version);
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 429) return { kind: "cooldown", retryAfterMs: retryAfterMs(res) };
    if (!res.ok) return { kind: "fail" };
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
    return { kind: "ok", data: { quota, spend } };
  } catch {
    return { kind: "fail" };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a `Retry-After` header (seconds) to ms; default 60s when absent/unparseable. */
function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  const secs = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
  return (Number.isFinite(secs) && secs > 0 ? secs : 60) * 1000;
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
  /** Local Cursor app version (for the client User-Agent), else null. */
  version: string | null;
}

/**
 * Read Cursor's locally-stored session token from state.vscdb and derive the
 * WorkOS user id from its JWT `sub` claim, plus the local Cursor version for the
 * client User-Agent. Returns null when the DB is unreadable, no token is
 * present, or the token has expired (so we skip a doomed call). The token
 * string is used only to build the request and is never stored on the report.
 */
function readCursorSessionAuth(home: string): CursorSessionAuth | null {
  const vscdb = cursorGlobalVscdb(home);
  if (!vscdb) return null;
  const items = readVscdbItems(vscdb, [
    "cursorAuth/accessToken",
    "cursor.startupMetrics.lastVersion",
  ]);
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
  return { token, userId, version: strOr(items?.["cursor.startupMetrics.lastVersion"]) };
}

// Cursor is an Electron app; its embedded browser presents a VS Code-style UA
// (`… <App>/<ver> Chrome/<chromium> Electron/<electron> Safari/537.36`). We
// mirror that, injecting the LIVE Cursor version read from state.vscdb. The
// Chromium/Electron pair is cosmetic (tracks Cursor's VS Code base) — bump when
// Cursor's base does; the identifying `Cursor/<version>` part is always live.
const CURSOR_CHROMIUM = "132.0.6834.210";
const CURSOR_ELECTRON = "34.5.8";

/** Cursor Electron client User-Agent, embedding the live app version. */
function cursorUserAgent(version: string | null): string {
  const ver = version ?? "0.0.0";
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/${ver} Chrome/${CURSOR_CHROMIUM} Electron/${CURSOR_ELECTRON} Safari/537.36`;
}

const CURSOR_USAGE_URL = "https://cursor.com/api/dashboard/get-current-period-usage";

/**
 * The request we send to Cursor's usage endpoint — the WorkOS session cookie
 * (`<userId>::<token>`) plus the browser-consistent Origin/Referer cursor.com
 * requires, and Cursor's own Electron client UA. Extracted so the doctor probe
 * exercises the exact request we use in production.
 */
function cursorUsageRequest(auth: CursorSessionAuth): { url: string; init: RequestInit } {
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${auth.userId}::${auth.token}`)}`;
  return {
    url: CURSOR_USAGE_URL,
    init: {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: "https://cursor.com",
        Referer: "https://cursor.com/dashboard/spending",
        "User-Agent": cursorUserAgent(auth.version),
      },
      body: "{}",
    },
  };
}

/**
 * Fetch the current-period usage the Cursor UI shows on its Spending page.
 * Returns a `FetchOutcome`: `ok`, `cooldown` on a 429, or `fail`.
 */
async function fetchCursorUsage(
  auth: CursorSessionAuth,
  timeoutMs: number,
): Promise<FetchOutcome<{ usage: CursorUsage; spend: SpendStatus | null }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { url, init } = cursorUsageRequest(auth);
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (res.status === 429) return { kind: "cooldown", retryAfterMs: retryAfterMs(res) };
    if (!res.ok) return { kind: "fail" };
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
    return { kind: "ok", data: { usage, spend } };
  } catch {
    return { kind: "fail" };
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

async function fetchCursorApi(
  key: string,
  userAgent: string,
  timeoutMs: number,
): Promise<ApiEnrichment> {
  const out: ApiEnrichment = { ok: false, keyName: null, cloudAgents: null, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`https://api.cursor.com${path}`, {
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

export function readDevtools(opts: ReadDevtoolsOpts = {}): DevtoolsReport {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const usage = opts.usage ?? false;
  const windowDays = opts.windowDays ?? 7;
  const only = new Set(opts.only ?? ALL_TOOLS);

  const tools: ToolStatus[] = [];
  if (only.has("claude-code")) tools.push(readClaudeCode(home, now, usage, windowDays));
  if (only.has("codex")) tools.push(readCodex(home, now, windowDays));
  if (only.has("cursor")) tools.push(readCursor(home));

  return {
    generatedAt: new Date(now).toISOString(),
    // The window that any shown token total is measured over. Codex always
    // reports a windowed total; Claude's transcript scan is `--usage`-gated.
    windowDays,
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

function readCodex(home: string, now: number, windowDays: number): ToolStatus {
  const dir = join(home, ".codex");
  const status: ToolStatus = base("codex");
  const globbed = codexRollouts(home);
  status.installed = existsSync(dir) || globbed.length > 0;
  if (!status.installed) {
    status.notes.push("~/.codex not found");
    return status;
  }

  // Codex can have more than one install on a machine (e.g. a WSL CLI and the
  // Windows desktop app, each its own account). They must not be mixed: read
  // auth AND rate limits from the SAME install — the one actually in use, which
  // is whichever owns the most-recently-written rollout.
  const newestRollout = newestFile(globbed);
  const activeRoot = newestRollout ? codexRootOf(newestRollout) : dir;

  // Auth: <activeRoot>/auth.json. The id_token carries the non-secret account +
  // plan claims; the access_token carries the meaningful expiry (it outlives the
  // id_token and is what refreshes), so we report that, not the id_token's.
  const auth = readJson<Record<string, unknown>>(join(activeRoot, "auth.json"));
  if (auth) {
    const tokens = auth.tokens as Record<string, unknown> | undefined;
    const idToken = strOr(tokens?.id_token);
    const accessToken = strOr(tokens?.access_token);
    const idClaims = idToken ? decodeJwtClaims(idToken) : null;
    const accessExp = numOr(accessToken ? decodeJwtClaims(accessToken)?.exp : undefined);
    if (idClaims) {
      status.account = strOr(idClaims.email);
      const authClaim = idClaims["https://api.openai.com/auth"] as
        | Record<string, unknown>
        | undefined;
      status.plan = strOr(authClaim?.chatgpt_plan_type);
    }
    // Prefer the access token's expiry; fall back to the id_token's.
    const exp = accessExp ?? numOr(idClaims?.exp);
    status.authExpiresAt = exp ? new Date(exp * 1000).toISOString() : null;
    status.loggedIn = Boolean(accessToken || idToken) && (exp == null || exp * 1000 > now);
    if (exp && exp * 1000 <= now) {
      status.notes.push("token expired; refreshes via stored refresh token");
    }
  } else {
    status.loggedIn = false;
    status.notes.push("no auth.json found (not logged in)");
  }

  // Activity: prefer the active install's state_5.sqlite (`threads`) for exact
  // counts, but only when it's actually the active install's DB — otherwise the
  // rollouts are the cross-install-consistent source.
  const state = readCodexState(join(activeRoot, "sqlite", "state_5.sqlite"));
  const activeRollouts = globbed.filter((f) => codexRootOf(f) === activeRoot);
  if (state) {
    status.sessions = state.sessions;
    if (state.lastMs) status.lastActivity = new Date(state.lastMs).toISOString();
  } else {
    // No DB for the active install (e.g. the Windows desktop app uses a
    // different store): fall back to that install's rollout files.
    status.sessions = activeRollouts.length || null;
    status.lastActivity = latestMtimeIso(activeRollouts);
  }

  // Windowed token total: always shown (the tail scan is card-cheap), summed
  // from the rollouts since they're the fresh cross-install source — the state
  // DB can lag the live sessions.
  status.tokensUsed = sumCodexTokens(activeRollouts, now, windowDays);

  // Freshest rollout → current rate-limit windows + live plan_type.
  if (newestRollout) {
    const rl = lastRateLimits(newestRollout);
    if (rl) {
      status.quota = [rl.primary, rl.secondary].filter((q): q is QuotaWindow => q !== null);
      if (rl.planType) status.plan = rl.planType; // live plan wins over the id_token
      if (rl.reachedType) status.notes.push(`rate limit reached (${rl.reachedType} window)`);
    }
  }
  if (!status.quota?.length) status.notes.push("no local rate-limit snapshot in latest session");

  return status;
}

/** The Codex install root that owns a rollout path (the part before `/sessions/`). */
function codexRootOf(rolloutPath: string): string {
  const parts = rolloutPath.split(/[/\\]sessions[/\\]/);
  return parts.length > 1 ? parts[0] : rolloutPath;
}

interface CodexState {
  sessions: number;
  lastMs: number | null;
  newestRollout: string | null;
}

/** Read Codex's `state_5.sqlite` threads table for session count, recency, newest rollout.
 * (Token totals come from the rollouts, not here — the DB can lag live sessions.) */
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
  /** Non-null only when a limit was actually hit (e.g. "primary"/"secondary"). */
  reachedType: string | null;
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

/** Bytes tail-read per rollout when summing tokens — enough to hold the last
 * `token_count` event of any real session while staying cheap on a networked
 * (WSL → /mnt/c) filesystem. */
const CODEX_TAIL_BYTES = 131_072;

/**
 * Windowed token total across the in-window rollouts, light enough to run on
 * every card render. Each `token_count` event carries a *cumulative*
 * `info.total_token_usage`, so the session total is the last such event — found
 * by scanning only the file's tail rather than every line. A session whose final
 * `token_count` sits beyond the tail (rare: a huge trailing non-token event) is
 * undercounted; acceptable for a card estimate.
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a partial first line from the tail cut — skip it
    }
    const payload = (parsed as { payload?: Record<string, unknown> }).payload;
    if (!payload || payload.type !== "token_count") continue;
    const info = payload.info as Record<string, unknown> | undefined;
    const totals = info?.total_token_usage as Record<string, unknown> | undefined;
    const t = numOr(totals?.total_tokens);
    if (t) last = t; // cumulative — the last reading wins
  }
  return last;
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
