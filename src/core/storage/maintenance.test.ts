import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "./catalog.ts";
import {
  executeStorageMaintenance,
  HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
  type HarneryMaintenanceAction,
  type HarneryMaintenanceProvider,
  planStorageMaintenance,
  readMaintenanceTransaction,
  runAutomaticMaintenanceSlice,
  writePressureSummary,
} from "./maintenance.ts";
import { consolidateMutationReceipts } from "./receipts.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage maintenance", () => {
  test("plans only pressure-selected work within global budgets", async () => {
    const root = fixture();
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    const provider = fixtureProvider([action("first", 2, 20), action("too-large", 5, 50)]);
    const transaction = await planStorageMaintenance(catalog, [provider], pressure(), {
      now: new Date("2026-08-29T12:00:00.000Z"),
      budget: { max_duration_ms: 1_000, max_files: 3, max_bytes: 30 },
      persist: true,
    });
    expect(transaction.actions.map(({ action_id }) => action_id)).toEqual(["first"]);
    expect(transaction.reason_codes).toContain("global_budget_exhausted");
    expect(readMaintenanceTransaction(root, transaction.transaction_id)).toEqual(transaction);
  });

  test("requires exact confirmation, writes immutable receipts, and resumes idempotently", async () => {
    const root = fixture();
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    let applied = 0;
    const provider = fixtureProvider([action("one", 1, 10)], () => {
      applied += 1;
      return { outcome: "applied", output_sha256: "a".repeat(64) };
    });
    const transaction = await planStorageMaintenance(catalog, [provider], pressure(), {
      persist: true,
      now: new Date("2026-08-29T12:01:00.000Z"),
    });
    await expect(
      executeStorageMaintenance(catalog, [provider], transaction.transaction_id, { yes: false }),
    ).rejects.toThrow("requires the exact transaction id and --yes");
    const committed = await executeStorageMaintenance(
      catalog,
      [provider],
      transaction.transaction_id,
      {
        yes: true,
        now: new Date("2026-08-29T12:02:00.000Z"),
      },
    );
    expect(committed.state).toBe("committed");
    expect(applied).toBe(1);
    expect(
      existsSync(
        join(root, ".harnery/maintenance/receipts", transaction.transaction_id, "one.json"),
      ),
    ).toBeTrue();
    await executeStorageMaintenance(catalog, [provider], transaction.transaction_id, { yes: true });
    expect(applied).toBe(1);
  });

  test("refuses destructive actions even with confirmation while activation is disabled", async () => {
    const root = fixture();
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    let applied = false;
    const destructive = { ...action("delete-one", 1, 10), destructive: true };
    const provider = fixtureProvider([destructive], () => {
      applied = true;
      return { outcome: "applied" };
    });
    const transaction = await planStorageMaintenance(catalog, [provider], pressure(), {
      persist: true,
    });
    await expect(
      executeStorageMaintenance(catalog, [provider], transaction.transaction_id, { yes: true }),
    ).rejects.toThrow("destructive maintenance is inactive");
    expect(applied).toBeFalse();
    expect(readMaintenanceTransaction(root, transaction.transaction_id).state).toBe("refused");
  });

  test("automatic maintenance is claim-first and dormant roots pay nothing", async () => {
    const root = fixture();
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    expect(await runAutomaticMaintenanceSlice(catalog, [])).toMatchObject({
      ran: false,
      reason: "no-pressure",
    });
    expect(existsSync(join(root, ".harnery"))).toBeFalse();

    writePressureSummary(root, pressure());
    let releasePlan: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const provider = fixtureProvider([action("one", 1, 10)]);
    provider.plan = async () => {
      await gate;
      return { actions: [action("one", 1, 10)] };
    };
    const first = runAutomaticMaintenanceSlice(catalog, [provider], {
      now: new Date("2026-08-29T12:03:00.000Z"),
    });
    await Bun.sleep(20);
    const second = await runAutomaticMaintenanceSlice(catalog, [provider], {
      now: new Date("2026-08-29T12:03:00.000Z"),
    });
    expect(second.reason).toBe("contended");
    releasePlan?.();
    expect(await first).toMatchObject({ ran: true, reason: "planned", actions: 1 });
  });

  test("losslessly consolidates receipts only after exact confirmation", async () => {
    const root = fixture();
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    const provider = fixtureProvider([action("one", 1, 10), action("two", 1, 10)]);
    const transaction = await planStorageMaintenance(catalog, [provider], pressure(), {
      persist: true,
    });
    await executeStorageMaintenance(catalog, [provider], transaction.transaction_id, { yes: true });
    const planned = consolidateMutationReceipts(root, { threshold: 2 });
    expect(planned).toMatchObject({ source_count: 2, applied: false });
    const committed = consolidateMutationReceipts(root, {
      threshold: 2,
      consolidation_id: planned!.segment_id,
      yes: true,
    });
    expect(committed).toMatchObject({ source_count: 2, applied: true });
    const payload = readFileSync(
      join(root, ".harnery/maintenance/receipts/segments", `${planned!.segment_id}.jsonl`),
      "utf8",
    );
    expect(payload.trim().split("\n")).toHaveLength(2);
    expect(
      existsSync(
        join(root, ".harnery/maintenance/receipts", transaction.transaction_id, "one.json"),
      ),
    ).toBeFalse();
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-maintenance-"));
  roots.push(root);
  return root;
}

function action(action_id: string, files: number, bytes: number): HarneryMaintenanceAction {
  return {
    action_id,
    family_id: "storage-maintenance-run-log",
    kind: "compact",
    target_ref: action_id,
    files,
    bytes,
    destructive: false,
  };
}

function fixtureProvider(
  actions: readonly HarneryMaintenanceAction[],
  apply: HarneryMaintenanceProvider["apply"] = () => ({ outcome: "applied" }),
): HarneryMaintenanceProvider {
  return {
    family_id: "storage-maintenance-run-log",
    plan: () => ({ actions, next_cursor: "next" }),
    apply,
  };
}

function pressure() {
  return {
    schema: HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
    captured_at: "2026-08-29T12:00:00.000Z",
    families: [
      {
        family_id: "storage-maintenance-run-log",
        logical_bytes: 1_000,
        regular_files: 10,
        needs_maintenance: true,
        observed_at: "2026-08-29T12:00:00.000Z",
      },
    ],
  } as const;
}
