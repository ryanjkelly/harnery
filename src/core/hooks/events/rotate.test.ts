/**
 * Locks the size-triggered rotation of `.harnery/events.ndjson`: it rolls at
 * the cap, no-ops below it, keeps the rolled content in a dated archive, dedupes
 * same-day archives, and serializes concurrent rollers via the O_EXCL roll-lock
 * so two processes never double-rename.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { maybeRotateEventStream } from "./rotate.ts";

const CAP = 1024; // 1 KiB cap for tests

function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-rotate-"));
  mkdirSync(path.join(root, ".harnery"), { recursive: true });
  return root;
}

function streamPath(root: string): string {
  return path.join(root, ".harnery", "events.ndjson");
}

function archives(root: string): string[] {
  return readdirSync(path.join(root, ".harnery"))
    .filter((n) => n.startsWith("events-") && n.endsWith(".ndjson"))
    .sort();
}

/** Write `bytes` worth of ndjson lines to the active stream. */
function fill(root: string, bytes: number): void {
  const line = `${JSON.stringify({ event_id: "x", data: "y".repeat(64) })}\n`;
  let out = "";
  while (Buffer.byteLength(out, "utf8") < bytes) out += line;
  writeFileSync(streamPath(root), out, "utf8");
}

beforeEach(() => {
  process.env.HARNERY_EVENTS_ROLL_BYTES = String(CAP);
});
afterEach(() => {
  delete process.env.HARNERY_EVENTS_ROLL_BYTES;
});

describe("maybeRotateEventStream", () => {
  test("no-op below the cap", () => {
    const root = freshRoot();
    fill(root, CAP - 200);
    const before = readFileSync(streamPath(root), "utf8");
    expect(maybeRotateEventStream(root)).toBe(false);
    expect(archives(root)).toHaveLength(0);
    expect(readFileSync(streamPath(root), "utf8")).toBe(before);
  });

  test("no-op when the stream doesn't exist", () => {
    const root = freshRoot();
    expect(maybeRotateEventStream(root)).toBe(false);
  });

  test("rolls at the cap: archive holds the content, active is fresh + empty", () => {
    const root = freshRoot();
    fill(root, CAP + 500);
    const original = readFileSync(streamPath(root), "utf8");

    expect(maybeRotateEventStream(root)).toBe(true);

    const arch = archives(root);
    expect(arch).toHaveLength(1);
    expect(arch[0]).toMatch(/^events-\d{4}-\d{2}-\d{2}\.ndjson$/);
    // Archive preserves the rolled content verbatim.
    expect(readFileSync(path.join(root, ".harnery", arch[0]), "utf8")).toBe(original);
    // Active file exists and is empty, ready for the next append.
    expect(existsSync(streamPath(root))).toBe(true);
    expect(statSync(streamPath(root)).size).toBe(0);
  });

  test("second roll the same day dedupes with a .N suffix", () => {
    const root = freshRoot();
    fill(root, CAP + 100);
    expect(maybeRotateEventStream(root)).toBe(true);
    // Re-fill + roll again — same UTC day, so the base name is taken.
    fill(root, CAP + 100);
    expect(maybeRotateEventStream(root)).toBe(true);

    const arch = archives(root);
    expect(arch).toHaveLength(2);
    // One base name, one .1 suffix.
    expect(arch.some((n) => /^events-\d{4}-\d{2}-\d{2}\.ndjson$/.test(n))).toBe(true);
    expect(arch.some((n) => /^events-\d{4}-\d{2}-\d{2}\.1\.ndjson$/.test(n))).toBe(true);
  });

  test("a held roll-lock blocks a concurrent roll (no double-rename)", () => {
    const root = freshRoot();
    fill(root, CAP + 100);
    // Simulate a peer mid-roll: hold the lock (fresh mtime, not stale).
    const lockPath = path.join(root, ".harnery", "events.ndjson.roll.lock");
    writeFileSync(lockPath, "", "utf8");

    // Our roll must back off rather than rename behind the peer.
    expect(maybeRotateEventStream(root)).toBe(false);
    expect(archives(root)).toHaveLength(0);
    // Active stream untouched.
    expect(statSync(streamPath(root)).size).toBeGreaterThan(CAP);
  });

  test("a stale roll-lock is stolen so a crashed roller can't wedge rotation", () => {
    const root = freshRoot();
    fill(root, CAP + 100);
    const lockPath = path.join(root, ".harnery", "events.ndjson.roll.lock");
    writeFileSync(lockPath, "", "utf8");
    const lockMtime = statSync(lockPath).mtimeMs;

    // Pretend "now" is well past the stale threshold (60s).
    expect(maybeRotateEventStream(root, lockMtime + 120_000)).toBe(true);
    expect(archives(root)).toHaveLength(1);
  });
});
