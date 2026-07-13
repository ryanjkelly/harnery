/**
 * Fixture tests for src/lib/devtools.ts: builds a fake home with each agent
 * tool's on-disk layout and asserts the reader extracts login/plan/expiry/
 * quota/session signals from local files only (no network).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enrichFromApi,
  readDevtools,
  resolveCursorApiKey,
  type ToolStatus,
} from "../../src/lib/devtools.ts";

const NOW = Date.parse("2026-07-13T00:00:00.000Z");

/** Minimal JWT with the given claims (unsigned; only the payload is decoded). */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

let home: string;

function byTool(tools: ToolStatus[], name: string): ToolStatus {
  const t = tools.find((x) => x.tool === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "devtools-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("readDevtools — empty home", () => {
  test("all tools report not installed", () => {
    const { tools } = readDevtools({ home, now: NOW });
    expect(tools).toHaveLength(3);
    for (const t of tools) {
      expect(t.installed).toBe(false);
      expect(t.notes.join(" ")).toContain("not found");
    }
  });
});

describe("readDevtools — claude-code", () => {
  test("parses oauth creds + account metadata + session count", () => {
    const dir = path.join(home, ".claude");
    mkdirSync(path.join(dir, "projects", "proj-a"), { recursive: true });
    writeFileSync(
      path.join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "secret-should-not-surface",
          expiresAt: NOW + 3_600_000,
          refreshTokenExpiresAt: NOW + 30 * 86_400_000,
          subscriptionType: "team",
          rateLimitTier: "default_claude_max_5x",
        },
      }),
    );
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          emailAddress: "dev@example.com",
          seatTier: "team_tier_1",
          userRateLimitTier: "default_claude_max_5x",
        },
      }),
    );
    writeFileSync(path.join(dir, "projects", "proj-a", "s1.jsonl"), "{}\n");
    writeFileSync(path.join(dir, "projects", "proj-a", "s2.jsonl"), "{}\n");

    const cc = byTool(readDevtools({ home, now: NOW }).tools, "claude-code");
    expect(cc.installed).toBe(true);
    expect(cc.loggedIn).toBe(true);
    expect(cc.account).toBe("dev@example.com");
    expect(cc.plan).toBe("team_tier_1"); // seat tier wins over subscriptionType
    expect(cc.sessions).toBe(2);
    expect(cc.quota).toBeNull(); // server-side
    expect(JSON.stringify(cc)).not.toContain("secret-should-not-surface");
  });

  test("--usage sums token fields from assistant transcript lines", () => {
    const dir = path.join(home, ".claude", "projects", "p");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
      JSON.stringify({
        type: "assistant",
        message: { usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } },
      }),
      JSON.stringify({ type: "user" }),
    ].join("\n");
    writeFileSync(path.join(dir, "t.jsonl"), lines);

    const cc = byTool(readDevtools({ home, now: NOW, usage: true, windowDays: 3650 }).tools, "claude-code");
    expect(cc.tokensUsed).toBe(135);
  });

  test("expired refresh token => not logged in", () => {
    const dir = path.join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { expiresAt: NOW - 1000, refreshTokenExpiresAt: NOW - 1000, subscriptionType: "pro" },
      }),
    );
    const cc = byTool(readDevtools({ home, now: NOW }).tools, "claude-code");
    expect(cc.loggedIn).toBe(false);
  });
});

