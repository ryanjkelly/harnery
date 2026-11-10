import { mkdirSync } from "node:fs";
import type { LockDirSeam } from "../../src/lib/held-lock.ts";

/** A seam whose `mkdir` throws `code` for the first `failures` calls, then
 * creates the folder. For tests. */
export function failingLockDirSeam(
  code: string,
  platform: NodeJS.Platform,
  failures = Number.POSITIVE_INFINITY,
): LockDirSeam & { calls: number } {
  const seam = {
    calls: 0,
    platform,
    mkdir(path: string) {
      seam.calls += 1;
      if (seam.calls <= failures) {
        throw Object.assign(new Error(`${code}: mkdir '${path}'`), { code });
      }
      mkdirSync(path);
    },
  };
  return seam;
}
