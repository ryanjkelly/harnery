import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  readStorageSnapshot,
  STORAGE_SNAPSHOT_MAX_AGE_MS,
  writeStorageSnapshot,
} from "./storage-snapshot-cache";

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
  cached: { key: string; savedAt: number; report: StorageFootprintReport } | null;
  inFlight: Map<string, Promise<StorageFootprintReport>>;
}

const cacheScope = globalThis as typeof globalThis & {
  __harneryStorageFootprintCacheV2?: StorageFootprintCacheState;
};
const cacheState = cacheScope.__harneryStorageFootprintCacheV2 ?? {
  cached: null,
  inFlight: new Map(),
};
cacheScope.__harneryStorageFootprintCacheV2 = cacheState;

/**
 * Read the canonical, metadata-only storage inventory for one project root.
 *
 * The inventory walks every managed root, which on a large project takes
 * seconds. A fresh snapshot is served as-is. An expired snapshot is served
 * immediately while one refresh runs in the background, so a page load never
 * waits on the walk once the first snapshot exists. Only a cold cache blocks.
 */
export async function readStorageFootprint(
  root = coordRoot(),
  options: {
    cacheMs?: number;
    now?: () => number;
    inventoryReader?: (root: string) => Promise<HarneryStorageInventoryReport>;
  } = {},
): Promise<StorageFootprintReport> {
  const clock = options.now ?? Date.now;
  const now = clock();
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const catalog = createStorageCatalog({ coord_root: root, project_root: root });
  // Catalog descriptors include resolved roots and effective configuration.
  // A moved checkout or changed policy must not inherit an older report.
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        root,
        schema: HARNERY_STORAGE_INVENTORY_SCHEMA,
        families: catalog.families,
        diagnostics: catalog.log_storage_diagnostics,
      }),
    )
    .digest("hex");
  let cached = cacheMs > 0 && cacheState.cached?.key === key ? cacheState.cached : null;
  if (cached && (now < cached.savedAt || now - cached.savedAt > STORAGE_SNAPSHOT_MAX_AGE_MS))
    cached = null;
  if (!cached && cacheMs > 0) {
    const disk = await readStorageSnapshot(root, key, now);
    if (disk && isStorageInventoryReport(disk.inventory)) {
      try {
        cached = {
          key,
          savedAt: disk.savedAt,
          report: projectStorageFootprint(catalog, disk.inventory),
        };
        cacheState.cached = cached;
      } catch {
        // A structurally unusable or obsolete display snapshot is a cache miss.
      }
    }
  }
  if (cached && now - cached.savedAt < cacheMs) return cached.report;
  const refresh = startStorageFootprintRefresh(
    root,
    key,
    catalog,
    options.inventoryReader ?? readInventoryFromCli,
    cacheMs,
    clock,
  );
  if (cached) {
    refresh.catch(() => {});
    return cached.report;
  }
  return refresh;
}

function startStorageFootprintRefresh(
  root: string,
  key: string,
  catalog: ReturnType<typeof createStorageCatalog>,
  inventoryReader: (root: string) => Promise<HarneryStorageInventoryReport>,
  cacheMs: number,
  clock: () => number,
): Promise<StorageFootprintReport> {
  const existing = cacheState.inFlight.get(key);
  if (existing) return existing;
  const promise = inventoryReader(root)
    .then(async (inventory) => {
      if (!isStorageInventoryReport(inventory))
        throw new Error("storage inventory emitted an unsupported schema");
      const report = projectStorageFootprint(catalog, inventory);
      const savedAt = clock();
      if (cacheMs > 0 && cacheState.inFlight.get(key) === promise) {
        cacheState.cached = { key, savedAt, report };
        await writeStorageSnapshot(root, key, savedAt, inventory);
      }
      return report;
    })
    .finally(() => {
      if (cacheState.inFlight.get(key) === promise) cacheState.inFlight.delete(key);
    });
  cacheState.inFlight.set(key, promise);
  return promise;
}

/** Clear the process-local snapshot when a test or host lifecycle resets roots. */
export function clearStorageFootprintCache(): void {
  cacheState.cached = null;
  cacheState.inFlight.clear();
}

