import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import {
  buildToolFailureDetailV3,
  readToolFailureDetailsV3,
  recordToolFailureDetailV3,
  TOOL_FAILURE_DETAILS_MAX_DAY_BYTES,
  TOOL_FAILURE_ERROR_MAX_CHARS,
  toolFailureDetailsRoot,
} from "./tool-failure-details.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-tool-failures-"));
  roots.push(root);
  return root;
}

describe("tool failure details", () => {
  test("prefers the harness error text and summarizes the command", () => {
    const root = tempRoot();
    const detail = buildToolFailureDetailV3(root, {
      event_id: "evt_1",
      tool_name: "Bash",
      tool_input: { command: "git push origin main", description: "Push" },
      tool_response: null,
      raw: { error: "Exit code 128\nfatal: could not read from remote" },
    });
    expect(detail.input).toBe("git push origin main");
    expect(detail.error).toBe("Exit code 128\nfatal: could not read from remote");
    expect(detail.tool).toBe("Bash");
  });

  test("falls back to the tool response and its error-like fields", () => {
    const root = tempRoot();
    expect(
      buildToolFailureDetailV3(root, {
        event_id: "evt_2",
        tool_name: "shell",
        tool_response: { stderr: "permission denied", exit_code: 1 },
      }).error,
    ).toBe("permission denied");
    expect(
      buildToolFailureDetailV3(root, {
        event_id: "evt_3",
        tool_name: "Read",
        tool_response: "File does not exist.",
      }).error,
    ).toBe("File does not exist.");
  });

  test("reads an error field under another harness's name", () => {
    const root = tempRoot();
    expect(
      buildToolFailureDetailV3(root, {
        event_id: "evt_6",
        tool_name: "Read",
        raw: { error_message: "ENOENT: no such file", failure_type: "error" },
      }).error,
    ).toBe("ENOENT: no such file");
    expect(
      buildToolFailureDetailV3(root, {
        event_id: "evt_7",
        tool_name: "Read",
        raw: { failure_type: "timeout" },
      }).error,
    ).toBe("failure type: timeout");
  });

  test("redacts secrets, makes project paths relative, and strips terminal colors", () => {
    const root = tempRoot();
    const detail = buildToolFailureDetailV3(root, {
      event_id: "evt_4",
      tool_name: "Bash",
      tool_input: { command: `curl -H "Authorization: Bearer abc.def.ghi" ${root}/x` },
      raw: { error: `\u001b[31mfailed\u001b[0m reading ${root}/src/a.ts with API_TOKEN=hunter2` },
    });
    expect(detail.input).not.toContain("abc.def.ghi");
    expect(detail.input).toContain("Bearer [REDACTED:token]");
    expect(detail.input).not.toContain(root);
    expect(detail.error).toBe("failed reading src/a.ts with API_TOKEN=[REDACTED]");
  });

  test("keeps the start and the end of a long error", () => {
    const root = tempRoot();
    const long = `START ${"x".repeat(10_000)} END`;
    const detail = buildToolFailureDetailV3(root, {
      event_id: "evt_5",
      tool_name: "Bash",
      raw: { error: long },
    });
    expect(detail.error?.length).toBe(TOOL_FAILURE_ERROR_MAX_CHARS);
    expect(detail.error?.startsWith("START")).toBeTrue();
    expect(detail.error?.endsWith("END")).toBeTrue();
    expect(detail.error).toContain("characters omitted");
    expect(detail.error_chars).toBe(long.length);
  });

  test("writes owner-only daily files and reads records back by event id", () => {
    const root = tempRoot();
    const now = new Date("2026-11-24T08:00:00.000Z");
    const path = recordToolFailureDetailV3(
      root,
      { event_id: "evt_a", tool_name: "Read", tool_input: { file_path: "a.ts" }, raw: {} },
      now,
    );
    recordToolFailureDetailV3(root, { event_id: "evt_b", tool_name: "Edit" }, now);
    expect(path).toBe(join(toolFailureDetailsRoot(root), "2026-11-24.jsonl"));
    if (process.platform !== "win32") {
      expect(statSync(path as string).mode & 0o077).toBe(0);
    }
    const found = readToolFailureDetailsV3(root, new Set(["evt_a", "evt_missing"]));
    expect([...found.keys()]).toEqual(["evt_a"]);
    expect(found.get("evt_a")?.input).toBe("a.ts");
  });

  test("removes daily files past the 14-day window and skips a full day", () => {
    const root = tempRoot();
    const dir = toolFailureDetailsRoot(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-11-09.jsonl"), "");
    writeFileSync(join(dir, "2026-11-11.jsonl"), "");
    writeFileSync(join(dir, "notes.txt"), "kept");
    const now = new Date("2026-11-24T08:00:00.000Z");
    writeFileSync(join(dir, "2026-11-24.jsonl"), "x".repeat(TOOL_FAILURE_DETAILS_MAX_DAY_BYTES));
    expect(recordToolFailureDetailV3(root, { event_id: "evt_c", tool_name: "Bash" }, now)).toBe(
      undefined,
    );
    expect(existsSync(join(dir, "2026-11-09.jsonl"))).toBeFalse();
    expect(existsSync(join(dir, "2026-11-11.jsonl"))).toBeTrue();
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("kept");
  });

  test("never throws when the store cannot be written", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".harnery"), "a file where a directory belongs");
    expect(recordToolFailureDetailV3(root, { event_id: "evt_d", tool_name: "Bash" })).toBe(
      undefined,
    );
  });
});
