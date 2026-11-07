import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
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
import { harnChildEnv, harnCommand, harneryBinPath } from "./harn-command";
import {
  acquireStorageRefreshLease,
  readStorageRefreshLease,
  readStorageSnapshot,
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
/** After a failed walk, page views wait this long before starting another one. */
const DEFAULT_RETRY_MS = 2 * 60_000;
/** A walk times out after 10 minutes, so an older lease belongs to a lost walk. */
const LEASE_STALE_MS = 12 * 60_000;

export interface StorageRefreshFailure {
  at: number;
  message: string;
}

interface CachedFootprint {
  key: string;
  savedAt: number;
  report: StorageFootprintReport;
}

interface RefreshEntry {
  promise: Promise<StorageFootprintReport>;
  startedAt: number;
}

interface StorageFootprintCacheState {
  cached: CachedFootprint | null;
  inFlight: Map<string, RefreshEntry>;
  failures: Map<string, StorageRefreshFailure>;
}

const cacheScope = globalThis as typeof globalThis & {
  __harneryStorageFootprintCacheV3?: StorageFootprintCacheState;
};
const cacheState = cacheScope.__harneryStorageFootprintCacheV3 ?? {
  cached: null,
  inFlight: new Map(),
  failures: new Map(),
};
cacheScope.__harneryStorageFootprintCacheV3 = cacheState;

interface StorageReadOptions {
  cacheMs?: number;
  now?: () => number;
  inventoryReader?: (root: string) => Promise<HarneryStorageInventoryReport>;
}

interface StorageContext {
  root: string;
  key: string;
  catalog: ReturnType<typeof createStorageCatalog>;
  now: number;
  clock: () => number;
  cacheMs: number;
  inventoryReader: (root: string) => Promise<HarneryStorageInventoryReport>;
}

function storageContext(root: string, options: StorageReadOptions): StorageContext {
  const clock = options.now ?? Date.now;
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
  return {
    root,
    key,
    catalog,
    now: clock(),
    clock,
    cacheMs: options.cacheMs ?? DEFAULT_CACHE_MS,
    inventoryReader: options.inventoryReader ?? readInventoryFromCli,
  };
}

/**
 * The newest usable measurement for this root. Memory answers while it is
 * fresh; otherwise the disk snapshot is consulted, because a warm-handover
 * peer may have finished a newer walk. With `allowOtherKey`, a snapshot of
 * this root taken under different storage settings is returned with
 * `exactKey: false` so the caller can show it as stale.
 */
async function loadCachedFootprint(
  ctx: StorageContext,
  allowOtherKey: boolean,
): Promise<(CachedFootprint & { exactKey: boolean }) | null> {
  if (ctx.cacheMs <= 0) return null;
  const memory = cacheState.cached;
  const cached =
    memory && memory.key === ctx.key && ctx.now >= memory.savedAt
      ? { ...memory, exactKey: true }
      : null;
  if (cached && ctx.now - cached.savedAt < ctx.cacheMs) return cached;
  const disk = await readStorageSnapshot(ctx.root, ctx.key, ctx.now, { allowOtherKey });
  const newer = disk && (!cached || (disk.exactKey && disk.savedAt > cached.savedAt));
  if (disk && newer && isStorageInventoryReport(disk.inventory)) {
    try {
      const report = projectStorageFootprint(ctx.catalog, disk.inventory);
      const loaded = { key: ctx.key, savedAt: disk.savedAt, report };
      if (disk.exactKey) cacheState.cached = loaded;
      return { ...loaded, exactKey: disk.exactKey };
    } catch {
      // A structurally unusable or obsolete display snapshot is a cache miss.
    }
  }
  return cached;
}

/**
 * Read the canonical, metadata-only storage inventory for one project root,
 * waiting for a walk only when no measurement exists yet.
 *
 * The inventory walks every managed root, which on a large project takes
 * about a minute. A fresh snapshot is served as-is. An expired snapshot of any
 * age is served immediately while one refresh runs in the background. Only a
 * cold cache blocks. The dashboard page uses `readStorageFootprintState`,
 * which never blocks.
 */
export async function readStorageFootprint(
  root = coordRoot(),
  options: StorageReadOptions = {},
): Promise<StorageFootprintReport> {
  const ctx = storageContext(root, options);
  const cached = await loadCachedFootprint(ctx, false);
  if (cached && ctx.now - cached.savedAt < ctx.cacheMs) return cached.report;
  const refresh = startStorageFootprintRefresh(ctx, false);
  if (!refresh) throw new Error("storage inventory refresh could not start");
  if (cached) {
    refresh.promise.catch((error: unknown) => logBackgroundFailure(cached.savedAt, error));
    return cached.report;
  }
  return refresh.promise;
}

export type StorageFootprintState =
  | {
      status: "ready";
      report: StorageFootprintReport;
      /** Epoch ms when the shown walk finished. */
      measuredAt: number;
      /** Older than the freshness window, or measured under other storage settings. */
      stale: boolean;
      /** The shown numbers predate a change to the storage catalog or policy. */
      settingsChanged: boolean;
      /** A walk is running now, in this process or a warm-handover peer. */
      refreshing: boolean;
      /** The most recent walk failed; cleared by the next success. */
      lastFailure: StorageRefreshFailure | null;
    }
  | { status: "measuring"; startedAt: number }
  | { status: "failed"; failure: StorageRefreshFailure; retryAt: number };

interface StateOptions extends StorageReadOptions {
  /** Start a walk even when the measurement is fresh or a recent walk failed. */
  force?: boolean;
  retryMs?: number;
}

/**
 * Never waits for a walk. Returns the newest measurement at once and starts at
 * most one background walk when it is older than the freshness window (five
 * minutes by default). With no measurement yet, it starts the walk and
 * reports `measuring`. After a failed walk, page views do not start another
 * for `retryMs`; `force` (the page's "Measure now") overrides both limits.
 */
export async function readStorageFootprintState(
  root = coordRoot(),
  options: StateOptions = {},
): Promise<StorageFootprintState> {
  return (await resolveStorageFootprintState(root, options)).state;
}

async function resolveStorageFootprintState(
  root: string,
  options: StateOptions,
): Promise<{ state: StorageFootprintState; ctx: StorageContext }> {
  const ctx = storageContext(root, options);
  const cached = await loadCachedFootprint(ctx, true);
  const fresh = Boolean(cached?.exactKey && ctx.now - cached.savedAt < ctx.cacheMs);
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const failure = cacheState.failures.get(ctx.key) ?? null;
  const backingOff = failure !== null && ctx.now - failure.at < retryMs;
  let running = cacheState.inFlight.get(ctx.key) ?? null;
  if (!running && (options.force || (!fresh && !backingOff))) {
    running = startStorageFootprintRefresh(ctx, true);
    running?.promise.catch((error: unknown) => logBackgroundFailure(cached?.savedAt, error));
  }
  const elsewhere = running
    ? null
    : readStorageRefreshLease(ctx.root, ctx.now, LEASE_STALE_MS, cacheState.inFlight.size > 0);
  const refreshing = running !== null || elsewhere !== null;
  let state: StorageFootprintState;
  if (cached) {
    state = {
      status: "ready",
      report: cached.report,
      measuredAt: cached.savedAt,
      stale: !fresh,
      settingsChanged: !cached.exactKey,
      refreshing,
      lastFailure: failure,
    };
  } else if (refreshing) {
    state = {
      status: "measuring",
      startedAt: running?.startedAt ?? elsewhere?.startedAt ?? ctx.now,
    };
  } else {
    const shown = failure ?? { at: ctx.now, message: "storage inventory has not run" };
    state = { status: "failed", failure: shown, retryAt: shown.at + retryMs };
  }
  return { state, ctx };
}

export type StorageRefreshOutcome =
  | { status: "measured"; measuredAt: number }
  | { status: "fresh"; measuredAt: number }
  | { status: "elsewhere" };

/**
 * Start (or join) a walk and wait for it to finish. Without `force`, a fresh
 * measurement returns at once. A walk held by a warm-handover peer cannot be
 * awaited here; the page's live refresh picks up its snapshot. A failed walk
 * rejects with its message.
 */
export async function refreshStorageFootprint(
  root = coordRoot(),
  options: StateOptions = {},
): Promise<StorageRefreshOutcome> {
  const { state, ctx } = await resolveStorageFootprintState(root, options);
  const running = cacheState.inFlight.get(ctx.key);
  if (running) {
    await running.promise;
    return { status: "measured", measuredAt: cacheState.cached?.savedAt ?? ctx.clock() };
  }
  if (state.status === "failed") throw new Error(state.failure.message);
  if (state.status === "measuring" || (state.status === "ready" && state.refreshing)) {
    return { status: "elsewhere" };
  }
  return { status: "fresh", measuredAt: state.measuredAt };
}

function logBackgroundFailure(savedAt: number | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    savedAt === undefined
      ? `[storage] background inventory refresh failed with no earlier snapshot: ${message}`
      : `[storage] background inventory refresh failed; serving the snapshot from ${new Date(savedAt).toISOString()}: ${message}`,
  );
}

