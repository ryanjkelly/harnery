/** End-to-end binary smoke tests for the universal V2 hook path. */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeEventLedgerV2 } from "../../src/core/events/v2/bootstrap.ts";
import { sha256V2 } from "../../src/core/events/v2/canonical.ts";
import { readActiveLedgerV2 } from "../../src/core/events/v2/reader.ts";

const HARNERY_DIR = resolve(import.meta.dir, "../..");
const AGENT_HOOK = join(HARNERY_DIR, "bin", "agent-hook");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent-hook universal V2 binary path", () => {
  test("records a Claude session, turn, and tool span without retaining raw content", () => {
    const root = sandbox(true);
    const session = "claude-binary-session";
    run(root, "session-start", "claude-code", {
      session_id: session,
      model: "claude-sonnet-4-6",
      source: "startup",
    });
    run(root, "user-prompt-submit", "claude-code", {
      session_id: session,
      prompt: "PRIVATE_PROMPT_BODY",
    });
    run(root, "pre-tool-use", "claude-code", {
      session_id: session,
      tool_use_id: "tool-binary-1",
      tool_name: "Read",
      tool_input: { file_path: join(root, "README.md"), token: "PRIVATE_TOOL_INPUT" },
    });
    run(root, "post-tool-use", "claude-code", {
      session_id: session,
      tool_use_id: "tool-binary-1",
      tool_name: "Read",
      tool_response: "PRIVATE_TOOL_OUTPUT",
    });

    const eventTypes = readActiveLedgerV2(root).events.map(({ event }) => event.event_type);
    expect(eventTypes).toContain("session.started");
    expect(eventTypes).toContain("turn.started");
    expect(eventTypes).toContain("tool.requested");
    expect(eventTypes).toContain("tool.completed");
    const durable = readFileSync(join(root, ".harnery", "ledgers", "v2", "active.ndjson"), "utf8");
    expect(durable).not.toContain("PRIVATE_PROMPT_BODY");
    expect(durable).not.toContain("PRIVATE_TOOL_INPUT");
    expect(durable).not.toContain("PRIVATE_TOOL_OUTPUT");
  });

  test("records Codex approval waits in V2", () => {
    const root = sandbox(true);
    const session = "codex-binary-session";
    run(root, "session-start", "codex", {
      session_id: session,
      thread_id: session,
      model: "gpt-5.6",
      source: "startup",
    });
    run(root, "permission-request", "codex", {
      session_id: session,
      thread_id: session,
      turn_id: "turn-approval",
      permission_type: "command",
    });

    expect(readActiveLedgerV2(root).events.map(({ event }) => event.event_type)).toContain(
      "interaction.wait_started",
    );
  });

  test("records Cursor session starts in V2", () => {
    const root = sandbox(true);
    run(root, "session-start", "cursor", {
      conversation_id: "cursor-binary-session",
      hook_event_name: "sessionStart",
      cursor_version: "3.5.17",
      workspace_roots: [root],
    });

    const started = readActiveLedgerV2(root).events.find(
      ({ event }) => event.event_type === "session.started",
    )?.event;
    if (started?.event_type !== "session.started") {
      throw new Error("expected Cursor session.started event");
    }
    expect(started.payload.runtime_attestation.adapter).toMatchObject({
      state: "observed",
      value: { id: "cursor" },
    });
  });

  test("an uninitialized root refuses event recording", () => {
    const root = sandbox(false);
    run(root, "session-start", "claude-code", {
      session_id: "uninitialized-session",
      source: "startup",
    });

    expect(existsSync(join(root, ".harnery", "ledgers", "v2", "active.ndjson"))).toBeFalse();
  });
});

function sandbox(initialize: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v2-binary-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  symlinkSync(HARNERY_DIR, join(root, "harnery"));
  if (initialize) {
    initializeEventLedgerV2({
      coordRoot: root,
      harneryBuild: "fixture",
      hostBuild: "fixture",
      configDigest: sha256V2("config"),
      approvalRecordId: "test-v2-binary",
    });
  }
  return root;
}

function run(
  root: string,
  event: string,
  adapter: "claude-code" | "codex" | "cursor",
  payload: object,
) {
  const result = spawnSync("bash", [AGENT_HOOK, event, "--adapter", adapter], {
    input: JSON.stringify(payload),
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
  });
  expect(result.status).toBe(0);
  return result;
}
