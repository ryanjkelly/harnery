import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  listSessionFinalizationRequestsV3,
  requestSessionEndExplicitV3,
} from "../agents/session-finalizer-v3.ts";
import {
  readLiveCoordinationRow,
  readLiveCoordinationRows,
} from "../agents/state/live-coordination-view.ts";
import { canonicalJsonV3, sha256V3 } from "../events/v3/canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../events/v3/capabilities.ts";
import {
  buildCandidateGenesisManifestV3,
  EVENT_V3_GENESIS_MANIFEST,
  repairEventV3ControlPair,
} from "../events/v3/control.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../events/v3/fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../events/v3/generated.ts";
import { readHookProducerStateV3 } from "../events/v3/producers/recorder.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";

const HARNERY_DIR = resolve(import.meta.dir, "../../..");
const AGENT_HOOK = join(HARNERY_DIR, "bin", "agent-hook");
const roots: string[] = [];

setDefaultTimeout(15_000);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent-hook V3 hard cut", () => {
  test("routes a fresh host prompt reminder only through the supported non-native adapter", () => {
    const reminder = "HOST_REMINDER_SENTINEL: keep the reader-facing voice.";
    const cases = [
      { adapter: "claude-code" as const, sessionKey: "session_id", expected: false },
      { adapter: "codex" as const, sessionKey: "session_id", expected: true },
      { adapter: "cursor" as const, sessionKey: "conversation_id", expected: false },
    ];

    for (const entry of cases) {
      const root = candidateRoot(entry.adapter);
      writeFileSync(
        join(root, ".harnery", "config.jsonc"),
        JSON.stringify({ instructions: { promptReminder: reminder } }),
        "utf8",
      );
      const owner = `${entry.adapter}-reminder-owner`;
      const payload = { [entry.sessionKey]: owner, cwd: root };
      expect(
        run(AGENT_HOOK, ["session-start", "--adapter", entry.adapter], payload, root, {
          HARNERY_AGENT_COORD_BYPASS_STOP: "1",
        }).status,
      ).toBe(0);

      for (const prompt of ["first", "second"]) {
        const result = run(
          AGENT_HOOK,
          ["user-prompt-submit", "--adapter", entry.adapter],
          { ...payload, prompt },
          root,
          { HARNERY_AGENT_COORD_BYPASS_STOP: "1" },
        );
        expect(result.status).toBe(0);
        expect(result.stdout.includes(reminder)).toBe(entry.expected);
      }

      expect(JSON.stringify(readLedgerV3(root))).not.toContain(reminder);
      expect(JSON.stringify(readLiveCoordinationRows(root))).not.toContain(reminder);
    }
  });

  test("PostToolUse injects and PreToolUse enforces the pending session-name display", () => {
    const root = candidateRoot();
    const owner = "session-name-latch-owner";
    const name = "Agent Maya - Auth refactor";
    const runHook = (event: string, payload: Record<string, unknown>) =>
      run(AGENT_HOOK, [event, "--adapter", "claude-code"], payload, root, {
        HARNERY_AGENT_COORD_BYPASS_STOP: "1",
      });

    expect(
      runHook("session-start", { session_id: owner, cwd: root, source: "startup" }).status,
    ).toBe(0);
    const instanceId = readLiveCoordinationRows(root)[0]?.instance_id;
    if (!instanceId) throw new Error("session owner was not projected");
    const cachePath = join(root, ".harnery", "active", `${instanceId}.json`);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        ...readLiveCoordinationRow(root, instanceId),
        instance_id: instanceId,
        suggested_session_name: name,
      }),
      "utf8",
    );

    const unrelatedPost = runHook("post-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "ordinary-tool",
      tool_response: "ok",
    });
    expect(unrelatedPost.status).toBe(0);
    expect(unrelatedPost.stdout).not.toContain('"hookEventName":"PostToolUse"');
    expect(unrelatedPost.stdout).not.toContain(name);

    const post = runHook("post-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "set-task-tool",
      tool_response: {
        output: JSON.stringify({ suggested_session_name: name, first_of_session: true }),
      },
    });
    expect(post.status).toBe(0);
    expect(post.stdout).toContain('"hookEventName":"PostToolUse"');
    expect(post.stdout).toContain(name);

    const retryPost = runHook("post-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "set-task-retry-tool",
      tool_response: {
        output: JSON.stringify({
          suggested_session_name: name,
          first_of_session: false,
          session_name_retry: true,
        }),
      },
    });
    expect(retryPost.status).toBe(0);
    expect(retryPost.stdout).toContain('"hookEventName":"PostToolUse"');
    expect(retryPost.stdout).toContain(name);

    const remediation = runHook("pre-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "status-remediation",
      tool_input: { command: "harn agents status --end-turn" },
    });
    expect(remediation.status).toBe(0);
    expect(remediation.stdout).not.toContain('"permissionDecision":"deny"');

    const transcript = join(root, "transcript.jsonl");
    const mintResult = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: JSON.stringify({ first_of_session: true, suggested_session_name: name }),
          },
        ],
      },
    };
    writeFileSync(
      transcript,
      `${JSON.stringify(mintResult)}\n${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Starting before the title." }] },
      })}\n`,
    );
    const denied = runHook("pre-tool-use", {
      session_id: owner,
      cwd: root,
      transcript_path: transcript,
      tool_name: "Bash",
      tool_use_id: "too-soon",
      tool_input: { command: "echo too-soon" },
    });
    expect(denied.status).toBe(0);
    expect(denied.stdout).toContain('"permissionDecision":"deny"');
    expect(readLiveCoordinationRow(root, instanceId)?.session_name_seen_for).toBeUndefined();

    writeFileSync(
      transcript,
      `${JSON.stringify(mintResult)}\n${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `\`\`\`\n${name}\n\`\`\`` }] },
      })}\n`,
    );
    const allowed = runHook("pre-tool-use", {
      session_id: owner,
      cwd: root,
      transcript_path: transcript,
      tool_name: "Bash",
      tool_use_id: "after-display",
      tool_input: { command: "echo allowed" },
    });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).not.toContain('"permissionDecision":"deny"');
    expect(readLiveCoordinationRow(root, instanceId)?.session_name_seen_for).toBe(name);
  });

  test("Cursor records response evidence and never treats later narration as an omission", () => {
    const root = candidateRoot("cursor");
    const owner = "cursor-session-name-owner";
    const name = "Agent Maya - Auth refactor";
    const runHook = (event: string, payload: Record<string, unknown>) =>
      run(AGENT_HOOK, [event, "--adapter", "cursor"], payload, root, {
        HARNERY_AGENT_COORD_BYPASS_STOP: "1",
      });

    expect(
      runHook("session-start", {
        conversation_id: owner,
        generation_id: "cursor-name-start",
        hook_event_name: "sessionStart",
      }).status,
    ).toBe(0);
    const instanceId = readLiveCoordinationRows(root)[0]?.instance_id;
    if (!instanceId) throw new Error("Cursor owner was not projected");
    const cachePath = join(root, ".harnery", "active", `${instanceId}.json`);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        ...readLiveCoordinationRow(root, instanceId),
        instance_id: instanceId,
        suggested_session_name: name,
      }),
      "utf8",
    );

    const narration = runHook("pre-tool-use", {
      conversation_id: owner,
      generation_id: "cursor-name-narration",
      hook_event_name: "preToolUse",
      agent_message: "I will inspect the project now.",
      tool_name: "Grep",
      tool_use_id: "cursor-after-later-narration",
      tool_input: { pattern: "example" },
    });
    expect(narration.status).toBe(0);
    expect(narration.stdout).not.toContain('"permission":"deny"');
    expect(readLiveCoordinationRow(root, instanceId)?.session_name_seen_for).toBeUndefined();

    const response = runHook("after-agent-response", {
      conversation_id: owner,
      generation_id: "cursor-name-response",
      hook_event_name: "afterAgentResponse",
      text: `\`\`\`\n${name}\n\`\`\``,
    });
    expect(response.status).toBe(0);
    expect(readLiveCoordinationRow(root, instanceId)?.session_name_seen_for).toBe(name);

    const allowed = runHook("pre-tool-use", {
      conversation_id: owner,
      generation_id: "cursor-name-tool",
      hook_event_name: "preToolUse",
      agent_message: "Continuing after the displayed title.",
      tool_name: "Shell",
      tool_use_id: "cursor-after-display",
      tool_input: { command: "echo allowed" },
    });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).not.toContain('"permission":"deny"');
    expect(readLiveCoordinationRow(root, instanceId)?.session_name_seen_for).toBe(name);
  });

  test("Codex preserves ordered display and stays silent when its transcript is unavailable", () => {
    const root = candidateRoot("codex");
    const owner = "codex-session-name-owner";
    const name = "Agent Maya - Auth refactor";
    const runHook = (event: string, payload: Record<string, unknown>) =>
      run(AGENT_HOOK, [event, "--adapter", "codex"], payload, root, {
        HARNERY_AGENT_COORD_BYPASS_STOP: "1",
      });

    expect(
      runHook("session-start", {
        session_id: owner,
        thread_id: owner,
        cwd: root,
        source: "startup",
      }).status,
    ).toBe(0);
    const instanceId = readLiveCoordinationRows(root)[0]?.instance_id;
    if (!instanceId) throw new Error("Codex owner was not projected");
    const cachePath = join(root, ".harnery", "active", `${instanceId}.json`);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        ...readLiveCoordinationRow(root, instanceId),
        instance_id: instanceId,
        suggested_session_name: name,
      }),
      "utf8",
    );

    const unavailable = runHook("pre-tool-use", {
      session_id: owner,
      thread_id: owner,
      cwd: root,
      agent_message: "Codex hook metadata is not authoritative assistant transcript text.",
      tool_name: "Bash",
      tool_use_id: "codex-unflushed-display",
      tool_input: { command: "echo allowed-with-pending-verification" },
    });
    expect(unavailable.status).toBe(0);
    expect(unavailable.stdout).not.toContain('"permissionDecision":"deny"');
    expect(unavailable.stdout).not.toContain("pending session-name display");
    expect(readLiveCoordinationRow(root, instanceId)?.session_name_seen_for).toBeUndefined();

    const unavailableAgain = runHook("pre-tool-use", {
      session_id: owner,
      thread_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "codex-still-unavailable",
      tool_input: { command: "echo still-allowed-with-pending-verification" },
    });
    expect(unavailableAgain.stdout).not.toContain('"permissionDecision":"deny"');
    expect(unavailableAgain.stdout).not.toContain("pending session-name display");

    const transcript = join(root, "codex-rollout.jsonl");
    const block = `\`\`\`\n${name}\n\`\`\``;
    writeFileSync(
      transcript,
      `${[
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            output: [
              {
                type: "input_text",
                text: JSON.stringify({ first_of_session: true, suggested_session_name: name }),
              },
            ],
          },
        },
        { type: "event_msg", payload: { type: "agent_message", message: block } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: block }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Continuing with the repository review." }],
          },
        },
        { type: "event_msg", payload: { type: "user_message", message: "Continue." } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const allowed = runHook("pre-tool-use", {
      session_id: owner,
      thread_id: owner,
      cwd: root,
      transcript_path: transcript,
      tool_name: "Bash",
      tool_use_id: "codex-after-display",
      tool_input: { command: "echo allowed" },
    });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).not.toContain('"permissionDecision":"deny"');
    expect(readLiveCoordinationRow(root, instanceId)?.session_name_seen_for).toBe(name);

    const repeated = runHook("pre-tool-use", {
      session_id: owner,
      thread_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "codex-after-stamp",
      tool_input: { command: "echo still-allowed" },
    });
    expect(repeated.stdout).not.toContain('"permissionDecision":"deny"');
    expect(repeated.stdout).not.toContain("transcript is unavailable or not flushed yet");
  });

  test("Codex still denies a readable malformed session-name display", () => {
    const root = candidateRoot("codex");
    const owner = "codex-malformed-session-name-owner";
    const name = "Agent Maya - Auth refactor";
    const runHook = (event: string, payload: Record<string, unknown>) =>
      run(AGENT_HOOK, [event, "--adapter", "codex"], payload, root, {
        HARNERY_AGENT_COORD_BYPASS_STOP: "1",
      });
    expect(
      runHook("session-start", {
        session_id: owner,
        thread_id: owner,
        cwd: root,
        source: "startup",
      }).status,
    ).toBe(0);
    const instanceId = readLiveCoordinationRows(root)[0]?.instance_id;
    if (!instanceId) throw new Error("Codex owner was not projected");
    const cachePath = join(root, ".harnery", "active", `${instanceId}.json`);
    writeFileSync(
      cachePath,
      JSON.stringify({
        ...readLiveCoordinationRow(root, instanceId),
        instance_id: instanceId,
        suggested_session_name: name,
      }),
      "utf8",
    );
    const transcript = join(root, "codex-malformed-rollout.jsonl");
    writeFileSync(
      transcript,
      `${[
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            output: [
              {
                type: "input_text",
                text: JSON.stringify({ first_of_session: true, suggested_session_name: name }),
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `Starting now.\n\`\`\`\n${name}\n\`\`\`` }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const denied = runHook("pre-tool-use", {
      session_id: owner,
      thread_id: owner,
      cwd: root,
      transcript_path: transcript,
      tool_name: "Bash",
      tool_use_id: "codex-malformed-display",
      tool_input: { command: "echo denied" },
    });
    expect(denied.stdout).toContain('"permissionDecision":"deny"');
    expect(denied.stdout).toContain("agents suggest-name --json");
    expect(readLiveCoordinationRow(root, instanceId)?.session_name_seen_for).toBeUndefined();
  });

  test("candidate hooks record a complete canonical V3 lifecycle", () => {
    const root = candidateRoot();
    const owner = "candidate-owner";
    const outputs: string[] = [];
    const hook = (event: string, payload: Record<string, unknown>) => {
      const result = run(AGENT_HOOK, [event, "--adapter", "claude-code"], payload, root, {
        HARNERY_AGENT_COORD_BYPASS_STOP: "1",
      });
      expect(result.status).toBe(0);
      outputs.push(result.stdout, result.stderr);
    };

    hook("session-start", {
      session_id: owner,
      cwd: root,
      source: "startup",
      hook_event_name: "SessionStart",
    });
    hook("user-prompt-submit", {
      session_id: owner,
      cwd: root,
      prompt: "continue",
      hook_event_name: "UserPromptSubmit",
    });
    hook("pre-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "candidate-command",
      tool_input: { command: "echo candidate" },
      hook_event_name: "PreToolUse",
    });
    hook("post-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "candidate-command",
      tool_input: { command: "echo candidate" },
      tool_response: "candidate",
      hook_event_name: "PostToolUse",
    });
    hook("post-tool-use-failure", {
      session_id: owner,
      cwd: root,
      tool_name: "Edit",
      tool_use_id: "candidate-edit",
      tool_input: { file_path: join(root, "candidate.ts") },
      tool_response: "failed",
      hook_event_name: "PostToolUseFailure",
    });
    hook("stop", {
      session_id: owner,
      cwd: root,
      last_assistant_message: "done",
      hook_event_name: "Stop",
    });
    hook("session-end", {
      session_id: owner,
      cwd: root,
      reason: "exit",
      hook_event_name: "SessionEnd",
    });

    expect(outputs.join("\n")).not.toContain("error");
    const ledger = readLedgerV3(root);
    expect(ledger.complete).toBeTrue();
    expect(ledger.diagnostics).toEqual([]);
    expect(ledger.events.some(({ event }) => event.event_type === "session.started")).toBeTrue();
    expect(ledger.events.some(({ event }) => event.event_type === "session.ended")).toBeTrue();
    const completedTool = ledger.events
      .map(({ event }) => event)
      .find((event) => event.event_type === "tool.completed" && event.payload.tool.name === "Bash");
    if (completedTool?.event_type !== "tool.completed") throw new Error("tool terminal missing");
    expect(completedTool.payload.duration_ms.state).toBe("observed");
    const completedTurn = ledger.events
      .map(({ event }) => event)
      .find((event) => event.event_type === "turn.completed");
    expect(
      completedTurn?.event_type === "turn.completed" && completedTurn.payload.ritual,
    ).toMatchObject({
      status_box_present: { state: "observed", value: false },
      session_name: { state: "observed", value: { required: false, present: false } },
    });
    expect(ledger.events.length).toBeGreaterThan(2);
  }, 10_000);

  test("Claude Code Stop enforcement blocks from structural V3 ritual evidence", () => {
    const root = candidateRoot();
    const owner = "stop-enforcement-owner";
    const hook = (event: string, payload: Record<string, unknown>) => {
      const result = run(AGENT_HOOK, [event, "--adapter", "claude-code"], payload, root);
      expect(result.status).toBe(0);
    };

    hook("session-start", { session_id: owner, cwd: root, source: "startup" });
    hook("user-prompt-submit", {
      session_id: owner,
      cwd: root,
      prompt: "answer without tools",
    });
    const stop = run(
      AGENT_HOOK,
      ["stop", "--adapter", "claude-code"],
      {
        session_id: owner,
        cwd: root,
        last_assistant_message: "done",
      },
      root,
    );

    expect(stop.status).toBe(2);
    expect(stop.stdout).toBe("");
    expect(stop.stderr).toContain("End-of-turn rule (2/3)");
    expect(stop.stderr).toContain("rule=stop-hook.rule_2_3");
    const terminal = readLedgerV3(root)
      .events.map(({ event }) => event)
      .find((event) => event.event_type === "turn.completed");
    expect(terminal?.event_type === "turn.completed" && terminal.payload.ritual).toMatchObject({
      status_box_present: { state: "observed", value: false },
    });
  });

  test("stop hook completes an explicit end queued by its own open tool span", () => {
    const root = candidateRoot();
    const owner = "deferred-end-owner";
    const hook = (event: string, payload: Record<string, unknown>) => {
      const result = run(AGENT_HOOK, [event, "--adapter", "claude-code"], payload, root, {
        HARNERY_AGENT_COORD_BYPASS_STOP: "1",
      });
      expect(result.status).toBe(0);
    };
    hook("session-start", { session_id: owner, cwd: root, source: "startup" });
    hook("user-prompt-submit", { session_id: owner, cwd: root, prompt: "finish" });
    hook("pre-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "end-tool",
      tool_input: { command: "harn agents status --end-turn --end-session" },
    });
    const state = readHookProducerStateV3(root, "claude-code", owner);
    if (!state) throw new Error("producer state missing");
    expect(
      requestSessionEndExplicitV3({
        coordRoot: root,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        coordination_finalized: true,
      }).state,
    ).toBe("queued");
    hook("post-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "end-tool",
      tool_input: { command: "harn agents status --end-turn --end-session" },
      tool_response: "queued",
    });
    hook("stop", {
      session_id: owner,
      cwd: root,
      last_assistant_message: "done",
    });
    expect(readHookProducerStateV3(root, "claude-code", owner)?.terminal).toBeTrue();
    expect(listSessionFinalizationRequestsV3(root)[0]).toMatchObject({
      trigger: "explicit_end",
      status: "completed",
    });
    expect(
      readLedgerV3(root).events.filter(({ event }) => event.event_type === "session.ended"),
    ).toHaveLength(1);
  });

  test("Cursor prompt bootstrap names, routes, and ends one authoritative session", () => {
    const root = candidateRoot("cursor");
    const owner = "cursor-current-owner";
    const staleAgent = "cursor-stale-agent";
    const hook = (event: string, payload: Record<string, unknown>) => {
      const result = run(AGENT_HOOK, [event, "--adapter", "cursor"], payload, root, {
        HARNERY_AGENT_COORD_BYPASS_STOP: "1",
      });
      expect(result.status).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("error");
    };

    hook("user-prompt-submit", {
      conversation_id: owner,
      generation_id: "cursor-prompt-generation",
      prompt: "run two commands and end",
      hook_event_name: "beforeSubmitPrompt",
    });
    hook("pre-tool-use", {
      agent_id: staleAgent,
      conversation_id: owner,
      generation_id: "cursor-tool-generation",
      tool_name: "Shell",
      tool_use_id: "cursor-end-tool",
      tool_input: { command: "harn agents status --end-turn --end-session" },
      hook_event_name: "preToolUse",
    });

    const state = readHookProducerStateV3(root, "cursor", owner);
    if (!state) throw new Error("Cursor producer state missing");
    expect(readLiveCoordinationRows(root)[0]?.name).toMatch(/^[A-Z][a-z]+$/);
    expect(
      requestSessionEndExplicitV3({
        coordRoot: root,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        coordination_finalized: true,
      }).state,
    ).toBe("queued");

    hook("post-tool-use", {
      agent_id: staleAgent,
      conversation_id: owner,
      generation_id: "cursor-tool-generation",
      tool_name: "Shell",
      tool_use_id: "cursor-end-tool",
      tool_input: { command: "harn agents status --end-turn --end-session" },
      tool_response: "queued",
      hook_event_name: "postToolUse",
    });
    hook("stop", {
      conversation_id: owner,
      generation_id: "cursor-stop-generation",
      last_assistant_message: "done",
      hook_event_name: "stop",
    });

    expect(readHookProducerStateV3(root, "cursor", owner)?.terminal).toBeTrue();
    expect(listSessionFinalizationRequestsV3(root)[0]).toMatchObject({
      trigger: "explicit_end",
      status: "completed",
    });
    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events.filter((event) => event.event_type === "tool.requested")).toHaveLength(1);
    expect(events.filter((event) => event.event_type === "tool.completed")).toHaveLength(1);
    expect(
      events
        .filter(
          (event) => event.event_type === "turn.started" || event.event_type === "turn.completed",
        )
        .map((event) => ("turn_id" in event.scope ? event.scope.turn_id : undefined)),
    ).toEqual([state.current_turn_id, state.current_turn_id]);
    expect(JSON.stringify(events)).not.toContain(staleAgent);

    const history = readFileSync(join(root, ".harnery", ".name-history"), "utf8");
    expect(history).toContain(owner);
    expect(readLiveCoordinationRows(root)).toHaveLength(0);
    const terminalName = JSON.parse(history.trim().split("\n").at(-1)!) as { name?: string };
    expect(terminalName.name).toMatch(/^[A-Z][a-z]+$/);
  });

  test("a claude-code dispatch carrying a Cursor payload records nothing", () => {
    const root = candidateRoot();
    // Cursor's dual dispatch pipes its own payload (top-level cursor_version
    // envelope) into the Claude Code hook file. That twin must not record.
    const result = run(
      AGENT_HOOK,
      ["session-start", "--adapter", "claude-code"],
      {
        conversation_id: "cursor-twin-owner",
        session_id: "cursor-twin-owner",
        generation_id: "cursor-twin-owner",
        hook_event_name: "sessionStart",
        model: "cursor-grok-4.5-high",
        cursor_version: "2026.08.11-e8db854",
        workspace_roots: [root],
        transcript_path: null,
      },
      root,
    );
    expect(result.status).toBe(0);
    const ledger = readLedgerV3(root);
    expect(ledger.events.some(({ event }) => event.event_type === "session.started")).toBeFalse();
  });
});

