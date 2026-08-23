import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { readLedgerV3Since } from "../events/v3/index.ts";
import {
  acquireSemanticServiceLease,
  readSemanticServiceStatus,
  runSemanticServiceDaemon,
} from "./service.ts";
import { semanticPaths, writeSemanticAgentDocument, writeSemanticManifest } from "./storage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-semantic-service-"));
  roots.push(root);
  return root;
}

describe("semantic service", () => {
  test("refuses one live owner and recovers a stale lease", () => {
    const root = fixture();
    const release = acquireSemanticServiceLease(root);
    expect(() => acquireSemanticServiceLease(root)).toThrow("semantic service is already running");
    release();

    const paths = semanticPaths(root);
    writeFileSync(
      paths.lease,
      `${JSON.stringify({
        pid: 2_147_483_647,
        host: hostname(),
        nonce: "stale",
        created_at: "2026-08-22T20:00:00.000Z",
      })}\n`,
    );
    const releaseRecovered = acquireSemanticServiceLease(root);
    releaseRecovered();
    expect(() => readFileSync(paths.lease, "utf8")).toThrow();
  });

  test("runs one bounded pass and leaves a stopped, inspectable receipt", async () => {
    const root = fixture();
    let calls = 0;
    const cursor = {
      genesis_id: "gex_fixture",
      segment_ordinal: 1,
      byte_offset: 128,
      event_id: "evt_01922e33-7abc-7def-8abc-0123456789ab",
    };
    const readSince = (() => ({
      events: [{}],
      diagnostics: [],
      complete: true,
      genesis_id: "gex_fixture",
      active_schema_digest: "fixture",
      advances: [],
      bytes: 128,
      cursor,
      reset_required: false,
    })) as unknown as typeof readLedgerV3Since;

    const terminal = await runSemanticServiceDaemon({
      coordRoot: root,
      debounceMs: 0,
      wakeIntervalMs: 1,
      heartbeatIntervalMs: 60_000,
      maxSweeps: 1,
      readSince,
      async runOnce() {
        calls += 1;
        return {
          schema_version: 1,
          ledger_genesis_id: "gex_fixture",
          evidence_count: 1,
          evidence_by_harness: { "claude-code": 0, codex: 1, cursor: 0 },
          model_calls: 1,
          cache_hits: 0,
          outcomes: [
            {
              generation_id: "gen_01922e33-7abc-7def-8abc-0123456789ab",
              source_harness: "codex",
              action: "accepted",
              model_call: true,
              duration_ms: 1250,
              input_bytes: 4096,
              output_bytes: 512,
            },
          ],
          completed_at: "2026-08-22T20:00:01.000Z",
        };
      },
    });

    expect(calls).toBe(1);
    expect(terminal).toMatchObject({
      state: "stopped",
      sweep_count: 1,
      pass_count: 1,
      model_calls: 1,
      cache_hits: 0,
    });
    expect(readSemanticServiceStatus(root)).toMatchObject({
      running: false,
      stale: false,
      record: { state: "stopped", pass_count: 1 },
    });
    const log = readFileSync(semanticPaths(root).log, "utf8");
    expect(log).toContain('"event":"pass"');
    expect(log).toContain(
      '"codex":{"evidence_count":1,"model_calls":1,"cache_hits":0,"accepted":1,"unavailable":0,"invalid":0,"deferred":0,"duration_ms":[1250],"input_bytes":[4096],"output_bytes":[512]}',
    );
    expect(log).not.toContain("gen_01922e33");
  });

  test("retries an eligible deferred document without new ledger evidence", async () => {
    const root = fixture();
    const generationId = "gen_01922e33-7abc-7def-8abc-0123456789ab";
    const cursor = {
      genesis_id: "gex_fixture",
      segment_ordinal: 1,
      byte_offset: 128,
      event_id: "evt_01922e33-7abc-7def-8abc-0123456789ab",
    };
    writeSemanticAgentDocument(root, {
      schema_version: 2,
      instance_id: "inst_01922e33-7abc-7def-8abc-0123456789ab",
      generation_id: generationId,
      source: {
        ledger_genesis_id: "gex_fixture",
        evidence_digest: `sha256:${"a".repeat(64)}`,
        observed_through_event_id: "evt_01922e33-7abc-7def-8abc-0123456789ab",
        observed_through_ts: "2026-08-22T20:00:00.000Z",
      },
      generated_at: "2026-08-22T20:00:01.000Z",
      reader_outcome: "deferred",
      reader: {
        harness: "codex",
        configured_model: "gpt-5.6-luna",
        resolved_model_id: "gpt-5.6-luna",
        model_attestation: "requested-only",
        prompt_contract_version: 2,
      },
      receipt: {
        reason_code: "rate_cap",
        eligible_after: "2026-08-22T20:01:00.000Z",
      },
    });
    writeSemanticManifest(root, {
      schema_version: 2,
      ledger_genesis_id: "gex_fixture",
      cursor,
      configuration_digest: `sha256:${"b".repeat(64)}`,
      evidence_contract_version: 1,
      prompt_contract_version: 2,
      adapter_resolutions: {},
      pending: [],
      call_history: [],
      updated_at: "2026-08-22T20:00:01.000Z",
    });
    let calls = 0;
    const readSince = (() => ({
      events: [],
      diagnostics: [],
      complete: true,
      genesis_id: "gex_fixture",
      active_schema_digest: "fixture",
      advances: [],
      bytes: 0,
      cursor,
      reset_required: false,
    })) as unknown as typeof readLedgerV3Since;

    await runSemanticServiceDaemon({
      coordRoot: root,
      debounceMs: 0,
      wakeIntervalMs: 1,
      heartbeatIntervalMs: 60_000,
      maxSweeps: 1,
      now: () => new Date("2026-08-22T20:01:01.000Z"),
      readSince,
      async runOnce() {
        calls += 1;
        return {
          schema_version: 1,
          ledger_genesis_id: "gex_fixture",
          evidence_count: 1,
          evidence_by_harness: { "claude-code": 0, codex: 1, cursor: 0 },
          model_calls: 1,
          cache_hits: 0,
          outcomes: [
            {
              generation_id: generationId,
              source_harness: "codex",
              action: "accepted",
              model_call: true,
            },
          ],
          completed_at: "2026-08-22T20:01:01.000Z",
        };
      },
    });

    expect(calls).toBe(1);
  });

  test("omits deferred-only pass logs and throttles repeated sweep errors", async () => {
    const deferredRoot = fixture();
    const cursor = {
      genesis_id: "gex_fixture",
      segment_ordinal: 1,
      byte_offset: 128,
      event_id: "evt_01922e33-7abc-7def-8abc-0123456789ab",
    };
    const readSince = (() => ({
      events: [{}],
      diagnostics: [],
      complete: true,
      genesis_id: "gex_fixture",
      active_schema_digest: "fixture",
      advances: [],
      bytes: 128,
      cursor,
      reset_required: false,
    })) as unknown as typeof readLedgerV3Since;
    await runSemanticServiceDaemon({
      coordRoot: deferredRoot,
      debounceMs: 0,
      wakeIntervalMs: 1,
      heartbeatIntervalMs: 60_000,
      maxSweeps: 1,
      readSince,
      async runOnce() {
        return {
          schema_version: 1,
          ledger_genesis_id: "gex_fixture",
          evidence_count: 1,
          evidence_by_harness: { "claude-code": 0, codex: 1, cursor: 0 },
          model_calls: 0,
          cache_hits: 0,
          outcomes: [
            {
              generation_id: "gen_01922e33-7abc-7def-8abc-0123456789ab",
              source_harness: "codex",
              action: "deferred",
              model_call: false,
            },
          ],
          completed_at: "2026-08-22T20:00:01.000Z",
        };
      },
    });
    expect(readFileSync(semanticPaths(deferredRoot).log, "utf8")).not.toContain('"event":"pass"');

    const errorRoot = fixture();
    let clock = Date.parse("2026-08-22T20:00:00.000Z");
    await runSemanticServiceDaemon({
      coordRoot: errorRoot,
      wakeIntervalMs: 1,
      heartbeatIntervalMs: 60_000,
      maxSweeps: 3,
      now: () => {
        clock += 1_000;
        return new Date(clock);
      },
      readSince: (() => {
        throw new Error("event ledger unavailable");
      }) as unknown as typeof readLedgerV3Since,
      waitForWake: async () => {},
    });
    const errors = readFileSync(semanticPaths(errorRoot).log, "utf8").match(
      /"event":"sweep_error"/g,
    );
    expect(errors).toHaveLength(1);
  });
});
