import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assistantTextStartsWithSessionNameBlock } from "../../agents/session-name-display.ts";
import {
  detectForkParent,
  inspectSessionNameDisplayImmediately,
  scanAssistantStatusBoxPresent,
  scanAssistantTextIncludes,
  scanLatestAssistantText,
  scanSessionNameDisplayedImmediately,
  scanTranscriptRuntime,
  transcriptPathCandidates,
} from "./transcript.ts";

describe("scanAssistantTextIncludes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harn-transcript-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(lines: (object | string)[]): string {
    const p = join(dir, "transcript.jsonl");
    writeFileSync(
      p,
      `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
    );
    return p;
  }

  const NAME = "Agent Maya - Auth refactor";

  test("matches the needle in an assistant text block", () => {
    const p = writeTranscript([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: `\`\`\`\n${NAME}\n\`\`\`` }] },
      },
    ]);
    expect(scanAssistantTextIncludes(p, NAME)).toBe(true);
  });

  test("matches a plain-string assistant content", () => {
    const p = writeTranscript([{ type: "assistant", message: { content: `top\n${NAME}\nrest` } }]);
    expect(scanAssistantTextIncludes(p, NAME)).toBe(true);
  });

  test("does NOT match the needle inside a tool_result row", () => {
    // Load-bearing: the set-task JSON output lands in a tool_result row of the
    // same tail window, so a raw includes() would false-pass the moment
    // set-task runs (verified against a live CC transcript, 2026-08-09).
    const p = writeTranscript([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: `{"first_of_session":true,"suggested_session_name":"${NAME}"}`,
            },
          ],
        },
      },
    ]);
    expect(scanAssistantTextIncludes(p, NAME)).toBe(false);
  });

  test("does NOT match inside non-text assistant blocks (tool_use input)", () => {
    const p = writeTranscript([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", input: { command: `echo "${NAME}"` } }],
        },
      },
    ]);
    expect(scanAssistantTextIncludes(p, NAME)).toBe(false);
  });

  test("survives a truncated first line (tail-window start)", () => {
    const p = writeTranscript([
      `"message":{"content":[{"type":"text","text":"${NAME}"}]}}`, // torn row
      { type: "assistant", message: { content: [{ type: "text", text: NAME }] } },
    ]);
    expect(scanAssistantTextIncludes(p, NAME)).toBe(true);
  });

  test("returns false for missing path or empty needle", () => {
    expect(scanAssistantTextIncludes(undefined, NAME)).toBe(false);
    expect(scanAssistantTextIncludes(join(dir, "nope.jsonl"), NAME)).toBe(false);
    const p = writeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: NAME }] } },
    ]);
    expect(scanAssistantTextIncludes(p, "")).toBe(false);
  });

  test("the shared strict status-box helper accepts assistant text and rejects tool results", () => {
    const toolResultOnly = writeTranscript([
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "┌─ agent-Maya status" }],
        },
      },
    ]);
    expect(scanAssistantStatusBoxPresent(toolResultOnly, undefined)).toBe(false);
    expect(scanAssistantStatusBoxPresent(toolResultOnly, "```\n┌─ agent-Maya status\n```")).toBe(
      true,
    );
  });
});

