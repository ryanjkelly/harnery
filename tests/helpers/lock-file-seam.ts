import type { LockFileSeam } from "../../src/lib/held-lock.ts";
import { realLockFileSeam } from "../../src/lib/held-lock.ts";

/** A seam whose `createExclusive` throws `code` for the first `failures`
 * calls, then creates the file. For tests. */
export function failingLockFileSeam(
  code: string,
  platform: NodeJS.Platform,
  failures = Number.POSITIVE_INFINITY,
): LockFileSeam & { calls: number } {
  const seam = {
    calls: 0,
    platform,
    createExclusive(path: string, contents: string, mode?: number) {
      seam.calls += 1;
      if (seam.calls <= failures) {
        throw Object.assign(new Error(`${code}: open '${path}'`), { code });
      }
      realLockFileSeam.createExclusive(path, contents, mode);
    },
  };
  return seam;
}
