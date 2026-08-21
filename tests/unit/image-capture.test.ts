import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventV3 } from "../../src/core/events/v3/contract.ts";
import { validateEventV3 } from "../../src/core/events/v3/validate.ts";
import type { ParsedPayload } from "../../src/core/hooks/adapter/parse.ts";
import {
  captureImages,
  imageJanitor,
  recordImageArtifactsV3,
} from "../../src/core/hooks/effects/image-capture.ts";
import { eventV3Fixture } from "../helpers/event-v3.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-img-v3-"));
  mkdirSync(path.join(root, ".harnery"), { recursive: true });
  return root;
}

function writePng(dir: string, name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, PNG_1X1);
  return file;
}

function payload(value: Partial<ParsedPayload>): ParsedPayload {
  return { raw: { cwd: value.cwd }, ...value };
}

function imagesOf(root: string): string[] {
  const dir = path.join(root, ".harnery", "images");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("V3 image capture", () => {
  test("content-addresses a viewed image with only a workspace-relative path", () => {
    const root = freshRoot();
    const file = writePng(root, "shot.png");

    const captured = captureImages(
      root,
      "tool.requested",
      payload({ cwd: root, tool_name: "view_image", tool_input: { path: file } }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ role: "viewed", ext: "png", workspace_path: "shot.png" });
    expect(imagesOf(root)).toEqual([`${captured[0]!.hash}.png`]);
  });

  test("captures fresh shell output but rejects an old referenced image", () => {
    const root = freshRoot();
    const fresh = writePng(root, "fresh.png");
    const old = writePng(root, "old.png");
    const tenMinutesAgo = Date.now() / 1_000 - 600;
    utimesSync(old, tenMinutesAgo, tenMinutesAgo);

    const captured = captureImages(
      root,
      "tool.completed",
      payload({
        cwd: root,
        tool_name: "exec_command",
        tool_input: { cmd: `render ${fresh} ${old}` },
        tool_response: { output: `wrote ${fresh}; baseline ${old}` },
      }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ role: "produced", workspace_path: "fresh.png" });
  });

  test("records a schema-valid canonical artifact observation", () => {
    const root = freshRoot();
    const source = eventV3Fixture("tool.requested", 1) as EventV3;
    const hash = "b".repeat(64);

    recordImageArtifactsV3(root, source, [
      { hash, ext: "png", bytes: PNG_1X1.length, role: "viewed", workspace_path: "shot.png" },
    ]);

    const active = path.join(root, ".harnery", "ledgers", "v3", "active.ndjson");
    const event = JSON.parse(readFileSync(active, "utf8").trim()) as EventV3;
    expect(validateEventV3(event).issues).toEqual([]);
    expect(event).toMatchObject({
      event_type: "artifact.observed",
      links: { caused_by: [source.event_id] },
      payload: {
        artifact: {
          artifact_id: `art_${hash}`,
          kind: "image",
          media_type: "image/png",
          workspace_path: "shot.png",
        },
        operation: "viewed",
      },
    });
  });
});

describe("imageJanitor", () => {
  test("prunes by age and then oldest-first by size", () => {
    const root = freshRoot();
    const dir = path.join(root, ".harnery", "images");
    mkdirSync(dir, { recursive: true });
    const names = ["a", "b", "c"].map((value) => path.join(dir, `${value.repeat(64)}.png`));
    for (const [index, name] of names.entries()) {
      writeFileSync(name, PNG_1X1);
      const timestamp = Date.now() / 1_000 - (names.length - index) * 100;
      utimesSync(name, timestamp, timestamp);
    }
    const expired = path.join(dir, `${"d".repeat(64)}.png`);
    writeFileSync(expired, PNG_1X1);
    const fortyDaysAgo = Date.now() / 1_000 - 40 * 24 * 60 * 60;
    utimesSync(expired, fortyDaysAgo, fortyDaysAgo);

    const previousBytes = process.env.HARNERY_IMAGES_MAX_BYTES;
    const previousAge = process.env.HARNERY_IMAGES_MAX_AGE_DAYS;
    process.env.HARNERY_IMAGES_MAX_BYTES = String(PNG_1X1.length * 2 + 1);
    process.env.HARNERY_IMAGES_MAX_AGE_DAYS = "30";
    try {
      imageJanitor(root);
    } finally {
      if (previousBytes === undefined) delete process.env.HARNERY_IMAGES_MAX_BYTES;
      else process.env.HARNERY_IMAGES_MAX_BYTES = previousBytes;
      if (previousAge === undefined) delete process.env.HARNERY_IMAGES_MAX_AGE_DAYS;
      else process.env.HARNERY_IMAGES_MAX_AGE_DAYS = previousAge;
    }

    expect(imagesOf(root)).toHaveLength(2);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(names[0]!)).toBe(false);
  });
});
