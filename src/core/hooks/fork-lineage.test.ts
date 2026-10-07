import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectClaudeCodeFork } from "./fork-lineage.ts";

const P = "11111111-1111-4111-8111-111111111111";
const F = "33333333-3333-4333-8333-333333333333";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harn-fork-lineage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSession(id: string, rows: object[]): string {
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return p;
}

const live = (ids: string[]) => (id: string) => ids.includes(id);

describe("detectClaudeCodeFork", () => {
  test("inherited rows from a live parent are a fork (desktop Fork from here)", () => {
    const path = writeSession(F, [
      { type: "user", uuid: "u1", sessionId: P },
      { type: "user", uuid: "u2", sessionId: F },
    ]);
    expect(
      detectClaudeCodeFork({
        coordRoot: dir,
        transcriptPath: path,
        sessionId: F,
        source: "resume",
        isLive: live([P]),
      }),
    ).toEqual({ fork: true, forkedFrom: P, checked: true });
  });

  test("inherited rows from a finished session are a continuation, not a fork", () => {
    const path = writeSession(F, [{ type: "user", uuid: "u1", sessionId: P }]);
    expect(
      detectClaudeCodeFork({
        coordRoot: dir,
        transcriptPath: path,
        sessionId: F,
        source: "resume",
        isLive: live([]),
      }),
    ).toEqual({ fork: false, checked: true });
  });

  test("a declared CLI fork before its transcript exists is a fork awaiting its parent", () => {
    expect(
      detectClaudeCodeFork({
        coordRoot: dir,
        transcriptPath: join(dir, `${F}.jsonl`),
        sessionId: F,
        source: "fork",
        isLive: live([]),
      }),
    ).toEqual({ fork: true, checked: false });
  });

  test("a known fork resolves its parent by copied message uuids once the transcript lands", () => {
    const rows = (id: string) =>
      [1, 2, 3].map((n) => ({
        type: "user",
        uuid: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`,
        sessionId: id,
      }));
    writeSession(P, rows(P));
    const path = writeSession(F, rows(F));
    expect(
      detectClaudeCodeFork({
        coordRoot: dir,
        transcriptPath: path,
        sessionId: F,
        knownFork: true,
        isLive: live([]),
      }),
    ).toEqual({ fork: true, forkedFrom: P, checked: true });
  });

  test("a fresh startup session is checked without being a fork", () => {
    expect(
      detectClaudeCodeFork({
        coordRoot: dir,
        transcriptPath: join(dir, `${F}.jsonl`),
        sessionId: F,
        source: "startup",
      }),
    ).toEqual({ fork: false, checked: true });
  });

  test("a resumed parent whose rows are all its own is never labeled a fork", () => {
    const path = writeSession(P, [{ type: "user", uuid: "u1", sessionId: P }]);
    expect(
      detectClaudeCodeFork({
        coordRoot: dir,
        transcriptPath: path,
        sessionId: P,
        source: "resume",
        isLive: live([P]),
      }),
    ).toEqual({ fork: false, checked: true });
  });
});
