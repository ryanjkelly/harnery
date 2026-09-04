import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
const harneryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nodeVersion = execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
const node24Test = /^v24\./.test(nodeVersion) ? test : test.skip;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenClaw plugin distribution", () => {
  node24Test("builds a self-contained artifact that loads on a real Node 24 subprocess", () => {
    const pluginRoot = buildPluginFixture();
    writeFileSync(
      join(pluginRoot, "load.mjs"),
      'import { writeFileSync } from "node:fs"; import plugin from "./index.js"; writeFileSync("load-result.json", JSON.stringify({ id: plugin.id, node: process.version }));\n',
    );
    execFileSync("node", ["load.mjs"], { cwd: pluginRoot, stdio: "pipe" });
    expect(JSON.parse(readFileSync(join(pluginRoot, "load-result.json"), "utf8"))).toEqual({
      id: "harnery",
      node: expect.stringMatching(/^v24\./),
    });
  });

  node24Test("executes record mode on Node 24 without manufacturing unsupported evidence", () => {
    const pluginRoot = buildPluginFixture();
    const ledgerRoot = join(pluginRoot, "runtime-root");
    const logRoot = join(pluginRoot, "runtime-logs");
    writeFileSync(
      join(pluginRoot, "record-mode.mjs"),
      `
import plugin from "./index.js";
import { writeFileSync } from "node:fs";
const handlers = new Map();
let service;
plugin.register({
  pluginConfig: {
    mode: "record",
    ledgerRoot: ${JSON.stringify(ledgerRoot)},
    logRoot: ${JSON.stringify(logRoot)},
    agents: ["main"],
    debug: true,
    queueCapacity: 32
  },
  on(hook, handler) { handlers.set(hook, handler); },
  registerService(value) { service = value; }
});
const context = { sessionKey: "native-session-private", runId: "native-run-private", agentId: "main" };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
handlers.get("session_start")({}, context);
await delay(25);
handlers.get("before_prompt_build")({ prompt: "private prompt body" }, context);
await delay(25);
handlers.get("before_tool_call")({
  toolCallId: "native-tool-private",
  toolName: "exec",
  params: { command: "private shell argument" }
}, context);
await delay(25);
handlers.get("after_tool_call")({
  toolCallId: "native-tool-private",
  toolName: "exec",
  params: { command: "private shell argument" },
  result: "private tool output"
}, context);
await delay(25);
handlers.get("agent_end")({}, context);
await delay(25);
handlers.get("session_end")({}, context);
if (!service) throw new Error("recorder service was not registered");
await service.stop();
writeFileSync("record-result.json", JSON.stringify({ id: plugin.id, node: process.version }));
`,
    );

    execFileSync("node", ["record-mode.mjs"], {
      cwd: pluginRoot,
      stdio: "pipe",
      timeout: 30_000,
    });
    expect(JSON.parse(readFileSync(join(pluginRoot, "record-result.json"), "utf8"))).toEqual({
      id: "harnery",
      node: expect.stringMatching(/^v24\./),
    });

    const active = readFileSync(
      join(ledgerRoot, ".harnery", "ledgers", "v3", "active.ndjson"),
      "utf8",
    );
    const events = active
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event_type: string;
            payload: Record<string, unknown>;
          },
      );
    const session = events.find((event) => event.event_type === "session.started");
    expect(session?.payload.runtime_attestation).toMatchObject({
      model: { state: "unsupported", capability: "model_identity" },
    });
    const tool = events.find((event) => event.event_type === "tool.completed");
    expect(tool?.payload).toMatchObject({
      duration_ms: { state: "unsupported", capability: "tool_duration" },
      span: { duration_ms: { state: "unsupported", capability: "tool_duration" } },
    });
    const turn = events.find((event) => event.event_type === "turn.completed");
    expect(turn?.payload).toMatchObject({
      duration_ms: { state: "unsupported", capability: "turn_duration" },
      span: { duration_ms: { state: "unsupported", capability: "turn_duration" } },
      harness: { state: "unsupported", capability: "harness_timing" },
    });
    expect(events.some((event) => event.event_type === "health.capability_drift")).toBe(false);

    const persisted = `${readTree(ledgerRoot)}\n${readTree(logRoot)}`;
    for (const privateText of [
      "private prompt body",
      "private shell argument",
      "private tool output",
    ]) {
      expect(persisted).not.toContain(privateText);
    }
  });
});

function buildPluginFixture(): string {
  execFileSync("bun", ["run", "build:openclaw-plugin"], {
    cwd: harneryRoot,
    stdio: "pipe",
  });
  const root = mkdtempSync(join(tmpdir(), "harnery-openclaw-node-load-"));
  roots.push(root);
  const pluginRoot = join(root, "plugin");
  cpSync(join(harneryRoot, "openclaw-plugin", "dist"), pluginRoot, { recursive: true });
  const stubRoot = join(pluginRoot, "node_modules", "openclaw");
  mkdirSync(stubRoot, { recursive: true });
  writeFileSync(
    join(stubRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw", type: "module", exports: { "./plugin-sdk/core": "./core.js" } })}\n`,
  );
  writeFileSync(join(stubRoot, "core.js"), "export const definePluginEntry = value => value;\n");
  return pluginRoot;
}

function readTree(root: string): string {
  return readdirSync(root)
    .flatMap((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory() ? readTree(path) : readFileSync(path, "utf8");
    })
    .join("\n");
}
