/**
 * Tests for multi-account discovery and the usage source chain (ADR 0273):
 * stores are found in a synthetic home (never the real one or a Windows
 * mount), grouped per account, and each account's usage comes from the first
 * source that answers. Network and process calls are injected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { enrichFromApi, readDevtools, type ToolStatus } from "../../src/lib/devtools.ts";
import {
  type CliproxyConfig,
  discoverStores,
  groupAccounts,
  resolveCliproxyConfigs,
} from "../../src/lib/devtools-accounts.ts";
import { removeDir } from "../helpers/remove-dir.ts";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");
// Token validity is checked against the real clock, so fixtures use fixed far epochs.
const VALID_MS = Date.parse("2099-01-01T00:00:00.000Z");
const EXPIRED_MS = Date.parse("2000-01-01T00:00:00.000Z");
const VALID_S = Math.floor(VALID_MS / 1000);

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "devtools-accounts-"));
});
afterEach(() => {
  removeDir(home);
});

function write(rel: string, value: unknown) {
  const p = path.join(home, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
}

function claudeDir(
  rel: string,
  opts: { token?: string; accessExp?: number; refreshExp?: number; uuid?: string; email?: string },
) {
  write(`${rel}/.credentials.json`, {
    claudeAiOauth: {
      accessToken: opts.token ?? "",
      expiresAt: opts.accessExp ?? VALID_MS,
      refreshTokenExpiresAt: opts.refreshExp ?? VALID_MS,
      subscriptionType: "team",
    },
  });
  if (opts.uuid) {
    write(`${rel}/.claude.json`, {
      oauthAccount: { accountUuid: opts.uuid, emailAddress: opts.email, organizationUuid: "org-1" },
    });
  }
}

function tool(tools: ToolStatus[], name: string): ToolStatus {
  const t = tools.find((x) => x.tool === name);
  if (!t) throw new Error(`no ${name}`);
  return t;
}

type Call = { url: string; headers: Record<string, string>; body?: string };
function recordingFetch(
  handler: (c: Call) => { status: number; body: unknown; headers?: Record<string, string> },
) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const c: Call = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const CLAUDE_OK = { five_hour: { utilization: 12, resets_at: "2099-01-01T00:00:00Z" } };
const CODEX_OK = {
  plan_type: "pro",
  rate_limit: {
    primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: VALID_S },
    secondary_window: null,
  },
  credits: { has_credits: true, unlimited: false, balance: "10.5" },
};

describe("discovery + grouping", () => {
  test("finds every Claude and Codex store and groups copies of one account", () => {
    // Default dir signed out, but its .claude.json still names account A.
    claudeDir(".claude", { uuid: "uuid-A", email: "a@example.com" });
    write(".claude.json", {
      oauthAccount: { accountUuid: "uuid-A", emailAddress: "a@example.com" },
    });
    claudeDir(".claude_work", { token: "tok-A", uuid: "uuid-A", email: "a@example.com" });
    claudeDir(".claude_other", { token: "tok-B", uuid: "uuid-B", email: "b@example.com" });
    write(".cli-proxy-api/claude-a.json", {
      type: "claude",
      access_token: "proxy-A",
      account_uuid: "uuid-A",
      email: "a@example.com",
      expired: "2099-01-01T00:00:00Z",
    });
    write(".codex/auth.json", {
      tokens: {
        access_token: jwt({ exp: VALID_S }),
        id_token: jwt({
          email: "c@example.com",
          "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acct-C" },
        }),
        account_id: "acct-C",
      },
    });
    write(".codex-alt/auth.json", {
      tokens: { access_token: jwt({ exp: VALID_S }), account_id: "acct-D" },
    });
    write(".cli-proxy-api/codex-c.json", {
      type: "codex",
      access_token: "proxy-C",
      account_id: "acct-C",
      expired: "2099-01-01T00:00:00Z",
    });
    // CLI Proxy bookkeeping files are not accounts.
    write(".cli-proxy-api/codex-c.json.lock", "");
    write(".cli-proxy-api/api-key.txt", "x");

    const stores = discoverStores({ home, now: NOW, includeHost: false });
    const groups = groupAccounts(stores);
    const claude = groups.filter((g) => g.tool === "claude-code");
    const codex = groups.filter((g) => g.tool === "codex");
    expect(claude).toHaveLength(2);
    expect(codex).toHaveLength(2);

    const a = claude.find((g) => g.identity.accountId === "uuid-A");
    expect(a?.stores.map((s) => path.basename(s.path))).toEqual([
      ".claude",
      ".claude_work",
      "claude-a.json", // CLI Proxy copies come after the account's own stores
    ]);
    expect(a?.stores[0]?.loggedIn).toBe(false);
    expect(codex.find((g) => g.identity.accountId === "acct-C")?.stores).toHaveLength(2);

    // The report lists accounts, signed-in first, with no token strings.
    const report = readDevtools({ home, now: NOW });
    const cc = tool(report.tools, "claude-code");
    expect(cc.accounts.map((x) => x.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(cc.accounts[0]?.stores.map((s) => s.kind)).toEqual([
      "claude-dir",
      "claude-dir",
      "cliproxy-file",
    ]);
    expect(cc.account).toBe("a@example.com");
    expect(tool(report.tools, "codex").accounts).toHaveLength(2);
    const json = JSON.stringify(report);
    for (const secret of ["tok-A", "tok-B", "proxy-A", "proxy-C"])
      expect(json).not.toContain(secret);
  });

  test("honors CLAUDE_CONFIG_DIR and CODEX_HOME from the given env", () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "devtools-env-"));
    try {
      mkdirSync(path.join(elsewhere, "claude"), { recursive: true });
      writeFileSync(
        path.join(elsewhere, "claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: VALID_MS } }),
      );
      mkdirSync(path.join(elsewhere, "codex"), { recursive: true });
      writeFileSync(
        path.join(elsewhere, "codex", "auth.json"),
        JSON.stringify({ tokens: { access_token: jwt({ exp: VALID_S }), account_id: "acct-E" } }),
      );
      const stores = discoverStores({
        home,
        includeHost: false,
        env: {
          CLAUDE_CONFIG_DIR: path.join(elsewhere, "claude"),
          CODEX_HOME: path.join(elsewhere, "codex"),
        },
      });
      expect(stores.map((s) => s.storeKind)).toEqual(["claude-dir", "codex-home"]);
    } finally {
      removeDir(elsewhere);
    }
  });
});

describe("source chain", () => {
  test("an expired own token is skipped; the CLI Proxy file's token answers directly", async () => {
    claudeDir(".claude_work", {
      token: "tok-expired",
      accessExp: EXPIRED_MS,
      uuid: "uuid-A",
      email: "a@example.com",
    });
    write(".cli-proxy-api/claude-a.json", {
      type: "claude",
      access_token: "proxy-fresh",
      account_uuid: "uuid-A",
      expired: "2099-01-01T00:00:00Z",
    });
    const { fn, calls } = recordingFetch(() => ({ status: 200, body: CLAUDE_OK }));
    const report = readDevtools({ home, now: NOW, only: ["claude-code"] });
    await enrichFromApi(report, { home, fetch: fn, cacheTtlMs: 0, cliproxy: null });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.Authorization).toBe("Bearer proxy-fresh");
    const acct = tool(report.tools, "claude-code").accounts[0];
    expect(acct?.source).toBe("direct");
    expect(acct?.sourceDetail).toContain("cliproxy-file");
    expect(acct?.quota?.[0]).toMatchObject({ window: "5h", usedPercent: 12 });
    expect(acct?.notes.some((n) => n.includes("token expired, skipped"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("proxy-fresh");
  });

  function seedCodex() {
    write(".codex/auth.json", {
      tokens: { access_token: jwt({ exp: VALID_S }), account_id: "acct-C" },
    });
    // A local snapshot the chain can fall back to.
    write(
      ".codex/sessions/2026/07/12/rollout-2026-07-12T00-00-00-x.jsonl",
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: { primary: { used_percent: 77, window_minutes: 300, resets_at: VALID_S } },
        },
      }),
    );
  }
  const proxy: CliproxyConfig[] = [
    { urls: ["http://127.0.0.1:1", "http://10.0.0.2:1"], key: "mgmt", source: "env" },
  ];
  const listing = {
    files: [
      {
        auth_index: "idx-1",
        type: "codex",
        email: "c@example.com",
        name: "codex-c.json",
        id_token: { chatgpt_account_id: "acct-C" },
      },
    ],
  };

  test("direct fails → app-server fails → CLI Proxy answers (in that order)", async () => {
    seedCodex();
    const order: string[] = [];
    const { fn, calls } = recordingFetch((c) => {
      if (c.url.startsWith("http://127.0.0.1:1")) throw new Error("connection refused");
      if (c.url.endsWith("/wham/usage")) {
        order.push("direct");
        return { status: 401, body: {} };
      }
      if (c.url.endsWith("/v0/management/auth-files")) return { status: 200, body: listing };
      if (c.url.endsWith("/v0/management/api-call")) {
        // The reset-credit list rides the same route after the usage read.
        if (JSON.parse(c.body ?? "{}").url?.endsWith("/rate-limit-reset-credits"))
          return { status: 200, body: { status_code: 200, body: JSON.stringify({ credits: [] }) } };
        order.push("cliproxy");
        return { status: 200, body: { status_code: 200, body: JSON.stringify(CODEX_OK) } };
      }
      return { status: 404, body: {} };
    });
    const report = readDevtools({ home, now: NOW, only: ["codex"] });
    expect(report.tools[0]?.accounts[0]?.source).toBe("snapshot");
    await enrichFromApi(report, {
      home,
      fetch: fn,
      cacheTtlMs: 0,
      cliproxy: proxy,
      codexAppServer: async () => {
        order.push("app-server");
        return { ok: false, reason: "codex not on PATH" };
      },
    });
    expect(order).toEqual(["direct", "app-server", "cliproxy"]);
    const acct = report.tools[0]?.accounts[0];
    expect(acct?.source).toBe("cliproxy");
    expect(acct?.stale).toBe(false);
    expect(acct?.plan).toBe("pro");
    expect(acct?.quota?.[0]).toMatchObject({ window: "weekly", usedPercent: 5 });
    expect(acct?.credits?.balance).toBe(10.5);
    expect(acct?.notes.some((n) => n.startsWith("direct") && n.includes("HTTP 401"))).toBe(true);
    // The api-call carries the account header and the $TOKEN$ placeholder, not a token.
    const call = calls.find((c) => c.url.endsWith("/api-call"));
    const body = JSON.parse(call?.body ?? "{}");
    expect(body.auth_index).toBe("idx-1");
    expect(body.header.Authorization).toBe("Bearer $TOKEN$");
    expect(body.header["ChatGPT-Account-Id"]).toBe("acct-C");
    // The loopback URL failed, so the host-IP candidate served the listing.
    expect(call?.url.startsWith("http://10.0.0.2:1")).toBe(true);
  });

  test("app-server answers when direct fails; CLI Proxy is not called", async () => {
    seedCodex();
    const { fn, calls } = recordingFetch(() => ({ status: 500, body: {} }));
    const homes: string[] = [];
    const report = readDevtools({ home, now: NOW, only: ["codex"] });
    await enrichFromApi(report, {
      home,
      fetch: fn,
      cacheTtlMs: 0,
      cliproxy: proxy,
      codexAppServer: async (h) => {
        homes.push(h);
        return {
          ok: true,
          result: {
            rateLimits: {
              primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: VALID_S },
              secondary: null,
              planType: "plus",
            },
          },
        };
      },
    });
    expect(homes).toEqual([path.join(home, ".codex")]);
    expect(calls.some((c) => c.url.includes("/v0/management/"))).toBe(false);
    const acct = report.tools[0]?.accounts[0];
    expect(acct?.source).toBe("codex-app-server");
    expect(acct?.quota?.[0]).toMatchObject({ window: "5h", usedPercent: 9 });
  });

  test("every source failing keeps the local snapshot, marked stale", async () => {
    seedCodex();
    const { fn } = recordingFetch(() => ({ status: 500, body: {} }));
    const report = readDevtools({ home, now: NOW, only: ["codex"] });
    await enrichFromApi(report, {
      home,
      fetch: fn,
      cacheTtlMs: 0,
      cliproxy: null,
      codexAppServer: null,
    });
    const acct = report.tools[0]?.accounts[0];
    expect(acct?.source).toBe("snapshot");
    expect(acct?.stale).toBe(true);
    expect(acct?.quota?.[0]).toMatchObject({ usedPercent: 77 });
    expect(acct?.notes).toContain("cliproxy: not configured");
  });
});

describe("CLI Proxy settings", () => {
  test("reads an app's saved usage-limit source and its secret key", () => {
    write(".t3/userdata/settings.json", {
      usageLimitSources: {
        "office-pc": {
          kind: "cliproxy",
          url: "http://127.0.0.1:8317",
          managementKey: "••••••",
          enabled: true,
        },
        off: { kind: "cliproxy", url: "http://x:1", managementKey: "k", enabled: false },
      },
    });
    // base64url("office-pc") without padding = b2ZmaWNlLXBj
    write(".t3/userdata/secrets/usage-limit-source-b2ZmaWNlLXBj.bin", "secret-key\n");
    const cfgs = resolveCliproxyConfigs({
      home,
      includeHost: false,
      env: {},
      hostIps: ["172.20.0.1"],
    });
    expect(cfgs).toEqual([
      {
        urls: ["http://127.0.0.1:8317", "http://172.20.0.1:8317"],
        key: "secret-key",
        source: "app-settings",
      },
    ]);
  });

  test("env wins, then Harnery's own file; duplicate keys merge", () => {
    write(".config/harnery/cliproxy.json", { url: "http://file:2", key: "k2" });
    const cfgs = resolveCliproxyConfigs({
      home,
      includeHost: false,
      env: { HARNERY_CLIPROXY_URL: "http://env:1/", HARNERY_CLIPROXY_KEY: "k1" },
      hostIps: [],
    });
    expect(cfgs.map((c) => [c.source, c.urls[0]])).toEqual([
      ["env", "http://env:1"],
      ["file", "http://file:2"],
    ]);
  });
});

describe("Cursor", () => {
  function seedIde(token: string) {
    const gs = path.join(home, ".config", "Cursor", "User", "globalStorage");
    mkdirSync(gs, { recursive: true });
    const { Database } = require("bun:sqlite");
    const db = new Database(path.join(gs, "state.vscdb"));
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    const put = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    put.run("cursorAuth/accessToken", token);
    put.run(
      "cursorAuth/cachedScopedProfile",
      JSON.stringify({ authId: "auth0|user_ABC", displayName: "x" }),
    );
    put.run("cursorAuth/cachedEmail", "u@example.com");
    put.run("cursorAuth/stripeMembershipType", "pro");
    put.finalize();
    db.close();
  }

  test("an opaque IDE token is accepted; the CLI JWT for the same user is tried first", async () => {
    seedIde("opaque-ide-token");
    write(".config/cursor/auth.json", {
      accessToken: jwt({ sub: "auth0|user_ABC", exp: VALID_S }),
      refreshToken: "r",
    });
    const report = readDevtools({ home, now: NOW, only: ["cursor"] });
    const cu = tool(report.tools, "cursor");
    expect(cu.accounts).toHaveLength(1);
    expect(cu.accounts[0]?.id).toBe("cursor:user_ABC");
    expect(cu.accounts[0]?.email).toBe("u@example.com");
    expect(cu.accounts[0]?.stores.map((s) => s.kind)).toEqual(["cursor-cli", "cursor-ide"]);

    const { fn, calls } = recordingFetch((c) =>
      c.url.includes("api2.cursor.sh") && c.headers.Authorization?.startsWith("Bearer ey")
        ? {
            status: 200,
            body: {
              billingCycleEnd: "1786305644000",
              planUsage: { totalPercentUsed: 16.2, apiPercentUsed: 71.8, autoPercentUsed: 10.6 },
            },
          }
        : { status: 401, body: {} },
    );
    await enrichFromApi(report, { home, fetch: fn, cacheTtlMs: 0, cursorKey: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["Connect-Protocol-Version"]).toBe("1");
    expect(cu.accounts[0]?.source).toBe("direct");
    expect(cu.accounts[0]?.sourceDetail).toContain("cursor-cli");
    expect(cu.usage?.totalPercentUsed).toBe(16.2);
    expect(JSON.stringify(report)).not.toContain("opaque-ide-token");
  });

  test("an IDE-only opaque token reaches the API route with its profile user id", async () => {
    seedIde("opaque-ide-token");
    const { fn, calls } = recordingFetch(() => ({
      status: 200,
      body: { planUsage: { totalPercentUsed: 1 } },
    }));
    const report = readDevtools({ home, now: NOW, only: ["cursor"] });
    await enrichFromApi(report, { home, fetch: fn, cacheTtlMs: 0, cursorKey: null });
    expect(calls[0]?.headers.Authorization).toBe("Bearer opaque-ide-token");
    expect(tool(report.tools, "cursor").accounts[0]?.loggedIn).toBe(true);
  });
});
