import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { createStorageCatalog } from "../core/storage/catalog.ts";
import type {
  HarneryStorageClass,
  HarneryStorageInventoryReport,
  HarneryStorageMeasurement,
} from "../core/storage/contract.ts";
import { storageHealth } from "../core/storage/health.ts";
import { filterStorageInventory, inventoryStorage } from "../core/storage/inventory.ts";

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

function inventoryRows(report: HarneryStorageInventoryReport): Record<string, unknown>[] {
  return report.families.map((family) => ({
    family_id: family.family_id,
    class: family.storage_class,
    state: family.state,
    regular_files: measurementValue(family.totals.regular_files),
    logical_bytes: measurementValue(family.totals.logical_bytes),
    allocated_bytes: measurementValue(family.totals.allocated_bytes),
    maintenance: family.maintenance.state,
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
      code: error instanceof StorageCommandError ? error.code : "storage_inspection_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    emit.setExitCode(1);
  }
}
