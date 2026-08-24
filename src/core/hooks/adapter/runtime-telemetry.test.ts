import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearRuntimeTelemetryCachesForTest,
  discoverCodexSessionTranscript,
  readRuntimeContextTelemetry,
  readRuntimeContextUsage,
  readRuntimeTuning,
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

  test("joins a fresh active Codex sample only after the matching turn boundary", () => {
    const priorTurn = "prior-turn";
    const transcript = writeCodex([
      taskStarted(1, priorTurn),
      tokenCount(2, 20, 1_000, "2026-08-21T20:23:50.000Z"),
      taskComplete(3, priorTurn),
      taskStarted(4),
      tokenCount(5, 120, 1_000),
    ]);

    expect(
      readRuntimeContextTelemetry({
        adapter: "codex",
        session_id: SESSION,
        turn_id: TURN,
        transcript_path: transcript,
        observed_at: COMPLETE_TIME,
        mode: "active_turn",
      }),
    ).toMatchObject({
      state: "observed",
      used_tokens: 120,
      limit_tokens: 1_000,
      measured_at: TOKEN_TIME,
    });
  });

  test("uses the canonical turn-open clock when task_started leaves the bounded tail", () => {
    const transcript = writeCodex([
      taskStarted(1),
      {
        timestamp: "2026-08-21T20:24:10.000Z",
        ordinal: 2,
        type: "response_item",
        payload: { type: "message", content: "x".repeat(512 * 1024) },
      },
      tokenCount(3, 120, 1_000),
    ]);
    const request = {
      adapter: "codex" as const,
      session_id: SESSION,
      turn_id: TURN,
      turn_started_at: "2026-08-21T20:24:00.000Z",
      transcript_path: transcript,
      observed_at: COMPLETE_TIME,
      mode: "active_turn" as const,
    };

    expect(readRuntimeContextTelemetry(request, { maxTailBytes: 64 * 1024 })).toMatchObject({
      state: "observed",
      used_tokens: 120,
      limit_tokens: 1_000,
    });

    clearRuntimeTelemetryCachesForTest();
    const oldToken = writeCodex(
      [
        taskStarted(1),
        {
          timestamp: "2026-08-21T20:24:10.000Z",
          ordinal: 2,
          type: "response_item",
          payload: { type: "message", content: "x".repeat(512 * 1024) },
        },
        tokenCount(3, 20, 1_000, "2026-08-21T20:23:59.000Z"),
      ],
      "old-active-token",
    );
    expect(
      readRuntimeContextTelemetry(
        { ...request, transcript_path: oldToken },
        { maxTailBytes: 64 * 1024 },
      ),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_turn_not_found" });
  });

  test("keeps stale, missing, and cross-turn active Codex samples partial", () => {
    const transcript = writeCodex([
      taskStarted(1, "prior-turn"),
      tokenCount(2, 20, 1_000),
      taskComplete(3, "prior-turn"),
      taskStarted(4),
    ]);
    expect(
      readRuntimeContextTelemetry({
        adapter: "codex",
        session_id: SESSION,
        turn_id: TURN,
        transcript_path: transcript,
        observed_at: COMPLETE_TIME,
        mode: "active_turn",
      }),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_token_count_missing" });
    expect(
      readRuntimeContextTelemetry({
        adapter: "codex",
        session_id: SESSION,
        turn_id: "different-turn",
        transcript_path: transcript,
        observed_at: COMPLETE_TIME,
        mode: "active_turn",
      }),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_turn_not_found" });

    clearRuntimeTelemetryCachesForTest();
    const stale = writeCodex(
      [taskStarted(1), tokenCount(2, 100, 1_000, "2026-08-21T20:20:00.000Z")],
      "active-stale",
    );
    expect(
      readRuntimeContextTelemetry(
        {
          adapter: "codex",
          session_id: SESSION,
          turn_id: TURN,
          transcript_path: stale,
          observed_at: COMPLETE_TIME,
          mode: "active_turn",
        },
        { maxSampleAgeMs: 5_000 },
      ),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_sample_stale" });
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

  test("turn mode discovers and caches a Codex rollout when Stop omits transcript_path", () => {
    const linuxRoot = join(root, "linux", ".codex", "sessions");
    const windowsRoot = join(root, "mnt", "c", "Users", "maya", ".codex", "sessions");
    writeCodex(
      [taskStarted(1), tokenCount(2, 120_000, 258_400), taskComplete(3)],
      "linux",
      linuxRoot,
    );
    const request = {
      adapter: "codex" as const,
      session_id: SESSION,
      turn_id: TURN,
      mode: "turn" as const,
    };
    const options = { codexRoots: [linuxRoot, windowsRoot] };

    expect(readRuntimeContextTelemetry(request, options)).toMatchObject({
      state: "observed",
      used_tokens: 120_000,
      limit_tokens: 258_400,
    });

    // A later duplicate would make a fresh discovery ambiguous. The verified
    // session cache keeps the reader on the original rollout instead.
    writeCodex(
      [taskStarted(1), tokenCount(2, 200_000, 258_400), taskComplete(3)],
      "windows",
      windowsRoot,
    );
    expect(readRuntimeContextTelemetry(request, options)).toMatchObject({
      state: "observed",
      used_tokens: 120_000,
      limit_tokens: 258_400,
    });
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
      `${[
        {
          timestamp: "2026-08-21T20:24:13.000Z",
          type: "user",
          uuid: "user-turn",
          promptId: TURN,
          sessionId: SESSION,
          message: { role: "user", content: "PRIVATE_PROMPT_SENTINEL" },
        },
        {
          timestamp: TOKEN_TIME,
          type: "assistant",
          uuid: "assistant-turn",
          parentUuid: "user-turn",
          sessionId: SESSION,
          message: {
            model: "claude-opus-fixture",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
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

  test("joins Claude used tokens to a published canonical-model context limit", () => {
    for (const [index, model] of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ].entries()) {
      const transcript = join(root, `claude-known-model-${index}.jsonl`);
      writeFileSync(
        transcript,
        `${[
          {
            type: "user",
            uuid: "user-turn",
            promptId: TURN,
            sessionId: SESSION,
            message: { role: "user", content: "PRIVATE_PROMPT" },
          },
          {
            type: "assistant",
            uuid: "assistant-turn",
            parentUuid: "user-turn",
            sessionId: SESSION,
            timestamp: TOKEN_TIME,
            message: {
              model,
              usage: {
                input_tokens: 10,
                cache_creation_input_tokens: 20,
                cache_read_input_tokens: 30,
              },
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n")}\n`,
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
        state: "observed",
        used_tokens: 60,
        limit_tokens: 1_000_000,
        measured_at: TOKEN_TIME,
        method: "claude_transcript_usage_model_capability",
        attestation: "inferred",
        confidence: "high",
      });
    }
  });

  test("reads fresh turn-matched Claude context during an active turn", () => {
    const transcript = join(root, "claude-active-turn.jsonl");
    writeFileSync(
      transcript,
      `${[
        {
          type: "user",
          uuid: "active-user",
          promptId: TURN,
          sessionId: SESSION,
          message: { role: "user", content: "PRIVATE_ACTIVE_PROMPT" },
        },
        {
          type: "assistant",
          uuid: "active-assistant",
          parentUuid: "active-user",
          sessionId: SESSION,
          timestamp: TOKEN_TIME,
          message: {
            model: "claude-opus-5",
            usage: {
              input_tokens: 68_000,
              cache_creation_input_tokens: 320,
              cache_read_input_tokens: 300,
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );

    expect(
      readRuntimeContextTelemetry({
        adapter: "claude-code",
        session_id: SESSION,
        turn_id: TURN,
        transcript_path: transcript,
        observed_at: COMPLETE_TIME,
        mode: "active_turn",
      }),
    ).toMatchObject({
      state: "observed",
      used_tokens: 68_620,
      limit_tokens: 1_000_000,
      measured_at: TOKEN_TIME,
      attestation: "inferred",
      confidence: "high",
    });
    expect(
      readRuntimeContextTelemetry(
        {
          adapter: "claude-code",
          session_id: SESSION,
          turn_id: TURN,
          transcript_path: transcript,
          observed_at: "2026-08-21T20:30:00.000Z",
          mode: "active_turn",
        },
        { maxSampleAgeMs: 5_000 },
      ),
    ).toMatchObject({ state: "partial", reason: "claude_transcript_sample_stale" });
    expect(
      readRuntimeContextTelemetry({
        adapter: "claude-code",
        session_id: SESSION,
        turn_id: "different-turn",
        transcript_path: transcript,
        observed_at: COMPLETE_TIME,
        mode: "active_turn",
      }),
    ).toMatchObject({ state: "partial", reason: "claude_transcript_turn_not_found" });
  });

  test("reads Cursor first-party composer percentage without inventing token counts", () => {
    const cursorRoot = join(root, "Cursor", "User", "workspaceStorage");
    writeCursorDatabase(cursorRoot, "workspace-a", [
      { composerId: SESSION, contextUsagePercent: 63.5, lastUpdatedAt: Date.parse(TOKEN_TIME) },
    ]);

    const result = readRuntimeContextTelemetry(
      {
        adapter: "cursor",
        session_id: SESSION,
        observed_at: COMPLETE_TIME,
        mode: "turn",
      },
      { cursorRoots: [cursorRoot] },
    );
    expect(result).toMatchObject({
      state: "observed",
      used_percent: 63.5,
      measured_at: TOKEN_TIME,
      method: "cursor_composer_context_percent",
      attestation: "derived",
      confidence: "high",
    });
    expect(JSON.stringify(result)).not.toContain("limit_tokens");
  });

  test("keeps a fresh Cursor database percentage usable during an active turn", () => {
    const cursorRoot = join(root, "Cursor-active", "User", "workspaceStorage");
    writeCursorDatabase(cursorRoot, "workspace-a", [
      { composerId: SESSION, contextUsagePercent: 63.5, lastUpdatedAt: Date.parse(TOKEN_TIME) },
    ]);

    expect(
      readRuntimeContextTelemetry(
        {
          adapter: "cursor",
          session_id: SESSION,
          observed_at: COMPLETE_TIME,
          mode: "active_turn",
        },
        { cursorRoots: [cursorRoot] },
      ),
    ).toMatchObject({ state: "observed", used_percent: 63.5 });
  });

  test("caches Cursor's session database and bounds discovery", () => {
    const cursorRoot = join(root, "Cursor", "User", "workspaceStorage");
    writeCursorDatabase(cursorRoot, "a-workspace", [
      { composerId: SESSION, contextUsagePercent: 25, lastUpdatedAt: Date.parse(TOKEN_TIME) },
    ]);
    const request = { adapter: "cursor" as const, session_id: SESSION, mode: "status" as const };
    const options = { cursorRoots: [cursorRoot], maxCursorDatabases: 1 };
    expect(readRuntimeContextTelemetry(request, options)).toMatchObject({
      state: "observed",
      used_percent: 25,
    });

    writeCursorDatabase(cursorRoot, "0-earlier", [
      { composerId: SESSION, contextUsagePercent: 90, lastUpdatedAt: Date.parse(TOKEN_TIME) },
    ]);
    expect(readRuntimeContextTelemetry(request, options)).toMatchObject({
      state: "observed",
      used_percent: 25,
    });
  });

  test("keeps stale, missing, and ambiguous Cursor samples honest", () => {
    const cursorRoot = join(root, "Cursor", "User", "workspaceStorage");
    writeCursorDatabase(cursorRoot, "workspace-a", [
      { composerId: SESSION, contextUsagePercent: 10, lastUpdatedAt: Date.parse(TOKEN_TIME) },
    ]);
    expect(
      readRuntimeContextTelemetry(
        {
          adapter: "cursor",
          session_id: SESSION,
          observed_at: "2026-08-21T20:30:00.000Z",
          mode: "turn",
        },
        { cursorRoots: [cursorRoot], maxSampleAgeMs: 5_000 },
      ),
    ).toMatchObject({ state: "partial", reason: "cursor_context_sample_stale" });

    clearRuntimeTelemetryCachesForTest();
    const missing = readRuntimeContextTelemetry(
      { adapter: "cursor", session_id: "missing-session", mode: "status" },
      { cursorRoots: [cursorRoot] },
    );
    expect(missing).toMatchObject({
      state: "partial",
      reason: "cursor_context_session_not_found",
    });
    expect("bytes_read" in missing ? missing.bytes_read : 0).toBeGreaterThan(0);

    clearRuntimeTelemetryCachesForTest();
    writeCursorDatabase(cursorRoot, "workspace-b", [
      { composerId: SESSION, contextUsagePercent: 20, lastUpdatedAt: Date.parse(TOKEN_TIME) },
    ]);
    expect(
      readRuntimeContextTelemetry(
        { adapter: "cursor", session_id: SESSION, mode: "status" },
        { cursorRoots: [cursorRoot] },
      ),
    ).toMatchObject({ state: "partial", reason: "cursor_context_sample_ambiguous" });
  });

  test("joins Claude usage to the requested prompt instead of the newest assistant row", () => {
    const transcript = join(root, "claude-cross-turn.jsonl");
    const rows = [
      {
        type: "user",
        uuid: "user-one",
        promptId: TURN,
        sessionId: SESSION,
        message: { role: "user", content: "PRIVATE_FIRST_PROMPT" },
      },
      {
        type: "assistant",
        uuid: "assistant-one",
        parentUuid: "user-one",
        sessionId: SESSION,
        timestamp: TOKEN_TIME,
        message: { model: "claude-opus-fixture", usage: { input_tokens: 60 } },
      },
      {
        type: "user",
        uuid: "user-two",
        parentUuid: "assistant-one",
        promptId: "newer-prompt",
        sessionId: SESSION,
        message: { role: "user", content: "PRIVATE_SECOND_PROMPT" },
      },
      {
        type: "assistant",
        uuid: "assistant-two",
        parentUuid: "user-two",
        sessionId: SESSION,
        timestamp: COMPLETE_TIME,
        message: { model: "claude-opus-fixture", usage: { input_tokens: 600 } },
      },
    ];
    writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

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
    expect(
      readRuntimeContextTelemetry({
        adapter: "claude-code",
        session_id: SESSION,
        turn_id: "missing-prompt",
        transcript_path: transcript,
        mode: "turn",
      }),
    ).toMatchObject({ state: "partial", reason: "claude_transcript_turn_not_found" });
    expect(
      readRuntimeContextTelemetry({
        adapter: "claude-code",
        session_id: "different-session",
        turn_id: TURN,
        transcript_path: transcript,
        mode: "turn",
      }),
    ).toMatchObject({ state: "partial", reason: "claude_transcript_session_mismatch" });
  });

  test("follows a compacted Claude parent chain without crossing prompt ownership", () => {
    const transcript = join(root, "claude-compacted-chain.jsonl");
    const rows = [
      {
        type: "user",
        uuid: "prompt-row",
        promptId: TURN,
        sessionId: SESSION,
        message: { role: "user", content: "PRIVATE_PROMPT" },
      },
      {
        type: "summary",
        uuid: "compaction-row",
        parentUuid: "prompt-row",
        sessionId: SESSION,
        message: { summary: "PRIVATE_COMPACTION_BODY" },
      },
      {
        type: "assistant",
        uuid: "assistant-row",
        parentUuid: "compaction-row",
        sessionId: SESSION,
        timestamp: TOKEN_TIME,
        message: { model: "claude-opus-after-compact", usage: { input_tokens: 73 } },
      },
    ];
    writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

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
      used_tokens: 73,
    });
  });

  test("fails closed when a bounded Claude tail truncates the prompt ancestor", () => {
    const transcript = join(root, "claude-truncated-tail.jsonl");
    const user = {
      type: "user",
      uuid: "prompt-row",
      promptId: TURN,
      sessionId: SESSION,
      message: { role: "user", content: "PRIVATE_PROMPT" },
    };
    const assistant = {
      type: "assistant",
      uuid: "assistant-row",
      parentUuid: "prompt-row",
      sessionId: SESSION,
      timestamp: TOKEN_TIME,
      message: { model: "claude-opus-fixture", usage: { input_tokens: 91 } },
    };
    const assistantLine = `${JSON.stringify(assistant)}\n`;
    writeFileSync(transcript, `${JSON.stringify(user)}\n${assistantLine}`);

    expect(
      readRuntimeContextTelemetry(
        {
          adapter: "claude-code",
          session_id: SESSION,
          turn_id: TURN,
          transcript_path: transcript,
          mode: "turn",
        },
        { maxTailBytes: Buffer.byteLength(assistantLine) },
      ),
    ).toMatchObject({ state: "partial", reason: "claude_transcript_turn_not_found" });
  });

  test("moves from a named Claude flush miss to attributable usage after append", () => {
    const transcript = join(root, "claude-flush-order.jsonl");
    const user = {
      type: "user",
      uuid: "prompt-row",
      promptId: TURN,
      sessionId: SESSION,
      message: { role: "user", content: "PRIVATE_PROMPT" },
    };
    writeFileSync(transcript, `${JSON.stringify(user)}\n`);
    const request = {
      adapter: "claude-code" as const,
      session_id: SESSION,
      turn_id: TURN,
      transcript_path: transcript,
      mode: "turn" as const,
    };

    expect(readRuntimeContextTelemetry(request)).toMatchObject({
      state: "partial",
      reason: "claude_transcript_turn_not_found",
    });
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        uuid: "assistant-row",
        parentUuid: "prompt-row",
        sessionId: SESSION,
        timestamp: TOKEN_TIME,
        message: { model: "claude-opus-fixture", usage: { input_tokens: 109 } },
      })}\n`,
    );
    expect(readRuntimeContextTelemetry(request)).toMatchObject({
      state: "partial",
      reason: "claude_context_limit_tokens_not_reported",
      used_tokens: 109,
    });
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

  function writeCursorDatabase(
    cursorRoot: string,
    workspace: string,
    composers: Array<Record<string, unknown>>,
  ): string {
    const workspaceRoot = join(cursorRoot, workspace);
    mkdirSync(workspaceRoot, { recursive: true });
    const path = join(workspaceRoot, "state.vscdb");
    const database = new Database(path);
    database.run("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    database.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "composer.composerData",
      JSON.stringify({ allComposers: composers }),
    ]);
    database.close();
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

describe("runtime tuning telemetry", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "harn-runtime-tuning-"));
    clearRuntimeTelemetryCachesForTest();
  });

  afterEach(() => {
    clearRuntimeTelemetryCachesForTest();
    rmSync(root, { recursive: true, force: true });
  });

  function writeCodexRollout(rows: object[], session = SESSION): string {
    const directory = join(root, "2026", "08", "22");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `rollout-${session}.jsonl`);
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return path;
  }

  function writeClaudeTranscript(rows: object[]): string {
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return path;
  }

  function turnContext(ordinal: number, effort: string, model = "gpt-5.6-sol"): object {
    return {
      timestamp: TOKEN_TIME,
      ordinal,
      type: "turn_context",
      payload: { turn_id: TURN, model, effort, summary: "auto" },
    };
  }

  test("reads the newest Codex turn_context effort and model", () => {
    const transcript = writeCodexRollout([
      turnContext(1, "high"),
      taskStarted(2),
      turnContext(3, "xhigh"),
    ]);
    expect(
      readRuntimeTuning({ adapter: "codex", session_id: SESSION, transcript_path: transcript }),
    ).toMatchObject({
      state: "observed",
      effort: "xhigh",
      model: "gpt-5.6-sol",
      measured_at: TOKEN_TIME,
      method: "codex_transcript_turn_context",
      source_event: "codex.rollout_turn_context",
    });
  });

  test("falls back to the head when a long turn pushes turn_context past the tail", () => {
    const filler = {
      timestamp: TOKEN_TIME,
      ordinal: 2,
      type: "response_item",
      payload: { type: "message", content: "x".repeat(600 * 1024) },
    };
    const transcript = writeCodexRollout([turnContext(1, "medium"), filler, taskComplete(3)]);
    expect(
      readRuntimeTuning(
        { adapter: "codex", session_id: SESSION, transcript_path: transcript },
        { maxTailBytes: 64 * 1024 },
      ),
    ).toMatchObject({ state: "observed", effort: "medium", model: "gpt-5.6-sol" });
  });

  test("forward-scans past a fat instruction prefix to find turn_context", () => {
    // Real interactive rollouts open with hundreds of KB of session_meta,
    // instructions, and world_state before the first turn_context.
    const fat = (ordinal: number) => ({
      timestamp: TOKEN_TIME,
      ordinal,
      type: "response_item",
      payload: { type: "message", content: "y".repeat(120 * 1024) },
    });
    const tailFiller = {
      timestamp: TOKEN_TIME,
      ordinal: 9,
      type: "response_item",
      payload: { type: "message", content: "z".repeat(400 * 1024) },
    };
    const transcript = writeCodexRollout([
      fat(1),
      fat(2),
      fat(3),
      turnContext(4, "high"),
      tailFiller,
      taskComplete(10),
    ]);
    expect(
      readRuntimeTuning(
        { adapter: "codex", session_id: SESSION, transcript_path: transcript },
        { maxTailBytes: 64 * 1024 },
      ),
    ).toMatchObject({ state: "observed", effort: "high", model: "gpt-5.6-sol" });
  });

  test("keeps a Codex rollout without turn_context partial, not observed", () => {
    const transcript = writeCodexRollout([taskStarted(1), tokenCount(2, 100, 1_000)]);
    expect(
      readRuntimeTuning({ adapter: "codex", session_id: SESSION, transcript_path: transcript }),
    ).toMatchObject({ state: "partial", reason: "codex_transcript_turn_context_missing" });
  });

  test("reads CC model, effort, and speed from the same assistant row", () => {
    const transcript = writeClaudeTranscript([
      {
        type: "assistant",
        timestamp: TOKEN_TIME,
        effort: "low",
        message: { model: "claude-sonnet-5", usage: { speed: "standard" } },
      },
    ]);
    expect(
      readRuntimeTuning({ adapter: "claude-code", transcript_path: transcript }),
    ).toMatchObject({
      state: "observed",
      model: "claude-sonnet-5",
      effort: "low",
      speed: "standard",
      method: "claude_transcript_assistant_row",
    });
  });

  test("observes a no-dial CC model with no effort rather than failing", () => {
    const transcript = writeClaudeTranscript([
      {
        type: "assistant",
        timestamp: TOKEN_TIME,
        message: { model: "claude-haiku-4-5-20251001", usage: { speed: "standard" } },
      },
    ]);
    const result = readRuntimeTuning({ adapter: "claude-code", transcript_path: transcript });
    expect(result).toMatchObject({
      state: "observed",
      model: "claude-haiku-4-5-20251001",
      speed: "standard",
    });
    expect("effort" in result).toBe(false);
  });

  test("does not blend rows across a mid-session model swap", () => {
    const transcript = writeClaudeTranscript([
      {
        type: "assistant",
        timestamp: "2026-08-22T23:00:00.000Z",
        effort: "low",
        message: { model: "claude-sonnet-5", usage: { speed: "standard" } },
      },
      {
        type: "assistant",
        timestamp: TOKEN_TIME,
        effort: "high",
        message: { model: "claude-fable-5", usage: { speed: "fast" } },
      },
    ]);
    expect(
      readRuntimeTuning({ adapter: "claude-code", transcript_path: transcript }),
    ).toMatchObject({ state: "observed", model: "claude-fable-5", effort: "high", speed: "fast" });
  });

  test("skips synthetic CC rows and tool-use-only rows without model", () => {
    const transcript = writeClaudeTranscript([
      {
        type: "assistant",
        timestamp: TOKEN_TIME,
        effort: "high",
        message: { model: "claude-opus-5", usage: { speed: "standard" } },
      },
      { type: "assistant", effort: "low", message: { model: "<synthetic>" } },
      { type: "user", message: { role: "user" } },
    ]);
    expect(
      readRuntimeTuning({ adapter: "claude-code", transcript_path: transcript }),
    ).toMatchObject({ state: "observed", model: "claude-opus-5", effort: "high" });
  });

  test("stays partial when the CC transcript has no assistant row", () => {
    const transcript = writeClaudeTranscript([{ type: "user", message: { role: "user" } }]);
    expect(
      readRuntimeTuning({ adapter: "claude-code", transcript_path: transcript }),
    ).toMatchObject({ state: "partial", reason: "claude_transcript_assistant_row_missing" });
  });

  test("is unsupported for adapters with no known tuning source and for missing inputs", () => {
    expect(readRuntimeTuning({ adapter: "cursor" })).toMatchObject({
      state: "unsupported",
      reason: "runtime_adapter_not_supported",
    });
    expect(readRuntimeTuning({ adapter: "codex" })).toMatchObject({
      state: "unsupported",
      reason: "runtime_session_id_not_reported",
    });
    expect(readRuntimeTuning({ adapter: "claude-code" })).toMatchObject({
      state: "unsupported",
      reason: "runtime_context_telemetry_unavailable",
    });
  });

  test("never crosses message bodies through the typed boundary", () => {
    const transcript = writeClaudeTranscript([
      {
        type: "assistant",
        timestamp: TOKEN_TIME,
        effort: "high",
        message: {
          model: "claude-opus-5",
          content: [{ type: "text", text: "PRIVATE_BODY_SENTINEL" }],
          usage: { speed: "standard" },
        },
      },
    ]);
    const result = readRuntimeTuning({ adapter: "claude-code", transcript_path: transcript });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY_SENTINEL");
  });
});
