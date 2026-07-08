import { describe, expect, test } from "bun:test";
import { parseDocsAgeLog } from "../../src/lib/docs-sweep.ts";

describe("parseDocsAgeLog", () => {
  // Fixed "now" so ages are deterministic: 2026-07-08T12:00:00Z
  const now = Date.parse("2026-07-08T12:00:00Z");

  test("newest commit wins; skips non-md; ignores blank lines", () => {
    const log = [
      "COMMIT 2026-07-01T12:00:00Z",
      "docs/plans/fresh.md",
      "docs/plans/shared.md",
      "",
      "COMMIT 2026-01-01T12:00:00Z",
      "docs/plans/shared.md", // older — must not overwrite
      "docs/plans/old.md",
      "docs/plans/diagram.png", // non-md — skip
      "COMMIT not-a-date",
      "docs/plans/bogus.md", // currentAge null — skip
    ].join("\n");

    const ages = parseDocsAgeLog(log, now);
    expect(ages.get("docs/plans/fresh.md")).toBe(7);
    expect(ages.get("docs/plans/shared.md")).toBe(7); // newest wins
    expect(ages.get("docs/plans/old.md")).toBe(188);
    expect(ages.has("docs/plans/diagram.png")).toBe(false);
    expect(ages.has("docs/plans/bogus.md")).toBe(false);
  });

  test("empty / whitespace-only input → empty map", () => {
    expect(parseDocsAgeLog("", now).size).toBe(0);
    expect(parseDocsAgeLog("   \n\n", now).size).toBe(0);
  });
});
