import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentHookArgv,
  type Bridge,
  type BridgeResult,
  createHarneryOpenCodePlugin,
  HarneryDeny,
  type HookPayload,
  harneryToolName,
  interpretHookStdout,
  loadHarneryOpenCodeConfig,
  OPENCODE_SESSION_ENV,
  type OpenCodeBusEvent,
  type OpenCodePluginContext,
  toolResultText,
} from "../src/index.ts";

const CWD = "/repo";

describe("pure translation helpers", () => {
  test("maps OpenCode tool names onto Harnery's capitalized names", () => {
    expect(harneryToolName("shell")).toBe("Shell");
    expect(harneryToolName("bash")).toBe("Bash");
    expect(harneryToolName("read")).toBe("Read");
    expect(harneryToolName("webfetch")).toBe("Webfetch");
    expect(harneryToolName(undefined)).toBe("unknown");
  });

  test("flattens a Tool.Result to its text", () => {
    expect(toolResultText({ output: "ok" })).toBe("ok");
    expect(toolResultText({ content: "text" })).toBe("text");
    expect(
      toolResultText({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
    expect(toolResultText("raw")).toBe("raw");
  });

  test("reads context and deny from the Claude-shaped hook envelope", () => {
    const stdout = [
      "not json",
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "peers" },
      }),
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "claimed by agent-Kirk",
        },
      }),
    ].join("\n");
    expect(interpretHookStdout(stdout)).toEqual({
      context: "peers",
      deny: "claimed by agent-Kirk",
    });
    expect(interpretHookStdout("")).toEqual({});
  });

  test("builds the launcher argv like init's hook command", () => {
    const base = { schema: "s", projectRoot: "/repo", timeoutMs: 1 };
    expect(agentHookArgv({ ...base, agentHook: "agent-hook" }, "stop")).toEqual([
      "agent-hook",
      "stop",
      "--adapter",
      "opencode",
    ]);
    expect(agentHookArgv({ ...base, agentHook: "harnery/bin/agent-hook" }, "stop")).toEqual([
      "bash",
      "/repo/harnery/bin/agent-hook",
      "stop",
      "--adapter",
      "opencode",
    ]);
  });

  test("loads harnery.json beside the plugin and derives the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-oc-plugin-"));
    try {
      const pluginDir = join(root, ".opencode", "plugins", "harnery");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(pluginDir, "harnery.json"),
        JSON.stringify({
          schema: "harnery-opencode-plugin/v1",
          agentHook: "harnery/bin/agent-hook",
        }),
      );
      const config = loadHarneryOpenCodeConfig(pluginDir);
      expect(config.projectRoot).toBe(root);
      expect(config.agentHook).toBe("harnery/bin/agent-hook");
      expect(loadHarneryOpenCodeConfig(join(root, "elsewhere")).agentHook).toBe("agent-hook");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Harnery OpenCode plugin", () => {
  test("registers every lifecycle hook and reports ready", async () => {
    const h = await harness();
    expect([...h.hooks.keys()].sort()).toEqual(
      [
        "permission:evaluate",
        "session:compaction",
        "session:context",
        "session:prompt",
        "shell:create.before",
        "tool:execute.after",
        "tool:execute.before",
      ].sort(),
    );
    expect(h.logs.map((l) => l.event)).toContain("plugin_ready");
  });

  test("prompt hook bridges user-prompt-submit and injects returned context into the next model call", async () => {
    const h = await harness({
      "user-prompt-submit": ok(context("UserPromptSubmit", "Session name pending")),
    });
    await h.fire("session:prompt", {
      sessionID: "ses_1",
      messageID: "msg_1",
      prompt: { text: "hi" },
    });
    expect(h.calls).toEqual([
      {
        subcommand: "user-prompt-submit",
        payload: {
          hook_event_name: "UserPromptSubmit",
          session_id: "ses_1",
          cwd: CWD,
          turn_id: "msg_1",
          prompt: "hi",
        },
      },
    ]);
    const request = { sessionID: "ses_1", system: [] as Array<{ type: string; text: string }> };
    await h.fire("session:context", request);
    expect(request.system).toEqual([{ type: "text", text: "Session name pending" }]);
    // Another session sees nothing.
    const other = { sessionID: "ses_2", system: [] as Array<{ type: string; text: string }> };
    await h.fire("session:context", other);
    expect(other.system).toEqual([]);
    // Turn end clears it.
    await h.bus({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
    const after = { sessionID: "ses_1", system: [] as Array<{ type: string; text: string }> };
    await h.fire("session:context", after);
    expect(after.system).toEqual([]);
  });

  test("execute.before bridges pre-tool-use with Harnery tool names and throws on a deny", async () => {
    const h = await harness({
      "pre-tool-use": ok(deny("path claimed by a peer")),
    });
    await expect(
      h.fire("tool:execute.before", {
        tool: "shell",
        sessionID: "ses_1",
        messageID: "msg_1",
        id: "call_1",
        input: { command: "git status" },
      }),
    ).rejects.toBeInstanceOf(HarneryDeny);
    expect(h.calls[0]).toEqual({
      subcommand: "pre-tool-use",
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "ses_1",
        cwd: CWD,
        turn_id: "msg_1",
        tool_name: "Shell",
        tool_input: { command: "git status" },
        tool_use_id: "call_1",
      },
    });
  });

  test("execute.after splits completed and error into post-tool-use and post-tool-use-failure", async () => {
    const h = await harness();
    await h.fire("tool:execute.after", {
      tool: "read",
      sessionID: "ses_1",
      id: "call_1",
      input: { filePath: "a.ts" },
      status: "completed",
      result: { output: "contents" },
    });
    await h.fire("tool:execute.after", {
      tool: "shell",
      sessionID: "ses_1",
      id: "call_2",
      input: { command: "false" },
      status: "error",
      error: new Error("exit 1"),
    });
    expect(h.calls.map((c) => c.subcommand)).toEqual(["post-tool-use", "post-tool-use-failure"]);
    expect(h.calls[0]!.payload).toMatchObject({ tool_name: "Read", tool_response: "contents" });
    expect(h.calls[1]!.payload).toMatchObject({
      tool_name: "Shell",
      tool_response: "exit 1",
      reason: "exit 1",
    });
  });

  test("permission.evaluate bridges permission-request without changing the decision", async () => {
    const h = await harness();
    const event = {
      sessionID: "ses_1",
      action: "shell",
      resources: ["rm -rf build"],
      effect: "ask" as const,
      message: "delete build output",
      source: { type: "tool", id: "call_9" },
    };
    await h.fire("permission:evaluate", event);
    expect(event.effect).toBe("ask");
    expect(h.calls[0]).toEqual({
      subcommand: "permission-request",
      payload: {
        hook_event_name: "PermissionRequest",
        session_id: "ses_1",
        cwd: CWD,
        tool_name: "Shell",
        tool_input: {
          resources: ["rm -rf build"],
          description: "delete build output",
          effect: "ask",
        },
        tool_use_id: "call_9",
      },
    });
  });

  test("shell.create.before stamps the originating session id into the tool shell env", async () => {
    const h = await harness();
    await h.fire("tool:execute.before", {
      tool: "shell",
      sessionID: "ses_7",
      id: "call_1",
      input: { command: "harn agents whoami" },
    });
    const shell = {
      command: "harn agents whoami",
      cwd: CWD,
      env: {} as Record<string, string | undefined>,
    };
    await h.fire("shell:create.before", shell);
    expect(shell.env[OPENCODE_SESSION_ENV]).toBe("ses_7");
    expect(shell.env.HARNERY_AGENT_COORD_PLATFORM).toBe("opencode");
    // A shell with no matching pending command falls back to the last tool session.
    const other = {
      command: "echo other",
      cwd: CWD,
      env: {} as Record<string, string | undefined>,
    };
    await h.fire("shell:create.before", other);
    expect(other.env[OPENCODE_SESSION_ENV]).toBe("ses_7");
  });

  test("compaction hook bridges pre-compact", async () => {
    const h = await harness();
    await h.fire("session:compaction", {
      sessionID: "ses_1",
      model: { providerID: "openrouter", id: "x/y", variant: "high" },
      system: [],
    });
    expect(h.calls[0]).toEqual({
      subcommand: "pre-compact",
      payload: {
        hook_event_name: "PreCompact",
        session_id: "ses_1",
        cwd: CWD,
        trigger: "auto",
        model: "openrouter/x/y#high",
      },
    });
  });

  test("bus events map session lifecycle to session-start, stop, stop-failure, and session-end", async () => {
    const h = await harness({
      "session-start": ok(context("SessionStart", "You are agent-Damon.")),
    });
    await h.bus({
      type: "session.created",
      data: { sessionID: "ses_1", directory: "/repo/sub", model: { providerID: "p", id: "m" } },
    });
    await h.bus({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
    await h.bus({
      type: "session.execution.failed",
      data: { sessionID: "ses_1", error: { message: "provider down" } },
    });
    await h.bus({
      type: "session.execution.interrupted",
      data: { sessionID: "ses_1", reason: "user" },
    });
    await h.bus({ type: "session.deleted", data: { sessionID: "ses_1" } });
    expect(h.calls.map((c) => c.subcommand)).toEqual([
      "session-start",
      "stop",
      "stop-failure",
      "stop-failure",
      "session-end",
    ]);
    expect(h.calls[0]!.payload).toEqual({
      hook_event_name: "SessionStart",
      session_id: "ses_1",
      cwd: "/repo/sub",
      source: "startup",
      model: "p/m",
    });
    expect(h.calls[1]!.payload).toMatchObject({ hook_event_name: "Stop", stop_hook_active: false });
    expect(h.calls[2]!.payload).toMatchObject({
      hook_event_name: "StopFailure",
      reason: "provider down",
    });
    expect(h.calls[3]!.payload).toMatchObject({ hook_event_name: "StopFailure", reason: "user" });
    expect(h.calls[4]!.payload).toMatchObject({ hook_event_name: "SessionEnd", clean_exit: true });
    expect(h.synthetic).toEqual([
      {
        sessionID: "ses_1",
        text: "You are agent-Damon.",
        description: "Harnery coordination context",
      },
    ]);
  });

  test("child sessions map to sub-agent-start and sub-agent-stop", async () => {
    const h = await harness();
    await h.bus({
      type: "session.created",
      data: { sessionID: "ses_child", parentID: "ses_parent", agent: "explore" },
    });
    await h.bus({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } });
    await h.bus({
      type: "session.execution.failed",
      data: { sessionID: "ses_child", error: "boom" },
    });
    expect(h.calls.map((c) => c.subcommand)).toEqual([
      "sub-agent-start",
      "sub-agent-stop",
      "sub-agent-stop",
    ]);
    expect(h.calls[0]!.payload).toEqual({
      hook_event_name: "SubagentStart",
      session_id: "ses_parent",
      parent_session_id: "ses_parent",
      subagent_id: "ses_child",
      agent_type: "explore",
      cwd: CWD,
    });
    expect(h.calls[1]!.payload).toMatchObject({ exit_status: "ok" });
    expect(h.calls[2]!.payload).toMatchObject({ exit_status: "error", reason: "boom" });
  });

  test("ignores bus events from another location and events without a session id", async () => {
    const h = await harness();
    await h.bus({
      type: "session.created",
      location: { directory: "/other" },
      data: { sessionID: "x" },
    });
    await h.bus({ type: "session.created", data: {} });
    await h.bus({ type: "server.connected", data: {} });
    expect(h.calls).toEqual([]);
  });

  test("a failing bridge never escapes a hook and is logged", async () => {
    const h = await harness(
      {},
      { exitCode: 1, stdout: "", stderr: "agent-hook: boom", timedOut: false },
    );
    await h.fire("session:prompt", { sessionID: "ses_1", prompt: { text: "hi" } });
    await h.bus({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
    expect(h.logs.filter((l) => l.event === "bridge_failure")).toHaveLength(2);
  });

  test("a Stop verdict (exit 2) is observed, never re-prompted", async () => {
    const h = await harness({
      stop: { exitCode: 2, stdout: "", stderr: "End-of-turn ritual incomplete.", timedOut: false },
    });
    await h.bus({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
    expect(h.synthetic).toEqual([]);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "stop_verdict_observed" }));
  });

  test("cleanup aborts the bus subscription and disposes every registration", async () => {
    const h = await harness();
    await h.cleanup();
    expect(h.disposed).toBe(7);
    expect(h.aborted).toBe(true);
  });
});

// ── harness ──────────────────────────────────────────────────────────────────

type Handler = (event: unknown) => Promise<void> | void;

function ok(stdout: string): BridgeResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}
function context(hookEventName: string, additionalContext: string): string {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })}\n`;
}
function deny(reason: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`;
}

