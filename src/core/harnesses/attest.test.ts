import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "../workflow/types.ts";
import { runHarnessAttestation } from "./attest.ts";
import type { HarnessAttestation } from "./attestation.ts";
import { createBuiltinHarnessRegistry } from "./registry.ts";

const registry = createBuiltinHarnessRegistry();

function ok(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return { ok: true, text: "ok", durationMs: 12, ...overrides };
}

function capture() {
  const written: HarnessAttestation[] = [];
  return { written, persist: (record: HarnessAttestation) => void written.push(record) };
}

describe("live harness attestation", () => {
  test("a completed turn records what it saw", async () => {
    const sink = capture();
    const report = await runHarnessAttestation(registry, {
      harnesses: ["claude-code"],
      versionProbe: () => "2.1.197",
      spawn: async () => ok({ sessionId: "s-1", costUsd: 0.004 }),
      persist: sink.persist,
      now: () => new Date("2026-07-24T19:00:00.000Z"),
    });
    expect(report.results[0]?.outcome).toBe("recorded");
    expect(report.recorded).toBe(1);
    expect(report.incomplete).toBe(false);
    expect(sink.written[0]?.observations).toEqual({
      invocation: "supported",
      finalResult: "supported",
      sessionId: "supported",
      cost: "supported",
    });
    expect(sink.written[0]?.binary_version).toBe("2.1.197");
  });

  test("what the vendor withholds is recorded as unsupported, not omitted", async () => {
    const sink = capture();
    await runHarnessAttestation(registry, {
      harnesses: ["codex"],
      versionProbe: () => "codex-cli 0.144.5",
      spawn: async () => ok(),
      persist: sink.persist,
    });
    expect(sink.written[0]?.observations.sessionId).toBe("unsupported");
    expect(sink.written[0]?.observations.cost).toBe("unsupported");
  });

  test("a missing binary is a skip that records nothing", async () => {
    const sink = capture();
    const report = await runHarnessAttestation(registry, {
      harnesses: ["cursor"],
      versionProbe: () => null,
      spawn: async () => {
        throw new Error("spawn must not run when the binary is absent");
      },
      persist: sink.persist,
    });
    expect(report.results[0]?.outcome).toBe("skipped");
    expect(report.recorded).toBe(0);
    expect(report.incomplete).toBe(true);
    expect(sink.written).toHaveLength(0);
  });

  test("an unreachable subject records nothing at all", async () => {
    // The prerequisite rule: a failed turn must not be written down as a page
    // of `unsupported`, because none of it was observed.
    const sink = capture();
    const report = await runHarnessAttestation(registry, {
      harnesses: ["codex"],
      versionProbe: () => "codex-cli 0.144.5",
      spawn: async () => ({ ok: false, text: "", durationMs: 5, error: "auth required" }),
      persist: sink.persist,
    });
    expect(report.results[0]?.outcome).toBe("unreachable");
    expect(report.results[0]?.note).toContain("auth required");
    expect(sink.written).toHaveLength(0);
  });

  test("a thrown probe fails that harness without stopping the sweep", async () => {
    const sink = capture();
    const report = await runHarnessAttestation(registry, {
      harnesses: ["codex", "cursor"],
      versionProbe: () => "1.0.0",
      spawn: async (harness) => {
        if (harness === "codex") throw new Error("boom");
        return ok({ sessionId: "s-2" });
      },
      persist: sink.persist,
    });
    expect(report.results.map((row) => row.outcome)).toEqual(["failed", "recorded"]);
    expect(sink.written.map((row) => row.harness)).toEqual(["cursor"]);
  });

  test("an empty reply is a completed turn with no final result", async () => {
    const sink = capture();
    await runHarnessAttestation(registry, {
      harnesses: ["codex"],
      versionProbe: () => "1.0.0",
      spawn: async () => ok({ text: "   " }),
      persist: sink.persist,
    });
    expect(sink.written[0]?.observations.finalResult).toBe("unsupported");
  });
});

describe("failure notes are bounded evidence", () => {
  test("a console-transcript failure is collapsed and the prompt echo removed", async () => {
    const noisy = `banner\n${"x".repeat(4000)}\nReply with the single word: ok\ntrailing`;
    const report = await runHarnessAttestation(registry, {
      harnesses: ["codex"],
      versionProbe: () => "codex-cli 0.144.5",
      spawn: async () => ({ ok: false, text: "", durationMs: 5, error: noisy }),
      persist: () => {},
    });
    const note = report.results[0]?.note ?? "";
    expect(note.length).toBeLessThan(300);
    expect(note).not.toContain("Reply with the single word");
    expect(note).not.toContain("\n");
  });

  test("a failure with no reason still reads cleanly", async () => {
    const report = await runHarnessAttestation(registry, {
      harnesses: ["codex"],
      versionProbe: () => "1.0.0",
      spawn: async () => ({ ok: false, text: "", durationMs: 5 }),
      persist: () => {},
    });
    expect(report.results[0]?.note).toContain("no error reported");
  });
});
