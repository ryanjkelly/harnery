import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failingLockDirSeam } from "../../tests/helpers/lock-dir-seam.ts";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import { isHeldLockError, isHeldLockFailure } from "./held-lock.ts";

describe("isHeldLockError", () => {
  test("EEXIST means a held lock on every platform", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(isHeldLockError("EEXIST", platform)).toBe(true);
    }
  });

  test("EPERM means a lock being removed on Windows only", () => {
    expect(isHeldLockError("EPERM", "win32")).toBe(true);
    expect(isHeldLockError("EPERM", "linux")).toBe(false);
    expect(isHeldLockError("EPERM", "darwin")).toBe(false);
  });

  test("other codes are real errors", () => {
    for (const code of ["EACCES", "ENOENT", "EBUSY", undefined]) {
      expect(isHeldLockError(code, "win32")).toBe(false);
      expect(isHeldLockError(code, "linux")).toBe(false);
    }
  });
});

describe("failingLockDirSeam", () => {
  test("throws the code for the given number of calls, then creates the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "held-lock-"));
    try {
      const seam = failingLockDirSeam("EPERM", "win32", 1);
      let caught: unknown;
      try {
        seam.mkdir(join(dir, "lock"));
      } catch (error) {
        caught = error;
      }
      expect(isHeldLockFailure(caught, seam)).toBe(true);
      expect(isHeldLockFailure(caught, { ...seam, platform: "linux" })).toBe(false);
      seam.mkdir(join(dir, "lock"));
      expect(seam.calls).toBe(2);
    } finally {
      removeDir(dir);
    }
  });
});