async function harness(
  responses: Record<string, BridgeResult> = {},
  fallback: BridgeResult = ok(""),
): Promise<{
  hooks: Map<string, Handler>;
  calls: Array<{ subcommand: string; payload: HookPayload }>;
  logs: Array<{ event: string; detail?: Record<string, unknown> }>;
  synthetic: Array<{ sessionID: string; text: string; description?: string }>;
  fire(hook: string, event: unknown): Promise<void>;
  bus(event: OpenCodeBusEvent): Promise<void>;
  cleanup(): Promise<void>;
  disposed: number;
  aborted: boolean;
}> {
  const hooks = new Map<string, Handler>();
  const calls: Array<{ subcommand: string; payload: HookPayload }> = [];
  const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const synthetic: Array<{ sessionID: string; text: string; description?: string }> = [];
  const state = { disposed: 0, aborted: false };
  const bridge: Bridge = async (subcommand, payload) => {
    calls.push({ subcommand, payload });
    return responses[subcommand] ?? fallback;
  };
  // The bus is driven by the test: a queue the async iterator drains.
  const queue: OpenCodeBusEvent[] = [];
  let wake: (() => void) | null = null;
  let signal: AbortSignal | undefined;
  const drained: Array<() => void> = [];
  const register = (domain: string) => async (name: string, callback: Handler) => {
    hooks.set(`${domain}:${name}`, callback);
    return {
      dispose: async () => {
        state.disposed += 1;
      },
    };
  };
  const ctx = {
    location: { directory: CWD },
    session: {
      hook: register("session"),
      synthetic: async (input: { sessionID: string; text: string; description?: string }) =>
        void synthetic.push(input),
    },
    tool: { hook: register("tool") },
    permission: { hook: register("permission") },
    shell: { hook: register("shell") },
    event: {
      subscribe(options?: { signal?: AbortSignal }) {
        signal = options?.signal;
        signal?.addEventListener("abort", () => {
          state.aborted = true;
          wake?.();
        });
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              const next = queue.shift();
              if (next) {
                yield next;
                drained.shift()?.();
                continue;
              }
              await new Promise<void>((r) => {
                wake = r;
              });
              wake = null;
            }
          },
        };
      },
    },
  } as unknown as OpenCodePluginContext;

  const plugin = createHarneryOpenCodePlugin({
    bridge,
    log: (event, detail) => void logs.push({ event, detail }),
    config: { schema: "s", agentHook: "agent-hook", projectRoot: CWD, timeoutMs: 100 },
  });
  const cleanup = await plugin.setup(ctx);
  // Let the subscription loop start and park on the queue.
  await Promise.resolve();

  return {
    hooks,
    calls,
    logs,
    synthetic,
    fire: async (hook, event) => {
      const handler = hooks.get(hook);
      if (!handler) throw new Error(`no handler for ${hook}`);
      await handler(event);
    },
    bus: (event) =>
      new Promise<void>((resolveDone) => {
        drained.push(resolveDone);
        queue.push(event);
        wake?.();
      }),
    cleanup,
    get disposed() {
      return state.disposed;
    },
    get aborted() {
      return state.aborted;
    },
  };
}
