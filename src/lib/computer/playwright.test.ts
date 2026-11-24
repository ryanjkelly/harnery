import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import type { SpawnResult } from "./driver-support.ts";
import {
  createPlaywrightDriver,
  isSensitiveField,
  PLAYWRIGHT_EXTENSION_ID,
  PLAYWRIGHT_MCP_VERSION,
  parseEvaluateResult,
  parseTabIndexes,
  readExtensionToken,
  renderToolResult,
  rewriteOutputPaths,
  typingTargets,
} from "./playwright.ts";
import type { HostInfo } from "./types.ts";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

/** A Local Storage record for the extension's token, as LevelDB writes it. */
function storageRecord(token: string): Buffer {
  const key = Buffer.from(
    `_chrome-extension://${PLAYWRIGHT_EXTENSION_ID}\u0000\u0001auth-token`,
    "latin1",
  );
  const value = Buffer.concat([Buffer.from([1]), Buffer.from(token, "latin1")]);
  return Buffer.concat([
    Buffer.from("junk"),
    key,
    Buffer.from([value.length]),
    value,
    Buffer.from("tail"),
  ]);
}

describe("readExtensionToken", () => {
  test("reads the newest token across log and table files", () => {
    const older = "0".repeat(43);
    expect(
      readExtensionToken([
        { name: "000012.log", bytes: storageRecord(TOKEN) },
        { name: "000005.ldb", bytes: storageRecord(older) },
      ]),
    ).toBe(TOKEN);
  });

  test("returns undefined without the extension's key", () => {
    expect(
      readExtensionToken([{ name: "000001.log", bytes: Buffer.from("nothing here") }]),
    ).toBeUndefined();
  });
});

describe("result helpers", () => {
  test("parseTabIndexes reads browser_tabs list lines", () => {
    expect(
      parseTabIndexes("### Result\n- 0: [A](https://a)\n- 1: (current) [B](https://b)"),
    ).toEqual([0, 1]);
    expect(parseTabIndexes("### Result\nNo open tabs.")).toEqual([]);
  });

  test("renderToolResult joins text and describes images", () => {
    const text = renderToolResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: "A".repeat(4096) },
      ],
    });
    expect(text).toContain("hello");
    expect(text).toContain("image/png omitted (3 KB)");
  });

  test("parseEvaluateResult unwraps a JSON string holding JSON", () => {
    const inner = JSON.stringify({ type: "password" });
    expect(
      parseEvaluateResult(`### Result\n${JSON.stringify(inner)}\n### Ran Playwright code`),
    ).toEqual({
      type: "password",
    });
    expect(parseEvaluateResult("no result")).toBeUndefined();
  });

  test("rewriteOutputPaths maps the server's Windows folder to the caller's", () => {
    const out = rewriteOutputPaths(
      "- [Snapshot](C:\\Users\\me\\AppData\\Local\\harnery\\tools\\playwright-mcp\\output\\page-1.yml)",
      "C:\\Users\\me\\AppData\\Local\\harnery\\tools\\playwright-mcp\\output",
      "/mnt/c/Users/me/AppData/Local/harnery/tools/playwright-mcp/output",
    );
    expect(out).toBe(
      "- [Snapshot](/mnt/c/Users/me/AppData/Local/harnery/tools/playwright-mcp/output/page-1.yml)",
    );
  });

  test("isSensitiveField flags passwords, code and card fields only", () => {
    expect(isSensitiveField({ type: "password" })).toBe(true);
    expect(isSensitiveField({ autocomplete: "one-time-code" })).toBe(true);
    expect(isSensitiveField({ name: "user_password" })).toBe(true);
    expect(isSensitiveField({ label: "Verification code" })).toBe(true);
    expect(isSensitiveField({ type: "text", name: "username", label: "Username" })).toBe(false);
    expect(isSensitiveField({ type: "search", name: "q" })).toBe(false);
  });

  test("typingTargets covers browser_type and text fields of browser_fill_form", () => {
    expect(typingTargets("browser_type", { target: "e1" })).toEqual(["e1"]);
    expect(
      typingTargets("browser_fill_form", {
        fields: [
          { target: "e2", type: "textbox" },
          { target: "e3", type: "checkbox" },
        ],
      }),
    ).toEqual(["e2"]);
    expect(typingTargets("browser_click", { target: "e4" })).toEqual([]);
  });
});