describe("readDevtools — codex", () => {
  test("reads session count + recency from state_5.sqlite; live plan from rollout", () => {
    const dir = path.join(home, ".codex");
    const day = path.join(dir, "sessions", "2026", "07", "11");
    mkdirSync(day, { recursive: true });
    mkdirSync(path.join(dir, "sqlite"), { recursive: true });
    writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "at-secret",
          id_token: jwt({
            email: "codex@example.com",
            exp: Math.floor((NOW + 86_400_000) / 1000),
            "https://api.openai.com/auth": { chatgpt_plan_type: "team" }, // stale
          }),
        },
      }),
    );
    const rollout = path.join(day, "rollout-2026-07-11T00-00-00-abc.jsonl");
    writeFileSync(
      rollout,
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            plan_type: "plus", // live plan should win over the id_token's "team"
            primary: { used_percent: 6, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 3600 },
          },
        },
      }),
    );
    // state_5.sqlite: two threads, newest points at the rollout above.
    const { Database } = require("bun:sqlite");
    const db = new Database(path.join(dir, "sqlite", "state_5.sqlite"));
    db.run(
      "CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at_ms INTEGER, tokens_used INTEGER)",
    );
    const put = db.prepare(
      "INSERT INTO threads (id, rollout_path, updated_at_ms, tokens_used) VALUES (?, ?, ?, ?)",
    );
    put.run("t1", rollout, Date.parse("2026-07-11T00:00:00Z"), 1000);
    put.run("t2", "/nonexistent/old.jsonl", Date.parse("2026-07-01T00:00:00Z"), 500);
    db.close();

    const cx = byTool(readDevtools({ home, now: NOW, usage: true }).tools, "codex");
    expect(cx.sessions).toBe(2); // from state_5.sqlite, not the single rollout file
    expect(cx.plan).toBe("plus"); // live rate-limit plan overrides the stale id_token
    expect(cx.tokensUsed).toBe(1500); // sum of tokens_used across threads
    expect(cx.lastActivity).toBe("2026-07-11T00:00:00.000Z");
    expect(cx.quota?.[0]).toEqual({
      window: "5h",
      usedPercent: 6,
      resetsAt: new Date((Math.floor(NOW / 1000) + 3600) * 1000).toISOString(),
    });
    expect(JSON.stringify(cx)).not.toContain("at-secret");
  });

  test("falls back to rollout glob + id_token plan when no state DB exists", () => {
    const dir = path.join(home, ".codex");
    const day = path.join(dir, "sessions", "2026", "07", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "at-secret",
          id_token: jwt({
            email: "codex@example.com",
            exp: Math.floor((NOW + 86_400_000) / 1000),
            "https://api.openai.com/auth": { chatgpt_plan_type: "team" },
          }),
        },
      }),
    );
    const rollout = [
      JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { total_tokens: 4242 } },
          rate_limits: {
            plan_type: "team",
            primary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 3600 },
            secondary: { used_percent: 40, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) + 86400 },
          },
        },
      }),
    ].join("\n");
    writeFileSync(path.join(day, "rollout-2026-07-01T00-00-00-abc.jsonl"), rollout);

    const cx = byTool(readDevtools({ home, now: NOW, usage: true, windowDays: 3650 }).tools, "codex");
    expect(cx.installed).toBe(true);
    expect(cx.loggedIn).toBe(true);
    expect(cx.account).toBe("codex@example.com");
    expect(cx.plan).toBe("team");
    expect(cx.sessions).toBe(1);
    expect(cx.quota).toEqual([
      { window: "5h", usedPercent: 12, resetsAt: new Date((Math.floor(NOW / 1000) + 3600) * 1000).toISOString() },
      { window: "weekly", usedPercent: 40, resetsAt: new Date((Math.floor(NOW / 1000) + 86400) * 1000).toISOString() },
    ]);
    expect(cx.tokensUsed).toBe(4242);
    expect(JSON.stringify(cx)).not.toContain("at-secret");
  });
});

