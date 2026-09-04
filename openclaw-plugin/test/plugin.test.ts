import { describe, expect, mock, test } from "bun:test";
import type {
  HarneryOpenClawConfig,
  OpenClawHookContext,
  OpenClawHookEvent,
  OpenClawHookName,
  OpenClawPluginApi,
  OpenClawTranslation,
  RecordQueue,
} from "../src/types.ts";

mock.module("openclaw/plugin-sdk/core", () => ({ definePluginEntry: (value: unknown) => value }));
const { createPluginDefinition } = await import("../src/index.ts");

describe("Harnery OpenClaw plugin", () => {
  test("registers every mapped hook and returns undefined from before_tool_call", () => {
    const harness = pluginHarness({ mode: "record" });
    expect([...harness.handlers.keys()]).toEqual([
      "session_start",
      "before_prompt_build",
      "before_tool_call",
      "after_tool_call",
      "agent_end",
      "session_end",
    ]);
    const result = harness.handlers.get("before_tool_call")?.(
      { toolCallId: "tool-a", toolName: "exec", params: { command: "secret" } },
      { sessionKey: "session-a", runId: "run-a", agentId: "main" },
    );
    expect(result).toBeUndefined();
    expect(harness.queued).toEqual([
      expect.objectContaining({ hook: "before_tool_call", signal: "pre-tool-use" }),
    ]);
  });

  test("honors the agent allowlist", () => {
    const harness = pluginHarness({ mode: "record", agents: ["main"] });
    harness.handlers.get("session_start")?.({}, { sessionKey: "session-a", agentId: "other" });
    expect(harness.queued).toEqual([]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: "agent_skipped",
        detail: { hook: "session_start", agent_id: "other" },
      }),
    );
  });

  test("capture mode logs only a redacted skeleton", () => {
    const harness = pluginHarness({ mode: "capture" });
    harness.handlers.get("before_prompt_build")?.(
      { prompt: "private prompt" },
      { sessionKey: "session-a", runId: "run-a", agentId: "main" },
    );
    expect(harness.queued).toEqual([]);
    const serialized = JSON.stringify(harness.logs);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).toContain("session-a");
  });

  test("a throwing queue never escapes a hook handler", () => {
    const harness = pluginHarness({ mode: "record" }, true);
    expect(() =>
      harness.handlers.get("session_start")?.({}, { sessionKey: "session-a", agentId: "main" }),
    ).not.toThrow();
    expect(harness.logs).toContainEqual(expect.objectContaining({ event: "handler_failure" }));
  });

  test("registers deterministic recorder shutdown with the plugin service lifecycle", async () => {
    const harness = pluginHarness({ mode: "record" });
    expect(harness.service?.id).toBe("harnery-event-recorder");
    await harness.service?.stop();
    expect(harness.closed).toBe(1);
  });
});

function pluginHarness(
  overrides: Partial<HarneryOpenClawConfig>,
  throwOnEnqueue = false,
): {
  handlers: Map<
    OpenClawHookName,
    (event: OpenClawHookEvent, context: OpenClawHookContext) => unknown
  >;
  queued: Array<{ hook: OpenClawHookName; signal: OpenClawTranslation["signal"] }>;
  logs: Array<{ event: string; detail?: Record<string, unknown> }>;
  service?: { id: string; stop(): void | Promise<void> };
  closed: number;
} {
  const handlers = new Map<
    OpenClawHookName,
    (event: OpenClawHookEvent, context: OpenClawHookContext) => unknown
  >();
  const queued: Array<{ hook: OpenClawHookName; signal: OpenClawTranslation["signal"] }> = [];
  const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  let closed = 0;
  let service: { id: string; stop(): void | Promise<void> } | undefined;
  const queue: RecordQueue = {
    enqueue(hook, translation) {
      if (throwOnEnqueue) throw new Error("fake recorder failed");
      queued.push({ hook, signal: translation.signal });
      return Promise.resolve();
    },
    capture(hook, skeleton) {
      logs.push({ event: "capture", detail: { hook, skeleton } });
    },
    log(event, detail) {
      logs.push({ event, detail });
    },
    boot() {},
    flush: () => Promise.resolve(),
    close: () => {
      closed += 1;
      return Promise.resolve();
    },
    stats: () => ({ accepted: queued.length, dropped: 0, failures: 0, pending: 0, closed: false }),
  };
  const api: OpenClawPluginApi = {
    pluginConfig: {
      mode: "capture",
      ledgerRoot: "/tmp/harnery-openclaw-plugin-test",
      logRoot: "/tmp/harnery-openclaw-plugin-test-logs",
      agents: ["main"],
      debug: true,
      recorderFault: false,
      queueCapacity: 128,
      ...overrides,
    },
    on(hook, handler) {
      handlers.set(hook, handler);
    },
    registerService(value) {
      service = value;
    },
  };
  createPluginDefinition({
    createQueue: () => queue,
    bundleSha256: () => "fixture-sha",
  }).register(api);
  return {
    handlers,
    queued,
    logs,
    get service() {
      return service;
    },
    get closed() {
      return closed;
    },
  };
}