describe("playwright driver", () => {
  let dir: string;
  let host: HostInfo;
  let calls: { op: string; tool?: string; args?: Record<string, unknown> }[];
  let sessionCount: number;
  /** Scripted replies for tools/call, by tool name. */
  let replies: Record<string, (args: Record<string, unknown>) => unknown>;
  /** Session ids the fake server has forgotten. */
  let forgotten: Set<string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harnery-playwright-"));
    host = { kind: "linux", desktopStateDir: join(dir, "state") };
    calls = [];
    sessionCount = 0;
    forgotten = new Set();
    replies = {};
    const profile = join(dir, "home", ".config", "google-chrome", "Profile 2");
    mkdirSync(join(profile, "Extensions", PLAYWRIGHT_EXTENSION_ID), { recursive: true });
    mkdirSync(join(profile, "Local Storage", "leveldb"), { recursive: true });
    writeFileSync(join(profile, "Local Storage", "leveldb", "000003.log"), storageRecord(TOKEN));
  });

  afterEach(() => removeDir(dir));

  const reply = (value: unknown): SpawnResult => ({
    status: 0,
    stdout: `${JSON.stringify(value)}\n`,
    stderr: "",
  });

  function driver() {
    return createPlaywrightDriver({
      host: () => host,
      home: () => join(dir, "home"),
      sleep: async () => {},
      pickPort: () => 41234,
      spawnSync: (_command, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "v22.11.0\n", stderr: "" };
        const op = args[1];
        if (op === "ping") return reply({ status: 400 });
        if (op === "init") {
          calls.push({ op });
          return reply({ status: 200, sid: `sid-${++sessionCount}` });
        }
        if (op === "end") {
          calls.push({ op });
          return reply({ status: 200 });
        }
        if (op === "tools")
          return reply({ status: 200, tools: [{ name: "browser_snapshot", description: "read" }] });
        if (op === "call") {
          const sid = args[3] as string;
          const tool = args[4] as string;
          const toolArgs = JSON.parse(Buffer.from(args[5] as string, "base64").toString("utf8"));
          calls.push({ op, tool, args: toolArgs });
          if (forgotten.has(sid)) return reply({ status: 404, result: null, error: null });
          const value = replies[tool]?.(toolArgs) ?? {
            content: [{ type: "text", text: `ok ${tool}` }],
          };
          return reply({ status: 200, result: value, error: null });
        }
        return { status: 1, stdout: "", stderr: "unexpected" };
      },
    });
  }

  /** Mark the pinned package installed and the daemon started, as install and up would. */
  function installAndStart() {
    const tools = join(host.desktopStateDir as string, "tools", "playwright-mcp");
    const install = join(tools, PLAYWRIGHT_MCP_VERSION);
    mkdirSync(join(install, "node_modules", "@playwright", "mcp"), { recursive: true });
    writeFileSync(join(install, "node_modules", "@playwright", "mcp", "cli.js"), "");
    const d = driver();
    const lock = d.planInstall(host).artifact.sha256;
    writeFileSync(
      join(install, ".harnery-install.json"),
      JSON.stringify({ version: PLAYWRIGHT_MCP_VERSION, lock_sha256: lock }),
    );
    writeFileSync(
      join(tools, "daemon.json"),
      JSON.stringify({ port: 41234, version: PLAYWRIGHT_MCP_VERSION }),
    );
    return d;
  }

  test("health finds the extension's profile and token", () => {
    const d = installAndStart();
    const report = d.health(host).json as {
      checks: { name: string; status: string; message: string }[];
    };
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.node?.status).toBe("pass");
    expect(byName.package?.status).toBe("pass");
    expect(byName.extension?.message).toContain('"Profile 2"');
    expect(byName.token?.status).toBe("pass");
    expect(byName.server?.status).toBe("pass");
  });

  test("plan names the extension when Chrome does not have it", () => {
    removeDir(join(dir, "home"));
    const plan = driver().planInstall(host);
    expect(plan.alreadyInstalled).toBe(false);
    expect(plan.setup?.join("\n")).toContain("chromewebstore.google.com");
  });

  test("a call opens one session per agent and reuses it", () => {
    const d = installAndStart();
    d.call(host, "browser_navigate", { url: "https://example.com", session: "agent-A" });
    d.call(host, "browser_snapshot", { session: "agent-A" });
    d.call(host, "browser_snapshot", { session: "agent-B" });
    expect(calls.filter((c) => c.op === "init")).toHaveLength(2);
    // The session label is Harnery's, never a tool argument.
    expect(calls.find((c) => c.tool === "browser_navigate")?.args).toEqual({
      url: "https://example.com",
    });
  });

  test("a session the server forgot is reopened and the call retried once", () => {
    const d = installAndStart();
    d.call(host, "browser_snapshot", { session: "agent-A" });
    forgotten.add("sid-1");
    const result = d.call(host, "browser_snapshot", { session: "agent-A" });
    expect(result.exitCode).toBe(0);
    expect(calls.filter((c) => c.op === "init")).toHaveLength(2);
  });

  test("an error result exits 1 with the tool's text", () => {
    const d = installAndStart();
    replies.browser_navigate = () => ({
      isError: true,
      content: [{ type: "text", text: "### Error\nboom" }],
    });
    const result = d.call(host, "browser_navigate", { url: "x", session: "agent-A" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("boom");
  });

  test("a click after typing needs a snapshot first", () => {
    const d = installAndStart();
    d.call(host, "browser_type", { target: "e1", text: "hi", session: "agent-A" });
    expect(d.checkCall?.(host, "browser_click", { target: "e2", session: "agent-A" })?.code).toBe(
      "browser_read_back_required",
    );
    // Another agent's typing never blocks this one.
    expect(
      d.checkCall?.(host, "browser_click", { target: "e2", session: "agent-B" }),
    ).toBeUndefined();
    d.call(host, "browser_snapshot", { session: "agent-A" });
    expect(
      d.checkCall?.(host, "browser_click", { target: "e2", session: "agent-A" }),
    ).toBeUndefined();
  });

  test("typing into a password field is refused after a live probe", () => {
    const d = installAndStart();
    d.call(host, "browser_snapshot", { session: "agent-A" });
    replies.browser_evaluate = (args) => ({
      content: [
        {
          type: "text",
          text: `### Result\n${JSON.stringify(JSON.stringify({ type: args.target === "e9" ? "password" : "text" }))}`,
        },
      ],
    });
    expect(
      d.checkCall?.(host, "browser_type", { target: "e9", text: "x", session: "agent-A" })?.code,
    ).toBe("browser_sensitive_field");
    expect(
      d.checkCall?.(host, "browser_type", { target: "e1", text: "x", session: "agent-A" }),
    ).toBeUndefined();
  });

  test("unchecked scripts are refused", () => {
    const d = installAndStart();
    expect(d.checkCall?.(host, "browser_run_code_unsafe", { code: "x" })?.code).toBe(
      "browser_script_not_checked",
    );
    expect(
      d.checkCall?.(host, "browser_evaluate", {
        function: "() => { document.querySelector('#p').value = 'x' }",
      })?.code,
    ).toBe("browser_script_not_checked");
    expect(
      d.checkCall?.(host, "browser_evaluate", { function: "() => document.title" }),
    ).toBeUndefined();
  });

  test("ending an agent's work closes its tabs from the last and ends its session", () => {
    const d = installAndStart();
    d.call(host, "browser_navigate", { url: "https://a", session: "agent-A" });
    replies.browser_tabs = (args) =>
      args.action === "list"
        ? {
            content: [
              {
                type: "text",
                text: "### Result\n- 0: [A](https://a)\n- 1: (current) [B](https://b)",
              },
            ],
          }
        : { content: [{ type: "text", text: "closed" }] };
    const lines = d.endAgentWork?.(host, "agent-A") ?? [];
    expect(lines[0]).toContain("Closed 2 Playwright tabs");
    expect(
      calls
        .filter((c) => c.tool === "browser_tabs" && c.args?.action === "close")
        .map((c) => c.args?.index),
    ).toEqual([1, 0]);
    expect(calls.some((c) => c.op === "end")).toBe(true);
    const sessions = JSON.parse(
      readFileSync(
        join(host.desktopStateDir as string, "tools", "playwright-mcp", "sessions.json"),
        "utf8",
      ),
    );
    expect(sessions["agent-A"]).toBeUndefined();
    // Nothing left to end the second time.
    expect(d.endAgentWork?.(host, "agent-A")).toEqual([]);
  });

  test("only a session's first call may come to the front", () => {
    const d = installAndStart();
    expect(d.takesForeground?.("browser_navigate", { session: "agent-A" })).toBe(true);
    d.call(host, "browser_navigate", { url: "https://a", session: "agent-A" });
    expect(d.takesForeground?.("browser_snapshot", { session: "agent-A" })).toBe(false);
  });

  test("the daemon reports it can attach, so the attach rule never restarts it", () => {
    const d = installAndStart();
    expect(d.daemonStatus(host)).toMatchObject({ running: true, browserAttach: true });
  });
});
