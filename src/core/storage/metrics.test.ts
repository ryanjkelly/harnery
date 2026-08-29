import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeMetricsSidecar, readMetricsSidecar } from "./metrics.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("log metrics sidecar", () => {
  test("merges counters and starts a new generation after corruption", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-metrics-"));
    roots.push(root);
    const path = join(root, "metrics.json");
    expect(mergeMetricsSidecar(path, { appended: 2 }).generation_reset).toBeTrue();
    expect(readMetricsSidecar(path)?.counters.appended).toBe(2);
    writeFileSync(path, "not-json");
    expect(mergeMetricsSidecar(path, { dropped: 1 }).generation_reset).toBeTrue();
    expect(readMetricsSidecar(path)?.counters.dropped).toBe(1);
  });
});
