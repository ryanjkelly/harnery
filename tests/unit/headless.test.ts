import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableHeadlessBackends,
  runHeadless,
  runHeadlessOn,
  whichBin,
} from "../../src/lib/headless/index.ts";
import { plantFakeCli } from "../helpers/fake-cli.ts";

/**
 * The suite fakes each harness CLI with a small JS program on a temp PATH (a
 * shell shim on POSIX, a real `.exe` on Windows), so it exercises real process
 * spawning, argv shapes, stdout/file output parsing, and the fallback walk —
 * without any harness installed.
 */

let binDir: string;
let savedPath: string | undefined;
let savedForced: string | undefined;

function fakeBin(name: string, script: string): string {
  return plantFakeCli(binDir, name, script);
}

/** An installed-but-broken backend: exits 1. */
function failingBin(name: string): string {
  return fakeBin(name, "process.exit(1);");
}

/** Fake-script lines that record argv one per line in `<binDir>/<file>`. */
function recordArgv(file: string): string[] {
  return [
    `import { writeFileSync } from "node:fs";`,
    `const args = process.argv.slice(2);`,
    `writeFileSync(${JSON.stringify(join(binDir, file))}, args.map((a) => a + "\\n").join(""));`,
  ];
}

/** A fake `claude` that emits the headless JSON envelope. */
function fakeClaude(result: string, opts: { error?: boolean } = {}) {
  const envelope = JSON.stringify({ is_error: opts.error ?? false, result });
  // argv capture lets tests assert flag shapes.
  fakeBin(
    "claude",
    [
      ...recordArgv("claude.argv"),
      `writeFileSync(${JSON.stringify(join(binDir, "claude.switch"))}, process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? "unset");`,
      `process.stdout.write(${JSON.stringify(envelope)});`,
    ].join("\n"),
  );
}

/** A fake `codex` that writes its reply to the --output-last-message path. */
function fakeCodex(reply: string) {
  fakeBin(
    "codex",
    [
      ...recordArgv("codex.argv"),
      `const out = args[args.indexOf("--output-last-message") + 1];`,
      `if (args.includes("--output-last-message") && out) writeFileSync(out, ${JSON.stringify(reply)});`,
    ].join("\n"),
  );
}

function fakeCursor(reply: string) {
  fakeBin("cursor-agent", `process.stdout.write(${JSON.stringify(reply)});`);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "headless-test-"));
  savedPath = process.env.PATH;
  savedForced = process.env.HARNERY_HEADLESS_BACKEND;
  process.env.PATH = binDir; // ONLY the fakes are visible
  delete process.env.HARNERY_HEADLESS_BACKEND;
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedForced === undefined) delete process.env.HARNERY_HEADLESS_BACKEND;
  else process.env.HARNERY_HEADLESS_BACKEND = savedForced;
  // A fake CLI that just exited can keep its folder busy briefly on Windows.
  const deadline = Date.now() + (process.platform === "win32" ? 10_000 : 0);
  for (;;) {
    try {
      rmSync(binDir, { recursive: true, force: true });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || Date.now() > deadline) throw error;
      Bun.sleepSync(100);
    }
  }
});

describe("whichBin / availability", () => {
  test("finds only executables on PATH, in preference order", () => {
    expect(availableHeadlessBackends()).toEqual([]);
    fakeCursor("x");
    fakeClaude("x");
    expect(availableHeadlessBackends()).toEqual(["claude-code", "cursor"]);
    // Windows resolves the planted .exe through PATHEXT.
    expect(whichBin("claude")).toBe(
      join(binDir, process.platform === "win32" ? "claude.exe" : "claude"),
    );
    expect(whichBin("nonexistent-harness")).toBeUndefined();
  });
});

