import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createStorageCatalog } from "../../src/core/storage/catalog";
import type {
  HarneryLogStorageDiagnostic,
  HarneryStorageClass,
  HarneryStorageFamilyHealth,
  HarneryStorageFamilyInventory,
  HarneryStorageHealthReport,
  HarneryStorageInventoryReport,
  HarneryStorageInventoryTotals,
} from "../../src/core/storage/contract";
import { HARNERY_STORAGE_INVENTORY_SCHEMA } from "../../src/core/storage/contract";
import { storageHealth } from "../../src/core/storage/health";
import { coordRoot } from "./coord-reader";

const execFile = promisify(execFileCallback);

export interface StorageClassSummary {
  storageClass: HarneryStorageClass;
  families: number;
  healthy: number;
  degraded: number;
  unknown: number;
  totals: HarneryStorageInventoryTotals;
}

export interface StorageFamilyView {
  inventory: HarneryStorageFamilyInventory;
  health: HarneryStorageFamilyHealth;
  descriptor: {
    owner: string;
    format: string;
    sensitivity: string;
    durability: string;
    writerModel: string;
    consumers: readonly string[];
  };
}

export interface StorageFootprintReport {
  inventory: HarneryStorageInventoryReport;
  health: HarneryStorageHealthReport;
  classes: readonly StorageClassSummary[];
  families: readonly StorageFamilyView[];
  catalog: {
    familyCount: number;
    rootCount: number;
    storageClassCount: number;
    diagnostics: readonly HarneryLogStorageDiagnostic[];
    dormantLogStorageFamilies: readonly string[];
  };
}

export interface StorageHealthSummary {
  healthy: number;
  degraded: number;
  unknown: number;
  needsAttention: number;
}

/** Unknown measurements stay visible without being promoted into the action queue. */
export function summarizeStorageHealth(
  families: readonly StorageFamilyView[],
): StorageHealthSummary {
  const healthy = families.filter(({ health }) => health.status === "healthy").length;
  const degraded = families.filter(({ health }) => health.status === "degraded").length;
  const unknown = families.length - healthy - degraded;
  return { healthy, degraded, unknown, needsAttention: degraded };
}

const STORAGE_CLASS_ORDER: readonly HarneryStorageClass[] = [
  "canonical-authority",
  "recovery-state",
  "durable-object-history",
  "operational-log",
  "debug-log",
  "repairable-cache",
  "managed-artifact",
];

const DEFAULT_CACHE_MS = 5 * 60_000;
interface StorageFootprintCacheState {
  cached: { root: string; expiresAt: number; report: StorageFootprintReport } | null;
  inFlight: { root: string; promise: Promise<StorageFootprintReport> } | null;
}

const cacheScope = globalThis as typeof globalThis & {
  __harneryStorageFootprintCache?: StorageFootprintCacheState;
};
const cacheState = cacheScope.__harneryStorageFootprintCache ?? { cached: null, inFlight: null };
cacheScope.__harneryStorageFootprintCache = cacheState;

/** Read the canonical, metadata-only storage inventory for one project root. */
export async function readStorageFootprint(
  root = coordRoot(),
  options: {
    cacheMs?: number;
    now?: () => number;
    inventoryReader?: (root: string) => Promise<HarneryStorageInventoryReport>;
  } = {},
): Promise<StorageFootprintReport> {
  const now = options.now?.() ?? Date.now();
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  if (cacheMs > 0 && cacheState.cached?.root === root && cacheState.cached.expiresAt > now) {
    return cacheState.cached.report;
  }
  if (cacheState.inFlight?.root === root) return cacheState.inFlight.promise;

  const promise = buildStorageFootprint(root, options.inventoryReader ?? readInventoryFromCli).then(
    (report) => {
      if (cacheMs > 0) cacheState.cached = { root, expiresAt: now + cacheMs, report };
      return report;
    },
  );
  cacheState.inFlight = { root, promise };
  try {
    return await promise;
  } finally {
    if (cacheState.inFlight?.promise === promise) cacheState.inFlight = null;
  }
}

/** Clear the process-local snapshot when a test or host lifecycle resets roots. */
export function clearStorageFootprintCache(): void {
  cacheState.cached = null;
  cacheState.inFlight = null;
}

