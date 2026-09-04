import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext, loadLazyCommand } from "../commander.ts";
import { ensureEventLedgerV3 } from "../core/events/v3/bootstrap.ts";
import { recordHookSignalV3 } from "../core/events/v3/producers/recorder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ledger-v3 command", () => {
  test("registers explicit authority, support-pack, and sealed-history tools", async () => {
    const program = createHarneryProgram();
    await loadLazyCommand(program, "ledger-v3");
    const command = program.commands.find((candidate) => candidate.name() === "ledger-v3");
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "status",
      "archives",
      "initialize",
      "recover",
      "verify-support",
      "unpack-support",
      "support-transaction-status",
      "support-plan",
      "support-shadow",
      "support-replacement",
      "verify-v1-fence",
      "legacy-inventory",
      "legacy-compress",
      "verify-legacy",
      "legacy-canary",
    ]);
    const recover = command?.commands.find((candidate) => candidate.name() === "recover");
    expect(recover?.options.map(({ long }) => long)).toEqual([
      "--root",
      "--approval-record-id",
      "--yes",
    ]);
    const replacement = command?.commands.find(
      (candidate) => candidate.name() === "support-replacement",
    );
    expect(replacement?.options.map(({ long }) => long)).toEqual([
      "--transaction",
      "--exact-transaction",
      "--yes",
      "--root",
    ]);
    const legacyCanary = command?.commands.find(
      (candidate) => candidate.name() === "legacy-canary",
    );
    expect(legacyCanary?.options.map(({ long }) => long)).toContain("--shadow");
    const plan = command?.commands.find((candidate) => candidate.name() === "support-plan");
    expect(plan?.options.map(({ long }) => long)).toEqual([
      "--authority-root",
      "--authority-state",
      "--root-id",
      "--genesis-id",
      "--evidence",
      "--observed-at",
      "--catalog-version",
      "--policy-version",
      "--source-authority-digest",
      "--root",
    ]);
  }, 15_000);

  test("status reports OpenClaw producer state from an explicit root", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-ledger-v3-openclaw-"));
    roots.push(root);
    ensureEventLedgerV3(root, "ledger-v3-openclaw-status-test");
    expect(
      recordHookSignalV3({
        coordRoot: root,
        mode: "active",
        signal: "session-start",
        payload: { raw: {}, session_id: "openclaw-session" },
        adapter: "openclaw",
        instance_id: "inst_openclaw-status",
        producer_id: "prd_openclaw-status",
        build_id: "build_openclaw-status",
        platform: "linux",
      }).state,
    ).toBe("recorded");

    const result = await runSupport(["status", "--root", root]);
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      state: "active",
      summary: {
        adapters: ["openclaw"],
        producer_states: 1,
        producer_states_by_adapter: { openclaw: 1 },
      },
    });
  });

  test("the environment override wins over the program context root", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-ledger-v3-override-"));
    roots.push(root);
    ensureEventLedgerV3(root, "ledger-v3-override-status-test");
    const previous = process.env.HARNERY_COORD_ROOT_OVERRIDE;
    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
    try {
      const result = await runSupport(["status"]);
      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({ state: "active" });
    } finally {
      if (previous === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
      else process.env.HARNERY_COORD_ROOT_OVERRIDE = previous;
    }
  });

  test("plans from exact evidence and produces a transaction consumable by support-shadow", async () => {
    const fixture = supportPlanFixture();
    const planned = await runSupport([
      "support-plan",
      "--authority-root",
      fixture.authority,
      "--authority-state",
      "active",
      "--root-id",
      "root_fixture",
      "--genesis-id",
      "gen_fixture",
      "--evidence",
      fixture.evidence,
      "--observed-at",
      "2026-08-29T00:00:00.000Z",
      "--catalog-version",
      "storage-v1",
      "--policy-version",
      "support-v1",
      "--root",
      fixture.root,
    ]);
    expect(planned.error).toBeUndefined();
    expect(planned.data).toMatchObject({
      state: "planned",
      authority: { state: "active", root_id: "root_fixture", genesis_id: "gen_fixture" },
      sources: [{ relative_path: "diagnostics/old.json", family: "diagnostic" }],
    });
    const transaction = (planned.data as { transaction_id: string }).transaction_id;
    const shadow = await runSupport([
      "support-shadow",
      "--transaction",
      transaction,
      "--genesis-id",
      "gen_fixture",
      "--minimum-harnery-version",
      "0.36.0",
      "--root",
      fixture.root,
    ]);
    expect(shadow.error).toBeUndefined();
    expect(shadow.data).toEqual({
      transaction_id: transaction,
      state: "shadow-verified",
      sources_preserved: true,
      replacement_enabled: false,
    });
    const wrongGenesisResume = await runSupport([
      "support-shadow",
      "--transaction",
      transaction,
      "--genesis-id",
      "gen_wrong",
      "--minimum-harnery-version",
      "0.36.0",
      "--root",
      fixture.root,
    ]);
    expect(wrongGenesisResume.data).toBeUndefined();
    expect(wrongGenesisResume.error).toEqual({
      code: "ledger_v3_support_shadow_failed",
      message: "event_v3_support_transaction_genesis_mismatch",
    });
  });

  test("support-plan refuses missing evidence instead of inferring eligibility", async () => {
    const fixture = supportPlanFixture({ evidence: {} });
    const result = await runSupport([
      "support-plan",
      "--authority-root",
      fixture.authority,
      "--authority-state",
      "active",
      "--root-id",
      "root_fixture",
      "--genesis-id",
      "gen_fixture",
      "--evidence",
      fixture.evidence,
      "--observed-at",
      "2026-08-29T00:00:00.000Z",
      "--catalog-version",
      "storage-v1",
      "--policy-version",
      "support-v1",
      "--root",
      fixture.root,
    ]);
    expect(result.data).toBeUndefined();
    expect(result.error).toEqual({
      code: "ledger_v3_support_plan_failed",
      message: "event_v3_support_plan_evidence_paths_mismatch",
    });

    const malformed = supportPlanFixture({
      evidence: {
        "diagnostics/old.json": {
          epoch_maintenance_enabled: "true",
          recorded_at: "2026-08-20T00:00:00.000Z",
          filename_recorded_at: "2026-08-20T00:00:00.000Z",
        },
      },
    });
    const malformedResult = await runSupport([
      "support-plan",
      "--authority-root",
      malformed.authority,
      "--authority-state",
      "active",
      "--root-id",
      "root_fixture",
      "--genesis-id",
      "gen_fixture",
      "--evidence",
      malformed.evidence,
      "--observed-at",
      "2026-08-29T00:00:00.000Z",
      "--catalog-version",
      "storage-v1",
      "--policy-version",
      "support-v1",
      "--root",
      malformed.root,
    ]);
    expect(malformedResult.error).toEqual({
      code: "ledger_v3_support_plan_failed",
      message: "event_v3_support_plan_evidence_invalid",
    });
  });
});