/**
 * Start one walk for this key, or return the one already running. With
 * `useLease`, a walk held by another dashboard process blocks a second one and
 * this returns null. Starting is synchronous, so two renders in one process
 * cannot both start a walk.
 */
function startStorageFootprintRefresh(ctx: StorageContext, useLease: boolean): RefreshEntry | null {
  const { root, key, catalog, cacheMs, clock } = ctx;
  const existing = cacheState.inFlight.get(key);
  if (existing) return existing;
  let release = () => {};
  if (useLease && cacheMs > 0) {
    const lease = acquireStorageRefreshLease(
      root,
      ctx.now,
      LEASE_STALE_MS,
      cacheState.inFlight.size > 0,
    );
    if (!lease.acquired) return null;
    release = lease.release;
  }
  let pending: Promise<HarneryStorageInventoryReport>;
  try {
    pending = Promise.resolve(ctx.inventoryReader(root));
  } catch (error) {
    pending = Promise.reject(error);
  }
  const promise: Promise<StorageFootprintReport> = pending
    .then(async (inventory) => {
      if (!isStorageInventoryReport(inventory))
        throw new Error("storage inventory emitted an unsupported schema");
      const report = projectStorageFootprint(catalog, inventory);
      const savedAt = clock();
      if (cacheMs > 0 && cacheState.inFlight.get(key)?.promise === promise) {
        cacheState.cached = { key, savedAt, report };
        await writeStorageSnapshot(root, key, savedAt, inventory);
      }
      cacheState.failures.delete(key);
      return report;
    })
    .catch((error: unknown) => {
      cacheState.failures.set(key, {
        at: clock(),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => {
      if (cacheState.inFlight.get(key)?.promise === promise) cacheState.inFlight.delete(key);
      release();
    });
  const entry = { promise, startedAt: ctx.now };
  cacheState.inFlight.set(key, entry);
  return entry;
}

/** Clear the process-local snapshot when a test or host lifecycle resets roots. */
export function clearStorageFootprintCache(): void {
  cacheState.cached = null;
  cacheState.inFlight.clear();
  cacheState.failures.clear();
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
  if (!harneryBinPath(root)) {
    throw new Error("could not locate the Harnery CLI for storage inventory");
  }
  const harn = harnCommand(root, ["storage", "inventory", "--json"]);
  const { stdout } = await execFile(harn.command, harn.args, {
    cwd: root,
    env: harnChildEnv(root),
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    // The walk is metadata-only but a large `.harnery` (1M files measured
    // 2026-09-08) takes about 150 s; the refresh runs in the background, so
    // a generous ceiling costs nothing and a tight one kept the cache cold.
    timeout: 10 * 60_000,
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
