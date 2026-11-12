import { expect, mock, test } from "claude-code/testing";

// Runs with `claude plugin test claude-code-plugin`. Each test loads the hooks
// module fresh and answers every Claude Code call with a stub, so no model,
// file or session is touched.

const HOME = "/home/tester";
const PREFS = `${HOME}/.config/harnery/preferences.json`;
const USAGE_DIR = `${HOME}/.cache/harnery/helpers`;

interface Setup {
  files?: Record<string, string>;
  env?: Record<string, string>;
  version?: string;
  cwd?: string;
  failRead?: boolean;
  /** Paths whose read throws, as an unreadable file would. */
  failPaths?: string[];
  /** Leave HOME unset, as on native Windows. */
  noHome?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: the kit's `on` and `$` are untyped here.
function stubs(on: any, setup: Setup = {}) {
  const files = new Map(Object.entries(setup.files ?? {}));
  const sent: Array<{ model?: string; effort?: string; agentId?: string }> = [];
  mock.env(on, setup.noHome ? (setup.env ?? {}) : { HOME, ...(setup.env ?? {}) });
  on("session.version", () => ({ value: { version: setup.version ?? "2.1.310" } }));
  on("session.cwd", () => ({ value: setup.cwd ?? "/work/app" }));
  on("session.id", () => ({ value: "sess:1/x" }));
  // A Windows-style path is not absolute on the test host, so Claude Code
  // resolves it against the working folder; match such keys by their ending.
  const key = (path: string) =>
    files.has(path) ? path : ([...files.keys()].find((k) => path.endsWith(`/${k}`)) ?? path);
  on("fs.exists", (_$: unknown, e: { path: string }) => ({ value: files.has(key(e.path)) }));
  on("fs.read", (_$: unknown, e: { path: string }) =>
    setup.failRead || setup.failPaths?.includes(key(e.path))
      ? { deny: "read refused" }
      : { value: files.get(key(e.path)) ?? "" },
  );
  on("fs.write", (_$: unknown, e: { path: string; text: string }) => {
    files.set(e.path, e.text);
    return { value: undefined };
  });
  on("agent.spawn", (_$: unknown, e: { name?: string }) => ({
    model: "claude-sonnet-5-5",
    agentId: e.name ?? "helper-1",
  }));
  on(
    "turn.step",
    async function* (
      _$: unknown,
      e: { turnId: string; index: number; model?: string; effort?: string; agentId?: string },
    ) {
      sent.push({ model: e.model, effort: e.effort, agentId: e.agentId });
      yield { kind: "text", index: 0, text: "ok" };
      return {
        turnId: e.turnId,
        index: e.index,
        answer: "ok",
        toolUses: [],
        stopReason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          model: e.model === "haiku" ? "claude-haiku-5-5" : e.model,
        },
      };
    },
  );
  on("turn.complete", () => ({ text: "" }));
  return { files, sent };
}

// biome-ignore lint/suspicious/noExplicitAny: the kit's `$` is untyped here.
async function step($: any, input: Record<string, unknown>) {
  const stream = $.turn.step({ turnId: "t", index: 0, messageCount: 1, ...input });
  let item = await stream.next();
  while (item.done !== true) item = await stream.next();
  return item.value;
}

// biome-ignore lint/suspicious/noExplicitAny: the kit's `$` is untyped here.
async function complete($: any, agentId: string, model: string) {
  await $.turn.complete({
    turnId: "t",
    answer: "ok",
    durationMs: 1,
    isAborted: false,
    agentId,
    usage: { input_tokens: 12, output_tokens: 7, model },
  });
}

