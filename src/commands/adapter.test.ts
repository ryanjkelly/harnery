import { describe, expect, test } from "bun:test";
import { createBuiltinAdapterRegistry, runAdapterBench } from "../core/adapters/index.ts";
import { renderBenchReport, renderProfile, renderProfileTable } from "./adapter.ts";

describe("adapter command rendering", () => {
  test("catalog table keeps the three adapters and high-signal claims visible", () => {
    const profiles = createBuiltinAdapterRegistry()
      .list()
      .map((adapter) => adapter.profile);
    const text = renderProfileTable(profiles);
    expect(text).toContain("Claude Code".replace("Claude Code", "claude-code"));
    expect(text).toContain("codex");
    expect(text).toContain("cursor-agent");
    expect(text).toContain("EFFORT");
  });

  test("show output includes qualifications, not only booleans", () => {
    const profile = createBuiltinAdapterRegistry().require("cursor").profile;
    const text = renderProfile(profile);
    expect(text).toContain("Cursor embeds effort");
    expect(text).toContain("compaction");
    expect(text).toContain("unknown");
  });

  test("bench output states that it made no model calls", () => {
    const report = runAdapterBench(createBuiltinAdapterRegistry(), {
      adapters: ["codex"],
      versionProbe: () => "installed",
      attestationReader: () => null,
    });
    expect(renderBenchReport(report)).toContain("offline (no model calls)");
  });
});