describe("ordered session-name transcript scans", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harn-transcript-name-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const NAME = "Agent Maya - Auth refactor";
  const BLOCK = `\`\`\`\n${NAME}\n\`\`\``;

  test("maps a Windows Codex rollout path to its WSL mount candidate", () => {
    expect(
      transcriptPathCandidates(
        "C:\\Users\\maya\\.codex\\sessions\\2026\\08\\20\\rollout-session.jsonl",
      ),
    ).toEqual([
      "C:\\Users\\maya\\.codex\\sessions\\2026\\08\\20\\rollout-session.jsonl",
      "/mnt/c/Users/maya/.codex/sessions/2026/08/20/rollout-session.jsonl",
    ]);
  });

  function writeTranscript(lines: object[]): string {
    const p = join(dir, "transcript.jsonl");
    writeFileSync(p, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    return p;
  }

  test("reads the latest Claude Code and Codex assistant text", () => {
    const claude = writeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "earlier" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: BLOCK }] } },
    ]);
    expect(scanLatestAssistantText(claude)).toBe(BLOCK);

    const codex = writeTranscript([
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: BLOCK }],
        },
      },
    ]);
    expect(scanLatestAssistantText(codex)).toBe(BLOCK);
  });

  test("skips Claude Code's current tool-use-only row and finds the preceding block", () => {
    const p = writeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: BLOCK }] } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", input: { command: "harn agents status" } }] },
      },
    ]);
    expect(scanLatestAssistantText(p)).toBe(BLOCK);
  });

  test("accepts the exact first assistant block after a Claude Code mint result", () => {
    const p = writeTranscript([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: JSON.stringify({
                first_of_session: true,
                suggested_session_name: NAME,
              }),
            },
          ],
        },
      },
      { type: "assistant", message: { content: [{ type: "text", text: BLOCK }] } },
    ]);
    expect(
      scanSessionNameDisplayedImmediately(p, NAME, assistantTextStartsWithSessionNameBlock),
    ).toBe(true);
  });

  test("accepts the exact first assistant block after a Codex mint result", () => {
    const p = writeTranscript([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: [
            {
              type: "input_text",
              text: JSON.stringify({ first_of_session: true, suggested_session_name: NAME }),
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: BLOCK }],
        },
      },
    ]);
    expect(
      scanSessionNameDisplayedImmediately(p, NAME, assistantTextStartsWithSessionNameBlock),
    ).toBe(true);
  });

  test("keeps a recorded Codex display valid after later commentary and a new turn", () => {
    const p = writeTranscript([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: [
            {
              type: "input_text",
              text: JSON.stringify({ first_of_session: true, suggested_session_name: NAME }),
            },
          ],
        },
      },
      { type: "event_msg", payload: { type: "agent_message", message: BLOCK } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: BLOCK }],
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
    ]);
    expect(
      inspectSessionNameDisplayImmediately(p, NAME, assistantTextStartsWithSessionNameBlock),
    ).toEqual({ state: "present" });
  });

  test("distinguishes malformed display evidence from an unavailable transcript", () => {
    const malformed = writeTranscript([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: [
            {
              type: "input_text",
              text: JSON.stringify({ first_of_session: true, suggested_session_name: NAME }),
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `Starting now.\n${BLOCK}` }],
        },
      },
    ]);
    expect(
      inspectSessionNameDisplayImmediately(
        malformed,
        NAME,
        assistantTextStartsWithSessionNameBlock,
      ),
    ).toEqual({ state: "absent" });
    expect(
      inspectSessionNameDisplayImmediately(
        join(dir, "missing.jsonl"),
        NAME,
        assistantTextStartsWithSessionNameBlock,
      ),
    ).toEqual({ state: "unavailable", reason: "missing_transcript" });
  });

  test("accepts an exact display after an explicit pending-name retry", () => {
    const p = writeTranscript([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: [
            {
              type: "input_text",
              text: JSON.stringify({ first_of_session: true, suggested_session_name: NAME }),
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `Starting now.\n${BLOCK}` }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: [
            {
              type: "input_text",
              text: JSON.stringify({
                first_of_session: false,
                session_name_retry: true,
                suggested_session_name: NAME,
              }),
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: BLOCK }],
        },
      },
    ]);
    expect(
      inspectSessionNameDisplayImmediately(p, NAME, assistantTextStartsWithSessionNameBlock),
    ).toEqual({ state: "present" });
  });

  test("rejects an end-of-task block when substantive assistant text came first", () => {
    const p = writeTranscript([
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: JSON.stringify({ first_of_session: true, suggested_session_name: NAME }),
            },
          ],
        },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "Working on it." }] } },
      { type: "assistant", message: { content: [{ type: "text", text: BLOCK }] } },
    ]);
    expect(
      scanSessionNameDisplayedImmediately(p, NAME, assistantTextStartsWithSessionNameBlock),
    ).toBe(false);
  });
});

describe("scanTranscriptRuntime", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harn-transcript-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(lines: object[]): string {
    const p = join(dir, "transcript.jsonl");
    writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return p;
  }

  test("reads message.model from the most-recent assistant turn", () => {
    const p = writeTranscript([
      { type: "user", message: { role: "user" } },
      { type: "assistant", message: { role: "assistant", model: "claude-opus-4-8" } },
    ]);
    expect(scanTranscriptRuntime(p)?.model).toBe("claude-opus-4-8");
  });

  test("walks from the end and returns the latest model", () => {
    const p = writeTranscript([
      { type: "assistant", message: { model: "claude-sonnet-4-6" } },
      { type: "assistant", message: { model: "claude-opus-4-8" } },
    ]);
    expect(scanTranscriptRuntime(p)?.model).toBe("claude-opus-4-8");
  });

  test("falls back to a top-level model field", () => {
    const p = writeTranscript([{ type: "assistant", model: "gpt-5.5" }]);
    expect(scanTranscriptRuntime(p)?.model).toBe("gpt-5.5");
  });

  test("skips synthetic placeholders", () => {
    const p = writeTranscript([
      { type: "assistant", message: { model: "claude-opus-4-8" } },
      { type: "assistant", message: { model: "<synthetic>" } },
    ]);
    expect(scanTranscriptRuntime(p)?.model).toBe("claude-opus-4-8");
  });

  test("returns undefined for missing / undefined / model-less transcripts", () => {
    expect(scanTranscriptRuntime(undefined)).toBeUndefined();
    expect(scanTranscriptRuntime(join(dir, "nope.jsonl"))).toBeUndefined();
    const p = writeTranscript([{ type: "user", message: { role: "user" } }]);
    expect(scanTranscriptRuntime(p)).toBeUndefined();
  });

  test("returns effort and speed from the same row as the model", () => {
    const p = writeTranscript([
      {
        type: "assistant",
        effort: "high",
        message: { model: "claude-opus-5", usage: { speed: "standard" } },
      },
    ]);
    expect(scanTranscriptRuntime(p)).toEqual({
      model: "claude-opus-5",
      effort: "high",
      speed: "standard",
    });
  });

  test("omits effort for a model with no effort dial", () => {
    const p = writeTranscript([
      {
        type: "assistant",
        message: { model: "claude-haiku-4-5-20251001", usage: { speed: "standard" } },
      },
    ]);
    expect(scanTranscriptRuntime(p)).toEqual({
      model: "claude-haiku-4-5-20251001",
      speed: "standard",
    });
  });

  test("pairs tuning with the newest row across a mid-session model swap", () => {
    // The swap is the hazard: pairing the newest model with a separately
    // scanned newest effort would blend two rows.
    const p = writeTranscript([
      {
        type: "assistant",
        effort: "low",
        message: { model: "claude-sonnet-5", usage: { speed: "standard" } },
      },
      {
        type: "assistant",
        effort: "high",
        message: { model: "claude-fable-5", usage: { speed: "fast" } },
      },
    ]);
    expect(scanTranscriptRuntime(p)).toEqual({
      model: "claude-fable-5",
      effort: "high",
      speed: "fast",
    });
  });

  test("skips a synthetic row entirely rather than mixing its tuning in", () => {
    const p = writeTranscript([
      {
        type: "assistant",
        effort: "high",
        message: { model: "claude-opus-5", usage: { speed: "standard" } },
      },
      { type: "assistant", effort: "low", message: { model: "<synthetic>" } },
    ]);
    expect(scanTranscriptRuntime(p)).toEqual({
      model: "claude-opus-5",
      effort: "high",
      speed: "standard",
    });
  });
});

