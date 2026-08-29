import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveCoordRoot as resolveCanonicalCoordRoot } from "../core/agents/coord-client.ts";
import { createStorageCatalog } from "../core/storage/catalog.ts";
import type {
  HarneryStorageClass,
  HarneryStorageInventoryReport,
  HarneryStorageMeasurement,
} from "../core/storage/contract.ts";
import { storageHealth } from "../core/storage/health.ts";
import { filterStorageInventory, inventoryStorage } from "../core/storage/inventory.ts";
import {
  DEFAULT_MAINTENANCE_BUDGET,
  executeStorageMaintenance,
  HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
  HarneryMaintenanceError,
  type HarneryStoragePressureSummary,
  listMaintenanceTransactions,
  planStorageMaintenance,
  readMaintenanceTransaction,
} from "../core/storage/maintenance.ts";
import { createStructuredLogMaintenanceProviders } from "../core/storage/maintenance-providers.ts";

const STORAGE_CLASSES = new Set<HarneryStorageClass>([
  "canonical-authority",
  "recovery-state",
  "operational-log",
  "debug-log",
  "durable-object-history",
  "repairable-cache",
  "managed-artifact",
]);

interface InventoryOptions {
  family?: string;
  class?: string;
  json?: boolean;
}

interface HealthOptions {
  json?: boolean;
}

interface MaintainOptions {
  family?: string;
  budget?: string;
  transaction?: string;
  yes?: boolean;
  authorizeStructuredLogDeletion?: boolean;
  json?: boolean;
}

interface StatusOptions {
  transaction?: string;
  json?: boolean;
}

export function registerStorageCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const storage = program
    .command("storage")
    .description("Inspect registered Harnery storage without reading file bodies");

  storage
    .command("inventory")
    .description("Inventory .harnery and explicitly registered external storage roots")
    .option("--family <id>", "Show one registered storage family")
    .option("--class <class>", "Show one registered storage class")
    .option("--json", "Emit the stable versioned inventory schema")
    .action(async (options: InventoryOptions) => {
      await run(emit, async () => {
        const catalog = catalogFor(context);
        if (options.family && !catalog.get(options.family)) {
          throw new StorageCommandError(
            "unknown_storage_family",
            `unknown storage family: ${options.family}`,
          );
        }
        const storageClass = parseStorageClass(options.class);
        const report = filterStorageInventory(await inventoryStorage(catalog), {
          ...(options.family ? { family_id: options.family } : {}),
          ...(storageClass ? { storage_class: storageClass } : {}),
        });
        if (options.json) {
          emit.config({ format: "json" });
          emit.data(report);
        } else {
          emit.rows(inventoryRows(report));
        }
      });
    });

  storage
    .command("health")
    .description("Report reason-coded health for every registered storage family")
    .option("--json", "Emit the stable versioned health schema")
    .action(async (options: HealthOptions) => {
      await run(emit, async () => {
        const report = storageHealth(await inventoryStorage(catalogFor(context)));
        if (options.json) {
          emit.config({ format: "json" });
          emit.data(report);
        } else {
          emit.text(`storage health: ${report.status}\n`);
          emit.rows(
            report.families.map((family) => ({
              family_id: family.family_id,
              status: family.status,
              reasons: family.reason_codes.join(",") || "none",
              maintenance: family.maintenance.state,
              max_bytes: family.log_storage?.effective_policy?.max_bytes ?? "unavailable",
              max_age_days: family.log_storage?.effective_policy?.max_age_days ?? "unavailable",
              managed_bytes: family.log_storage?.usage.managed_bytes ?? "not-a-log",
              unmanaged_bytes: family.log_storage?.usage.unmanaged_bytes ?? "not-a-log",
              pressure: family.log_storage?.pressure.state ?? "not-a-log",
              enforcement: family.log_storage?.retention.enforcement ?? "not-a-log",
            })),
          );
        }
      });
    });

  storage
    .command("maintain")
    .description("Plan bounded maintenance, or execute one exact transaction")
    .option("--family <id>", "Limit a new plan to one registered family")
    .option("--budget <duration>", "Wall-time budget such as 500ms, 5s, or 1m")
    .option("--dry-run", "Plan without mutating source storage", true)
    .option("--transaction <id>", "Execute one previously planned exact transaction")
    .option("--yes", "Confirm execution of the exact transaction")
    .option(
      "--authorize-structured-log-deletion",
      "Authorize deletion only for exact manifest-backed structured-log actions",
    )
    .option("--json", "Emit the versioned transaction schema")
    .action(async (options: MaintainOptions) => {
      await run(emit, async () => {
        const catalog = catalogFor(context);
        const providers = [
          ...createStructuredLogMaintenanceProviders(catalog),
          ...(context?.storageMaintenanceProviders ?? []),
        ];
        const transaction = options.transaction
          ? await executeStorageMaintenance(catalog, providers, options.transaction, {
              yes: options.yes === true,
              authorize_structured_log_deletion: options.authorizeStructuredLogDeletion === true,
            })
          : await planStorageMaintenance(catalog, providers, await pressureFor(catalog), {
              ...(options.family ? { family_id: options.family } : {}),
              budget: {
                ...DEFAULT_MAINTENANCE_BUDGET,
                max_duration_ms: parseDuration(options.budget),
              },
              persist: true,
            });
        if (options.json) {
          emit.config({ format: "json" });
          emit.data(transaction);
        } else {
          emit.rows([
            {
              transaction_id: transaction.transaction_id,
              state: transaction.state,
              dry_run: transaction.dry_run,
              actions: transaction.actions.length,
              files: transaction.actions.reduce((sum, action) => sum + action.files, 0),
              bytes: transaction.actions.reduce((sum, action) => sum + action.bytes, 0),
              reasons: transaction.reason_codes.join(",") || "none",
            },
          ]);
        }
      });
    });

  storage
    .command("status")
    .description("Inspect maintenance transactions without changing storage")
    .option("--transaction <id>", "Show one exact transaction")
    .option("--json", "Emit versioned transaction records")
    .action(async (options: StatusOptions) => {
      await run(emit, async () => {
        const catalog = catalogFor(context);
        const transactions = options.transaction
          ? [readMaintenanceTransaction(catalog.context.coord_root, options.transaction)]
          : listMaintenanceTransactions(catalog.context.coord_root);
        if (options.json) {
          emit.config({ format: "json" });
          emit.data(transactions);
        } else {
          emit.rows(
            transactions.map((transaction) => ({
              transaction_id: transaction.transaction_id,
              state: transaction.state,
              created_at: transaction.created_at,
              actions: transaction.actions.length,
              reasons: transaction.reason_codes.join(",") || "none",
            })),
          );
        }
      });
    });
}

