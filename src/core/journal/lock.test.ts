import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failingLockDirSeam } from "../../../tests/helpers/lock-dir-seam.ts";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { JOURNAL_LOCK_DIR, JournalLockBusyError, withJournalLock } from "./lock.ts";

const roots: string[] = [];
const journalDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "harnery-journal-lock-"));
  roots.push(root);
  return join(root, "journal");
};

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe("journal lock on Windows", () => {
  test("EPERM from a lock folder being removed waits on win32, as EEXIST does", () => {
    for (const [code, platform] of [
      ["EPERM", "win32"],
      ["EEXIST", "linux"],
    ] as const) {
      const dir = journalDir();
      const lockSeam = failingLockDirSeam(code, platform, 2);
      expect(withJournalLock(dir, () => "ran", { lockSeam })).toBe("ran");
      expect(lockSeam.calls).toBe(3);
      expect(existsSync(join(dir, JOURNAL_LOCK_DIR))).toBe(false);
    }
  });

  test("a lasting EPERM on win32 ends at the usual deadline with the busy error", () => {
    const lockSeam = failingLockDirSeam("EPERM", "win32");
    expect(() => withJournalLock(journalDir(), () => "ran", { timeoutMs: 30, lockSeam })).toThrow(
      JournalLockBusyError,
    );
    expect(lockSeam.calls).toBeGreaterThan(1);
  });

  test("EPERM on other platforms is still a real error", () => {
    const lockSeam = failingLockDirSeam("EPERM", "linux");
    let ran = false;
    expect(() =>
      withJournalLock(
        journalDir(),
        () => {
          ran = true;
        },
        { lockSeam },
      ),
    ).toThrow("EPERM");
    expect(ran).toBe(false);
    expect(lockSeam.calls).toBe(1);
  });
});
