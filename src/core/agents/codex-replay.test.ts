import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayCodexJsonl } from "./codex-replay.ts";

let root: string;
let jsonlPath: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `agent-coord-replay-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(root, ".harnery"), { recursive: true });
  jsonlPath = join(root, "codex-rollout.jsonl");
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

function writeJsonl(entries: Array<Record<string, unknown>>): void {
  writeFileSync(jsonlPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

function readEvents(): Array<Record<string, unknown>> {
  const events = join(root, ".harnery", "events.ndjson");
  if (!existsSync(events)) return [];
  return readFileSync(events, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("replayCodexJsonl", () => {
  test("missing file → emitted 0", () => {
    const r = replayCodexJsonl({
      coordRoot: root,
      sessionId: "s",
      instanceId: "s",
      jsonlPath: join(root, "nonexistent.jsonl"),
    });
    expect(r.emitted).toBe(0);
  });

  test("user_message emits user_prompt.submit", () => {
    writeJsonl([
      {
        type: "event_msg",
        timestamp: "2026-05-27T05:00:00Z",
        payload: { type: "user_message", message: "do the thing" },
      },
    ]);
    const r = replayCodexJsonl({
      coordRoot: root,
      sessionId: "s",
      instanceId: "s",
      jsonlPath,
    });
    expect(r.emitted).toBeGreaterThanOrEqual(1);
    const events = readEvents();
    const userPrompt = events.find((e) => e.event_type === "user_prompt.submit");
    expect(userPrompt).toBeDefined();
    expect((userPrompt!.data as { prompt_text?: string }).prompt_text).toBe("do the thing");
  });

  test("function_call emits tool.pre_use", () => {
    writeJsonl([
      {
        type: "response_item",
        timestamp: "2026-05-27T05:00:00Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "ls /tmp" }),
        },
      },
    ]);
    replayCodexJsonl({ coordRoot: root, sessionId: "s", instanceId: "s", jsonlPath });
    const events = readEvents();
    const tool = events.find((e) => e.event_type === "tool.pre_use");
    expect(tool).toBeDefined();
    expect((tool!.data as { tool_name?: string }).tool_name).toBe("Bash");
  });

  test("harn agents status in cmd emits state.status_checked", () => {
    writeJsonl([
      {
        type: "response_item",
        timestamp: "2026-05-27T05:00:00Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "harn agents status" }),
        },
      },
    ]);
    replayCodexJsonl({ coordRoot: root, sessionId: "s", instanceId: "s", jsonlPath });
    const events = readEvents();
    expect(events.some((e) => e.event_type === "state.status_checked")).toBe(true);
  });

  test("harn agents set-task in cmd emits state.task_set", () => {
    writeJsonl([
      {
        type: "response_item",
        timestamp: "2026-05-27T05:00:00Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: 'harn agents set-task "refactor"' }),
        },
      },
    ]);
    replayCodexJsonl({ coordRoot: root, sessionId: "s", instanceId: "s", jsonlPath });
    const events = readEvents();
    expect(events.some((e) => e.event_type === "state.task_set")).toBe(true);
  });

  test("turn.stop sets status_box_present=true when last message contains the box prefix", () => {
    writeJsonl([]);
    replayCodexJsonl({
      coordRoot: root,
      sessionId: "s",
      instanceId: "s",
      jsonlPath,
      lastAssistantMessage: "Some prose\n\n┌─ agent-Maya ─────────\nfooter",
    });
    const events = readEvents();
    const stop = events.find((e) => e.event_type === "turn.stop");
    expect(stop).toBeDefined();
    expect((stop!.data as { status_box_present?: boolean }).status_box_present).toBe(true);
  });

  test("turn.stop sets status_box_present=false when no box in last message", () => {
    writeJsonl([]);
    replayCodexJsonl({
      coordRoot: root,
      sessionId: "s",
      instanceId: "s",
      jsonlPath,
      lastAssistantMessage: "nothing to see here",
    });
    const events = readEvents();
    const stop = events.find((e) => e.event_type === "turn.stop");
    expect((stop!.data as { status_box_present?: boolean }).status_box_present).toBe(false);
  });
});
