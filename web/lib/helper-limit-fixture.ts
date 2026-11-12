/** Test fixture: a full helper limit report, with overrides. Used by tests only. */

import type { HelperLimitReport } from "./helper-limit";

export function helperLimitReportFixture(
  overrides: Partial<HelperLimitReport> = {},
): HelperLimitReport {
  return {
    tool: "claude-code",
    limit: { max_model: "opus", max_effort: "medium" },
    source: "user",
    summary: "Helpers run on Opus at Medium effort or cheaper.",
    user: { max_model: "opus", max_effort: "medium" },
    project_default: null,
    ladders: {
      models: ["haiku", "sonnet", "opus", "fable"],
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    active: true,
    inactive_reason: null,
    coverage: { covered: ["helpers", "harn run workers"], not_covered: ["forks", "teammates"] },
    last_24h: {
      since: "2026-11-10T12:00:00.000Z",
      helpers: 14,
      lowered: 9,
      by_model: { haiku: 3, opus: 11 },
    },
    warnings: [],
    ...overrides,
  };
}
