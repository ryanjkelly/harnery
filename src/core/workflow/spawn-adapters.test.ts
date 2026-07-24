import { describe, expect, test } from "bun:test";
import { buildClaudeInvocation, normalizeClaudeResult } from "./spawn-claude.ts";
import { buildCodexInvocation, normalizeCodexResult } from "./spawn-codex.ts";
import { buildCursorInvocation, normalizeCursorResult } from "./spawn-cursor.ts";
import type { SpawnRequest } from "./types.ts";

const request: SpawnRequest = {
  prompt: "do the thing",
  model: "model-x",
  timeoutMs: 1_000,
  maxTurns: 7,
  cwd: "/tmp",
};

describe("registered workflow adapter contracts", () => {
  test("Claude maps model, effort, and turn ceiling", () => {
    const plan = buildClaudeInvocation({ ...request, effort: "high" });
    expect(plan.argv).toEqual([
      "claude",
      "-p",
      "do the thing",
      "--output-format",
      "json",
      "--max-turns",
      "7",
      "--model",
      "model-x",
      "--effort",
      "high",
    ]);
  });

  test("Codex maps effort through a TOML-safe config override", () => {
    const plan = buildCodexInvocation({ ...request, effort: "xhigh" }, "/tmp/final.txt");
    expect(plan.argv).toContain('model_reasoning_effort="xhigh"');
    expect(plan.resultFile).toBe("/tmp/final.txt");
  });

  test("Cursor rejects separate effort instead of rewriting a model id", () => {
    expect(() => buildCursorInvocation({ ...request, effort: "high" })).toThrow(
      /not supported by cursor/,
    );
  });

  test("Cursor authorizes commands in non-interactive print mode", () => {
    const plan = buildCursorInvocation(request);
    expect(plan.argv).toContain("--trust");
    expect(plan.argv).toContain("--force");
  });

  test("normalizers expose only evidence their vendor result actually carries", () => {
    const claude = normalizeClaudeResult({
      stdout: JSON.stringify({ result: "done", session_id: "s1", total_cost_usd: 0.02 }),
      stderr: "",
      exitCode: 0,
      durationMs: 2,
    });
    const codex = normalizeCodexResult({
      stdout: "events",
      stderr: "",
      exitCode: 0,
      durationMs: 3,
      resultFileText: "done\n",
    });
    const cursor = normalizeCursorResult({
      stdout: JSON.stringify({ result: "done", session_id: "s2" }),
      stderr: "",
      exitCode: 0,
      durationMs: 4,
    });
    expect(claude).toMatchObject({ ok: true, text: "done", sessionId: "s1", costUsd: 0.02 });
    expect(codex).toEqual({ ok: true, text: "done", durationMs: 3 });
    expect(cursor).toMatchObject({ ok: true, text: "done", sessionId: "s2" });
  });
});
