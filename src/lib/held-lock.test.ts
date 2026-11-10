import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failingLockDirSeam } from "../../tests/helpers/lock-dir-seam.ts";
import { failingLockFileSeam } from "../../tests/helpers/lock-file-seam.ts";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import {
  isHeldFileLockError,
  isHeldFileLockFailure,
  isHeldLockError,
  isHeldLockFailure,
  realLockFileSeam,
} from "./held-lock.ts";

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

describe("isHeldFileLockError", () => {
  test("EEXIST means a held lock file on every platform", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(isHeldFileLockError("EEXIST", platform)).toBe(true);
    }
  });

  test("EPERM means a lock file being removed on Windows only", () => {
    expect(isHeldFileLockError("EPERM", "win32")).toBe(true);
    expect(isHeldFileLockError("EPERM", "linux")).toBe(false);
    expect(isHeldFileLockError("EPERM", "darwin")).toBe(false);
  });

  test("other codes are real errors", () => {
    for (const code of ["EACCES", "ENOENT", "EBUSY", undefined]) {
      expect(isHeldFileLockError(code, "win32")).toBe(false);
      expect(isHeldFileLockError(code, "linux")).toBe(false);
    }
  });
});

describe("realLockFileSeam", () => {
  test("creates the file once and reports a second create as held", () => {
    const dir = mkdtempSync(join(tmpdir(), "held-file-lock-"));
    try {
      const path = join(dir, "lock");
      realLockFileSeam.createExclusive(path, "owner", 0o600);
      expect(readFileSync(path, "utf8")).toBe("owner");
      let caught: unknown;
      try {
        realLockFileSeam.createExclusive(path, "other");
      } catch (error) {
        caught = error;
      }
      expect(isHeldFileLockFailure(caught)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("owner");
    } finally {
      removeDir(dir);
    }
  });
});

describe("failingLockFileSeam", () => {
  test("throws the code for the given number of calls, then creates the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "held-file-lock-"));
    try {
      const seam = failingLockFileSeam("EPERM", "win32", 1);
      let caught: unknown;
      try {
        seam.createExclusive(join(dir, "lock"), "x");
      } catch (error) {
        caught = error;
      }
      expect(isHeldFileLockFailure(caught, seam)).toBe(true);
      expect(isHeldFileLockFailure(caught, { ...seam, platform: "linux" })).toBe(false);
      seam.createExclusive(join(dir, "lock"), "x");
      expect(seam.calls).toBe(2);
    } finally {
      removeDir(dir);
    }
  });
});
