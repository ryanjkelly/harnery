import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { readLedgerV3Since } from "../events/v3/index.ts";
import {
  acquireSemanticServiceLease,
  ensureSemanticServiceRunning,
  readSemanticServiceStatus,
  requestSemanticServiceStop,
  runSemanticServiceDaemon,
} from "./service.ts";
import {
  readSemanticManifest,
  semanticPaths,
  writeSemanticAgentDocument,
  writeSemanticManifest,
} from "./storage.ts";
import { emptySemanticUsageAggregate, nativeSemanticUsage } from "./usage.ts";

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
  test("starts for active V3 and leaves running, paused, and inactive roots alone", async () => {
    const stopped = { running: false, stale: false, pending_count: 0 };
    const running = { running: true, stale: false, pending_count: 0 };
    let starts = 0;
    const start = async () => {
      starts += 1;
      return running;
    };

    expect(
      await ensureSemanticServiceRunning("/fixture/active", {
        readStatus: () => stopped,
        start,
        isPaused: () => false,
        isActive: () => true,
      }),
    ).toEqual({ state: "started", status: running });
    expect(
      await ensureSemanticServiceRunning("/fixture/running", {
        readStatus: () => running,
        start,
        isPaused: () => false,
        isActive: () => true,
      }),
    ).toEqual({ state: "running", status: running });
    expect(
      await ensureSemanticServiceRunning("/fixture/paused", {
        readStatus: () => stopped,
        start,
        isPaused: () => true,
        isActive: () => true,
      }),
    ).toEqual({ state: "paused", status: stopped });
    expect(
      await ensureSemanticServiceRunning("/fixture/inactive", {
        readStatus: () => stopped,
        start,
        isPaused: () => false,
        isActive: () => false,
      }),
    ).toEqual({ state: "inactive", status: stopped });
    expect(starts).toBe(1);
  });

  test("reports a failed automatic start without blocking its caller", async () => {
    const stopped = { running: false, stale: false, pending_count: 0 };
    expect(
      await ensureSemanticServiceRunning("/fixture/unavailable", {
        readStatus: () => stopped,
        start: async () => {
          throw new Error("fixture startup failure");
        },
        isPaused: () => false,
        isActive: () => true,
      }),
    ).toEqual({
      state: "unavailable",
      status: stopped,
      error: "fixture startup failure",
    });
  });

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

  test("keeps an operator pause until the next explicit daemon start", async () => {
    const root = fixture();
    const paths = semanticPaths(root);
    requestSemanticServiceStop(root);
    expect(existsSync(paths.stop)).toBe(true);

    await runSemanticServiceDaemon({
      coordRoot: root,
      wakeIntervalMs: 1,
      heartbeatIntervalMs: 60_000,
      maxSweeps: 1,
      readSince: (() => ({
        events: [],
        diagnostics: [],
        complete: true,
        genesis_id: "gex_fixture",
        active_schema_digest: "fixture",
        advances: [],
        bytes: 0,
        reset_required: false,
      })) as unknown as typeof readLedgerV3Since,
    });

    expect(existsSync(paths.stop)).toBe(false);
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
              usage: nativeSemanticUsage({
                input_tokens: 3200,
                cached_input_tokens: 2048,
                output_tokens: 256,
              }),
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
      process_usage: {
        call_count: 1,
        native_tokens: {
          input_tokens: 3200,
          cached_input_tokens: 2048,
          output_tokens: 256,
        },
        unreported_calls: 0,
      },
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
    expect(log).toContain(
      '"native_tokens":{"input_tokens":3200,"cached_input_tokens":2048,"output_tokens":256}',
    );
    expect(log).not.toContain("gen_01922e33");
  });

  test("keeps rolling usage across a service restart and leaves old calls unreported", () => {
    const root = fixture();
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    writeSemanticManifest(root, {
      schema_version: 2,
      ledger_genesis_id: "gex_fixture",
      configuration_digest: `sha256:${"a".repeat(64)}`,
      evidence_contract_version: 1,
      prompt_contract_version: 3,
      adapter_resolutions: {},
      pending: [],
      call_history: [
        {
          generation_id: "gen_01922e33-7abc-7def-8abc-0123456789ab",
          started_at: startedAt,
          source_harness: "codex",
          configured_model: "gpt-5.6-luna",
          resolved_model_id: "gpt-5.6-luna",
          model_attestation: "requested-only",
          outcome: "accepted",
          usage: nativeSemanticUsage({ input_tokens: 100, output_tokens: 20 }),
        },
        {
          generation_id: "gen_01922e33-7abd-7def-8abc-0123456789ab",
          started_at: startedAt,
        },
      ],
      updated_at: startedAt,
    });
    const writeStatus = (nonce: string, modelCalls: number) =>
      writeFileSync(
        semanticPaths(root).service,
        `${JSON.stringify({
          schema_version: 1,
          pid: process.pid,
          host: hostname(),
          nonce,
          state: "stopped",
          started_at: startedAt,
          heartbeat_at: startedAt,
          sweep_count: 1,
          pass_count: 1,
          model_calls: modelCalls,
          cache_hits: 0,
          process_usage: emptySemanticUsageAggregate(),
        })}\n`,
      );

    writeStatus("before-restart", 2);
    const before = readSemanticServiceStatus(root);
    writeStatus("after-restart", 0);
    const after = readSemanticServiceStatus(root);

    expect(before.rolling_calls).toMatchObject({ used: 2, limit: 60, available: 58 });
    expect(before.rolling_usage).toMatchObject({
      call_count: 2,
      native_tokens: { input_tokens: 100, output_tokens: 20 },
      unreported_calls: 1,
    });
    expect(after.rolling_usage).toEqual(before.rolling_usage);
    expect(after.process_usage).toMatchObject({ call_count: 0, unreported_calls: 0 });
  });

  test("recovers from a saved cursor when the active V3 genesis changes", async () => {
    const root = fixture();
    const oldCursor = {
      genesis_id: "gex_old",
      segment_ordinal: 1,
      byte_offset: 128,
      event_id: "evt_01922e33-7abc-7def-8abc-0123456789ab",
    };
    const newCursor = {
      genesis_id: "gex_new",
      segment_ordinal: 1,
      byte_offset: 256,
      event_id: "evt_01922e34-7abc-7def-8abc-0123456789ab",
    };
    writeSemanticManifest(root, {
      schema_version: 2,
      ledger_genesis_id: oldCursor.genesis_id,
      cursor: oldCursor,
      configuration_digest: `sha256:${"b".repeat(64)}`,
      evidence_contract_version: 1,
      prompt_contract_version: 3,
      adapter_resolutions: {},
      pending: [],
      call_history: [],
      updated_at: "2026-08-22T20:00:01.000Z",
    });
    const seenCursors: Array<typeof oldCursor | undefined> = [];
    const readSince = ((_root: string, cursor?: typeof oldCursor) => {
      seenCursors.push(cursor);
      if (cursor) {
        return {
          events: [],
          diagnostics: [{ code: "cursor_genesis_mismatch" }],
          complete: false,
          genesis_id: newCursor.genesis_id,
          active_schema_digest: "fixture",
          advances: [],
          bytes: 0,
          cursor,
          reset_required: true,
        };
      }
      return {
        events: [{}],
        diagnostics: [],
        complete: true,
        genesis_id: newCursor.genesis_id,
        active_schema_digest: "fixture",
        advances: [],
        bytes: 256,
        cursor: newCursor,
        reset_required: false,
      };
    }) as unknown as typeof readLedgerV3Since;
    let passes = 0;

    const terminal = await runSemanticServiceDaemon({
      coordRoot: root,
      debounceMs: 0,
      wakeIntervalMs: 1,
      heartbeatIntervalMs: 60_000,
      maxSweeps: 1,
      readSince,
      async runOnce() {
        passes += 1;
        return {
          schema_version: 1,
          ledger_genesis_id: newCursor.genesis_id,
          evidence_count: 1,
          evidence_by_harness: { "claude-code": 0, codex: 1, cursor: 0 },
          model_calls: 0,
          cache_hits: 1,
          outcomes: [],
          completed_at: "2026-08-22T20:00:02.000Z",
        };
      },
    });

    expect(seenCursors).toEqual([oldCursor, undefined]);
    expect(passes).toBe(1);
    expect(terminal.last_error_code).toBeUndefined();
    expect(readSemanticManifest(root)?.cursor).toEqual(newCursor);
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
        prompt_contract_version: 3,
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
      prompt_contract_version: 3,
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
