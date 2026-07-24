import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeBilling } from "./billing.ts";
import { buildChildEnv } from "./child-env.ts";

let home: string;

beforeEach(() => {
  home = join(
    tmpdir(),
    `billing-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("probeBilling: claude-code", () => {
  const io = (env: NodeJS.ProcessEnv = {}) => ({ env, home });

  test("credentials file with token, no key → subscription", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }),
    );
    const p = probeBilling("claude-code", io());
    expect(p.login).toBe("present");
    expect(p.mode).toBe("subscription");
  });

  test("key exported AND login present → api-key-override", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }),
    );
    const p = probeBilling("claude-code", io({ ANTHROPIC_API_KEY: "sk-x" }));
    expect(p.mode).toBe("api-key-override");
    expect(p.apiKeySource).toBe("ANTHROPIC_API_KEY");
  });

  test("key exported, no ~/.claude at all → api-key (deliberate key-only host)", () => {
    const p = probeBilling("claude-code", io({ ANTHROPIC_API_KEY: "sk-x" }));
    expect(p.login).toBe("absent");
    expect(p.mode).toBe("api-key");
  });

  test("~/.claude dir without credentials file (macOS keychain) → login unknown, never override", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const p = probeBilling("claude-code", io({ ANTHROPIC_API_KEY: "sk-x" }));
    expect(p.login).toBe("unknown");
    expect(p.mode).toBe("api-key");
  });

  test("credentials file without a token → login absent", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({}));
    expect(probeBilling("claude-code", io()).login).toBe("absent");
  });
});

describe("probeBilling: codex", () => {
  const io = (env: NodeJS.ProcessEnv = {}) => ({ env, home });

  test("auth.json with tokens → subscription login", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id: "x" } }));
    const p = probeBilling("codex", io());
    expect(p.login).toBe("present");
    expect(p.mode).toBe("subscription");
  });

  test("auth.json with only a stored API key → api-key mode with file source", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
    const p = probeBilling("codex", io());
    expect(p.login).toBe("absent");
    expect(p.apiKeyPresent).toBe(true);
    expect(p.apiKeySource).toContain("(stored key)");
    expect(p.mode).toBe("api-key");
  });

  test("env key over ChatGPT login → api-key-override; CODEX_HOME respected", () => {
    const codexHome = join(home, "custom-codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { id: "x" } }));
    const p = probeBilling("codex", io({ OPENAI_API_KEY: "sk-x", CODEX_HOME: codexHome }));
    expect(p.mode).toBe("api-key-override");
  });

  test("no auth.json → login absent", () => {
    expect(probeBilling("codex", io()).login).toBe("absent");
  });
});

describe("probeBilling: cursor", () => {
  test("login is always unknown (unverified storage), so override can never fire", () => {
    const p = probeBilling("cursor", { env: { CURSOR_API_KEY: "k" }, home });
    expect(p.login).toBe("unknown");
    expect(p.mode).toBe("api-key");
    expect(probeBilling("cursor", { env: {}, home }).mode).toBe("subscription");
  });
});

describe("buildChildEnv billing behavior", () => {
  const SAVED = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CURSOR_API_KEY",
    "CURSOR_SESSION",
    "CODEX_HOME",
    "CODEX_THREAD_ID",
  ];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of SAVED) saved.set(k, process.env[k]);
  });
  afterEach(() => {
    for (const k of SAVED) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("CURSOR_API_KEY survives the CURSOR* session scrub; session vars do not", () => {
    process.env.CURSOR_API_KEY = "key";
    process.env.CURSOR_SESSION = "sess";
    const env = buildChildEnv("wf-1");
    expect(env.CURSOR_API_KEY).toBe("key");
    expect(env.CURSOR_SESSION).toBeUndefined();
  });

  test("CODEX_HOME survives the CODEX* session scrub; thread identity does not", () => {
    process.env.CODEX_HOME = "/tmp/codex-auth-home";
    process.env.CODEX_THREAD_ID = "thread-1";
    const env = buildChildEnv("wf-1");
    expect(env.CODEX_HOME).toBe("/tmp/codex-auth-home");
    expect(env.CODEX_THREAD_ID).toBeUndefined();
  });

  test("subscriptionOnly deletes every API-key var", () => {
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.OPENAI_API_KEY = "b";
    process.env.CURSOR_API_KEY = "c";
    const env = buildChildEnv("wf-1", { subscriptionOnly: true });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.HARNERY_WORKFLOW_CHILD).toBe("1");
    expect(env.HARNERY_WORKFLOW_RUN_ID).toBe("wf-1");
  });

  test("without subscriptionOnly, non-colliding key vars pass through", () => {
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.OPENAI_API_KEY = "b";
    const env = buildChildEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("a");
    expect(env.OPENAI_API_KEY).toBe("b");
  });
});