function projectStorageFootprint(
  catalog: ReturnType<typeof createStorageCatalog>,
  inventory: HarneryStorageInventoryReport,
): StorageFootprintReport {
  const ids = new Set(inventory.families.map((family) => family.family_id));
  if (
    ids.size !== inventory.families.length ||
    ids.size !== catalog.families.length ||
    catalog.families.some((family) => !ids.has(family.id))
  ) {
    throw new Error("storage inventory does not match the complete catalog");
  }
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
  const object = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const strings = (v: unknown) => Array.isArray(v) && v.every((item) => typeof item === "string");
  const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const measurement = (v: unknown, unit: string) =>
    object(v) &&
    v.unit === unit &&
    ((v.state === "observed" && count(v.value)) ||
      (v.state === "unavailable" && typeof v.reason_code === "string"));
  const totals = (v: unknown) =>
    object(v) &&
    measurement(v.regular_files, "files") &&
    measurement(v.logical_bytes, "bytes") &&
    measurement(v.allocated_bytes, "bytes");
  const log = (v: unknown) => {
    if (!object(v) || !object(v.usage) || !object(v.pressure) || !object(v.retention)) return false;
    const usage = v.usage;
    if (
      ![
        "managed_bytes",
        "unmanaged_bytes",
        "total_bytes",
        "managed_files",
        "unmanaged_files",
      ].every((k) => count(usage[k]))
    )
      return false;
    if (
      typeof v.pressure.state !== "string" ||
      !strings(v.pressure.reason_codes) ||
      typeof v.retention.state !== "string" ||
      typeof v.retention.enforcement !== "string" ||
      !strings(v.retention.reason_codes)
    )
      return false;
    for (const k of ["ratio", "bytes_over"])
      if (v.pressure[k] !== null && !count(v.pressure[k])) return false;
    const policy = v.effective_policy;
    return (
      policy === null ||
      (object(policy) &&
        typeof policy.state === "string" &&
        ["max_bytes", "max_age_days", "max_age_ms"].every((k) => count(policy[k])) &&
        typeof policy.fingerprint === "string" &&
        object(policy.provenance) &&
        object(policy.provenance.max_bytes) &&
        typeof policy.provenance.max_bytes.source === "string" &&
        object(policy.provenance.max_age_days) &&
        typeof policy.provenance.max_age_days.source === "string" &&
        Array.isArray(policy.diagnostics) &&
        policy.diagnostics.every(
          (d: unknown) => object(d) && typeof d.code === "string" && typeof d.message === "string",
        ))
    );
  };
  if (
    !object(value) ||
    value.schema !== HARNERY_STORAGE_INVENTORY_SCHEMA ||
    typeof value.captured_at !== "string" ||
    !Number.isFinite(Date.parse(value.captured_at)) ||
    !object(value.privacy) ||
    value.privacy.content_read !== false ||
    value.privacy.path_mode !== "aggregate-labels" ||
    !object(value.scan) ||
    value.scan.mode !== "streaming-lstat" ||
    !count(value.scan.max_concurrency) ||
    value.scan.project_filesystem_scope !== ".harnery-and-registered-external-roots" ||
    !object(value.filter) ||
    Object.keys(value.filter).length !== 0 ||
    !totals(value.filesystem_totals) ||
    !object(value.scope_totals) ||
    !totals(value.scope_totals.coordination_root) ||
    !totals(value.scope_totals.registered_external_roots) ||
    !Array.isArray(value.families) ||
    !Array.isArray(value.issues)
  )
    return false;
  return (
    value.issues.every(
      (issue: unknown) =>
        object(issue) &&
        typeof issue.reason_code === "string" &&
        count(issue.count) &&
        issue.maintenance_eligible === false,
    ) &&
    value.families.every(
      (family: unknown) =>
        object(family) &&
        [
          "family_id",
          "source",
          "storage_class",
          "policy_version",
          "provider_id",
          "inventory",
          "state",
        ].every((k) => typeof family[k] === "string") &&
        object(family.maintenance) &&
        typeof family.maintenance.state === "string" &&
        (family.maintenance.reason_code === undefined ||
          typeof family.maintenance.reason_code === "string") &&
        strings(family.reason_codes) &&
        totals(family.totals) &&
        (family.log_storage === undefined || log(family.log_storage)) &&
        Array.isArray(family.roots) &&
        family.roots.every(
          (root: unknown) =>
            object(root) &&
            count(root.root_index) &&
            ["root_label", "ownership", "state"].every((k) => typeof root[k] === "string") &&
            strings(root.reason_codes) &&
            totals(root.totals),
        ),
    )
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
