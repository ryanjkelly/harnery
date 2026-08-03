import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "../workflow/types.ts";
import { runAdapterAttestation } from "./attest.ts";
import type { AdapterAttestation } from "./attestation.ts";
import { createBuiltinAdapterRegistry } from "./registry.ts";

const registry = createBuiltinAdapterRegistry();

function ok(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return { ok: true, text: "ok", durationMs: 12, ...overrides };
}

function capture() {
  const written: AdapterAttestation[] = [];
  return { written, persist: (record: AdapterAttestation) => void written.push(record) };
}

describe("live adapter attestation", () => {
  test("a completed turn records what it saw", async () => {
    const sink = capture();
    const report = await runAdapterAttestation(registry, {
      adapters: ["claude-code"],
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
    await runAdapterAttestation(registry, {
      adapters: ["codex"],
      versionProbe: () => "codex-cli 0.144.5",
      spawn: async () => ok(),
      persist: sink.persist,
    });
    expect(sink.written[0]?.observations.sessionId).toBe("unsupported");
    expect(sink.written[0]?.observations.cost).toBe("unsupported");
  });

  test("a missing binary is a skip that records nothing", async () => {
    const sink = capture();
    const report = await runAdapterAttestation(registry, {
      adapters: ["cursor"],
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
    const report = await runAdapterAttestation(registry, {
      adapters: ["codex"],
      versionProbe: () => "codex-cli 0.144.5",
      spawn: async () => ({ ok: false, text: "", durationMs: 5, error: "auth required" }),
      persist: sink.persist,
    });
    expect(report.results[0]?.outcome).toBe("unreachable");
    expect(report.results[0]?.note).toContain("auth required");
    expect(sink.written).toHaveLength(0);
  });

  test("a thrown probe fails that adapter without stopping the sweep", async () => {
    const sink = capture();
    const report = await runAdapterAttestation(registry, {
      adapters: ["codex", "cursor"],
      versionProbe: () => "1.0.0",
      spawn: async (adapter) => {
        if (adapter === "codex") throw new Error("boom");
        return ok({ sessionId: "s-2" });
      },
      persist: sink.persist,
    });
    expect(report.results.map((row) => row.outcome)).toEqual(["failed", "recorded"]);
    expect(sink.written.map((row) => row.adapter)).toEqual(["cursor"]);
  });

  test("an empty reply is a completed turn with no final result", async () => {
    const sink = capture();
    await runAdapterAttestation(registry, {
      adapters: ["codex"],
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
    const report = await runAdapterAttestation(registry, {
      adapters: ["codex"],
      versionProbe: () => "codex-cli 0.144.5",
      spawn: async () => ({ ok: false, text: "", durationMs: 5, error: noisy }),
      persist: () => {},
    });
    const note = report.results[0]?.note ?? "";
    expect(note.length).toBeLessThan(300);
    expect(note).not.toContain("Reply with the single word");
    expect(note).not.toContain("\n");
  });

  test("the note keeps the tail, where the real failure is", async () => {
    // Observed shape: a vendor CLI logs a cosmetic startup warning, prints a
    // long banner, then fails on the last line. Head truncation kept the
    // warning and hid the cause, which produced a wrong diagnosis.
    const transcript = [
      "ERROR codex_models_manager::cache: failed to load models cache: missing field `x`",
      "OpenAI Codex v0.144.5",
      "--------",
      `workdir: /tmp\nmodel: gpt-5.5\nprovider: openai\n${"filler ".repeat(60)}`,
      "session id: 019f9661-d51e-7dc0-b130-f6b852d86765",
      "ERROR: Your workspace is out of credits. Add credits to continue.",
    ].join("\n");
    const report = await runAdapterAttestation(registry, {
      adapters: ["codex"],
      versionProbe: () => "codex-cli 0.144.5",
      spawn: async () => ({ ok: false, text: "", durationMs: 5, error: transcript }),
      persist: () => {},
    });
    const note = report.results[0]?.note ?? "";
    expect(note).toContain("out of credits");
    expect(note).not.toContain("failed to load models cache");
  });

  test("a failure with no reason still reads cleanly", async () => {
    const report = await runAdapterAttestation(registry, {
      adapters: ["codex"],
      versionProbe: () => "1.0.0",
      spawn: async () => ({ ok: false, text: "", durationMs: 5 }),
      persist: () => {},
    });
    expect(report.results[0]?.note).toContain("no error reported");
  });
});
