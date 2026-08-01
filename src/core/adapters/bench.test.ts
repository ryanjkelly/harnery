import { describe, expect, test } from "bun:test";
import type { AdapterAttestation } from "./attestation.ts";
import { profileDigest, sealAttestation } from "./attestation.ts";
import { runAdapterBench } from "./bench.ts";
import { AdapterRegistry, createBuiltinAdapterRegistry } from "./registry.ts";

/** Echo each profile's own recorded vendor contract, so the contract dimension
 * is satisfied and a test can isolate the behavior it actually targets. */
function matchingVersionProbe(registry = createBuiltinAdapterRegistry()) {
  const byBinary = new Map(
    registry.ids().map((id) => {
      const profile = registry.require(id).profile;
      return [profile.binary, profile.verified?.version ?? "installed"];
    }),
  );
  return (binary: string) => byBinary.get(binary) ?? "installed";
}

describe("adapter conformance bench", () => {
  test("offline profiles reconcile against the production planners and normalizers", () => {
    const report = runAdapterBench(createBuiltinAdapterRegistry(), {
      versionProbe: matchingVersionProbe(),
    });
    expect(report.mode).toBe("offline");
    expect(report.adapters).toEqual(["claude-code", "codex", "cursor"]);
    expect(report.drift).toBe(false);
    expect(report.summary.drift).toBe(0);
    expect(report.summary.supported).toBeGreaterThan(0);
    expect(report.results.find((row) => row.dimension === "binary")?.verdict).toBe("supported");
  });

  test("missing vendor binaries are capability-neutral skips", () => {
    const report = runAdapterBench(createBuiltinAdapterRegistry(), {
      adapters: ["claude-code"],
      versionProbe: () => null,
    });
    expect(report.skipped).toBe(true);
    expect(report.drift).toBe(false);
    expect(report.results.find((row) => row.dimension === "binary")?.verdict).toBe("skipped");
  });

  test("a declaration that disagrees with executable behavior becomes drift", () => {
    const base = createBuiltinAdapterRegistry().require("codex");
    const registry = new AdapterRegistry([
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
    const report = runAdapterBench(registry, { versionProbe: () => "installed" });
    const invocation = report.results.find((row) => row.dimension === "invocation");
    expect(invocation?.observed).toBe("supported");
    expect(invocation?.verdict).toBe("drift");
    expect(report.drift).toBe(true);
  });

  test("dimension slices retain registration and availability context", () => {
    const report = runAdapterBench(createBuiltinAdapterRegistry(), {
      adapters: ["cursor"],
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
  const registry = createBuiltinAdapterRegistry();
  // Hermetic: never read this host's real attestation store.
  const noAttestations = () => null;

  test("an adapter-checked dimension never claims to be attested", () => {
    const report = runAdapterBench(registry, {
      adapters: ["claude-code"],
      versionProbe: matchingVersionProbe(registry),
      attestationReader: noAttestations,
    });
    const sessionId = report.results.find((row) => row.dimension === "sessionId");
    expect(sessionId?.verdict).toBe("supported");
    // Proven against the committed fixture, not against the installed CLI.
    expect(sessionId?.basis).toBe("adapter");
  });

  test("an unchecked dimension reports its declaration as unchecked", () => {
    const report = runAdapterBench(registry, {
      adapters: ["claude-code"],
      dimensions: ["streaming"],
      versionProbe: matchingVersionProbe(registry),
      attestationReader: noAttestations,
    });
    const streaming = report.results.find((row) => row.dimension === "streaming");
    expect(streaming?.observed).toBe("unknown");
    expect(streaming?.basis).toBe("declared");
  });

  test("only observations of the installed binary are attested", () => {
    const report = runAdapterBench(registry, {
      versionProbe: matchingVersionProbe(registry),
      attestationReader: noAttestations,
    });
    const attested = report.results.filter((row) => row.basis === "attested");
    expect(attested.length).toBeGreaterThan(0);
    for (const row of attested) {
      expect(["binary", "contract"]).toContain(row.dimension);
    }
  });

  test("nothing is attested when no vendor binary is present", () => {
    const report = runAdapterBench(registry, {
      versionProbe: () => null,
      attestationReader: noAttestations,
    });
    expect(report.basisSummary.attested).toBe(0);
    expect(report.basisSummary.adapter).toBeGreaterThan(0);
  });

  test("the basis rollup accounts for every result", () => {
    const report = runAdapterBench(registry, {
      versionProbe: matchingVersionProbe(registry),
      attestationReader: noAttestations,
    });
    const total =
      report.basisSummary.adapter + report.basisSummary.attested + report.basisSummary.declared;
    expect(total).toBe(report.results.length);
  });
});

describe("vendor contract attestation (ADR 0037)", () => {
  const registry = createBuiltinAdapterRegistry();
  const contractOf = (report: ReturnType<typeof runAdapterBench>) =>
    report.results.find((row) => row.dimension === "contract");

  /** A registry holding one profile whose recorded contract is pinned by the
   * test. These cases are about the reconciliation rule, so they must not move
   * when `bun run verify:contracts` legitimately updates the real catalogue. */
  function pinned(version: string | undefined) {
    const base = createBuiltinAdapterRegistry().require("codex");
    return new AdapterRegistry([
      {
        ...base,
        profile: {
          ...base.profile,
          id: "pinned-contract",
          verified: version ? { date: "2026-07-21", version } : undefined,
        },
      },
    ]);
  }

  test("an installed version matching the recorded contract is attested", () => {
    const report = runAdapterBench(pinned("codex-cli 0.145.0-alpha.18"), {
      versionProbe: () => "codex-cli 0.145.0-alpha.18",
      attestationReader: () => null,
    });
    expect(contractOf(report)?.verdict).toBe("supported");
    expect(contractOf(report)?.basis).toBe("attested");
    expect(report.drift).toBe(false);
  });

  test("a vendor version prefix does not defeat the match", () => {
    // A CLI that prints its version bare must reconcile against a recorded
    // contract that carries the vendor prefix.
    const report = runAdapterBench(pinned("codex-cli 0.145.0-alpha.18"), {
      versionProbe: () => "0.145.0-alpha.18",
      attestationReader: () => null,
    });
    expect(contractOf(report)?.verdict).toBe("supported");
  });

  test("an installed version that differs from the recorded contract is drift", () => {
    const report = runAdapterBench(pinned("codex-cli 0.145.0-alpha.18"), {
      versionProbe: () => "codex-cli 0.144.5",
      attestationReader: () => null,
    });
    expect(contractOf(report)?.verdict).toBe("drift");
    expect(contractOf(report)?.basis).toBe("attested");
    expect(contractOf(report)?.note).toContain("0.144.5");
    expect(report.drift).toBe(true);
  });

  test("an unparseable recorded contract stays unknown rather than being inferred", () => {
    // Synthetic on purpose: the rule under test is "a recorded value that is
    // not a version yields unknown", not whatever the built-in profiles happen
    // to carry today.
    const base = createBuiltinAdapterRegistry().require("claude-code");
    const unparseable = new AdapterRegistry([
      {
        ...base,
        profile: {
          ...base.profile,
          id: "prose-contract",
          verified: { date: "2026-07-20", version: "current CLI contract" },
        },
      },
    ]);
    const report = runAdapterBench(unparseable, {
      versionProbe: () => "2.1.197 (Claude Code)",
      attestationReader: () => null,
    });
    expect(contractOf(report)?.verdict).toBe("unknown");
    expect(contractOf(report)?.basis).toBe("declared");
    expect(report.drift).toBe(false);
  });

  test("a recorded contract that matches the installed version is attested", () => {
    // Guards the real catalog: after `bun run verify:contracts`, an attested
    // profile's contract row must reconcile on the host it was written from.
    const report = runAdapterBench(registry, {
      adapters: ["claude-code"],
      versionProbe: () => registry.require("claude-code").profile.verified?.version ?? "",
      attestationReader: () => null,
    });
    expect(contractOf(report)?.verdict).toBe("supported");
  });

  test("an absent binary skips the contract check instead of failing it", () => {
    const report = runAdapterBench(registry, {
      adapters: ["cursor"],
      versionProbe: () => null,
    });
    expect(contractOf(report)?.verdict).toBe("skipped");
    expect(contractOf(report)?.basis).toBe("declared");
    expect(report.drift).toBe(false);
  });

  test("a profile with no recorded contract is unknown, not supported", () => {
    const base = createBuiltinAdapterRegistry().require("codex");
    const { verified: _dropped, ...profileWithoutContract } = base.profile;
    const registryWithout = new AdapterRegistry([
      { ...base, profile: { ...profileWithoutContract, id: "unpinned" } },
    ]);
    const report = runAdapterBench(registryWithout, { versionProbe: () => "9.9.9" });
    expect(contractOf(report)?.verdict).toBe("unknown");
    expect(contractOf(report)?.note).toContain("no verified vendor contract recorded");
  });
});

describe("bench reads live attestations (ADR 0038)", () => {
  const registry = createBuiltinAdapterRegistry();
  const codex = registry.require("codex").profile;

  function attestation(overrides: Partial<AdapterAttestation> = {}): AdapterAttestation {
    return sealAttestation({
      schema_version: 2,
      adapter: "codex",
      binary_version: "codex-cli 0.144.5",
      profile_digest: profileDigest(codex),
      subscription_only: false,
      observed_at: "2026-07-24T19:00:00.000Z",
      observations: { sessionId: "supported" },
      ...overrides,
    });
  }

  const rowFor = (report: ReturnType<typeof runAdapterBench>, dimension: string) =>
    report.results.find((row) => row.dimension === dimension);

  test("a live observation outranks the fixture check and is marked attested", () => {
    // codex declares sessionId unsupported and its fixture agrees. A live turn
    // that DID return a session id must surface as drift, not be ignored.
    const report = runAdapterBench(registry, {
      adapters: ["codex"],
      dimensions: ["sessionId"],
      versionProbe: () => "codex-cli 0.144.5",
      attestationReader: () => attestation(),
    });
    expect(rowFor(report, "sessionId")?.observed).toBe("supported");
    expect(rowFor(report, "sessionId")?.basis).toBe("attested");
    expect(rowFor(report, "sessionId")?.verdict).toBe("drift");
    expect(rowFor(report, "sessionId")?.note).toContain("codex-cli 0.144.5");
  });

  test("a stale attestation is ignored and the row falls back to adapter basis", () => {
    const report = runAdapterBench(registry, {
      adapters: ["codex"],
      dimensions: ["sessionId"],
      versionProbe: () => "codex-cli 0.146.0",
      attestationReader: () => attestation(),
    });
    expect(rowFor(report, "sessionId")?.basis).toBe("adapter");
    expect(rowFor(report, "sessionId")?.verdict).toBe("unsupported");
  });

  test("a dimension the attestation did not observe keeps its adapter basis", () => {
    const report = runAdapterBench(registry, {
      adapters: ["codex"],
      dimensions: ["sessionId", "finalResult"],
      versionProbe: () => "codex-cli 0.144.5",
      attestationReader: () => attestation({ observations: { sessionId: "supported" } }),
    });
    expect(rowFor(report, "sessionId")?.basis).toBe("attested");
    expect(rowFor(report, "finalResult")?.basis).toBe("adapter");
  });

  test("an unreadable attestation store never breaks the bench", () => {
    const report = runAdapterBench(registry, {
      adapters: ["codex"],
      dimensions: ["sessionId"],
      versionProbe: () => "codex-cli 0.144.5",
      attestationReader: () => {
        throw new Error("store unreadable");
      },
    });
    expect(rowFor(report, "sessionId")?.basis).toBe("adapter");
  });

  test("an attestation cannot be applied when the binary is absent", () => {
    const report = runAdapterBench(registry, {
      adapters: ["codex"],
      dimensions: ["sessionId"],
      versionProbe: () => null,
      attestationReader: () => attestation(),
    });
    expect(rowFor(report, "sessionId")?.basis).toBe("adapter");
    expect(report.basisSummary.attested).toBe(0);
  });
});