function usageLines(files: Map<string, string>) {
  const path = [...files.keys()].find((p) => p.startsWith(`${USAGE_DIR}/usage-`));
  if (!path) return { path: undefined, lines: [] };
  const lines = (files.get(path) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((raw) => JSON.parse(raw));
  return { path, lines };
}

const LIMIT = JSON.stringify({
  helpers: { "claude-code": { max_model: "haiku", max_effort: "low" } },
});

test("the main conversation's request is forwarded untouched", async ($, on) => {
  const { sent, files } = stubs(on, { files: { [PREFS]: LIMIT } });
  await step($, { model: "claude-opus-5-5", effort: "high" });
  expect(sent).toEqual([{ model: "claude-opus-5-5", effort: "high", agentId: undefined }]);
  expect(usageLines(files).lines).toEqual([]);
});

test("a helper above the limit is lowered and recorded", async ($, on) => {
  const { sent, files } = stubs(on, { files: { [PREFS]: LIMIT } });
  await $.agent.spawn({ subagentType: "general-purpose", name: "h1", prompt: "p" });
  const result = await step($, { model: "claude-sonnet-5-5", effort: "high", agentId: "h1" });
  expect(sent[0]).toEqual({ model: "haiku", effort: "low", agentId: "h1" });
  expect(result.usage.model).toBe("claude-haiku-5-5");
  await complete($, "h1", "claude-haiku-5-5");
  const { path, lines } = usageLines(files);
  expect(path).toMatch(/usage-\d{4}-\d{2}-\d{2}\.sess_1_x\.jsonl$/);
  expect(lines.length).toBe(1);
  expect(lines[0]).toMatchObject({
    tool: "claude-code",
    kind: "helper",
    session_id: "sess:1/x",
    agent_id: "h1",
    agent_type: "general-purpose",
    asked_model: "claude-sonnet-5-5",
    asked_effort: "high",
    sent_model: "haiku",
    sent_effort: "low",
    answered_model: "claude-haiku-5-5",
    input_tokens: 12,
    output_tokens: 7,
    lowered: true,
  });
});

test("a helper at or below the limit is left alone", async ($, on) => {
  const { sent } = stubs(on, { files: { [PREFS]: LIMIT } });
  await step($, { model: "claude-haiku-5-5", effort: "low", agentId: "h2" });
  expect(sent[0]).toEqual({ model: "claude-haiku-5-5", effort: "low", agentId: "h2" });
});

test("a fork is forwarded untouched and not recorded", async ($, on) => {
  const { sent, files } = stubs(on, { files: { [PREFS]: LIMIT } });
  await $.agent.spawn({ subagentType: "fork", fork: true, name: "f1", prompt: "p" });
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "f1" });
  await complete($, "f1", "claude-opus-5-5");
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "high", agentId: "f1" });
  expect(usageLines(files).lines).toEqual([]);
});

test("with no limit a helper is unchanged but still recorded", async ($, on) => {
  const { sent, files } = stubs(on);
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "h3" });
  await complete($, "h3", "claude-opus-5-5");
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "high", agentId: "h3" });
  const { lines } = usageLines(files);
  expect(lines.length).toBe(1);
  expect(lines[0]).toMatchObject({ agent_id: "h3", sent_model: "claude-opus-5-5", lowered: false });
});

test("lines from several helper turns accumulate in one file", async ($, on) => {
  const { files } = stubs(on);
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "a" });
  await complete($, "a", "claude-opus-5-5");
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "b" });
  await complete($, "b", "claude-opus-5-5");
  expect(usageLines(files).lines.map((l) => l.agent_id)).toEqual(["a", "b"]);
});

test("the skip switch turns the plugin off", async ($, on) => {
  const { sent, files } = stubs(on, {
    files: { [PREFS]: LIMIT },
    env: { HARNERY_HELPER_LIMIT_SKIP: "1" },
  });
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "h4" });
  await complete($, "h4", "claude-opus-5-5");
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "high", agentId: "h4" });
  expect(usageLines(files).lines).toEqual([]);
});

test("an older Claude Code is left alone", async ($, on) => {
  const { sent, files } = stubs(on, { files: { [PREFS]: LIMIT }, version: "2.1.300" });
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "h5" });
  await complete($, "h5", "claude-opus-5-5");
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "high", agentId: "h5" });
  expect(usageLines(files).lines).toEqual([]);
});

test("the project default applies, found by walking up from the working directory", async ($, on) => {
  const config = `{
    // project default
    "helpers": { "claude-code": { "max_model": "sonnet" /* model only */ } }
  }`;
  const { sent } = stubs(on, {
    cwd: "/work/app/pkg",
    files: { "/work/app/.harnery/config.jsonc": config },
  });
  await step($, { model: "claude-opus-5-5", effort: "max", agentId: "h6" });
  expect(sent[0]).toEqual({ model: "sonnet", effort: "max", agentId: "h6" });
});

test("the person's explicit no-limit beats the project default", async ($, on) => {
  const { sent } = stubs(on, {
    files: {
      [PREFS]: JSON.stringify({ helpers: { "claude-code": {} } }),
      "/work/app/.harnery/config.jsonc":
        '{ "helpers": { "claude-code": { "max_model": "haiku" } } }',
    },
  });
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "h7" });
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "high", agentId: "h7" });
});

test("XDG folders are honored", async ($, on) => {
  const { sent, files } = stubs(on, {
    env: { XDG_CONFIG_HOME: "/xdg/config", XDG_CACHE_HOME: "/xdg/cache" },
    files: { "/xdg/config/harnery/preferences.json": LIMIT },
  });
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "h8" });
  await complete($, "h8", "claude-haiku-5-5");
  expect(sent[0]).toEqual({ model: "haiku", effort: "low", agentId: "h8" });
  expect([...files.keys()].some((p) => p.startsWith("/xdg/cache/harnery/helpers/usage-"))).toBe(
    true,
  );
});

