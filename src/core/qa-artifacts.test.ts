import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_MANIFEST } from "./artifacts/index.ts";
import { createManagedQaOutParent, latestManagedQaRun } from "./qa-artifacts.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-qa-artifacts-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRun(parent: string, id: string, startedAt: string): string {
  const runDir = join(parent, `run-${id}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "run-status.json"),
    `${JSON.stringify({ run_id: id, started_at: startedAt }, null, 2)}\n`,
  );
  return runDir;
}

describe("managed QA artifacts", () => {
  test("implicit output creates a manifest-backed workspace under .harnery/artifacts", () => {
    const outParent = createManagedQaOutParent(root, "qa-run");
    expect(outParent).toContain(join(root, ".harnery", "artifacts"));
    expect(existsSync(join(outParent, ARTIFACT_MANIFEST))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(outParent, ARTIFACT_MANIFEST), "utf8"));
    expect(manifest.slug).toBe("qa-run");
    expect(manifest.purpose).toBe("Page QA run evidence");
  });

  test("latest run is selected across isolated qa-run and qa-record workspaces", () => {
    const runnerParent = createManagedQaOutParent(root, "qa-run");
    const recordParent = createManagedQaOutParent(root, "qa-record");
    writeRun(runnerParent, "older", "2026-09-01T12:00:00.000Z");
    const newer = writeRun(recordParent, "newer", "2026-09-01T13:00:00.000Z");
    expect(latestManagedQaRun(root)).toBe(newer);
  });

  test("unmanaged lookalikes are not eligible for no-path qa-status", () => {
    const unmanaged = join(root, ".harnery", "artifacts", "unmanaged");
    writeRun(unmanaged, "fake", "2026-09-01T14:00:00.000Z");
    expect(latestManagedQaRun(root)).toBeNull();
  });

  test("partial manifests are not treated as managed QA workspaces", () => {
    const partial = join(root, ".harnery", "artifacts", "partial");
    const runDir = writeRun(partial, "fake", "2026-09-01T14:00:00.000Z");
    writeFileSync(
      join(partial, ARTIFACT_MANIFEST),
      `${JSON.stringify({ schema_version: 1, slug: "qa-run" }, null, 2)}\n`,
    );
    expect(existsSync(runDir)).toBe(true);
    expect(latestManagedQaRun(root)).toBeNull();
  });
});
