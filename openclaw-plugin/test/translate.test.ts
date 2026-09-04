import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSkeleton } from "../src/redact.ts";
import { translateOpenClawHook } from "../src/translate.ts";
import {
  OPENCLAW_HOOKS,
  type OpenClawHookContext,
  type OpenClawHookEvent,
  type OpenClawHookName,
} from "../src/types.ts";

interface Fixture {
  source:
    | { kind: "synthetic"; contract: string; authored_at: string }
    | {
        kind: "native_capture";
        openclaw_version: string;
        captured_at: string;
        input: "capture-mode-debug";
      };
  hook: OpenClawHookName;
  event: OpenClawHookEvent;
  context: OpenClawHookContext;
}

const expectedSignals = {
  session_start: "session-start",
  before_prompt_build: "user-prompt-submit",
  before_tool_call: "pre-tool-use",
  after_tool_call: "post-tool-use",
  agent_end: "stop",
  session_end: "session-end",
} as const;

describe("OpenClaw hook translation", () => {
  test("maps every frozen-contract fixture and preserves native identities", () => {
    for (const fixture of fixtures()) {
      if (fixture.source.kind === "synthetic") {
        expect(fixture.source).toEqual({
          kind: "synthetic",
          contract: "openclaw-2026.7.1-2",
          authored_at: "2026-09-03",
        });
      }
      const result = translateOpenClawHook(fixture.hook, fixture.event, fixture.context);
      expect(result.value?.signal).toBe(expectedSignals[fixture.hook]);
      expect(result.value?.payload.session_id).toBe(fixture.context.sessionKey);
      expect(result.value?.payload.agent_id).toBe("main");
      if (fixture.context.runId) expect(result.value?.payload.turn_id).toBe(fixture.context.runId);
      if (fixture.event.toolCallId) {
        expect(result.value?.payload.tool_use_id).toBe(String(fixture.event.toolCallId));
      }
    }
  });

  test("consumes a complete intake-shaped native fixture directory", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-openclaw-native-translation-"));
    try {
      const versionRoot = join(root, "2026.7.1-2");
      mkdirSync(versionRoot, { recursive: true });
      for (const hook of OPENCLAW_HOOKS) {
        writeFileSync(
          join(versionRoot, `${hook}.json`),
          `${JSON.stringify(nativeFixture(hook))}\n`,
        );
      }

      const native = nativeFixtures(root);
      expect(native.map(({ hook }) => hook).sort()).toEqual([...OPENCLAW_HOOKS].sort());
      for (const fixture of native) {
        expect(
          translateOpenClawHook(fixture.hook, fixture.event, fixture.context).value?.signal,
        ).toBe(expectedSignals[fixture.hook]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps a tool error to post-tool-use-failure", () => {
    const result = translateOpenClawHook(
      "after_tool_call",
      { toolCallId: "tool-b", toolName: "exec", error: "failed" },
      { sessionKey: "session-b", runId: "run-b" },
    );
    expect(result.value?.signal).toBe("post-tool-use-failure");
    expect(result.value?.payload.reason).toBe("failed");
  });

  test("returns a reason when a required identity is absent", () => {
    expect(translateOpenClawHook("session_start", {}, {})).toEqual({
      value: null,
      reason: "session_start:missing_sessionKey",
    });
    expect(
      translateOpenClawHook(
        "before_tool_call",
        { toolName: "exec" },
        { sessionKey: "session", runId: "run" },
      ),
    ).toEqual({ value: null, reason: "before_tool_call:missing_toolCallId" });
  });

  test("capture skeletons retain no prompt, tool argument, or tool output text", () => {
    for (const fixture of fixtures()) {
      const serialized = JSON.stringify(captureSkeleton(fixture.event, fixture.context));
      expect(serialized).not.toContain("fixture prompt must be redacted");
      expect(serialized).not.toContain("fixture secret argument");
      expect(serialized).not.toContain("fixture secret output");
      expect(serialized).not.toContain("/workspace/project");
      expect(serialized).toContain(fixture.context.sessionKey ?? "fixture-session-a");
    }
  });

  test("retains identity-shaped keys only at trusted envelope locations", () => {
    const skeleton = captureSkeleton(
      {
        toolCallId: "trusted-tool",
        agentId: "event-agent-collision",
        params: {
          sessionKey: "nested-session-secret",
          runId: "nested-run-secret",
          toolCallId: "nested-tool-secret",
          values: [{ agentId: "array-agent-secret" }],
        },
      },
      {
        sessionKey: "trusted-session",
        runId: "trusted-run",
        agentId: "trusted-agent",
        toolCallId: "context-tool-collision",
        metadata: { sessionKey: "nested-context-secret" },
      },
    );
    const serialized = JSON.stringify(skeleton);

    expect(serialized).toContain("trusted-tool");
    expect(serialized).toContain("trusted-session");
    expect(serialized).toContain("trusted-run");
    expect(serialized).toContain("trusted-agent");
    for (const secret of [
      "event-agent-collision",
      "nested-session-secret",
      "nested-run-secret",
      "nested-tool-secret",
      "array-agent-secret",
      "context-tool-collision",
      "nested-context-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

function fixtures(): Fixture[] {
  const root = join(import.meta.dir, "..", "fixtures", "frozen-contract");
  const synthetic = readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(root, name), "utf8")) as Fixture);
  return [...synthetic, ...nativeFixtures(join(import.meta.dir, "..", "fixtures", "native"))];
}

function nativeFixtures(root: string): Fixture[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return nativeFixtures(path);
      if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
      const fixture = JSON.parse(readFileSync(path, "utf8")) as {
        source: Extract<Fixture["source"], { kind: "native_capture" }>;
        hook: OpenClawHookName;
        skeleton: { event: OpenClawHookEvent; context: OpenClawHookContext };
      };
      if (fixture.source.kind !== "native_capture") {
        throw new Error(`native_fixture_source_mismatch:${path}`);
      }
      return [
        {
          source: fixture.source,
          hook: fixture.hook,
          event: materializeNativeSkeleton(fixture.skeleton.event) as OpenClawHookEvent,
          context: materializeNativeSkeleton(fixture.skeleton.context) as OpenClawHookContext,
        },
      ];
    })
    .sort((left, right) => left.hook.localeCompare(right.hook));
}

function materializeNativeSkeleton(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materializeNativeSkeleton);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (typeof record.type === "string") {
    switch (record.type) {
      case "undefined":
        return undefined;
      case "string":
        return "captured-string";
      case "number":
        return 0;
      case "boolean":
        return false;
      case "null":
        return null;
      case "array":
        return Array.isArray(record.items) ? record.items.map(materializeNativeSkeleton) : [];
      case "object":
        return {};
      case "bigint":
        return 0n;
      case "function":
      case "symbol":
        return record.type;
    }
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, materializeNativeSkeleton(child)]),
  );
}

function nativeFixture(hook: OpenClawHookName) {
  const toolHook = hook === "before_tool_call" || hook === "after_tool_call";
  return {
    source: {
      kind: "native_capture" as const,
      openclaw_version: "2026.7.1-2",
      captured_at: "2026-09-04T15:00:00.000Z",
      input: "capture-mode-debug" as const,
    },
    hook,
    skeleton: {
      event: toolHook ? { toolCallId: "native-tool-id" } : {},
      context: {
        sessionKey: "native-session-id",
        agentId: "main",
        ...(hook === "session_start" || hook === "session_end" ? {} : { runId: "native-run-id" }),
      },
    },
  };
}
