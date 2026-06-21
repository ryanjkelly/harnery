/**
 * Name-pool + assignment tests for src/core/agents/state/names.ts:
 * COORD_NAMES layout invariants, plus assign / loopback / idempotency /
 * resolve behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assignName, COORD_NAMES, resolveName } from "../../src/core/agents/state/names.ts";

describe("COORD_NAMES layout invariants", () => {
  test("exactly 260 entries", () => {
    expect(COORD_NAMES.length).toBe(260);
  });

  test("all unique", () => {
    expect(new Set(COORD_NAMES).size).toBe(260);
  });

  test("all ASCII (no diacritics / non-printable bytes)", () => {
    for (const name of COORD_NAMES) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence of control + non-ASCII bytes is the point
      expect(name).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  test("all single-token title-case (first upper, rest lower letters)", () => {
    for (const name of COORD_NAMES) {
      expect(name).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  test("exactly 10 names per starting letter A..Z", () => {
    const byLetter = new Map<string, number>();
    for (const name of COORD_NAMES) {
      const c = name[0]!;
      byLetter.set(c, (byLetter.get(c) ?? 0) + 1);
    }
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      expect(byLetter.get(letter)).toBe(10);
    }
  });

  test("COORD_NAMES[i] starts with letter (i % 26)", () => {
    for (let i = 0; i < COORD_NAMES.length; i++) {
      const expectedLetter = String.fromCharCode(65 + (i % 26));
      expect(COORD_NAMES[i]![0]).toBe(expectedLetter);
    }
  });
});

describe("assignName / resolveName", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-names-"));
    mkdirSync(path.join(root, ".harnery"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("advances the alphabet across new sessions (counter slots 0,1,2)", () => {
    expect(assignName(root, "sess-a", "session")).toBe(COORD_NAMES[0]); // Anna
    expect(assignName(root, "sess-b", "session")).toBe(COORD_NAMES[1]); // Bob
    expect(assignName(root, "sess-c", "session")).toBe(COORD_NAMES[2]); // Carlos
    // counter advanced exactly 3 slots
    expect(readFileSync(path.join(root, ".harnery", ".name-counter"), "utf8").trim()).toBe("3");
  });

  test("counter loops back at index 260 (260 % 260 = 0 → Anna)", () => {
    writeFileSync(path.join(root, ".harnery", ".name-counter"), "259");
    expect(assignName(root, "sess-259", "session")).toBe(COORD_NAMES[259]); // Zora
    // counter now 260; next assign wraps to index 0
    expect(assignName(root, "sess-260", "session")).toBe(COORD_NAMES[0]); // Anna
  });

  test("resume idempotency: same instance reuses its name, no counter burn", () => {
    const first = assignName(root, "sess-x", "session");
    const counterAfterFirst = readFileSync(
      path.join(root, ".harnery", ".name-counter"),
      "utf8",
    ).trim();
    const second = assignName(root, "sess-x", "session");
    expect(second).toBe(first);
    // counter unchanged on the idempotent re-assign
    expect(readFileSync(path.join(root, ".harnery", ".name-counter"), "utf8").trim()).toBe(
      counterAfterFirst,
    );
  });

  test("durable name-history resolves independent of any heartbeat", () => {
    const name = assignName(root, "sess-durable", "session");
    // No heartbeat file exists; resolveName reads only .name-history.
    expect(resolveName(root, "sess-durable")?.name).toBe(name);
    expect(resolveName(root, "sess-durable")?.kind).toBe("session");
  });

  test("resolveName 3 paths: own id, session inherit→transient, unknown→null", () => {
    assignName(root, "parent-sess", "session");
    // path 1: own instance_id → original (name, kind)
    expect(resolveName(root, "parent-sess")).toEqual({
      name: COORD_NAMES[0]!,
      kind: "session",
    });
    // path 2: a subagent whose session_id is the parent → parent's name, kind transient
    expect(resolveName(root, "subagent-id", "parent-sess")).toEqual({
      name: COORD_NAMES[0]!,
      kind: "transient",
    });
    // path 3: unknown owner, no session match → null
    expect(resolveName(root, "ghost-id")).toBeNull();
  });
});
