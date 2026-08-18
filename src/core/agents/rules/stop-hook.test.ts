import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateStopHook } from "./stop-hook.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harn-stop-v3-"));
  roots.push(value);
  return value;
}

describe("evaluateStopHook on the universal V3 ledger", () => {
  test("an explicit bypass remains an unconditional allow", () => {
    expect(
      evaluateStopHook(root(), {
        rule: "stop-hook",
        instance_id: "operator",
        adapter: "claude-code",
        bypass: true,
      }),
    ).toMatchObject({ allow: true, rule: "stop-hook.bypass" });
  });

  test("Codex remains observe-only because its stop payload has no reply body", () => {
    expect(
      evaluateStopHook(root(), {
        rule: "stop-hook",
        instance_id: "operator",
        adapter: "codex",
      }),
    ).toMatchObject({ allow: true, rule: "stop-hook.codex_observe_only" });
  });

  test("other adapters fail open explicitly when V3 cannot prove reply-visible rituals", () => {
    const verdict = evaluateStopHook(root(), {
      rule: "stop-hook",
      instance_id: "operator",
      adapter: "claude-code",
    });
    expect(verdict).toMatchObject({
      allow: true,
      rule: "stop-hook.v3_reply_evidence_unavailable",
    });
    expect(verdict.reason).toContain("V3");
  });
});
