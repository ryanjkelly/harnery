import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetStorageSharing } from "../storage/modes.ts";
import type { WorkspaceBinding } from "../workflow/workspaces/types.ts";
import { ensureDirectory, lockIndex } from "./content.ts";

const roots: string[] = [];
const originalSharing = process.env.HARNERY_STORAGE_SHARING;
const originalUmask = process.umask();
afterEach(() => {
  process.umask(originalUmask);
  if (originalSharing === undefined) delete process.env.HARNERY_STORAGE_SHARING;
  else process.env.HARNERY_STORAGE_SHARING = originalSharing;
  resetStorageSharing();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(sharing: "private" | "group") {
  const root = mkdtempSync(join(tmpdir(), "turn-rollback-modes-"));
  roots.push(root);
  chmodSync(root, 0o750);
  const gitdir = join(root, "gitdir");
  mkdirSync(gitdir);
  writeFileSync(join(gitdir, "index"), "initial index");
  process.env.HARNERY_STORAGE_SHARING = sharing;
  resetStorageSharing();
  process.umask(0o077);
  const state = join(root, "state", "nested");
  ensureDirectory(state);
  const binding = {
    repository: { gitdir: { realpath: gitdir } },
  } as WorkspaceBinding;
  return { root, gitdir, state, binding };
}

function mode(path: string): number {
  return statSync(path).mode & 0o7777;
}

describe.skipIf(process.platform === "win32")("turn rollback project-state modes", () => {
  test("private rollback state and index publication remain owner-only under a strict umask", () => {
    const { root, gitdir, state, binding } = fixture("private");
    expect(mode(root)).toBe(0o750);
    expect(mode(join(root, "state"))).toBe(0o700);
    expect(mode(state)).toBe(0o700);
    const lock = lockIndex(binding, state);
    try {
      expect(mode(join(gitdir, "index.lock"))).toBe(0o600);
      expect(mode(lock.privatePath)).toBe(0o600);
      writeFileSync(lock.privatePath, "private restored index");
      lock.publish();
      expect(mode(join(gitdir, "index"))).toBe(0o600);
      expect(mode(root)).toBe(0o750);
    } finally {
      lock.close();
    }
  });

  test("group rollback state retains setgid and a shared index under a strict umask", () => {
    const { root, gitdir, state, binding } = fixture("group");
    expect(mode(root)).toBe(0o750);
    expect(mode(join(root, "state"))).toBe(0o2770);
    expect(mode(state)).toBe(0o2770);
    const lock = lockIndex(binding, state);
    try {
      expect(mode(join(gitdir, "index.lock"))).toBe(0o660);
      expect(mode(lock.privatePath)).toBe(0o660);
      writeFileSync(lock.privatePath, "group restored index");
      lock.publish();
      expect(mode(join(gitdir, "index"))).toBe(0o660);
      expect(mode(root)).toBe(0o750);
    } finally {
      lock.close();
    }
  });
  test.skipIf(!fs.existsSync("/proc/self/fd"))(
    "new state directories sync their existing parent after applying the configured mode",
    () => {
      const root = mkdtempSync(join(tmpdir(), "turn-rollback-parent-mode-"));
      roots.push(root);
      chmodSync(root, 0o750);
      process.env.HARNERY_STORAGE_SHARING = "group";
      resetStorageSharing();
      process.umask(0o077);
      const child = join(root, "state");
      const synced: { path: string; mode: number }[] = [];
      const original = fs.fsyncSync;
      const sync = spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
        synced.push({ path: fs.realpathSync(`/proc/self/fd/${fd}`), mode: mode(child) });
        original(fd);
      });
      try {
        ensureDirectory(child);
        expect(synced).toEqual([
          { path: child, mode: 0o2770 },
          { path: root, mode: 0o2770 },
        ]);
        expect(mode(root)).toBe(0o750);
      } finally {
        sync.mockRestore();
      }
    },
  );
});
