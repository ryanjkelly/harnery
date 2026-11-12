/**
 * Server-side reader for the helper agent limit on the Tools page. Runs
 * `harn devtools helpers --format json` through the shared CLI runner, so the
 * page and the terminal share one implementation, and returns the validated
 * report or null when the command fails or prints anything else.
 */

import { type HelperLimitReport, parseHelperLimitReport } from "./helper-limit";
import { runHarn } from "./run-harn";

export type { HelperLimitPair, HelperLimitReport } from "./helper-limit";

export const HELPER_LIMIT_READ_ARGS = ["devtools", "helpers", "--format", "json"];

/** Read the report; null when it cannot be read. Never throws. */
export async function readHelperLimitReport(): Promise<HelperLimitReport | null> {
  try {
    const res = await runHarn(HELPER_LIMIT_READ_ARGS, { timeoutMs: 20_000 });
    if (!res.ok) return null;
    return parseHelperLimitReport(res.stdout);
  } catch {
    return null;
  }
}
