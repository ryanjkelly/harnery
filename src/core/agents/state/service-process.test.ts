import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failingLockFileSeam } from "../../../../tests/helpers/lock-file-seam.ts";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import { acquireServiceLease, type ServiceLiveness } from "./service-process.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

function leasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-service-lease-"));
  roots.push(root);
  return join(root, "service", "lease.json");
}

const refused: Array<{ pid: number | undefined; liveness: ServiceLiveness }> = [];
const refuse = (pid: number | undefined, liveness: ServiceLiveness) => {
  refused.push({ pid, liveness });
  return new Error("service already running");
};

describe("service lease lock file", () => {
  afterEach(() => {
    refused.splice(0);
  });

  test("EPERM while the holder deletes the lease retries and takes it", () => {
    const path = leasePath();
    const seam = failingLockFileSeam("EPERM", "win32", 1);
    const lease = acquireServiceLease(path, refuse, {}, seam);
    expect(seam.calls).toBe(2);
    expect(existsSync(path)).toBe(true);
    lease.release();
    expect(existsSync(path)).toBe(false);
  });

  test("EPERM with a live owner refuses the start as for EEXIST", () => {
    const path = leasePath();
    acquireServiceLease(path, refuse);
    const seam = failingLockFileSeam("EPERM", "win32");
    expect(() => acquireServiceLease(path, refuse, {}, seam)).toThrow("service already running");
    expect(refused).toEqual([{ pid: process.pid, liveness: "running" }]);
    expect(seam.calls).toBe(1);
  });

  test("persistent EPERM with no lease file on disk stops after two attempts", () => {
    const path = leasePath();
    const seam = failingLockFileSeam("EPERM", "win32");
    expect(() => acquireServiceLease(path, refuse, {}, seam)).toThrow(
      /could not acquire the singleton lease/,
    );
    expect(seam.calls).toBe(2);
    expect(refused).toEqual([]);
  });

  test("EPERM on Linux is a real permission failure", () => {
    const path = leasePath();
    const seam = failingLockFileSeam("EPERM", "linux");
    expect(() => acquireServiceLease(path, refuse, {}, seam)).toThrow(/EPERM/);
    expect(seam.calls).toBe(1);
  });
});