describe("runHeadlessOn", () => {
  test("claude-code: parses the JSON envelope and passes model/turn flags", async () => {
    fakeClaude("the reply");
    const res = await runHeadlessOn("claude-code", { prompt: "hi", model: "m-test", maxTurns: 2 });
    expect(res).toEqual({ text: "the reply", backend: "claude-code" });
    const argv = readFileSync(join(binDir, "claude.argv"), "utf-8").split("\n");
    expect(argv).toContain("--model");
    expect(argv).toContain("m-test");
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("2");
    // no images staged → no Read tool grant
    expect(argv).not.toContain("--allowedTools");
  });

  test("claude-code: loads no MCP servers or connectors by default", async () => {
    fakeClaude("ok");
    await runHeadlessOn("claude-code", { prompt: "hi" });
    const argv = readFileSync(join(binDir, "claude.argv"), "utf-8").split("\n");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(argv).not.toContain("--setting-sources");
    expect(readFileSync(join(binDir, "claude.switch"), "utf-8")).toBe("false");
  });

  test('claude-code: mcp "inherit" and a server map are explicit opt-ins', async () => {
    const saved = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
    delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
    try {
      fakeClaude("ok");
      await runHeadlessOn("claude-code", { prompt: "hi", mcp: "inherit" });
      expect(readFileSync(join(binDir, "claude.argv"), "utf-8")).not.toContain("--mcp-config");
      expect(readFileSync(join(binDir, "claude.switch"), "utf-8")).toBe("unset");

      const servers = { mcpServers: { docs: { command: "docs-mcp" } } };
      await runHeadlessOn("claude-code", { prompt: "hi", mcp: servers });
      const argv = readFileSync(join(binDir, "claude.argv"), "utf-8").split("\n");
      expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(JSON.stringify(servers));
      expect(argv).toContain("--strict-mcp-config");
      expect(readFileSync(join(binDir, "claude.switch"), "utf-8")).toBe("false");
    } finally {
      if (saved !== undefined) process.env.ENABLE_CLAUDEAI_MCP_SERVERS = saved;
    }
  });

  test("claude-code: an is_error envelope throws", async () => {
    fakeClaude("boom", { error: true });
    expect(runHeadlessOn("claude-code", { prompt: "hi" })).rejects.toThrow("boom");
  });

  test("codex: reads the reply from --output-last-message and attaches images", async () => {
    fakeCodex("codex says");
    const res = await runHeadlessOn("codex", {
      prompt: ({ imagePaths }) => `look at ${imagePaths[0]}`,
      images: [{ data: Buffer.from("png-bytes") }],
    });
    expect(res).toEqual({ text: "codex says", backend: "codex" });
    const argv = readFileSync(join(binDir, "codex.argv"), "utf-8").split("\n");
    expect(argv).toContain("-i");
    expect(argv.some((a) => a.endsWith("image-1.png"))).toBe(true);
    expect(argv.some((a) => a.startsWith("look at ") && a.endsWith("image-1.png"))).toBe(true);
  });

  test("cursor: returns stdout text", async () => {
    fakeCursor("cursor says");
    const res = await runHeadlessOn("cursor", { prompt: "hi" });
    expect(res).toEqual({ text: "cursor says", backend: "cursor" });
  });

  test("an empty reply fails closed", async () => {
    fakeCursor("");
    expect(runHeadlessOn("cursor", { prompt: "hi" })).rejects.toThrow("empty reply");
  });

  test("a missing backend throws instead of skipping", async () => {
    expect(runHeadlessOn("codex", { prompt: "hi" })).rejects.toThrow("not installed");
  });
});

describe("runHeadless (chain)", () => {
  test("falls back past an installed-but-failing backend", async () => {
    failingBin("claude"); // installed, broken
    fakeCodex("recovered");
    const res = await runHeadless({ prompt: "hi" });
    expect(res).toEqual({ text: "recovered", backend: "codex" });
  });

  test("reports every failure when the whole chain fails", async () => {
    failingBin("claude");
    failingBin("codex");
    expect(runHeadless({ prompt: "hi" })).rejects.toThrow(/claude-code:.*\n.*codex:/s);
  });

  test("fallback:false stops after the first backend", async () => {
    failingBin("claude");
    fakeCodex("never reached");
    expect(runHeadless({ prompt: "hi" }, { fallback: false })).rejects.toThrow(
      "every headless backend failed",
    );
  });

  test("opts.backends restricts and reorders the walk", async () => {
    fakeClaude("claude says");
    fakeCursor("cursor says");
    const res = await runHeadless({ prompt: "hi" }, { backends: ["cursor"] });
    expect(res.backend).toBe("cursor");
  });

  test("HARNERY_HEADLESS_BACKEND forces one backend with no fallback", async () => {
    failingBin("claude");
    fakeCursor("cursor says");
    process.env.HARNERY_HEADLESS_BACKEND = "claude-code";
    expect(runHeadless({ prompt: "hi" })).rejects.toThrow();
    process.env.HARNERY_HEADLESS_BACKEND = "cursor";
    const res = await runHeadless({ prompt: "hi" });
    expect(res.backend).toBe("cursor");
  });

  test("nothing installed names the backends it looked for", async () => {
    expect(runHeadless({ prompt: "hi" })).rejects.toThrow("no headless backend installed");
  });
});
