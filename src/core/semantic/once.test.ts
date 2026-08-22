import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SemanticAdapter } from "./adapters.ts";
import type {
  SemanticConfiguredModel,
  SemanticEvidenceV1,
  SemanticHarness,
  SemanticModelReplyV1,
} from "./contract.ts";
import { runSemanticOnce } from "./once.ts";
import {
  inspectSemanticDocument,
  readSemanticManifest,
  semanticPaths,
  writeSemanticManifest,
} from "./storage.ts";

const EVENT_ONE = "evt_01922e33-7abc-7def-8abc-0123456789ab";
const EVENT_TWO = "evt_01922e33-7abd-7def-8abc-0123456789ab";
const GENERATION = "gen_01922e33-7abc-7def-8abc-0123456789ab";
const NOW = "2026-08-22T20:00:00.000Z";

function evidence(digestChar = "a"): SemanticEvidenceV1 {
  return {
    schema_version: 1,
    evidence_contract_version: 1,
    instance_id: "inst_fixture",
    generation_id: GENERATION,
    source_harness: "codex",
    source: {
      ledger_genesis_id: "gex_fixture",
      observed_through_event_id: EVENT_TWO,
      observed_through_ts: NOW,
    },
    task: { value: "Implement semantic reading", event_id: EVENT_ONE },
    operation: { category: "test", label: "Testing", event_id: EVENT_TWO },
    waits: [],
    recent: [
      {
        kind: "progress",
        event_id: EVENT_TWO,
        observed_at: NOW,
        label: "Tests observed",
        outcome: "succeeded",
      },
    ],
    evidence_event_ids: [EVENT_ONE, EVENT_TWO],
    evidence_digest: `sha256:${digestChar.repeat(64)}`,
  };
}

function reply(source: SemanticEvidenceV1): SemanticModelReplyV1 {
  return {
    schema_version: 1,
    generation_id: source.generation_id,
    evidence_digest: source.evidence_digest,
    meaning: {
      headline: {
        value: "Verifying semantic reading",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: [EVENT_TWO],
      },
      summary: {
        value: "The agent is testing the semantic read-model contract.",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: [EVENT_ONE, EVENT_TWO],
      },
      phase: {
        value: "verifying",
        basis: "model-synthesis",
        confidence: "high",
        evidence_event_ids: [EVENT_TWO],
      },
    },
  };
}

function fakeAdapters(
  source: SemanticEvidenceV1,
  calls: { count: number },
  output: unknown = reply(source),
): Record<SemanticHarness, SemanticAdapter> {
  const configured: Record<SemanticHarness, SemanticConfiguredModel> = {
    "claude-code": "haiku-4.5",
    codex: "gpt-5.6-luna",
    cursor: "composer-2.5",
  };
  const model: Record<SemanticHarness, string> = {
    "claude-code": "claude-haiku-4-5-20251001",
    codex: "gpt-5.6-luna",
    cursor: "composer-2.5",
  };
  return Object.fromEntries(
    (["claude-code", "codex", "cursor"] as const).map((harness) => {
      const adapter: SemanticAdapter = {
        route: {
          harness,
          binary: "fixture",
          configured_model: configured[harness],
          invocation_model_id: model[harness],
        },
        discover(now = () => new Date(NOW)) {
          return {
            harness,
            configured_model: configured[harness],
            resolved_model_id: model[harness],
            model_attestation: "requested-only",
            available: true,
            discovered_at: now().toISOString(),
          };
        },
        async invoke() {
          calls.count += 1;
          const text = JSON.stringify(output);
          return {
            ok: true,
            text,
            resolved_model_id: model[harness],
            model_attestation: "requested-only",
            duration_ms: 5,
            output_bytes: Buffer.byteLength(text),
          };
        },
      };
      return [harness, adapter];
    }),
  ) as Record<SemanticHarness, SemanticAdapter>;
}

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "harnery-semantic-once-"));
}

describe("semantic once", () => {
  test("materializes one accepted document and skips an unchanged replay", async () => {
    const root = fixtureRoot();
    const source = evidence();
    const calls = { count: 0 };
    try {
      const first = await runSemanticOnce({
        coordRoot: root,
        evidence: [source],
        adapters: fakeAdapters(source, calls),
        now: () => new Date(NOW),
      });
      expect(first).toMatchObject({ model_calls: 1, cache_hits: 0 });
      expect(first.outcomes[0]?.action).toBe("accepted");
      expect(inspectSemanticDocument(root, GENERATION)).toMatchObject({
        reader_outcome: "accepted",
        meaning: { headline: { value: "Verifying semantic reading" } },
      });

      const second = await runSemanticOnce({
        coordRoot: root,
        evidence: [source],
        adapters: fakeAdapters(source, calls),
        now: () => new Date(NOW),
      });
      expect(second.outcomes[0]?.action).toBe("unchanged");
      expect(calls.count).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reuses the full-tuple cache after the materialized agent file disappears", async () => {
    const root = fixtureRoot();
    const source = evidence();
    const calls = { count: 0 };
    try {
      const adapters = fakeAdapters(source, calls);
      await runSemanticOnce({
        coordRoot: root,
        evidence: [source],
        adapters,
        now: () => new Date(NOW),
      });
      rmSync(join(semanticPaths(root).agents, `${GENERATION}.json`));
      const replay = await runSemanticOnce({
        coordRoot: root,
        evidence: [source],
        adapters,
        now: () => new Date(NOW),
      });
      expect(replay).toMatchObject({ model_calls: 0, cache_hits: 1 });
      expect(replay.outcomes[0]?.action).toBe("cached");
      expect(calls.count).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces old meaning with a visible deferred receipt at the hard rate cap", async () => {
    const root = fixtureRoot();
    const firstEvidence = evidence("a");
    const nextEvidence = evidence("b");
    const calls = { count: 0 };
    try {
      const adapters = fakeAdapters(firstEvidence, calls);
      await runSemanticOnce({
        coordRoot: root,
        evidence: [firstEvidence],
        adapters,
        now: () => new Date(NOW),
      });
      const manifest = readSemanticManifest(root)!;
      manifest.call_history = Array.from({ length: 60 }, () => ({
        generation_id: GENERATION,
        started_at: NOW,
      }));
      writeSemanticManifest(root, manifest);

      const report = await runSemanticOnce({
        coordRoot: root,
        evidence: [nextEvidence],
        adapters: fakeAdapters(nextEvidence, calls),
        now: () => new Date(NOW),
      });
      expect(report.outcomes[0]?.action).toBe("deferred");
      expect(inspectSemanticDocument(root, GENERATION)).toEqual(
        expect.objectContaining({
          reader_outcome: "deferred",
          receipt: { reason_code: "rate_cap", eligible_after: "2026-08-22T21:00:00.000Z" },
        }),
      );
      expect("meaning" in (inspectSemanticDocument(root, GENERATION) ?? {})).toBe(false);
      expect(calls.count).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stores invalid output without retaining the raw reply", async () => {
    const root = fixtureRoot();
    const source = evidence();
    const calls = { count: 0 };
    try {
      const report = await runSemanticOnce({
        coordRoot: root,
        evidence: [source],
        adapters: fakeAdapters(source, calls, { unsupported: "private raw output" }),
        now: () => new Date(NOW),
      });
      expect(report.outcomes[0]?.action).toBe("invalid");
      const stored = inspectSemanticDocument(root, GENERATION);
      expect(stored).toMatchObject({
        reader_outcome: "invalid",
        receipt: { reason_code: "invalid_output" },
      });
      expect(JSON.stringify(stored)).not.toContain("private raw output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
