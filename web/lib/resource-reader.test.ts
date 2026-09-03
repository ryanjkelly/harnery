import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESOURCE_SNAPSHOT_SCHEMA_VERSION } from "../../src/core/resources/contract";
import { sampleResources } from "../../src/core/resources/sampler";
import { resourcePaths, writePrivateJsonAtomic } from "../../src/core/resources/storage";
import { readResourceDashboard } from "./resource-reader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resource dashboard reader", () => {
  test("returns a validated snapshot and its freshness", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-resource-reader-"));
    roots.push(root);
    const snapshot = sampleResources(root, undefined, { nowMs: 10_000 }).snapshot;
    writePrivateJsonAtomic(resourcePaths(root).snapshot, snapshot);
    const report = readResourceDashboard(root, 12_500);
    expect(report.snapshot?.schema_version).toBe(RESOURCE_SNAPSHOT_SCHEMA_VERSION);
    expect(report.freshness_ms).toBe(2_500);
  });
});
