import { describe, expect, test } from "bun:test";
import { runHarnessBench } from "./bench.ts";
import { createBuiltinHarnessRegistry, HarnessRegistry } from "./registry.ts";

/** Echo each profile's own recorded vendor contract, so the contract dimension
 * is satisfied and a test can isolate the behavior it actually targets. */
function matchingVersionProbe(registry = createBuiltinHarnessRegistry()) {
  const byBinary = new Map(
    registry.ids().map((id) => {
      const profile = registry.require(id).profile;
      return [profile.binary, profile.verified?.version ?? "installed"];
    }),
  );
  return (binary: string) => byBinary.get(binary) ?? "installed";
}

describe("harness conformance bench", () => {
  test("offline profiles reconcile against the production planners and normalizers", () => {
    const report = runHarnessBench(createBuiltinHarnessRegistry(), {
      versionProbe: matchingVersionProbe(),
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
      "contract",
      "sessionId",
    ]);
    expect(report.results.at(-1)?.verdict).toBe("supported");
  });
});

describe("bench result basis (ADR 0037)", () => {
  const registry = createBuiltinHarnessRegistry();

  test("an adapter-checked dimension never claims to be attested", () => {
    const report = runHarnessBench(registry, {
      harnesses: ["claude-code"],
      versionProbe: matchingVersionProbe(registry),
    });
    const sessionId = report.results.find((row) => row.dimension === "sessionId");
    expect(sessionId?.verdict).toBe("supported");
    // Proven against the committed fixture, not against the installed CLI.
    expect(sessionId?.basis).toBe("adapter");
  });

  test("an unchecked dimension reports its declaration as unchecked", () => {
    const report = runHarnessBench(registry, {
      harnesses: ["claude-code"],
      dimensions: ["streaming"],
      versionProbe: matchingVersionProbe(registry),
    });
    const streaming = report.results.find((row) => row.dimension === "streaming");
    expect(streaming?.observed).toBe("unknown");
    expect(streaming?.basis).toBe("declared");
  });

  test("only observations of the installed binary are attested", () => {
    const report = runHarnessBench(registry, {
      versionProbe: matchingVersionProbe(registry),
    });
    const attested = report.results.filter((row) => row.basis === "attested");
    expect(attested.length).toBeGreaterThan(0);
    for (const row of attested) {
      expect(["binary", "contract"]).toContain(row.dimension);
    }
  });

  test("nothing is attested when no vendor binary is present", () => {
    const report = runHarnessBench(registry, { versionProbe: () => null });
    expect(report.basisSummary.attested).toBe(0);
    expect(report.basisSummary.adapter).toBeGreaterThan(0);
  });

  test("the basis rollup accounts for every result", () => {
    const report = runHarnessBench(registry, {
      versionProbe: matchingVersionProbe(registry),
    });
    const total =
      report.basisSummary.adapter + report.basisSummary.attested + report.basisSummary.declared;
    expect(total).toBe(report.results.length);
  });
});

describe("vendor contract attestation (ADR 0037)", () => {
  const registry = createBuiltinHarnessRegistry();
  const contractOf = (report: ReturnType<typeof runHarnessBench>) =>
    report.results.find((row) => row.dimension === "contract");

  test("an installed version matching the recorded contract is attested", () => {
    const report = runHarnessBench(registry, {
      harnesses: ["codex"],
      versionProbe: () => registry.require("codex").profile.verified?.version ?? "",
    });
    expect(contractOf(report)?.verdict).toBe("supported");
    expect(contractOf(report)?.basis).toBe("attested");
    expect(report.drift).toBe(false);
  });

  test("a vendor version prefix does not defeat the match", () => {
    // The recorded contract is `codex-cli 0.145.0-alpha.18`; a CLI that prints
    // its version bare must still reconcile.
    const report = runHarnessBench(registry, {
      harnesses: ["codex"],
      versionProbe: () => "0.145.0-alpha.18",
    });
    expect(contractOf(report)?.verdict).toBe("supported");
  });

  test("an installed version that differs from the recorded contract is drift", () => {
    const report = runHarnessBench(registry, {
      harnesses: ["codex"],
      versionProbe: () => "codex-cli 0.144.5",
    });
    expect(contractOf(report)?.verdict).toBe("drift");
    expect(contractOf(report)?.basis).toBe("attested");
    expect(contractOf(report)?.note).toContain("0.144.5");
    expect(report.drift).toBe(true);
  });

  test("an unparseable recorded contract stays unknown rather than being inferred", () => {
    // `claude-code` records the literal string "current CLI contract".
    const report = runHarnessBench(registry, {
      harnesses: ["claude-code"],
      versionProbe: () => "2.1.197 (Claude Code)",
    });
    expect(contractOf(report)?.verdict).toBe("unknown");
    expect(contractOf(report)?.basis).toBe("declared");
    expect(report.drift).toBe(false);
  });

  test("an absent binary skips the contract check instead of failing it", () => {
    const report = runHarnessBench(registry, {
      harnesses: ["cursor"],
      versionProbe: () => null,
    });
    expect(contractOf(report)?.verdict).toBe("skipped");
    expect(contractOf(report)?.basis).toBe("declared");
    expect(report.drift).toBe(false);
  });

  test("a profile with no recorded contract is unknown, not supported", () => {
    const base = createBuiltinHarnessRegistry().require("codex");
    const { verified: _dropped, ...profileWithoutContract } = base.profile;
    const registryWithout = new HarnessRegistry([
      { ...base, profile: { ...profileWithoutContract, id: "unpinned" } },
    ]);
    const report = runHarnessBench(registryWithout, { versionProbe: () => "9.9.9" });
    expect(contractOf(report)?.verdict).toBe("unknown");
    expect(contractOf(report)?.note).toContain("no verified vendor contract recorded");
  });
});
