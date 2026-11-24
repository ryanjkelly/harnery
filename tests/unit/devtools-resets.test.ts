/**
 * Reset grants, reset credits and the usage history behind recent burn rates
 * (ADR 0273, amendment 2026-11-23). Every network call is injected and every
 * write lands in a synthetic home.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { enrichFromApi, readDevtools, type ToolStatus } from "../../src/lib/devtools.ts";
import {
  historyPath,
  lookbackFor,
  readHistory,
  recentFor,
  recordSamples,
  type UsageSample,
} from "../../src/lib/devtools-history.ts";
import { removeDir } from "../helpers/remove-dir.ts";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");
const VALID_MS = Date.parse("2099-01-01T00:00:00.000Z");
const VALID_S = Math.floor(VALID_MS / 1000);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "devtools-resets-"));
});
afterEach(() => {
  removeDir(home);
});

function write(rel: string, value: unknown) {
  const p = path.join(home, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
}

function tool(tools: ToolStatus[], name: string): ToolStatus {
  const t = tools.find((x) => x.tool === name);
  if (!t) throw new Error(`no ${name}`);
  return t;
}

type Call = { url: string; headers: Record<string, string> };
function recordingFetch(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const c: Call = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Shapes follow real responses; identifiers are removed.
const CLAUDE_WITH_GRANTS = {
  five_hour: { utilization: 4, resets_at: "2099-01-01T03:10:00.302483+00:00" },
  seven_day: { utilization: 71, resets_at: "2099-01-05T07:00:00.302501+00:00" },
  cedar_ember: {
    eligible: true,
    at_limit: false,
    grants: [
      {
        label: "One full limit reset",
        resets_total: 1,
        resets_left: 1,
        starts_at: "2026-11-10T21:30:00+00:00",
        ends_at: "2026-12-10T22:00:00+00:00",
        clears: ["five_hour", "seven_day"],
        paused: false,
        usable_now: true,
        use_requires_limit: false,
        type: "full",
        unavailable_reason: null,
        gives_back_weekly: false,
      },
      {
        label: "One model reset",
        resets_total: 2,
        resets_left: 2,
        ends_at: "2027-03-09T07:59:00+00:00",
        usable_now: false,
        type: "full",
        unavailable_reason: "not_at_limit",
        gives_back_weekly: true,
      },
      {
        label: "Used up",
        resets_total: 1,
        resets_left: 0,
        ends_at: "2027-03-09T07:59:00+00:00",
        usable_now: false,
        type: "full",
        unavailable_reason: "unavailable",
        gives_back_weekly: true,
      },
    ],
    weekly_resets_at: "2099-01-05T07:00:00+00:00",
    cooldown_until: null,
  },
  limits: [
    { kind: "session", percent: 4, resets_at: "2099-01-01T03:10:00.302483+00:00", scope: null },
    { kind: "weekly_all", percent: 71, resets_at: "2099-01-05T07:00:00.302501+00:00", scope: null },
  ],
  spend: null,
};

const CODEX_USAGE = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: VALID_S },
    secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: VALID_S },
  },
  credits: { has_credits: true, unlimited: false, balance: "62801.46" },
  rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 },
};
const CODEX_RESETS = {
  credits: [
    {
      reset_type: "codex_rate_limits",
      status: "available",
      granted_at: "2026-10-31T20:35:52.697792Z",
      expires_at: "2026-11-30T20:35:52.697792Z",
      title: "Full reset (Weekly + 5 hr)",
    },
    {
      reset_type: "codex_rate_limits",
      status: "available",
      granted_at: "2026-11-01T23:02:12.696360Z",
      expires_at: "2026-12-01T23:02:12.696360Z",
      title: "Full reset (Weekly + 5 hr)",
    },
    {
      reset_type: "codex_rate_limits",
      status: "redeemed",
      expires_at: "2026-12-12T22:58:24.799128Z",
      title: "Full reset (Weekly + 5 hr)",
    },
  ],
  available_count: 2,
};

function seedClaude() {
  write(".claude/.credentials.json", {
    claudeAiOauth: {
      accessToken: "tok-claude",
      expiresAt: VALID_MS,
      refreshTokenExpiresAt: VALID_MS,
    },
  });
}
function seedCodex() {
  write(".codex/auth.json", {
    tokens: { access_token: jwt({ exp: VALID_S }), account_id: "acct-C" },
  });
}

describe("reset grants", () => {
  test("Claude: one usage call carries the grants; used-up grants are left out", async () => {
    seedClaude();
    const { fn, calls } = recordingFetch(() => ({ status: 200, body: CLAUDE_WITH_GRANTS }));
    const report = readDevtools({ home, now: NOW, only: ["claude-code"] });
    await enrichFromApi(report, { home, fetch: fn, cacheTtlMs: 0, cliproxy: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1");
    const acct = tool(report.tools, "claude-code").accounts[0];
    expect(acct?.resets).toEqual([
      {
        kind: "full",
        label: "One full limit reset",
        left: 1,
        total: 1,
        expiresAt: "2026-12-10T22:00:00.000Z",
        usableNow: true,
        unavailableReason: null,
      },
      {
        kind: "fable",
        label: "One model reset",
        left: 2,
        total: 2,
        expiresAt: "2027-03-09T07:59:00.000Z",
        usableNow: false,
        unavailableReason: "not_at_limit",
      },
    ]);
  });

  test("Claude: a null grants section means none; an absent one means unknown", async () => {
    seedClaude();
    let body: unknown = { ...CLAUDE_WITH_GRANTS, cedar_ember: null };
    const { fn } = recordingFetch(() => ({ status: 200, body }));
    const r1 = readDevtools({ home, now: NOW, only: ["claude-code"] });
    await enrichFromApi(r1, { home, fetch: fn, cacheTtlMs: 0, cliproxy: null });
    expect(tool(r1.tools, "claude-code").accounts[0]?.resets).toEqual([]);

    const { cedar_ember: _drop, ...rest } = CLAUDE_WITH_GRANTS;
    body = rest;
    const r2 = readDevtools({ home, now: NOW, only: ["claude-code"] });
    await enrichFromApi(r2, { home, fetch: fn, cacheTtlMs: 0, cliproxy: null });
    expect(tool(r2.tools, "claude-code").accounts[0]?.resets).toBeNull();
  });

  test("Codex: the reset-credit list is read with the usage call's auth", async () => {
    seedCodex();
    const { fn, calls } = recordingFetch((c) => {
      if (c.url.endsWith("/wham/usage")) return { status: 200, body: CODEX_USAGE };
      if (c.url.endsWith("/wham/rate-limit-reset-credits"))
        return { status: 200, body: CODEX_RESETS };
      return { status: 404, body: {} };
    });
    const report = readDevtools({ home, now: NOW, only: ["codex"] });
    await enrichFromApi(report, {
      home,
      fetch: fn,
      cacheTtlMs: 0,
      cliproxy: null,
      codexAppServer: null,
    });
    const resetsCall = calls.find((c) => c.url.endsWith("/rate-limit-reset-credits"));
    expect(resetsCall?.headers["ChatGPT-Account-Id"]).toBe("acct-C");
    expect(resetsCall?.headers.Authorization?.startsWith("Bearer ")).toBe(true);
    const acct = tool(report.tools, "codex").accounts[0];
    expect(acct?.resets?.map((g) => [g.kind, g.label, g.left, g.expiresAt])).toEqual([
      ["full", "Full reset (Weekly + 5 hr)", 1, "2026-11-30T20:35:52.697Z"],
      ["full", "Full reset (Weekly + 5 hr)", 1, "2026-12-01T23:02:12.696Z"],
    ]);
    expect(acct?.credits?.balance).toBe(62801.46);
  });

  test("Codex: a failed list keeps usage and falls back to the usage response's count", async () => {
    seedCodex();
    const { fn } = recordingFetch((c) =>
      c.url.endsWith("/wham/usage")
        ? { status: 200, body: CODEX_USAGE }
        : { status: 429, body: { error: "rate limited" } },
    );
    const report = readDevtools({ home, now: NOW, only: ["codex"] });
    await enrichFromApi(report, {
      home,
      fetch: fn,
      cacheTtlMs: 0,
      cliproxy: null,
      codexAppServer: null,
    });
    const acct = tool(report.tools, "codex").accounts[0];
    expect(acct?.source).toBe("direct");
    expect(acct?.quota?.map((q) => q.usedPercent)).toEqual([20, 40]);
    expect(acct?.resets).toEqual([
      {
        kind: "full",
        label: "Full reset",
        left: 3,
        total: 3,
        expiresAt: null,
        usableNow: null,
        unavailableReason: null,
      },
    ]);
  });
});

describe("usage history", () => {
  test("live reads are recorded; a cache hit is not", async () => {
    seedCodex();
    const { fn, calls } = recordingFetch((c) =>
      c.url.endsWith("/wham/usage")
        ? { status: 200, body: CODEX_USAGE }
        : { status: 200, body: CODEX_RESETS },
    );
    const opts = { home, fetch: fn, cliproxy: null, codexAppServer: null } as const;
    const r1 = readDevtools({ home, now: NOW, only: ["codex"] });
    await enrichFromApi(r1, opts);
    const first = readHistory(home);
    expect(first.map((s) => [s.window, s.used])).toEqual([
      ["5h", 20],
      ["weekly", 40],
    ]);
    expect(first[0]?.account).toBe("codex:acct-C");
    // One point is not a rate, but the reading is attached.
    expect(r1.tools[0]?.accounts[0]?.quota?.[0]?.recent?.points).toHaveLength(1);
    expect(r1.tools[0]?.accounts[0]?.quota?.[0]?.recent?.ratePerHour).toBeNull();

    // Second enrichment inside the cache TTL: no network, no new sample.
    const r2 = readDevtools({ home, now: NOW, only: ["codex"] });
    await enrichFromApi(r2, opts);
    expect(calls.filter((c) => c.url.endsWith("/wham/usage"))).toHaveLength(1);
    expect(readHistory(home)).toHaveLength(2);
    expect(historyPath(home).startsWith(home)).toBe(true);
  });

  test("history: false writes nothing", async () => {
    seedCodex();
    const { fn } = recordingFetch(() => ({ status: 200, body: CODEX_USAGE }));
    const report = readDevtools({ home, now: NOW, only: ["codex"] });
    await enrichFromApi(report, {
      home,
      fetch: fn,
      cacheTtlMs: 0,
      cliproxy: null,
      codexAppServer: null,
      history: false,
    });
    expect(existsSync(historyPath(home))).toBe(false);
  });

  test("a key is resampled only when its value changes or ten minutes pass", () => {
    const s = (t: number, used: number): UsageSample => ({
      t,
      account: "a",
      window: "5h",
      used,
      resetsAt: null,
    });
    recordSamples(home, [s(NOW, 10)], NOW);
    recordSamples(home, [s(NOW + 5 * MIN, 10)], NOW + 5 * MIN); // unchanged, too soon
    recordSamples(home, [s(NOW + 6 * MIN, 12)], NOW + 6 * MIN); // changed
    recordSamples(home, [s(NOW + 17 * MIN, 12)], NOW + 17 * MIN); // unchanged, 11 min later
    expect(readHistory(home).map((x) => x.used)).toEqual([10, 12, 12]);
  });

  test("samples older than 35 days are pruned on rewrite", () => {
    const old = { t: NOW - 40 * DAY, account: "a", window: "weekly", used: 5, resetsAt: null };
    write(".cache/harnery/devtools/history.jsonl", `${JSON.stringify(old)}\n`);
    const kept = recordSamples(home, [{ ...old, t: NOW, used: 6 }], NOW);
    expect(kept.map((x) => x.used)).toEqual([6]);
    const lines = readFileSync(historyPath(home), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("recent rate: samples in the current window over the lookback", () => {
    const reset = new Date(NOW + 2 * HOUR).toISOString();
    const prevReset = new Date(NOW - 3 * HOUR).toISOString();
    const samples: UsageSample[] = [
      // previous window: ignored
      { t: NOW - 4 * HOUR, account: "a", window: "5h", used: 90, resetsAt: prevReset },
      // current window, older than the 90-minute lookback: ignored
      { t: NOW - 2 * HOUR, account: "a", window: "5h", used: 5, resetsAt: reset },
      { t: NOW - 60 * MIN, account: "a", window: "5h", used: 10, resetsAt: reset },
      { t: NOW - 30 * MIN, account: "a", window: "5h", used: 15, resetsAt: reset },
      { t: NOW, account: "a", window: "5h", used: 20, resetsAt: reset },
      // another account: ignored
      { t: NOW, account: "b", window: "5h", used: 99, resetsAt: reset },
    ];
    const r = recentFor(
      samples,
      { account: "a", window: "5h" },
      {
        resetsAt: reset,
        durationMs: 5 * HOUR,
        now: NOW,
      },
    );
    expect(r?.lookbackMs).toBe(90 * MIN);
    expect(r?.points).toEqual([
      [NOW - 60 * MIN, 10],
      [NOW - 30 * MIN, 15],
      [NOW, 20],
    ]);
    expect(r?.ratePerHour).toBe(10);
    expect(r?.sinceMs).toBe(NOW - 60 * MIN);
  });

  test("recent rate restarts after a drop and needs a fifth of the lookback", () => {
    const samples: UsageSample[] = [
      { t: NOW - 20 * HOUR, account: "a", window: "weekly", used: 60, resetsAt: null },
      { t: NOW - 10 * HOUR, account: "a", window: "weekly", used: 70, resetsAt: null },
      // a reset grant cleared usage
      { t: NOW - 2 * HOUR, account: "a", window: "weekly", used: 1, resetsAt: null },
      { t: NOW, account: "a", window: "weekly", used: 3, resetsAt: null },
    ];
    const r = recentFor(
      samples,
      { account: "a", window: "weekly" },
      {
        resetsAt: null,
        durationMs: 7 * DAY,
        now: NOW,
      },
    );
    expect(r?.points.map((p) => p[1])).toEqual([1, 3]);
    // 2h span < 20% of the 24h lookback
    expect(r?.ratePerHour).toBeNull();
  });

  test("points are thinned to 24, keeping both ends", () => {
    const samples: UsageSample[] = Array.from({ length: 100 }, (_, i) => ({
      t: NOW - (99 - i) * MIN,
      account: "a",
      window: "cursor:total",
      used: i,
      resetsAt: null,
    }));
    const r = recentFor(
      samples,
      { account: "a", window: "cursor:total" },
      {
        resetsAt: null,
        durationMs: null,
        now: NOW,
      },
    );
    expect(r?.points).toHaveLength(24);
    expect(r?.points[0]).toEqual([NOW - 99 * MIN, 0]);
    expect(r?.points[23]).toEqual([NOW, 99]);
  });

  test("lookbacks by window", () => {
    expect(lookbackFor("5h", 5 * HOUR)).toBe(90 * MIN);
    expect(lookbackFor("weekly · Fable", 7 * DAY)).toBe(DAY);
    expect(lookbackFor("cursor:api", null)).toBe(3 * DAY);
    expect(lookbackFor("2h", 2 * HOUR)).toBe(30 * MIN);
    expect(lookbackFor("unknown", null)).toBe(DAY);
  });
});