function candidateRoot(adapter: "claude-code" | "codex" | "cursor" = "claude-code"): string {
  const root = mkdtempSync(join(tmpdir(), "harn-hook-v3-route-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
  mkdirSync(join(root, ".harnery", "pid-map"), { recursive: true });
  writeFileSync(join(root, ".harnery", ".lock"), "");
  symlinkSync(HARNERY_DIR, join(root, "harnery"));
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(["add", "seed.txt"]);
  git(["commit", "-qm", "seed"]);

  const keys = loadOrCreateFingerprintKeyStoreV3(root);
  const manifest = buildCandidateGenesisManifestV3({
    profile: {
      initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      contract_source_digest: sha256V3("contract"),
      harnery_commit: "fixture",
      host_repository_commit: "fixture",
      producer_build_ids: ["build_fixture"],
      adapter_capability_profile_digests: [
        `sha256:${adapterCapabilityProfileDigestV3(adapter).slice(4)}`,
      ],
      config_digest: sha256V3("config"),
      canonicalizer_version: "harnery-jcs-nfc-v1",
      fingerprint_version: "hmac-sha256-v1",
      privacy_key_epoch: keys.active_epoch_id,
      candidate_created_at: "2026-08-16T18:00:00.000Z",
    },
    root_id: "root_fixture",
    instance_id: "inst_cutover",
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 1,
      build_id: "build_fixture",
      platform: "linux",
    },
  });
  const manifestPath = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV3ControlPair(root).state).toBe("candidate");
  return root;
}

function run(
  bin: string,
  args: string[],
  payload: Record<string, unknown>,
  root: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const env = { ...process.env };
  for (const key of [
    "HARNERY_AGENT_COORD_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CURSOR_SESSION_ID",
    "CURSOR_CONVERSATION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "HARNERY_AGENT_COORD_OWNER",
    "HARNERY_AGENT_COORD_BRIDGE",
  ]) {
    delete env[key];
  }
  const result = spawnSync("bash", [bin, ...args], {
    input: Object.keys(payload).length > 0 ? JSON.stringify(payload) : "",
    cwd: root,
    encoding: "utf8",
    env: { ...env, HARNERY_COORD_ROOT_OVERRIDE: root, ...extraEnv },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}
