/**
 * Locks the agent image-feed capture effect: viewed (Read) + produced (Bash)
 * detection, content-addressed dedup, the produced mtime gate, the size cap,
 * and the emitted `image.captured` shape. Plus the retention janitor's size +
 * age pruning.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureImages, imageJanitor } from "../../src/core/hooks/effects/image-capture.ts";

// A 1×1 PNG (smallest valid). Bytes are stable so the sha256 is deterministic.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-img-"));
  mkdirSync(path.join(root, ".harnery"), { recursive: true });
  return root;
}

function writePng(dir: string, name: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, PNG_1x1);
  return p;
}

function readCaptured(root: string): Array<Record<string, unknown>> {
  const p = path.join(root, ".harnery", "events.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.event_type === "image.captured");
}

function imagesOf(root: string): string[] {
  const dir = path.join(root, ".harnery", "images");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("image-capture: viewed (Read)", () => {
  test("captures a Read of an image → blob + event with role=viewed", () => {
    const root = freshRoot();
    const png = writePng(root, "shot.png");
    captureImages(root, {
      eventType: "tool.pre_use",
      data: {
        tool_name: "Read",
        tool_input: JSON.stringify({ file_path: png }),
        intent: "look at the screenshot",
        tool_use_id: "toolu_1",
      },
      payload: { raw: { cwd: root } } as never,
      instanceId: "iid-1",
      sessionId: "sid-1",
      harness: "claude-code",
    });

    const events = readCaptured(root);
    expect(events.length).toBe(1);
    const d = events[0]!.data as Record<string, unknown>;
    expect(d.role).toBe("viewed");
    expect(d.ext).toBe("png");
    expect(d.intent).toBe("look at the screenshot");
    expect(d.source_path).toBe("shot.png"); // canonicalized under coordRoot
    expect(typeof d.hash).toBe("string");
    expect(imagesOf(root)).toEqual([`${d.hash}.png`]);
  });

  test("ignores Read of a non-image file", () => {
    const root = freshRoot();
    const txt = path.join(root, "notes.txt");
    writeFileSync(txt, "hello");
    captureImages(root, {
      eventType: "tool.pre_use",
      data: { tool_name: "Read", tool_input: JSON.stringify({ file_path: txt }) },
      payload: { raw: { cwd: root } } as never,
      instanceId: "iid",
      sessionId: "sid",
      harness: "claude-code",
    });
    expect(readCaptured(root).length).toBe(0);
  });

  test("dedup: re-viewing identical bytes → one blob, two events", () => {
    const root = freshRoot();
    const a = writePng(root, "a.png");
    const b = writePng(root, "b.png"); // same bytes, different name
    for (const file of [a, b]) {
      captureImages(root, {
        eventType: "tool.pre_use",
        data: { tool_name: "Read", tool_input: JSON.stringify({ file_path: file }) },
        payload: { raw: { cwd: root } } as never,
        instanceId: "iid",
        sessionId: "sid",
        harness: "claude-code",
      });
    }
    expect(readCaptured(root).length).toBe(2); // two touches
    expect(imagesOf(root).length).toBe(1); // one content-addressed blob
  });
});

describe("image-capture: produced (Bash)", () => {
  test("captures a freshly-produced image referenced in command output", () => {
    const root = freshRoot();
    const png = writePng(root, "out.png");
    captureImages(root, {
      eventType: "tool.post_use",
      data: { tool_name: "Bash" },
      payload: {
        raw: { cwd: root, tool_input: { command: `harn browse https://x --out ${root}/out` } },
        tool_response: { stdout: `wrote ${png}`, stderr: "" },
      } as never,
      instanceId: "iid",
      sessionId: "sid",
      harness: "claude-code",
    });
    const events = readCaptured(root);
    expect(events.length).toBe(1);
    const d = events[0]!.data as Record<string, unknown>;
    expect(d.role).toBe("produced");
    expect(String(d.command_head)).toContain("harn browse");
  });

  test("produced mtime gate: an old image mentioned in output is NOT captured", () => {
    const root = freshRoot();
    const png = writePng(root, "old.png");
    const old = Date.now() / 1000 - 600; // 10 min ago
    utimesSync(png, old, old);
    captureImages(root, {
      eventType: "tool.post_use",
      data: { tool_name: "Bash" },
      payload: {
        raw: { cwd: root, tool_input: { command: `cat ${png}` } },
        tool_response: { stdout: png },
      } as never,
      instanceId: "iid",
      sessionId: "sid",
      harness: "claude-code",
    });
    expect(readCaptured(root).length).toBe(0);
  });
});

describe("imageJanitor", () => {
  test("prunes blobs older than the age cap", () => {
    const root = freshRoot();
    const dir = path.join(root, ".harnery", "images");
    mkdirSync(dir, { recursive: true });
    const oldBlob = path.join(dir, `${"a".repeat(64)}.png`);
    const newBlob = path.join(dir, `${"b".repeat(64)}.png`);
    writeFileSync(oldBlob, PNG_1x1);
    writeFileSync(newBlob, PNG_1x1);
    const old = Date.now() / 1000 - 40 * 24 * 60 * 60; // 40 days ago
    utimesSync(oldBlob, old, old);

    const prev = process.env.HARNERY_IMAGES_MAX_AGE_DAYS;
    process.env.HARNERY_IMAGES_MAX_AGE_DAYS = "30";
    try {
      imageJanitor(root);
    } finally {
      if (prev === undefined) delete process.env.HARNERY_IMAGES_MAX_AGE_DAYS;
      else process.env.HARNERY_IMAGES_MAX_AGE_DAYS = prev;
    }

    expect(existsSync(oldBlob)).toBe(false);
    expect(existsSync(newBlob)).toBe(true);
  });

  test("prunes oldest-first past the size cap", () => {
    const root = freshRoot();
    const dir = path.join(root, ".harnery", "images");
    mkdirSync(dir, { recursive: true });
    // Three blobs; cap below their combined size so the oldest gets dropped.
    const names = ["a", "b", "c"].map((c) => path.join(dir, `${c.repeat(64)}.png`));
    names.forEach((n, i) => {
      writeFileSync(n, PNG_1x1);
      const t = Date.now() / 1000 - (names.length - i) * 100; // a oldest, c newest
      utimesSync(n, t, t);
    });

    const prev = process.env.HARNERY_IMAGES_MAX_BYTES;
    process.env.HARNERY_IMAGES_MAX_BYTES = String(PNG_1x1.length * 2 + 1); // room for ~2
    try {
      imageJanitor(root);
    } finally {
      if (prev === undefined) delete process.env.HARNERY_IMAGES_MAX_BYTES;
      else process.env.HARNERY_IMAGES_MAX_BYTES = prev;
    }

    const remaining = imagesOf(root);
    expect(remaining.length).toBe(2);
    expect(remaining).not.toContain(`${"a".repeat(64)}.png`); // oldest pruned
  });
});