describe("detectForkParent", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harn-fork-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const P = "11111111-1111-4111-8111-111111111111";
  const G = "22222222-2222-4222-8222-222222222222";
  const F = "33333333-3333-4333-8333-333333333333";

  function msg(uuid: string, sessionId: string, type: "user" | "assistant" = "user"): object {
    return { type, uuid, sessionId, message: { role: type } };
  }
  function writeSession(id: string, rows: object[]): string {
    const p = join(dir, `${id}.jsonl`);
    writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return p;
  }
  const u = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

  test("finds the parent whose uuids the fork copied (sessionId rewritten)", () => {
    writeSession(P, [msg(u(1), P), msg(u(2), P, "assistant"), msg(u(3), P)]);
    // Fork: same uuids, rewritten sessionId, plus adapter preamble noise.
    const fork = writeSession(F, [
      { type: "ai-title", sessionId: F },
      msg(u(1), F),
      msg(u(2), F, "assistant"),
      msg(u(3), F),
    ]);
    expect(detectForkParent(fork, F)).toBe(P);
  });

  test("prefers the true parent over a grandparent (deeper overlap wins)", () => {
    // Grandparent holds rows 1-2; parent forked from it and grew to 1-6;
    // fork copied all six from the parent.
    writeSession(G, [msg(u(1), G), msg(u(2), G)]);
    writeSession(
      P,
      [1, 2, 3, 4, 5, 6].map((n) => msg(u(n), P)),
    );
    const fork = writeSession(
      F,
      [1, 2, 3, 4, 5, 6].map((n) => msg(u(n), F)),
    );
    expect(detectForkParent(fork, F)).toBe(P);
  });

  test("prefers the true parent over a sibling fork (minimal container wins)", () => {
    // Sibling forked earlier from the same parent and grew its own turns;
    // both contain the fork's whole copied prefix (score tie).
    writeSession(
      P,
      [1, 2, 3].map((n) => msg(u(n), P)),
    );
    writeSession(G, [...[1, 2, 3].map((n) => msg(u(n), G)), msg(u(7), G), msg(u(8), G)]);
    const fork = writeSession(
      F,
      [1, 2, 3].map((n) => msg(u(n), F)),
    );
    expect(detectForkParent(fork, F)).toBe(P);
  });

  test("returns undefined for a fresh un-forked session (no sibling overlap)", () => {
    writeSession(P, [msg(u(1), P)]);
    const fresh = writeSession(F, [msg(u(9), F)]);
    expect(detectForkParent(fresh, F)).toBeUndefined();
  });

  test("returns undefined when the transcript has no message rows yet", () => {
    const empty = writeSession(F, [{ type: "ai-title", sessionId: F }]);
    expect(detectForkParent(empty, F)).toBeUndefined();
  });

  test("ignores non-session-shaped siblings and never throws on garbage", () => {
    writeFileSync(join(dir, "notes.jsonl"), "not json\n");
    writeFileSync(join(dir, `${P}.jsonl`), "{truncated\n");
    const fork = writeSession(F, [msg(u(1), F)]);
    expect(detectForkParent(fork, F)).toBeUndefined();
    expect(detectForkParent(undefined, F)).toBeUndefined();
    expect(detectForkParent(join(dir, "missing.jsonl"), F)).toBeUndefined();
  });
});