async function buildStorageFootprint(
  root: string,
  inventoryReader: (root: string) => Promise<HarneryStorageInventoryReport>,
): Promise<StorageFootprintReport> {
  const catalog = createStorageCatalog({ coord_root: root, project_root: root });
  const inventory = await inventoryReader(root);
  const health = storageHealth(inventory);
  const healthByFamily = new Map(health.families.map((family) => [family.family_id, family]));
  const families = inventory.families.map((family) => {
    const descriptor = catalog.require(family.family_id);
    return {
      inventory: family,
      health: requireFamilyHealth(healthByFamily, family.family_id),
      descriptor: {
        owner: descriptor.owner,
        format: descriptor.format,
        sensitivity: descriptor.sensitivity,
        durability: descriptor.durability,
        writerModel: descriptor.writer_model,
        consumers: descriptor.consumers,
      },
    };
  });

  return {
    inventory,
    health,
    classes: summarizeClasses(families),
    families,
    catalog: {
      familyCount: catalog.families.length,
      rootCount: catalog.families.reduce((sum, family) => sum + family.resolved_roots.length, 0),
      storageClassCount: new Set(catalog.families.map((family) => family.storage_class)).size,
      diagnostics: catalog.log_storage_diagnostics,
      dormantLogStorageFamilies: catalog.dormant_log_storage_families,
    },
  };
}

async function readInventoryFromCli(root: string): Promise<HarneryStorageInventoryReport> {
  const bin = harnBin(root);
  const { stdout } = await execFile(bin, ["storage", "inventory", "--json"], {
    cwd: root,
    env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`storage inventory emitted invalid JSON: ${(error as Error).message}`);
  }
  if (!isStorageInventoryReport(parsed)) {
    throw new Error("storage inventory emitted an unsupported schema");
  }
  return parsed;
}

function harnBin(root: string): string {
  const candidates = [join(root, "harnery", "bin", "harn"), join(root, "bin", "harn")];
  const bin = candidates.find((candidate) => existsSync(candidate));
  if (!bin) throw new Error("could not locate the Harnery CLI for storage inventory");
  return bin;
}

function isStorageInventoryReport(value: unknown): value is HarneryStorageInventoryReport {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === HARNERY_STORAGE_INVENTORY_SCHEMA &&
    typeof record.captured_at === "string" &&
    Array.isArray(record.families) &&
    Array.isArray(record.issues)
  );
}

function summarizeClasses(families: readonly StorageFamilyView[]): StorageClassSummary[] {
  return STORAGE_CLASS_ORDER.map((storageClass) => {
    const rows = families.filter(({ inventory }) => inventory.storage_class === storageClass);
    return {
      storageClass,
      families: rows.length,
      healthy: rows.filter(({ health }) => health.status === "healthy").length,
      degraded: rows.filter(({ health }) => health.status === "degraded").length,
      unknown: rows.filter(({ health }) => health.status === "unknown").length,
      totals: sumTotals(rows.map(({ inventory }) => inventory.totals)),
    };
  }).filter(({ families: count }) => count > 0);
}

function sumTotals(rows: readonly HarneryStorageInventoryTotals[]): HarneryStorageInventoryTotals {
  return {
    regular_files: sumMeasurement(rows, "regular_files", "files"),
    logical_bytes: sumMeasurement(rows, "logical_bytes", "bytes"),
    allocated_bytes: sumMeasurement(rows, "allocated_bytes", "bytes"),
  };
}

function sumMeasurement(
  rows: readonly HarneryStorageInventoryTotals[],
  key: keyof HarneryStorageInventoryTotals,
  unit: "files" | "bytes",
): HarneryStorageInventoryTotals[typeof key] {
  let value = 0;
  for (const row of rows) {
    const measurement = row[key];
    if (measurement.state === "unavailable") return measurement;
    value += measurement.value;
  }
  return { state: "observed", unit, value };
}

function requireFamilyHealth(
  healthByFamily: ReadonlyMap<string, HarneryStorageFamilyHealth>,
  familyId: string,
): HarneryStorageFamilyHealth {
  const health = healthByFamily.get(familyId);
  if (!health) throw new Error(`storage health omitted registered family: ${familyId}`);
  return health;
}
