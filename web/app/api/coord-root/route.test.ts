import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { coordRootId } from "../../../../src/lib/coord-root-id";
import { __resetCoordRootCache } from "@/lib/coord-reader";
import { GET } from "./route";

let root: string;
let priorRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "harn-coord-root-"));
  mkdirSync(path.join(root, ".harnery"));
  priorRoot = process.env.HARNERY_COORD_ROOT;
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = priorRoot;
  __resetCoordRootCache();
  rmSync(root, { recursive: true, force: true });
});

describe("coord-root identity", () => {
  test("returns an opaque identity for the dashboard's canonical repository root", async () => {
    const response = GET();
    const body = (await response.json()) as { root_id: string };

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.root_id).toBe(coordRootId(realpathSync(root)));
    expect(JSON.stringify(body)).not.toContain(root);
  });
});
