import { describe, expect, test } from "bun:test";
import {
  helperLimitArgs,
  isHelperLimitReport,
  last24hLabel,
  limitOptions,
  pairLabel,
  parseHelperLimitBody,
  parseHelperLimitReport,
  sourceLabel,
} from "./helper-limit";
import { helperLimitReportFixture } from "./helper-limit-fixture";

describe("helper limit report shape", () => {
  test("accepts the full report, including an explicit no-limit choice", () => {
    expect(isHelperLimitReport(helperLimitReportFixture())).toBe(true);
    expect(isHelperLimitReport(helperLimitReportFixture({ user: {}, limit: null }))).toBe(true);
  });

  test("rejects missing or mistyped fields", () => {
    const base = helperLimitReportFixture() as unknown as Record<string, unknown>;
    for (const broken of [
      { ...base, source: "machine" },
      { ...base, active: "yes" },
      { ...base, ladders: { models: ["opus"] } },
      { ...base, user: { max_model: 3 } },
      { ...base, limit: { model: "opus" } },
      { ...base, last_24h: { since: "x", helpers: -1, lowered: 0, by_model: {} } },
      { ...base, last_24h: { since: "x", helpers: 1, lowered: 0, by_model: { opus: "1" } } },
      { ...base, coverage: { covered: [] } },
      { ...base, warnings: undefined },
      [],
      null,
    ]) {
      expect(isHelperLimitReport(broken)).toBe(false);
    }
  });

  test("parses stdout and returns null for anything else", () => {
    expect(parseHelperLimitReport(JSON.stringify(helperLimitReportFixture()))?.tool).toBe(
      "claude-code",
    );
    expect(parseHelperLimitReport("error: unknown command")).toBeNull();
    expect(parseHelperLimitReport('{"tool":"claude-code"}')).toBeNull();
  });
});

describe("helper limit request body", () => {
  test("a pair sets, an empty pair is no limit, null clears", () => {
    expect(parseHelperLimitBody({ limit: { max_model: "opus", max_effort: "medium" } })).toEqual({
      ok: true,
      change: { kind: "set", limit: { max_model: "opus", max_effort: "medium" } },
    });
    expect(parseHelperLimitBody({ limit: {} })).toEqual({
      ok: true,
      change: { kind: "set", limit: {} },
    });
    expect(parseHelperLimitBody({ limit: null })).toEqual({ ok: true, change: { kind: "clear" } });
  });

  test("refuses anything outside the strict shape", () => {
    for (const body of [
      null,
      "opus",
      {},
      { limit: undefined },
      { limit: { max_model: "opus" }, extra: 1 },
      { limit: { model: "opus" } },
      { limit: { max_model: "Opus" } },
      { limit: { max_model: "opus; rm -rf" } },
      { limit: { max_model: "--clear" } },
      { limit: { max_effort: 3 } },
      { limit: { max_effort: "" } },
      { limit: ["opus"] },
    ]) {
      expect(parseHelperLimitBody(body).ok).toBe(false);
    }
  });

  test("builds one argument per word", () => {
    expect(
      helperLimitArgs({ kind: "set", limit: { max_model: "opus", max_effort: "medium" } }),
    ).toEqual(["devtools", "helpers", "opus", "medium", "--format", "json"]);
    expect(helperLimitArgs({ kind: "set", limit: { max_effort: "low" } })).toEqual([
      "devtools",
      "helpers",
      "low",
      "--format",
      "json",
    ]);
    expect(helperLimitArgs({ kind: "set", limit: {} })).toEqual([
      "devtools",
      "helpers",
      "none",
      "--format",
      "json",
    ]);
    expect(helperLimitArgs({ kind: "clear" })).toEqual([
      "devtools",
      "helpers",
      "--clear",
      "--format",
      "json",
    ]);
  });
});

describe("helper limit wording", () => {
  test("options start with No limit and keep the ladder order", () => {
    expect(limitOptions(["haiku", "opus"])).toEqual([
      { value: "", label: "No limit" },
      { value: "haiku", label: "Haiku" },
      { value: "opus", label: "Opus" },
    ]);
  });

  test("source, pair and last-24-hours labels", () => {
    expect(sourceLabel("user")).toBe("your choice for all projects");
    expect(sourceLabel("project")).toBe("this project's default");
    expect(sourceLabel("none")).toBeNull();
    expect(pairLabel({ max_model: "sonnet", max_effort: "medium" })).toBe(
      "Sonnet at Medium effort",
    );
    expect(pairLabel({ max_effort: "low" })).toBe("Low effort");
    expect(pairLabel(null)).toBe("None");
    expect(last24hLabel(helperLimitReportFixture().last_24h)).toBe(
      "Last 24 hours, all projects: 14 helpers, 9 lowered. Ran on Opus 11, Haiku 3.",
    );
    expect(last24hLabel({ since: "x", helpers: 0, lowered: 0, by_model: {} })).toBe(
      "No helpers in the last 24 hours.",
    );
  });
});
