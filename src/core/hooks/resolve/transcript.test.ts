import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectForkParent, scanTranscriptModel } from "./transcript.ts";

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
