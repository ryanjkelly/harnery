import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventV3 } from "../../src/core/events/v3/contract.ts";
import { eventV3Fixture, fixtureObject } from "../../tests/helpers/event-v3.ts";
import { __resetCoordRootCache } from "./coord-reader.ts";
import { projectImageCaptures, readImageCaptures } from "./images.ts";

const roots: string[] = [];
const previousRoot = process.env.HARNERY_COORD_ROOT;

afterEach(() => {
  if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = previousRoot;
  __resetCoordRootCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readImageCaptures", () => {
  test("lists retained pre-V3 blobs as unattributed images", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-images-v3-"));
    roots.push(root);
    const imageDir = join(root, ".harnery", "images");
    mkdirSync(imageDir, { recursive: true });
    const hash = "a".repeat(64);
    writeFileSync(join(imageDir, `${hash}.png`), Buffer.from("fixture"));
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();

    const response = readImageCaptures();

    expect(response.images).toHaveLength(1);
    expect(response.images[0]).toMatchObject({
      hash,
      ext: "png",
      touch_count: 0,
      agents: [],
      roles: [],
      blob_exists: true,
    });
    expect(response.meta).toMatchObject({
      source: "v3",
      authoritative: false,
      distinct: 1,
      total_touches: 0,
    });
    expect(response.meta.reason).toContain("metadata is temporarily unavailable");
  });

  test("joins canonical artifact observations to their source tool and identity", () => {
    const hash = "b".repeat(64);
    const source = eventV3Fixture("tool.requested", 1);
    const artifact = eventV3Fixture("artifact.observed", 2);
    fixtureObject(source.payload).tool = { namespace: "codex", name: "view_image" };
    fixtureObject(artifact.scope).instance_id = fixtureObject(source.scope).instance_id;
    fixtureObject(artifact.scope).session_id = fixtureObject(source.scope).session_id;
    fixtureObject(artifact.scope).generation_id = fixtureObject(source.scope).generation_id;
    fixtureObject(artifact.links).caused_by = [source.event_id];
    fixtureObject(artifact.payload).artifact = {
      artifact_id: `art_${hash}`,
      kind: "image",
      media_type: "image/png",
      bytes: 7,
      retention_class: "bounded_local",
      workspace_path: "screens/shot.png",
    };
    fixtureObject(artifact.payload).operation = "viewed";
    const instanceId = String(fixtureObject(artifact.scope).instance_id);

    const projected = projectImageCaptures(
      [source as EventV3, artifact as EventV3],
      new Map([[hash, { ext: "png", bytes: 7, mtime: "2026-08-18T15:00:00.000Z" }]]),
      { [instanceId]: { name: "agent-Dahlia", platform: "codex" } },
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      hash,
      touch_count: 1,
      agents: ["agent-Dahlia"],
      roles: ["viewed"],
      blob_exists: true,
      touches: [
        {
          agent: "agent-Dahlia",
          role: "viewed",
          source_path: "screens/shot.png",
          tool_name: "view_image",
          adapter: "codex",
        },
      ],
    });
  });
});
