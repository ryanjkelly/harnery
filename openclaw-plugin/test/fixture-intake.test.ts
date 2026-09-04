import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intakeCaptureRows, writeCaptureFixtures } from "../src/fixture-intake.ts";
import { captureSkeleton } from "../src/redact.ts";
import { OPENCLAW_HOOKS, type OpenClawHookName } from "../src/types.ts";

describe("OpenClaw native fixture intake", () => {
  test("requires and labels one capture for every supported hook", () => {
    const fixtures = intakeCaptureRows(captureJsonl(), "2026.7.1-2");
    expect(fixtures.map(({ hook }) => hook)).toEqual([...OPENCLAW_HOOKS]);
    expect(fixtures).toContainEqual(
      expect.objectContaining({
        source: {
          kind: "native_capture",
          openclaw_version: "2026.7.1-2",
          captured_at: "2026-09-04T15:00:00.000Z",
          input: "capture-mode-debug",
        },
        hook: "before_tool_call",
      }),
    );
  });

  test("rejects missing and duplicate hook sets", () => {
    expect(() => intakeCaptureRows(captureJsonl(OPENCLAW_HOOKS.slice(1)), "2026.7.1-2")).toThrow(
      "missing_capture_hooks:session_start",
    );
    expect(() =>
      intakeCaptureRows(captureJsonl([...OPENCLAW_HOOKS, "before_tool_call"]), "2026.7.1-2"),
    ).toThrow("duplicate_capture_hook:before_tool_call");
  });

  test("rejects a capture row containing raw nested content", () => {
    const rows = captureRows();
    const row = rows.find(({ hook }) => hook === "before_tool_call")!;
    (row.skeleton.event as Record<string, unknown>).params = {
      sessionKey: "raw nested content",
    };
    expect(() =>
      intakeCaptureRows(rows.map((value) => JSON.stringify(value)).join("\n"), "2026.7.1-2"),
    ).toThrow("capture_contains_raw_string:event.params.sessionKey");

    (row.skeleton.event as Record<string, unknown>).params = { retryCode: 123456 };
    expect(() =>
      intakeCaptureRows(rows.map((value) => JSON.stringify(value)).join("\n"), "2026.7.1-2"),
    ).toThrow("capture_contains_raw_number:event.params.retryCode");

    (row.skeleton.event as Record<string, unknown>).params = { items: [] };
    expect(() =>
      intakeCaptureRows(rows.map((value) => JSON.stringify(value)).join("\n"), "2026.7.1-2"),
    ).toThrow("capture_contains_raw_array:event.params.items");
  });

  test("writes collision-safe owner-only fixture files", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-openclaw-fixture-intake-"));
    try {
      const input = join(root, "capture.jsonl");
      const output = join(root, "fixtures");
      writeFileSync(input, captureJsonl());
      const paths = writeCaptureFixtures(input, output, "2026.7.1-2");
      expect(paths.map((path) => path.slice(output.length + 1))).toEqual(
        OPENCLAW_HOOKS.map((hook) => `${hook.replaceAll("_", "-")}.json`),
      );
      for (const path of paths) {
        expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
          source: { kind: "native_capture" },
        });
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      expect(() => writeCaptureFixtures(input, output, "2026.7.1-2")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function captureJsonl(hooks: readonly OpenClawHookName[] = OPENCLAW_HOOKS): string {
  const byHook = new Map(captureRows().map((row) => [row.hook, row]));
  return `${hooks.map((hook) => JSON.stringify(byHook.get(hook))).join("\n")}\n`;
}

function captureRows(): Array<
  Record<string, unknown> & {
    hook: OpenClawHookName;
    skeleton: { event: unknown; context: unknown };
  }
> {
  return OPENCLAW_HOOKS.map((hook) => {
    const event =
      hook === "before_prompt_build"
        ? { prompt: "private prompt" }
        : hook === "before_tool_call" || hook === "after_tool_call"
          ? {
              toolCallId: "native-tool-id",
              toolName: "exec",
              params: { command: "private command" },
              ...(hook === "after_tool_call" ? { result: "private result" } : {}),
            }
          : {};
    const context = {
      sessionKey: "native-session-id",
      agentId: "main",
      ...(hook === "session_start" || hook === "session_end" ? {} : { runId: "native-run-id" }),
    };
    return {
      observed_at: "2026-09-04T15:00:00.000Z",
      event: "capture",
      hook,
      skeleton: captureSkeleton(event, context),
    };
  });
}