function catalogFor(context?: HarneryProgramContext) {
  const coordRoot = resolve(
    context?.resolveCoordRoot?.() ??
      context?.repoRoot ??
      process.env.HARNERY_COORD_ROOT ??
      resolveCanonicalCoordRoot() ??
      process.cwd(),
  );
  return createStorageCatalog(
    { coord_root: coordRoot, project_root: resolve(context?.repoRoot ?? coordRoot) },
    context?.storage,
  );
}

function parseStorageClass(value: string | undefined): HarneryStorageClass | undefined {
  if (value === undefined) return undefined;
  if (!STORAGE_CLASSES.has(value as HarneryStorageClass)) {
    throw new StorageCommandError("unknown_storage_class", `unknown storage class: ${value}`);
  }
  return value as HarneryStorageClass;
}

async function pressureFor(
  catalog: ReturnType<typeof createStorageCatalog>,
): Promise<HarneryStoragePressureSummary> {
  const inventory = await inventoryStorage(catalog);
  return {
    schema: HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
    captured_at: inventory.captured_at,
    families: inventory.families.map((family) => ({
      family_id: family.family_id,
      logical_bytes:
        family.totals.logical_bytes.state === "observed" ? family.totals.logical_bytes.value : 0,
      regular_files:
        family.totals.regular_files.state === "observed" ? family.totals.regular_files.value : 0,
      needs_maintenance: family.maintenance.state === "eligible",
      observed_at: inventory.captured_at,
    })),
  };
}

function parseDuration(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAINTENANCE_BUDGET.max_duration_ms;
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match)
    throw new StorageCommandError("invalid_maintenance_budget", `invalid duration: ${value}`);
  const amount = Number(match[1]);
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 60 * 60 * 1_000) {
    throw new StorageCommandError("invalid_maintenance_budget", `invalid duration: ${value}`);
  }
  return result;
}

function inventoryRows(report: HarneryStorageInventoryReport): Record<string, unknown>[] {
  return report.families.map((family) => ({
    family_id: family.family_id,
    class: family.storage_class,
    state: family.state,
    regular_files: measurementValue(family.totals.regular_files),
    logical_bytes: measurementValue(family.totals.logical_bytes),
    allocated_bytes: measurementValue(family.totals.allocated_bytes),
    maintenance: family.maintenance.state,
    max_bytes: family.log_storage?.effective_policy?.max_bytes ?? "unavailable",
    max_age_days: family.log_storage?.effective_policy?.max_age_days ?? "unavailable",
    managed_bytes: family.log_storage?.usage.managed_bytes ?? "not-a-log",
    unmanaged_bytes: family.log_storage?.usage.unmanaged_bytes ?? "not-a-log",
    pressure: family.log_storage?.pressure.state ?? "not-a-log",
    enforcement: family.log_storage?.retention.enforcement ?? "not-a-log",
    reasons: family.reason_codes.join(",") || "none",
  }));
}

function measurementValue(measurement: HarneryStorageMeasurement): number | string {
  return measurement.state === "observed"
    ? measurement.value
    : `unavailable:${measurement.reason_code}`;
}

class StorageCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function run(emit: EmitContext, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    emit.error({
      code:
        error instanceof StorageCommandError || error instanceof HarneryMaintenanceError
          ? error.code
          : "storage_inspection_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    emit.setExitCode(1);
  }
}
