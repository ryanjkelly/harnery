import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createStorageCatalog, type HarneryStorageCatalog } from "./catalog.ts";
import {
  HARNERY_MAINTENANCE_CURSOR_SCHEMA,
  type HarneryAutomaticMaintenanceResult,
  type HarneryMaintenanceBudget,
  type HarneryMaintenanceProvider,
  readMaintenanceTransaction,
  runAutomaticMaintenanceSlice,
} from "./maintenance.ts";

const STALE_RUNNING_CLAIM_MS = 10 * 60 * 1_000;

export const SESSION_START_MAINTENANCE_BUDGET: HarneryMaintenanceBudget = Object.freeze({
  max_duration_ms: 250,
  max_files: 50,
  max_bytes: 16 * 1024 * 1024,
});

export interface ExistingMaintenanceJanitors {
  journal(): unknown;
  images(): unknown;
  artifacts(): unknown;
}

export interface AutomaticMaintenanceComposition {
  catalog: HarneryStorageCatalog;
  providers: readonly HarneryMaintenanceProvider[];
}

export function createExistingMaintenanceProviders(
  janitors: ExistingMaintenanceJanitors,
): readonly HarneryMaintenanceProvider[] {
  return [
    delegatedJanitorProvider("journal-history", "journal-janitor", janitors.journal),
    delegatedJanitorProvider("captured-images", "image-janitor", janitors.images),
    delegatedJanitorProvider("managed-artifacts", "artifact-janitor", janitors.artifacts),
  ];
}

export function createAutomaticMaintenanceComposition(
  coordRoot: string,
  janitors: ExistingMaintenanceJanitors,
): AutomaticMaintenanceComposition {
  const root = resolve(coordRoot);
  return {
    catalog: createStorageCatalog({ coord_root: root, project_root: root }),
    providers: createExistingMaintenanceProviders(janitors),
  };
}

/**
 * Run the bounded SessionStart slice. This path is permanently planning-only:
 * owner janitors retain their current direct activation until a later,
 * provider-specific production decision.
 */
export async function runAutomaticMaintenancePass(
  composition: AutomaticMaintenanceComposition,
  options: { now?: Date; budget?: HarneryMaintenanceBudget } = {},
): Promise<HarneryAutomaticMaintenanceResult> {
  if (process.env.HARNERY_SESSIONSTART_MAINTENANCE === "0") return disabledResult();
  const now = options.now ?? new Date();
  recoverInterruptedDailyClaim(composition.catalog.context.coord_root, now);
  return runAutomaticMaintenanceSlice(composition.catalog, composition.providers, {
    now,
    budget: options.budget ?? SESSION_START_MAINTENANCE_BUDGET,
    execute: false,
  });
}

function delegatedJanitorProvider(
  familyId: "journal-history" | "captured-images" | "managed-artifacts",
  janitorId: string,
  janitor: () => unknown,
): HarneryMaintenanceProvider {
  return {
    family_id: familyId,
    budget: { max_duration_ms: 100, max_files: 25, max_bytes: 8 * 1024 * 1024 },
    plan: ({ pressure, budget, cursor, now }) => {
      const day = now.toISOString().slice(0, 10);
      if (cursor === day || pressure.regular_files === 0) return { actions: [], next_cursor: day };
      return {
        actions: [
          {
            action_id: `${janitorId}-${day}`,
            family_id: familyId,
            kind: "delegated-janitor",
            target_ref: janitorId,
            files: Math.min(pressure.regular_files, budget.max_files),
            bytes: Math.min(pressure.logical_bytes, budget.max_bytes),
            destructive: true,
            metadata: { activation: "explicit-only", existing_owner_rules: true },
          },
        ],
        next_cursor: day,
      };
    },
    apply: ({ action }) => {
      if (
        action.family_id !== familyId ||
        action.kind !== "delegated-janitor" ||
        action.target_ref !== janitorId ||
        !action.destructive
      ) {
        return { outcome: "refused", detail: "delegated janitor action did not match its scope" };
      }
      janitor();
      return { outcome: "applied", detail: "existing owner janitor completed" };
    },
  };
}

interface DailyCursor {
  schema: typeof HARNERY_MAINTENANCE_CURSOR_SCHEMA;
  state: "running" | "complete";
  claimed_at: string;
  transaction_id: string;
}

function recoverInterruptedDailyClaim(coordRoot: string, now: Date): void {
  const path = join(resolve(coordRoot), ".harnery", "maintenance", "cursors", "daily.json");
  if (!existsSync(path)) return;
  let cursor: DailyCursor;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return;
    cursor = JSON.parse(readFileSync(path, "utf8")) as DailyCursor;
  } catch {
    return;
  }
  if (
    cursor.schema !== HARNERY_MAINTENANCE_CURSOR_SCHEMA ||
    cursor.state !== "running" ||
    !Number.isFinite(Date.parse(cursor.claimed_at)) ||
    now.getTime() - Date.parse(cursor.claimed_at) < STALE_RUNNING_CLAIM_MS ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(cursor.transaction_id)
  ) {
    return;
  }
  const transactionPath = join(
    resolve(coordRoot),
    ".harnery",
    "maintenance",
    "transactions",
    `${cursor.transaction_id}.json`,
  );
  if (existsSync(transactionPath)) {
    try {
      const transaction = readMaintenanceTransaction(coordRoot, cursor.transaction_id);
      if (transaction.state !== "planned") return;
      atomicCursor(path, { ...cursor, state: "complete" });
      return;
    } catch {
      return;
    }
  }
  const preserved = join(
    dirname(path),
    `daily.interrupted-${now.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`,
  );
  try {
    renameSync(path, preserved);
  } catch {
    // Another SessionStart may own or have completed the claim.
  }
}

function atomicCursor(path: string, cursor: DailyCursor): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function disabledResult(): HarneryAutomaticMaintenanceResult {
  return { ran: false, reason: "disabled", actions: 0, files: 0, bytes: 0 };
}
