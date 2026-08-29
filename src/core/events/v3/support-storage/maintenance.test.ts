import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventV3SupportInventoryEntry } from "./inventory.ts";
import {
  activateEventV3SupportReplacement,
  authorizeEventV3SupportReplacement,
  planEventV3SupportReplacement,
  planEventV3SupportTransaction,
  readEventV3SupportTransaction,
  recoverEventV3SupportTransaction,
  verifyEventV3SupportTransactionShadow,
  writeEventV3SupportTransactionShadow,
} from "./maintenance.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Event Ledger V3 support maintenance transaction", () => {
  test("advances through shadow proof and exact authorization without replacing sources", async () => {
    const fixture = transactionFixture();
    const planned = await planEventV3SupportTransaction(fixture.input);
    expect(planned.state).toBe("planned");
    expect(
      await recoverEventV3SupportTransaction({
        transaction_root: fixture.transactions,
        transaction_id: planned.transaction_id,
        expected_current_genesis_id: "gen_fixture",
      }),
    ).toEqual({ action: "write-shadow" });
    const shadow = await writeEventV3SupportTransactionShadow({
      transaction_root: fixture.transactions,
      transaction_id: planned.transaction_id,
      minimum_harnery_version: "0.36.0",
      now: "2026-08-29T00:01:00.000Z",
    });
    expect(shadow.state).toBe("shadow-written");
    expect(readFileSync(fixture.source, "utf8")).toBe('{"code":"safe"}\n');
    const verified = await verifyEventV3SupportTransactionShadow({
      transaction_root: fixture.transactions,
      transaction_id: planned.transaction_id,
      expected_current_genesis_id: "gen_fixture",
      now: "2026-08-29T00:02:00.000Z",
    });
    expect(verified.state).toBe("shadow-verified");
    await expect(
      authorizeEventV3SupportReplacement({
        transaction_root: fixture.transactions,
        transaction_id: planned.transaction_id,
        exact_transaction_id: planned.transaction_id,
        yes: false,
        now: "2026-08-29T00:03:00.000Z",
      }),
    ).rejects.toThrow("event_v3_support_replacement_yes_required");
    await expect(
      authorizeEventV3SupportReplacement({
        transaction_root: fixture.transactions,
        transaction_id: planned.transaction_id,
        exact_transaction_id: `vst_${"f".repeat(32)}`,
        yes: true,
        now: "2026-08-29T00:03:00.000Z",
      }),
    ).rejects.toThrow("event_v3_support_replacement_exact_transaction_mismatch");
    const ready = await authorizeEventV3SupportReplacement({
      transaction_root: fixture.transactions,
      transaction_id: planned.transaction_id,
      exact_transaction_id: planned.transaction_id,
      yes: true,
      now: "2026-08-29T00:03:00.000Z",
    });
    expect(ready.state).toBe("replacement-ready");
    const replacement = await planEventV3SupportReplacement({
      transaction_root: fixture.transactions,
      transaction_id: planned.transaction_id,
    });
    expect(replacement).toMatchObject({
      enabled: false,
      reason: "event_v3_support_replacement_activation_disabled",
      frozen_source_paths: ["diagnostics/safe.json"],
    });
    expect(() => activateEventV3SupportReplacement()).toThrow(
      "event_v3_support_replacement_activation_disabled",
    );
    expect(readFileSync(fixture.source, "utf8")).toBe('{"code":"safe"}\n');
    expect(
      (await readEventV3SupportTransaction(fixture.transactions, planned.transaction_id)).sequence,
    ).toBe(4);
  });

  test("fault injection refuses changed sources, corrupt packs, and epoch rolls", async () => {
    const changed = transactionFixture();
    const changedPlan = await planEventV3SupportTransaction(changed.input);
    writeFileSync(changed.source, '{"code":"changed"}\n');
    await expect(
      writeEventV3SupportTransactionShadow({
        transaction_root: changed.transactions,
        transaction_id: changedPlan.transaction_id,
        minimum_harnery_version: "0.36.0",
        now: "2026-08-29T00:01:00.000Z",
      }),
    ).rejects.toThrow("event_v3_support_frozen_source_mismatch");

    const corrupted = transactionFixture();
    const corruptedPlan = await planEventV3SupportTransaction(corrupted.input);
    const shadow = await writeEventV3SupportTransactionShadow({
      transaction_root: corrupted.transactions,
      transaction_id: corruptedPlan.transaction_id,
      minimum_harnery_version: "0.36.0",
      now: "2026-08-29T00:01:00.000Z",
    });
    writeFileSync(
      join(corrupted.transactions, corruptedPlan.transaction_id, shadow.shadow!.payload_path),
      "corrupt",
    );
    await expect(
      verifyEventV3SupportTransactionShadow({
        transaction_root: corrupted.transactions,
        transaction_id: corruptedPlan.transaction_id,
        expected_current_genesis_id: "gen_fixture",
        now: "2026-08-29T00:02:00.000Z",
      }),
    ).rejects.toThrow("event_v3_support_payload_length_mismatch");
    await expect(
      recoverEventV3SupportTransaction({
        transaction_root: corrupted.transactions,
        transaction_id: corruptedPlan.transaction_id,
        expected_current_genesis_id: "gen_new_epoch",
      }),
    ).rejects.toThrow("event_v3_support_transaction_genesis_mismatch");
  });
});

function transactionFixture(): {
  source: string;
  transactions: string;
  input: Parameters<typeof planEventV3SupportTransaction>[0];
} {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-maintenance-test-"));
  roots.push(root);
  const authority = join(root, "authority");
  const transactions = join(root, "transactions");
  mkdirSync(join(authority, "diagnostics"), { recursive: true });
  mkdirSync(transactions, { recursive: true });
  const source = join(authority, "diagnostics", "safe.json");
  const contents = Buffer.from('{"code":"safe"}\n');
  writeFileSync(source, contents, { mode: 0o600 });
  const entry: EventV3SupportInventoryEntry = {
    authority: { state: "active", genesis_id: "gen_fixture" },
    family: "diagnostic",
    relative_path: "diagnostics/safe.json",
    bytes: contents.length,
    digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    disposition: "pack-eligible",
    reasons: ["diagnostic_consumer_window_elapsed"],
    observed: {
      recorded_at: "2026-08-20T00:00:00.000Z",
      modified_at: "2026-08-20T00:00:00.000Z",
    },
  };
  return {
    source,
    transactions,
    input: {
      transaction_root: transactions,
      authority_root: authority,
      root_id: "root_fixture",
      genesis_id: "gen_fixture",
      authority_state: "active",
      entries: [entry],
      catalog_version: "storage-v1",
      policy_version: "event-v3-support-v1",
      now: "2026-08-29T00:00:00.000Z",
    },
  };
}
