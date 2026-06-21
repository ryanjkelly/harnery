/**
 * Locks the per-harness Stop-block enforcement channel. Claude Code / Codex
 * block via exit-2 + a stderr reason (the harness re-prompts); Cursor ignores
 * stop-hook exit codes (fail-open) and re-prompts ONLY via a `followup_message`
 * in stdout JSON that it auto-submits as the next user message.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { emitStopBlock } from "./output.ts";

let outChunks: string[] = [];
let errChunks: string[] = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

function capture(): void {
  outChunks = [];
  errChunks = [];
  process.stdout.write = (s: string | Uint8Array) => {
    outChunks.push(String(s));
    return true;
  };
  process.stderr.write = (s: string | Uint8Array) => {
    errChunks.push(String(s));
    return true;
  };
}

afterEach(() => {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
});

const verdict = {
  reason: "End-of-turn rule (1/3): run `harn agents status`.",
  rule: "stop-hook.rule_1_3",
};

describe("emitStopBlock", () => {
  test("cursor → followup_message on stdout, exit 0, nothing on stderr", () => {
    capture();
    const code = emitStopBlock("cursor", verdict);
    process.stdout.write = realOut;
    process.stderr.write = realErr;

    expect(code).toBe(0);
    expect(errChunks.join("")).toBe("");
    const payload = JSON.parse(outChunks.join("").trim()) as { followup_message?: string };
    expect(typeof payload.followup_message).toBe("string");
    expect(payload.followup_message).toContain("harn agents status");
    expect(payload.followup_message).toContain("rule=stop-hook.rule_1_3");
  });

  test("claude-code → stderr reason, exit 2, nothing on stdout", () => {
    capture();
    const code = emitStopBlock("claude-code", verdict);
    process.stdout.write = realOut;
    process.stderr.write = realErr;

    expect(code).toBe(2);
    expect(outChunks.join("")).toBe("");
    expect(errChunks.join("")).toContain("harn agents status");
    expect(errChunks.join("")).toContain("rule=stop-hook.rule_1_3");
  });

  test("codex behaves like claude-code (exit 2 + stderr)", () => {
    capture();
    const code = emitStopBlock("codex", verdict);
    process.stdout.write = realOut;
    process.stderr.write = realErr;

    expect(code).toBe(2);
    expect(outChunks.join("")).toBe("");
    expect(errChunks.join("")).toContain("rule=stop-hook.rule_1_3");
  });

  test("cursor falls back to a generic message when reason is absent", () => {
    capture();
    const code = emitStopBlock("cursor", { rule: "stop-hook.rule_3_3" });
    process.stdout.write = realOut;
    process.stderr.write = realErr;

    expect(code).toBe(0);
    const payload = JSON.parse(outChunks.join("").trim()) as { followup_message?: string };
    expect((payload.followup_message ?? "").length).toBeGreaterThan(0);
  });
});