test("a failure inside the plugin forwards the request unchanged", async ($, on) => {
  const { sent } = stubs(on, { files: { [PREFS]: LIMIT }, failRead: true });
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "h9" });
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "high", agentId: "h9" });
});

const PROJECT_HAIKU = {
  "/work/app/.harnery/config.jsonc":
    '{ "helpers": { "claude-code": { "max_model": "haiku", "max_effort": "low" } } }',
};

test("absent preferences: the project default applies", async ($, on) => {
  const { sent } = stubs(on, { files: { ...PROJECT_HAIKU } });
  await step($, { model: "claude-opus-5-5", effort: "max", agentId: "p1" });
  expect(sent[0]).toEqual({ model: "haiku", effort: "low", agentId: "p1" });
});

test("valid preferences: the person's choice applies over the project default", async ($, on) => {
  const { sent } = stubs(on, {
    files: {
      ...PROJECT_HAIKU,
      [PREFS]: JSON.stringify({ helpers: { "claude-code": { max_model: "sonnet" } } }),
    },
  });
  await step($, { model: "claude-opus-5-5", effort: "max", agentId: "p2" });
  expect(sent[0]).toEqual({ model: "sonnet", effort: "max", agentId: "p2" });
});

test("preferences that cannot be read leave the request unchanged", async ($, on) => {
  const { sent } = stubs(on, { files: { ...PROJECT_HAIKU, [PREFS]: LIMIT }, failPaths: [PREFS] });
  await step($, { model: "claude-opus-5-5", effort: "max", agentId: "p3" });
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "max", agentId: "p3" });
});

test("preferences that do not parse leave the request unchanged", async ($, on) => {
  const { sent } = stubs(on, { files: { ...PROJECT_HAIKU, [PREFS]: "{ not json" } });
  await step($, { model: "claude-opus-5-5", effort: "max", agentId: "p4" });
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "max", agentId: "p4" });
});

test("preferences that are not an object leave the request unchanged", async ($, on) => {
  const { sent } = stubs(on, { files: { ...PROJECT_HAIKU, [PREFS]: "[1, 2]" } });
  await step($, { model: "claude-opus-5-5", effort: "max", agentId: "p5" });
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "max", agentId: "p5" });
});

test("a project config that cannot be read means no project default", async ($, on) => {
  const { sent } = stubs(on, {
    files: { ...PROJECT_HAIKU },
    failPaths: Object.keys(PROJECT_HAIKU),
  });
  await step($, { model: "claude-opus-5-5", effort: "max", agentId: "p6" });
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "max", agentId: "p6" });
});

test("a project config that does not parse means no project default", async ($, on) => {
  const { sent } = stubs(on, { files: { "/work/app/.harnery/config.jsonc": "{ helpers: " } });
  await step($, { model: "claude-opus-5-5", effort: "max", agentId: "p7" });
  expect(sent[0]).toEqual({ model: "claude-opus-5-5", effort: "max", agentId: "p7" });
});

test("Windows: USERPROFILE stands in for HOME", async ($, on) => {
  const profile = "C:\\Users\\tester";
  const { sent, files } = stubs(on, {
    noHome: true,
    env: { USERPROFILE: profile },
    files: { [`${profile}\\.config/harnery/preferences.json`]: LIMIT },
  });
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "w1" });
  await complete($, "w1", "claude-haiku-5-5");
  expect(sent[0]).toEqual({ model: "haiku", effort: "low", agentId: "w1" });
  expect(
    [...files.keys()].some((p) => p.includes(`${profile}\\.cache/harnery/helpers/usage-`)),
  ).toBe(true);
});

test("Windows: a nested working folder finds the project default above it", async ($, on) => {
  const config = `{ "helpers": { "claude-code": { "max_model": "haiku", "max_effort": "low" } } }`;
  const { sent } = stubs(on, {
    noHome: true,
    env: { USERPROFILE: "C:\\Users\\tester" },
    cwd: "C:\\work\\app\\src",
    files: { "C:\\work\\app/.harnery/config.jsonc": config },
  });
  await step($, { model: "claude-opus-5-5", effort: "max", agentId: "w3" });
  expect(sent[0]).toEqual({ model: "haiku", effort: "low", agentId: "w3" });
});

test("Windows: XDG folders still win over USERPROFILE", async ($, on) => {
  const { sent } = stubs(on, {
    noHome: true,
    env: {
      USERPROFILE: "C:\\Users\\tester",
      XDG_CONFIG_HOME: "D:\\cfg",
      XDG_CACHE_HOME: "D:\\cache",
    },
    files: { "D:\\cfg/harnery/preferences.json": LIMIT },
  });
  await step($, { model: "claude-opus-5-5", effort: "high", agentId: "w2" });
  expect(sent[0]).toEqual({ model: "haiku", effort: "low", agentId: "w2" });
});
