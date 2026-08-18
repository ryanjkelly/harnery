import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetCoordRootCache } from "./coord-reader.ts";
import { readImageCaptures } from "./images.ts";

const roots: string[] = [];
const previousRoot = process.env.HARNERY_COORD_ROOT;

afterEach(() => {
  if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = previousRoot;
  __resetCoordRootCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readImageCaptures", () => {
  test("reports the privacy-safe V2 image feed as explicitly unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-images-v2-"));
    roots.push(root);
    mkdirSync(join(root, ".harnery"), { recursive: true });
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();

    const response = readImageCaptures();

    expect(response.images).toEqual([]);
    expect(response.meta).toMatchObject({
      source: "v2",
      authoritative: false,
      distinct: 0,
      total_touches: 0,
    });
    expect(response.meta.reason).toContain("do not expose");
  });
});
