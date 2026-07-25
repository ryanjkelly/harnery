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
  test("a child killed for exceeding its timeout is a failure, not an empty success", () => {
    // A vendor CLI that handles the kill signal cleanly exits 0 and writes no
    // result. Without the explicit flag that reads as "finished, had nothing to
    // say", which hides the failure and blames whatever consumes the empty text.
    const killed = { stdout: "", stderr: "", exitCode: 0, durationMs: 300_031, timedOut: true };
    for (const normalize of [normalizeClaudeResult, normalizeCodexResult, normalizeCursorResult]) {
      const result = normalize(killed);
      expect(result.ok).toBe(false);
      expect(result.text).toBe("");
      expect(result.error).toMatch(/timed out after 300031ms/);
    }
  });

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

describe("spawn failure classification (ADR 0046)", () => {
  const normalizers = [
    ["claude", normalizeClaudeResult],
    ["codex", normalizeCodexResult],
    ["cursor", normalizeCursorResult],
  ] as const;

  test("a missing binary (ENOENT) classes environment for every adapter", () => {
    // The structural signal: the binary was never there. exec collapses it to
    // 127 but carries the errno, and the adapter promotes it to environment.
    for (const [, normalize] of normalizers) {
      const result = normalize({
        stdout: "",
        stderr: "",
        exitCode: 127,
        durationMs: 1,
        spawnErrno: "ENOENT",
      });
      expect(result.ok).toBe(false);
      expect(result.class).toBe("environment");
    }
  });

  test("a bare 127 with no errno is NOT environment — it stays a charged work failure", () => {
    // A shell 127 is indistinguishable from a legitimate one; without the errno
    // it must default to charging, never silently grant an uncharged retry.
    for (const [, normalize] of normalizers) {
      const result = normalize({ stdout: "", stderr: "", exitCode: 127, durationMs: 1 });
      expect(result.ok).toBe(false);
      expect(result.class).toBeUndefined();
    }
  });

  test("a 5xx/circuit-open failure classes upstream", () => {
    for (const [, normalize] of normalizers) {
      const result = normalize({
        stdout: "",
        stderr: "upstream refused: 503 service unavailable (circuit_open)",
        exitCode: 1,
        durationMs: 1,
      });
      expect(result.ok).toBe(false);
      expect(result.class).toBe("upstream");
    }
  });

  test("an ordinary non-zero exit stays unclassed (charged work failure)", () => {
    for (const [, normalize] of normalizers) {
      const result = normalize({
        stdout: "",
        stderr: "your workspace is out of credits",
        exitCode: 1,
        durationMs: 1,
      });
      expect(result.ok).toBe(false);
      expect(result.class).toBeUndefined();
    }
  });

  test("a Claude harness envelope that carries an overloaded error classes upstream", () => {
    const result = normalizeClaudeResult({
      stdout: JSON.stringify({
        is_error: true,
        subtype: "api_error",
        errors: ["the model provider is overloaded"],
        result: "",
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.class).toBe("upstream");
  });

  test("a Cursor is_error result carrying a 429 classes upstream", () => {
    const result = normalizeCursorResult({
      stdout: JSON.stringify({ is_error: true, result: "429 too many requests", session_id: "s3" }),
      stderr: "",
      exitCode: 0,
      durationMs: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.class).toBe("upstream");
  });
});
