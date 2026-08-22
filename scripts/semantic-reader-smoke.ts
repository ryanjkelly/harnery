import {
  buildSemanticPrompt,
  createSemanticAdapters,
  extractSemanticJson,
  SEMANTIC_READER_ROUTES,
  type SemanticEvidenceV1,
  type SemanticHarness,
  validateSemanticModelReply,
} from "../src/core/semantic/index.ts";

const EVENT_TASK = "evt_01922e33-7abc-7def-8abc-0123456789ab";
const EVENT_PROGRESS = "evt_01922e33-7abd-7def-8abc-0123456789ab";
const GENERATION = "gen_01922e33-7abc-7def-8abc-0123456789ab";
const NOW = "2026-08-22T20:00:00.000Z";

function fixture(harness: SemanticHarness): SemanticEvidenceV1 {
  return {
    schema_version: 1,
    evidence_contract_version: 1,
    instance_id: `inst_semantic-smoke-${harness}`,
    generation_id: GENERATION,
    source_harness: harness,
    source: {
      ledger_genesis_id: "gex_semantic-smoke",
      observed_through_event_id: EVENT_PROGRESS,
      observed_through_ts: NOW,
    },
    task: { value: "Verify the semantic reader contract", event_id: EVENT_TASK },
    operation: { category: "test", label: "Testing", event_id: EVENT_PROGRESS },
    waits: [],
    recent: [
      {
        kind: "progress",
        event_id: EVENT_PROGRESS,
        observed_at: NOW,
        label: "Contract fixture observed",
        outcome: "succeeded",
      },
    ],
    evidence_event_ids: [EVENT_TASK, EVENT_PROGRESS],
    evidence_digest: `sha256:${"a".repeat(64)}`,
  };
}

const adapters = createSemanticAdapters();
let failed = false;
const requested = process.argv.slice(2);
const harnesses = (
  requested.length > 0 ? requested : ["claude-code", "codex", "cursor"]
) as SemanticHarness[];

for (const harness of harnesses) {
  if (!(harness in adapters)) throw new Error(`unknown harness: ${harness}`);
  const evidence = fixture(harness);
  const prompt = buildSemanticPrompt(evidence);
  const result = await adapters[harness].invoke(prompt.prompt);
  if (!result.ok) {
    failed = true;
    console.log(
      JSON.stringify({
        harness,
        configured_model: SEMANTIC_READER_ROUTES[harness].configured_model,
        ok: false,
        reason_code: result.reason_code,
        duration_ms: result.duration_ms,
      }),
    );
    continue;
  }
  const verdict = validateSemanticModelReply(extractSemanticJson(result.text), evidence);
  if (!verdict.ok) failed = true;
  console.log(
    JSON.stringify({
      harness,
      configured_model: SEMANTIC_READER_ROUTES[harness].configured_model,
      ok: verdict.ok,
      model_attestation: result.model_attestation,
      resolved_model_id: result.resolved_model_id,
      input_bytes: prompt.bytes,
      output_bytes: result.output_bytes,
      duration_ms: result.duration_ms,
      ...(verdict.ok ? {} : { issue_codes: verdict.issues }),
    }),
  );
}

if (failed) process.exitCode = 1;
