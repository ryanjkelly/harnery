import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearRuntimeTelemetryCachesForTest,
  discoverCodexSessionTranscript,
  readRuntimeContextTelemetry,
  readRuntimeContextUsage,
} from "./runtime-telemetry.ts";

const SESSION = "01a025fb-2214-7943-be54-30f5ba66c9e0";
const TURN = "01a025fd-cafd-7242-8705-89f2b38bb624";
const TOKEN_TIME = "2026-08-21T20:24:14.000Z";
const COMPLETE_TIME = "2026-08-21T20:24:15.200Z";

describe("runtime context telemetry", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "harn-runtime-telemetry-"));
    clearRuntimeTelemetryCachesForTest();
  });

  afterEach(() => {
    clearRuntimeTelemetryCachesForTest();
    rmSync(root, { recursive: true, force: true });
  });

  test("joins a bounded Codex token sample to its native completed turn", () => {
    const transcript = writeCodex([
      taskStarted(1),
      tokenCount(2, 120_000, 258_400),
      taskComplete(3),
    ]);

    expect(
      readRuntimeContextTelemetry({
        adapter: "codex",
        session_id: SESSION,
        turn_id: TURN,
        transcript_path: transcript,
        mode: "turn",
      }),
    ).toMatchObject({
      state: "observed",
      used_tokens: 120_000,
      limit_tokens: 258_400,
      measured_at: TOKEN_TIME,
      method: "codex_transcript_token_count",
      source_event: "codex.rollout_token_count",
    });
  });

  test("never crosses prompt, reasoning, command, or result bodies through the typed boundary", () => {
    const sentinels = {
      prompt: "PRIVATE_PROMPT_SENTINEL",
      reasoning: "PRIVATE_REASONING_SENTINEL",
      command: "PRIVATE_COMMAND_SENTINEL",
      result: "PRIVATE_RESULT_SENTINEL",
    };
    const transcript = writeCodex([
      taskStarted(1),
      {
        timestamp: "2026-08-21T20:24:13.000Z",
        ordinal: 2,
        type: "response_item",
        payload: { type: "message", ...sentinels },
      },
      tokenCount(3, 42, 1_000),
      taskComplete(4),
    ]);

    const result = readRuntimeContextTelemetry({
      adapter: "codex",
      session_id: SESSION,
      turn_id: TURN,
      transcript_path: transcript,
      mode: "turn",
    });
    const serialized = JSON.stringify(result);
    for (const sentinel of Object.values(sentinels)) expect(serialized).not.toContain(sentinel);
  });

  test("bounds I/O even when the rollout contains a very large earlier body", () => {
    const transcript = writeCodex([
      {
        timestamp: "2026-08-21T20:24:00.000Z",
        ordinal: 0,
        type: "response_item",
        payload: { type: "message", content: "x".repeat(512 * 1024) },
      },
      taskStarted(1),
      tokenCount(2, 100, 1_000),
      taskComplete(3),
    ]);
    const result = readRuntimeContextTelemetry(
      {
        adapter: "codex",
        session_id: SESSION,
        turn_id: TURN,
        transcript_path: transcript,
        mode: "turn",
      },
      { maxTailBytes: 64 * 1024 },
    );
    expect(result.state).toBe("observed");
    expect(result.bytes_read).toBeLessThanOrEqual(64 * 1024);
  });

  test("keeps a pre-terminal or absent turn sample partial", () => {
    const transcript = writeCodex([taskStarted(1), tokenCount(2, 100, 1_000)]);
    expect(
      readRuntimeContextTelemetry({
        adapter: "codex",
        session_id: SESSION,
        turn_id: TURN,
        transcript_path: transcript,
        mode: "turn",
      }),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_turn_not_terminal" });

    expect(
      readRuntimeContextTelemetry({
        adapter: "codex",
        session_id: SESSION,
        turn_id: "different-turn",
        transcript_path: transcript,
        mode: "turn",
      }),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_turn_not_found" });
  });

  test("rejects a stale or cross-turn latest token sample", () => {
    const stale = writeCodex([
      taskStarted(1),
      tokenCount(2, 100, 1_000, "2026-08-21T20:20:00.000Z"),
      taskComplete(3),
    ]);
    expect(
      readRuntimeContextTelemetry(
        {
          adapter: "codex",
          session_id: SESSION,
          turn_id: TURN,
          transcript_path: stale,
          mode: "turn",
        },
        { maxSampleAgeMs: 5_000 },
      ),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_sample_stale" });

    clearRuntimeTelemetryCachesForTest();
    const priorTurn = "prior-turn";
    const crossTurn = writeCodex(
      [
        taskStarted(1, priorTurn),
        tokenCount(2, 50, 1_000),
        taskComplete(3, priorTurn),
        taskStarted(4),
        taskComplete(5),
      ],
      "cross-turn",
    );
    expect(
      readRuntimeContextTelemetry({
        adapter: "codex",
        session_id: SESSION,
        turn_id: TURN,
        transcript_path: crossTurn,
        mode: "turn",
      }),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_token_count_missing" });
  });

  test("discovers Linux and WSL-shaped roots once and refuses ambiguity", () => {
    const linuxRoot = join(root, "linux", ".codex", "sessions");
    const windowsRoot = join(root, "mnt", "c", "Users", "maya", ".codex", "sessions");
    const transcript = writeCodex(
      [taskStarted(1), tokenCount(2, 100, 1_000), taskComplete(3)],
      "linux",
      linuxRoot,
    );
    expect(
      readRuntimeContextUsage("codex", SESSION, { codexRoots: [linuxRoot, windowsRoot] }),
    ).toEqual({ used: 100, window: 1_000 });

    rmSync(transcript);
    clearRuntimeTelemetryCachesForTest();
    writeCodex(
      [taskStarted(1), tokenCount(2, 100, 1_000), taskComplete(3)],
      "linux-again",
      linuxRoot,
    );
    writeCodex(
      [taskStarted(1), tokenCount(2, 200, 2_000), taskComplete(3)],
      "windows",
      windowsRoot,
    );
    expect(
      readRuntimeContextTelemetry(
        { adapter: "codex", session_id: SESSION, turn_id: TURN, mode: "turn" },
        { codexRoots: [linuxRoot, windowsRoot] },
      ),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_ambiguous" });
  });

  test("discoverCodexSessionTranscript finds the rollout for a payload with no transcript_path", () => {
    const linuxRoot = join(root, "linux", ".codex", "sessions");
    const transcript = writeCodex(
      [taskStarted(1), tokenCount(2, 100, 1_000), taskComplete(3)],
      "rollout-2026-08-21T15-12-34",
      linuxRoot,
    );
    expect(discoverCodexSessionTranscript(SESSION, undefined, { codexRoots: [linuxRoot] })).toBe(
      transcript,
    );
  });

  test("discoverCodexSessionTranscript returns undefined on ambiguity, mismatch, or bad ids", () => {
    const linuxRoot = join(root, "linux", ".codex", "sessions");
    const windowsRoot = join(root, "mnt", "c", "Users", "maya", ".codex", "sessions");
    writeCodex([taskStarted(1)], "one", linuxRoot);
    writeCodex([taskStarted(1)], "two", windowsRoot);
    expect(
      discoverCodexSessionTranscript(SESSION, undefined, {
        codexRoots: [linuxRoot, windowsRoot],
      }),
    ).toBeUndefined();
    expect(
      discoverCodexSessionTranscript("other-session", undefined, { codexRoots: [linuxRoot] }),
    ).toBeUndefined();
    expect(discoverCodexSessionTranscript(undefined)).toBeUndefined();
    expect(
      discoverCodexSessionTranscript("../../etc/passwd", undefined, { codexRoots: [linuxRoot] }),
    ).toBeUndefined();
  });

  test("refuses a supplied transcript whose filename belongs to another session", () => {
    const transcript = writeCodex(
      [taskStarted(1), tokenCount(2, 100, 1_000), taskComplete(3)],
      "wrong-session",
      undefined,
      "different-session",
    );
    expect(
      readRuntimeContextTelemetry({
        adapter: "codex",
        session_id: SESSION,
        turn_id: TURN,
        transcript_path: transcript,
        mode: "turn",
      }),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_session_mismatch" });
  });

  test("keeps Claude used tokens partial without a model-authoritative limit", () => {
    const transcript = join(root, "claude.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: TOKEN_TIME,
        type: "assistant",
        message: {
          model: "claude-opus-fixture",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        },
      })}\n`,
    );
    expect(
      readRuntimeContextTelemetry({
        adapter: "claude-code",
        session_id: SESSION,
        turn_id: TURN,
        transcript_path: transcript,
        mode: "turn",
      }),
    ).toMatchObject({
      state: "partial",
      reason: "claude_context_limit_tokens_not_reported",
      used_tokens: 60,
    });
    expect(readRuntimeContextUsage("claude-code", SESSION)).toBeNull();
  });

  function writeCodex(
    rows: object[],
    label = "rollout",
    sessionsRoot = root,
    session = SESSION,
  ): string {
    const directory = join(sessionsRoot, "2026", "08", "21");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${label}-${session}.jsonl`);
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return path;
  }
});

function taskStarted(ordinal: number, turnId = TURN): object {
  return {
    timestamp: "2026-08-21T20:24:00.000Z",
    ordinal,
    type: "event_msg",
    payload: { type: "task_started", turn_id: turnId },
  };
}

function tokenCount(ordinal: number, used: number, limit: number, timestamp = TOKEN_TIME): object {
  return {
    timestamp,
    ordinal,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: used }, model_context_window: limit },
    },
  };
}

function taskComplete(ordinal: number, turnId = TURN): object {
  return {
    timestamp: COMPLETE_TIME,
    ordinal,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId },
  };
}
