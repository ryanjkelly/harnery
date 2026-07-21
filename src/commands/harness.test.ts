import { describe, expect, test } from "bun:test";
import { createBuiltinHarnessRegistry, runHarnessBench } from "../core/harnesses/index.ts";
import { renderBenchReport, renderProfile, renderProfileTable } from "./harness.ts";

describe("harness command rendering", () => {
  test("catalog table keeps the three harnesses and high-signal claims visible", () => {
    const profiles = createBuiltinHarnessRegistry()
      .list()
      .map((adapter) => adapter.profile);
    const text = renderProfileTable(profiles);
    expect(text).toContain("Claude Code".replace("Claude Code", "claude-code"));
    expect(text).toContain("codex");
    expect(text).toContain("cursor-agent");
    expect(text).toContain("EFFORT");
  });

  test("show output includes qualifications, not only booleans", () => {
    const profile = createBuiltinHarnessRegistry().require("cursor").profile;
    const text = renderProfile(profile);
    expect(text).toContain("Cursor embeds effort");
    expect(text).toContain("compaction");
    expect(text).toContain("unknown");
  });

  test("bench output states that it made no model calls", () => {
    const report = runHarnessBench(createBuiltinHarnessRegistry(), {
      harnesses: ["codex"],
      versionProbe: () => "installed",
    });
    expect(renderBenchReport(report)).toContain("offline (no model calls)");
  });
});