async function runSupport(argv: string[]): Promise<{ data: unknown; error: unknown }> {
  let data: unknown;
  let error: unknown;
  const emit = {
    data: (value: unknown) => {
      data = value;
    },
    error: (value: unknown) => {
      error = value;
    },
  } as EmitContext;
  try {
    await createHarneryProgram({ emit }).parseAsync(["ledger-v3", ...argv], { from: "user" });
  } catch {
    // Refusals emit a structured error before the command action rethrows.
  }
  return { data, error };
}

function supportPlanFixture(options: { evidence?: Record<string, unknown> } = {}): {
  root: string;
  authority: string;
  evidence: string;
} {
  const root = mkdtempSync(join(tmpdir(), "harnery-ledger-v3-cli-"));
  roots.push(root);
  const authority = join(root, "authority");
  const diagnostics = join(authority, "diagnostics");
  mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
  const source = join(diagnostics, "old.json");
  writeFileSync(source, '{"code":"safe"}\n', { mode: 0o600 });
  chmodSync(source, 0o600);
  const evidence = join(root, "evidence.json");
  writeFileSync(
    evidence,
    `${JSON.stringify(
      options.evidence ?? {
        "diagnostics/old.json": {
          contract_valid: true,
          epoch_maintenance_enabled: true,
          recorded_at: "2026-08-20T00:00:00.000Z",
          filename_recorded_at: "2026-08-20T00:00:00.000Z",
          maximum_loose_consumer_window_ms: 0,
          fixed_consumer_grace_ms: 0,
        },
      },
    )}\n`,
    { mode: 0o600 },
  );
  return { root, authority, evidence };
}
