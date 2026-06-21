import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanTranscriptModel } from "./transcript.ts";

describe("scanTranscriptModel", () => {
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
    expect(scanTranscriptModel(p)).toBe("claude-opus-4-8");
  });

  test("walks from the end and returns the latest model", () => {
    const p = writeTranscript([
      { type: "assistant", message: { model: "claude-sonnet-4-6" } },
      { type: "assistant", message: { model: "claude-opus-4-8" } },
    ]);
    expect(scanTranscriptModel(p)).toBe("claude-opus-4-8");
  });

  test("falls back to a top-level model field", () => {
    const p = writeTranscript([{ type: "assistant", model: "gpt-5.5" }]);
    expect(scanTranscriptModel(p)).toBe("gpt-5.5");
  });

  test("skips synthetic placeholders", () => {
    const p = writeTranscript([
      { type: "assistant", message: { model: "claude-opus-4-8" } },
      { type: "assistant", message: { model: "<synthetic>" } },
    ]);
    expect(scanTranscriptModel(p)).toBe("claude-opus-4-8");
  });

  test("returns undefined for missing / undefined / model-less transcripts", () => {
    expect(scanTranscriptModel(undefined)).toBeUndefined();
    expect(scanTranscriptModel(join(dir, "nope.jsonl"))).toBeUndefined();
    const p = writeTranscript([{ type: "user", message: { role: "user" } }]);
    expect(scanTranscriptModel(p)).toBeUndefined();
  });
});
