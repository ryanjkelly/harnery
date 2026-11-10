import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import {
  containsTrackedPath,
  readTrackedPaths,
  setAfterTrackedListingForTest,
} from "./tracked-paths.ts";

const roots: string[] = [];

afterEach(() => {
  setAfterTrackedListingForTest(null);
  for (const root of roots.splice(0)) removeDir(root);
});

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, windowsHide: true });
  expect(result.status).toBe(0);
}

/** A repository with one tracked file deep inside the artifact store. */
function repo(): { root: string; store: string } {
  const root = mkdtempSync(join(tmpdir(), "harnery-tracked-"));
  roots.push(root);
  git(root, "init", "-q");
  const store = join(root, ".harnery", "artifacts");
  mkdirSync(join(store, "unit-a", "nested"), { recursive: true });
  mkdirSync(join(store, "unit-b"), { recursive: true });
  writeFileSync(join(store, "unit-a", "nested", "kept.txt"), "tracked\n");
  writeFileSync(join(store, "unit-b", "loose.txt"), "untracked\n");
  writeFileSync(join(root, "outside.txt"), "tracked elsewhere\n");
  git(root, "add", "-f", join(store, "unit-a", "nested", "kept.txt"), "outside.txt");
  return { root, store };
}

describe("tracked path snapshot", () => {
  test("answers for a tracked file, each of its ancestors, and untracked siblings", () => {
    const { root, store } = repo();
    const snapshot = readTrackedPaths(root, store);
    expect(snapshot.entries).not.toBeNull();
    expect(containsTrackedPath(root, join(store, "unit-a"), snapshot)).toBe(true);
    expect(containsTrackedPath(root, join(store, "unit-a", "nested"), snapshot)).toBe(true);
    expect(containsTrackedPath(root, join(store, "unit-a", "nested", "kept.txt"), snapshot)).toBe(
      true,
    );
    expect(containsTrackedPath(root, join(store, "unit-b"), snapshot)).toBe(false);
    expect(containsTrackedPath(root, join(store, "unit-c"), snapshot)).toBe(false);
  });

  test("agrees with a per-path read when no snapshot is given", () => {
    const { root, store } = repo();
    expect(containsTrackedPath(root, join(store, "unit-a"))).toBe(true);
    expect(containsTrackedPath(root, join(store, "unit-b"))).toBe(false);
  });

  test("a path staged while the listing runs is not reported untracked", () => {
    const { root, store } = repo();
    let staged = false;
    setAfterTrackedListingForTest(() => {
      if (staged) return;
      staged = true;
      git(root, "add", "-f", join(store, "unit-b", "loose.txt"));
    });
    const snapshot = readTrackedPaths(root, store);
    expect(staged).toBe(true);
    expect(containsTrackedPath(root, join(store, "unit-b"), snapshot)).toBe(true);
  });

  test("an index that keeps changing during every listing fails closed", () => {
    const { root, store } = repo();
    let n = 0;
    setAfterTrackedListingForTest(() => {
      const file = join(store, "unit-b", `churn-${n++}.txt`);
      writeFileSync(file, "x\n");
      git(root, "add", "-f", file);
    });
    const snapshot = readTrackedPaths(root, store);
    expect(snapshot.entries).toBeNull();
    expect(containsTrackedPath(root, join(store, "unit-b"), snapshot)).toBe(true);
  });

  test("a path outside the snapshot's scope gets its own read instead of a guess", () => {
    const { root, store } = repo();
    const snapshot = readTrackedPaths(root, store);
    expect(containsTrackedPath(root, join(root, "outside.txt"), snapshot)).toBe(true);
  });

  test("fails closed outside the repository or when Git cannot answer", () => {
    const { root, store } = repo();
    expect(containsTrackedPath(root, join(tmpdir(), "elsewhere"))).toBe(true);
    const plain = mkdtempSync(join(tmpdir(), "harnery-untracked-"));
    roots.push(plain);
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(plain, "missing-git-dir");
    try {
      const snapshot = readTrackedPaths(plain, join(plain, "store"));
      expect(snapshot.entries).toBeNull();
      expect(containsTrackedPath(plain, join(plain, "store", "unit"), snapshot)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
    expect(containsTrackedPath(root, join(store, "unit-b"))).toBe(false);
  });

  test.if(process.platform === "win32" || process.platform === "darwin")(
    "matches regardless of letter case where the file system ignores it",
    () => {
      const { root, store } = repo();
      const snapshot = readTrackedPaths(root, store);
      expect(containsTrackedPath(root, join(store, "UNIT-A"), snapshot)).toBe(true);
    },
  );
});
