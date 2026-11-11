import type { ReplaceFileSeam } from "../../src/lib/cookies/client.ts";
import { realReplaceFileSeam } from "../../src/lib/cookies/client.ts";

/** A seam whose `rename` throws `code` for the first `failures` calls, then
 * renames the file. For tests. */
export function failingReplaceSeam(
  code: string,
  platform: NodeJS.Platform,
  failures = Number.POSITIVE_INFINITY,
): ReplaceFileSeam & { calls: number } {
  const seam = {
    calls: 0,
    platform,
    rename(from: string, to: string) {
      seam.calls += 1;
      if (seam.calls <= failures) {
        throw Object.assign(new Error(`${code}: rename '${from}' -> '${to}'`), { code });
      }
      realReplaceFileSeam.rename(from, to);
    },
  };
  return seam;
}