describe("readDevtools — cursor", () => {
  test("reads account/plan/subscription + session count from state.vscdb", () => {
    const dir = path.join(home, ".cursor");
    mkdirSync(dir, { recursive: true });
    const gsDir = path.join(home, ".config", "Cursor", "User", "globalStorage");
    mkdirSync(gsDir, { recursive: true });
    const dbPath = path.join(gsDir, "state.vscdb");

    // Build a real VS Code ItemTable so the reader exercises its SQLite path.
    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    const put = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    put.run("cursorAuth/cachedEmail", "dev@example.com");
    put.run("cursorAuth/stripeMembershipType", "pro_plus");
    put.run("cursorAuth/stripeSubscriptionStatus", "active");
    put.run("cursorAuth/accessToken", "secret-should-not-surface");
    put.run(
      "composer.composerHeaders",
      JSON.stringify({
        allComposers: [
          { composerId: "a", lastUpdatedAt: Date.parse("2026-07-01T00:00:00Z") },
          { composerId: "b", lastUpdatedAt: Date.parse("2026-07-05T00:00:00Z") },
        ],
      }),
    );
    db.close();

    const cu = byTool(readDevtools({ home, now: NOW }).tools, "cursor");
    expect(cu.installed).toBe(true);
    expect(cu.loggedIn).toBe(true);
    expect(cu.account).toBe("dev@example.com");
    expect(cu.plan).toBe("pro_plus");
    expect(cu.sessions).toBe(2);
    expect(cu.lastActivity).toBe("2026-07-05T00:00:00.000Z");
    expect(cu.quota).toBeNull();
    expect(cu.notes.join(" ")).toContain("subscription active");
    expect(cu.notes.join(" ")).toContain("server-side");
    expect(JSON.stringify(cu)).not.toContain("secret-should-not-surface");
  });

  test("falls back to login-presence when no vscdb is present", () => {
    const dir = path.join(home, ".cursor");
    mkdirSync(path.join(dir, "projects", "proj-x"), { recursive: true });
    writeFileSync(path.join(dir, "statsig-cache.json"), JSON.stringify({ userID: "user-abc", data: {} }));
    const serverDir = path.join(home, ".cursor-server");
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(path.join(serverDir, ".deadbeef.token"), "tok");

    const cu = byTool(readDevtools({ home, now: NOW }).tools, "cursor");
    expect(cu.installed).toBe(true);
    expect(cu.loggedIn).toBe(true);
    expect(cu.account).toBe("user-abc");
    expect(cu.sessions).toBe(1);
    expect(cu.notes.join(" ")).toContain("login-presence only");
  });
});

describe("enrichFromApi — cursor Cloud Agent API", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.CURSOR_API_KEY;
  });

  function mockCursor(routes: Record<string, { status: number; body: unknown }>) {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      for (const [suffix, r] of Object.entries(routes)) {
        if (u.endsWith(suffix)) return new Response(JSON.stringify(r.body), { status: r.status });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  }

  test("valid key populates api.ok + cloudAgents (active = non-terminal statuses)", async () => {
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    mockCursor({
      "/v0/me": { status: 200, body: { apiKeyName: "dev-ai", userEmail: "x@example.com" } },
      "/v0/agents": {
        status: 200,
        body: { agents: [{ status: "EXPIRED" }, { status: "RUNNING" }, { status: "FINISHED" }] },
      },
    });
    const report = readDevtools({ home, now: NOW, only: ["cursor"] });
    await enrichFromApi(report, { cursorKey: "crsr_test" });
    const cu = byTool(report.tools, "cursor");
    expect(cu.api?.ok).toBe(true);
    expect(cu.api?.keyName).toBe("dev-ai");
    expect(cu.api?.cloudAgents).toEqual({ total: 3, active: 1 });
    // Success is carried by the structured `api` fields; no redundant note added.
    expect(cu.notes.some((n) => n.includes("not usable"))).toBe(false);
  });

  test("invalid key sets api.ok=false with an error note, never throws", async () => {
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    mockCursor({ "/v0/me": { status: 401, body: { message: "Invalid" } } });
    const report = readDevtools({ home, now: NOW, only: ["cursor"] });
    await enrichFromApi(report, { cursorKey: "crsr_bad" });
    const cu = byTool(report.tools, "cursor");
    expect(cu.api?.ok).toBe(false);
    expect(cu.api?.error).toContain("401");
  });

  test("no key leaves api null (no network)", async () => {
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const report = readDevtools({ home, now: NOW, only: ["cursor"] });
    await enrichFromApi(report, { cursorKey: null });
    expect(byTool(report.tools, "cursor").api).toBeNull();
    expect(called).toBe(false);
  });

  test("resolveCursorApiKey prefers the CURSOR_API_KEY env var", () => {
    process.env.CURSOR_API_KEY = "crsr_env";
    expect(resolveCursorApiKey()).toBe("crsr_env");
  });
});

describe("readDevtools — only filter", () => {
  test("restricts to requested tools", () => {
    const { tools } = readDevtools({ home, now: NOW, only: ["codex"] });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool).toBe("codex");
  });
});
