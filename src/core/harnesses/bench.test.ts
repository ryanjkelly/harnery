import { describe, expect, test } from "bun:test";
import { runHarnessBench } from "./bench.ts";
import { createBuiltinHarnessRegistry, HarnessRegistry } from "./registry.ts";

describe("harness conformance bench", () => {
  test("offline profiles reconcile against the production planners and normalizers", () => {
    const report = runHarnessBench(createBuiltinHarnessRegistry(), {
      versionProbe: (binary) => `${binary} test-version`,
    });
    expect(report.mode).toBe("offline");
    expect(report.harnesses).toEqual(["claude-code", "codex", "cursor"]);
    expect(report.drift).toBe(false);
    expect(report.summary.drift).toBe(0);
    expect(report.summary.supported).toBeGreaterThan(0);
    expect(report.results.find((row) => row.dimension === "binary")?.verdict).toBe("supported");
  });

  test("missing vendor binaries are capability-neutral skips", () => {
    const report = runHarnessBench(createBuiltinHarnessRegistry(), {
      harnesses: ["claude-code"],
      versionProbe: () => null,
    });
    expect(report.skipped).toBe(true);
    expect(report.drift).toBe(false);
    expect(report.results.find((row) => row.dimension === "binary")?.verdict).toBe("skipped");
  });

  test("a declaration that disagrees with executable behavior becomes drift", () => {
    const base = createBuiltinHarnessRegistry().require("codex");
    const registry = new HarnessRegistry([
      {
        ...base,
        profile: {
          ...base.profile,
          id: "drifty",
          capabilities: {
            ...base.profile.capabilities,
            invocation: { support: "unsupported", note: "deliberately stale test claim" },
          },
        },
      },
    ]);
    const report = runHarnessBench(registry, { versionProbe: () => "installed" });
    const invocation = report.results.find((row) => row.dimension === "invocation");
    expect(invocation?.observed).toBe("supported");
    expect(invocation?.verdict).toBe("drift");
    expect(report.drift).toBe(true);
  });

  test("dimension slices retain registration and availability context", () => {
    const report = runHarnessBench(createBuiltinHarnessRegistry(), {
      harnesses: ["cursor"],
      dimensions: ["sessionId"],
      versionProbe: () => "installed",
    });
    expect(report.results.map((row) => row.dimension)).toEqual([
      "registration",
      "binary",
      "sessionId",
    ]);
    expect(report.results.at(-1)?.verdict).toBe("supported");
  });
});
