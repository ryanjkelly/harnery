/**
 * Locks the per-adapter Stop-block enforcement channel. Claude Code blocks via
 * exit-2 + a stderr reason; Cursor continues through `followup_message`; Codex
 * is observe-only because a continuation can replace the completed answer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOP_REMEDIATION_MARKER } from "../../agents/rules/stop-hook.ts";
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

  test("codex suppresses the block without writing hook output", () => {
    capture();
    const code = emitStopBlock("codex", verdict);
    process.stdout.write = realOut;
    process.stderr.write = realErr;

    expect(code).toBe(0);
    expect(outChunks.join("")).toBe("");
    expect(errChunks.join("")).toBe("");
  });

  test("cursor message leads with the remediation marker so the Stop verdict can see its own turn", () => {
    capture();
    emitStopBlock("cursor", verdict);
    process.stdout.write = realOut;
    process.stderr.write = realErr;

    const payload = JSON.parse(outChunks.join("").trim()) as { followup_message?: string };
    const message = payload.followup_message ?? "";
    // Leading, not trailing: prompt_text is clamped when recorded, so a marker
    // at the end could be truncated off a long reason.
    expect(message.startsWith(STOP_REMEDIATION_MARKER)).toBe(true);
    // Both commands named: Cursor opens a NEW turn per followup, so a message
    // that repairs the whole ritual ends the chain in one pass.
    expect(message).toContain("agents set-task");
    expect(message).toContain("agents status");
  });

  test("cursor remediation adds --end-turn only for an opted-in host", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-stop-output-"));
    mkdirSync(join(root, ".harnery"), { recursive: true });
    try {
      capture();
      writeFileSync(
        join(root, ".harnery", "config.jsonc"),
        `{ "binName": "acme", "agents": { "requireGitFinalization": false } }`,
      );
      emitStopBlock("cursor", verdict, root);
      const ordinary = JSON.parse(outChunks.join("").trim()) as { followup_message?: string };
      expect(ordinary.followup_message).toContain("acme agents status");
      expect(ordinary.followup_message).not.toContain("status --end-turn");

      capture();
      writeFileSync(
        join(root, ".harnery", "config.jsonc"),
        `{ "binName": "acme", "agents": { "requireGitFinalization": true } }`,
      );
      emitStopBlock("cursor", verdict, root);
      const guarded = JSON.parse(outChunks.join("").trim()) as { followup_message?: string };
      expect(guarded.followup_message).toContain("acme agents status --end-turn");
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude-code message carries no remediation marker (exit 2 continues the same turn)", () => {
    capture();
    emitStopBlock("claude-code", verdict);
    process.stdout.write = realOut;
    process.stderr.write = realErr;

    expect(errChunks.join("")).not.toContain(STOP_REMEDIATION_MARKER);
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
