import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { readLedgerV3Since } from "../events/v3/index.ts";
import { runSemanticServiceDaemon } from "./service.ts";
import { writeSemanticManifest } from "./storage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-semantic-efficiency-"));
  roots.push(root);
  return root;
}

describe("semantic service efficiency", () => {
  test("sweeps without a pass while every pending generation is inside its call cooldown", async () => {
    const root = fixture();
    const cursor = {
      genesis_id: "gex_fixture",
      segment_ordinal: 1,
      byte_offset: 128,
      event_id: "evt_01922e33-7abc-7def-8abc-0123456789ab",
    };
    writeSemanticManifest(root, {
      schema_version: 2,
      ledger_genesis_id: cursor.genesis_id,
      cursor,
      configuration_digest: `sha256:${"b".repeat(64)}`,
      evidence_contract_version: 1,
      prompt_contract_version: 3,
      adapter_resolutions: {},
      pending: [
        {
          generation_id: "gen_01922e33-7abc-7def-8abc-0123456789ab",
          evidence_digest: `sha256:${"a".repeat(64)}`,
          band: 2,
          pending_since: "2026-08-22T20:00:00.000Z",
        },
      ],
      call_history: [
        {
          generation_id: "gen_01922e33-7abc-7def-8abc-0123456789ab",
          started_at: "2026-08-22T20:00:00.000Z",
        },
      ],
      updated_at: "2026-08-22T20:00:00.000Z",
    });
    let passes = 0;
    const readSince = (() => ({
      events: [],
      diagnostics: [],
      complete: true,
      genesis_id: cursor.genesis_id,
      active_schema_digest: "fixture",
      advances: [],
      bytes: 0,
      cursor,
      reset_required: false,
    })) as unknown as typeof readLedgerV3Since;

    const terminal = await runSemanticServiceDaemon({
      coordRoot: root,
      debounceMs: 0,
      wakeIntervalMs: 1,
      heartbeatIntervalMs: 60_000,
      maxSweeps: 3,
      now: () => new Date("2026-08-22T20:00:10.000Z"),
      readSince,
      async runOnce() {
        passes += 1;
        throw new Error("held-only pending work must not start a pass");
      },
      waitForWake: async () => {},
    });

    expect(passes).toBe(0);
    expect(terminal.sweep_count).toBe(3);
    expect(terminal.pass_count).toBe(0);
  });
});
