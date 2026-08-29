import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { acquireNoClobberLease } from "../workflow/workspaces/leases.ts";
import type { HarneryStorageCatalog } from "./catalog.ts";

export const HARNERY_MAINTENANCE_TRANSACTION_SCHEMA =
  "harnery.storage-maintenance-transaction/v1" as const;
export const HARNERY_MAINTENANCE_RECEIPT_SCHEMA = "harnery.storage-maintenance-receipt/v1" as const;
export const HARNERY_MAINTENANCE_CURSOR_SCHEMA = "harnery.storage-maintenance-cursor/v1" as const;
export const HARNERY_MAINTENANCE_PRESSURE_SCHEMA = "harnery.storage-pressure/v1" as const;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const DEFAULT_STALE_MS = 10 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface HarneryMaintenanceBudget {
  max_duration_ms: number;
  max_files: number;
  max_bytes: number;
}

export interface HarneryStoragePressureFamily {
  family_id: string;
  logical_bytes: number;
  regular_files: number;
  needs_maintenance: boolean;
  observed_at: string;
}

export interface HarneryStoragePressureSummary {
  schema: typeof HARNERY_MAINTENANCE_PRESSURE_SCHEMA;
  captured_at: string;
  families: readonly HarneryStoragePressureFamily[];
}

export interface HarneryMaintenanceAction {
  action_id: string;
  family_id: string;
  kind: string;
  target_ref: string;
  files: number;
  bytes: number;
  destructive: boolean;
  expected_sha256?: string;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface HarneryMaintenanceProviderPlan {
  actions: readonly HarneryMaintenanceAction[];
  next_cursor?: string;
}

export interface HarneryMaintenanceProvider {
  family_id: string;
  budget?: Partial<HarneryMaintenanceBudget>;
  plan(input: {
    coord_root: string;
    pressure: HarneryStoragePressureFamily;
    cursor?: string;
    budget: HarneryMaintenanceBudget;
    now: Date;
  }): HarneryMaintenanceProviderPlan | Promise<HarneryMaintenanceProviderPlan>;
  apply(input: {
    coord_root: string;
    transaction_id: string;
    action: HarneryMaintenanceAction;
    now: Date;
  }): HarneryMaintenanceMutation | Promise<HarneryMaintenanceMutation>;
}

export interface HarneryMaintenanceMutation {
  outcome: "applied" | "already_applied" | "refused";
  output_sha256?: string;
  detail?: string;
}

export interface HarneryMaintenanceTransaction {
  schema: typeof HARNERY_MAINTENANCE_TRANSACTION_SCHEMA;
  transaction_id: string;
  created_at: string;
  updated_at: string;
  state: "planned" | "running" | "committed" | "refused" | "failed";
  dry_run: boolean;
  catalog_policies: Readonly<Record<string, string>>;
  budget: HarneryMaintenanceBudget;
  actions: readonly HarneryMaintenanceAction[];
  next_cursors: Readonly<Record<string, string>>;
  reason_codes: readonly string[];
}

export interface HarneryMaintenanceReceipt {
  schema: typeof HARNERY_MAINTENANCE_RECEIPT_SCHEMA;
  transaction_id: string;
  action_id: string;
  family_id: string;
  action_sha256: string;
  outcome: HarneryMaintenanceMutation["outcome"];
  output_sha256?: string;
  detail?: string;
  committed_at: string;
}

export interface HarneryAutomaticMaintenanceResult {
  ran: boolean;
  reason: "disabled" | "no-pressure" | "fresh" | "contended" | "planned" | "committed";
  transaction_id?: string;
  actions: number;
  files: number;
  bytes: number;
}

export const DEFAULT_MAINTENANCE_BUDGET: HarneryMaintenanceBudget = Object.freeze({
  max_duration_ms: 1_500,
  max_files: 250,
  max_bytes: 64 * 1024 * 1024,
});

export async function planStorageMaintenance(
  catalog: HarneryStorageCatalog,
  providers: readonly HarneryMaintenanceProvider[],
  pressure: HarneryStoragePressureSummary,
  options: {
    now?: Date;
    budget?: HarneryMaintenanceBudget;
    family_id?: string;
    persist?: boolean;
    transaction_id?: string;
  } = {},
): Promise<HarneryMaintenanceTransaction> {
  const now = options.now ?? new Date();
  assertDate(now);
  const budget = validateBudget(options.budget ?? DEFAULT_MAINTENANCE_BUDGET);
  validatePressure(pressure);
  const providerMap = providerRegistry(catalog, providers);
  if (options.family_id && !catalog.get(options.family_id)) {
    throw new HarneryMaintenanceError(
      "unknown_family",
      `unknown storage family: ${options.family_id}`,
    );
  }
  const started = Date.now();
  const actions: HarneryMaintenanceAction[] = [];
  const nextCursors: Record<string, string> = {};
  const reasons = new Set<string>();
  for (const row of pressure.families) {
    if (!row.needs_maintenance || (options.family_id && row.family_id !== options.family_id))
      continue;
    const provider = providerMap.get(row.family_id);
    if (!provider) {
      reasons.add(`provider_unavailable:${row.family_id}`);
      continue;
    }
    const family = catalog.require(row.family_id);
    if (family.provider.maintenance !== "storage") {
      reasons.add(`maintenance_not_storage_owned:${row.family_id}`);
      continue;
    }
    const remaining = remainingBudget(budget, actions, started);
    if (remaining.max_duration_ms <= 0 || remaining.max_files <= 0 || remaining.max_bytes <= 0) {
      reasons.add("global_budget_exhausted");
      break;
    }
    const cursor = readFamilyCursor(catalog.context.coord_root, row.family_id);
    const providerBudget = intersectBudget(remaining, provider.budget);
    const providerActions: HarneryMaintenanceAction[] = [];
    const planned = await provider.plan({
      coord_root: catalog.context.coord_root,
      pressure: row,
      cursor,
      budget: providerBudget,
      now,
    });
    if (planned.next_cursor !== undefined)
      nextCursors[row.family_id] = boundedCursor(planned.next_cursor);
    for (const action of planned.actions) {
      validateAction(action, row.family_id);
      if (
        !fitsBudget(action, budget, actions, started) ||
        !fitsBudget(action, providerBudget, providerActions, started)
      ) {
        reasons.add("global_budget_exhausted");
        break;
      }
      actions.push(structuredClone(action));
      providerActions.push(action);
    }
  }
  const transaction: HarneryMaintenanceTransaction = {
    schema: HARNERY_MAINTENANCE_TRANSACTION_SCHEMA,
    transaction_id:
      options.transaction_id ?? `maint-${now.toISOString().slice(0, 10)}-${randomUUID()}`,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    state: "planned",
    dry_run: true,
    catalog_policies: Object.fromEntries(
      [...new Set(actions.map(({ family_id }) => family_id))].map((familyId) => [
        familyId,
        catalog.require(familyId).policy.policy_version,
      ]),
    ),
    budget,
    actions,
    next_cursors: nextCursors,
    reason_codes: [...reasons].sort(),
  };
  validateTransaction(transaction);
  if (options.persist) writeTransaction(catalog.context.coord_root, transaction, false);
  return transaction;
}

export async function executeStorageMaintenance(
  catalog: HarneryStorageCatalog,
  providers: readonly HarneryMaintenanceProvider[],
  transactionId: string,
  options: { yes: boolean; now?: Date; allow_destructive?: boolean },
): Promise<HarneryMaintenanceTransaction> {
  if (!options.yes) {
    throw new HarneryMaintenanceError(
      "confirmation_required",
      "maintenance execution requires the exact transaction id and --yes",
    );
  }
  const now = options.now ?? new Date();
  assertDate(now);
  const transaction = readMaintenanceTransaction(catalog.context.coord_root, transactionId);
  if (transaction.transaction_id !== transactionId) {
    throw new HarneryMaintenanceError(
      "transaction_mismatch",
      "transaction id does not match its record",
    );
  }
  if (transaction.state === "committed") return transaction;
  for (const [familyId, version] of Object.entries(transaction.catalog_policies)) {
    if (catalog.require(familyId).policy.policy_version !== version) {
      throw new HarneryMaintenanceError("policy_changed", `storage policy changed for ${familyId}`);
    }
  }
  if (transaction.actions.some(({ destructive }) => destructive) && !options.allow_destructive) {
    const refused = updateTransaction(transaction, now, "refused", [
      ...transaction.reason_codes,
      "destructive_activation_required",
    ]);
    writeTransaction(catalog.context.coord_root, refused, true);
    throw new HarneryMaintenanceError(
      "destructive_activation_required",
      "destructive maintenance is inactive; a separate policy decision and activation are required",
    );
  }
  const providerMap = providerRegistry(catalog, providers);
  let current = updateTransaction(transaction, now, "running");
  writeTransaction(catalog.context.coord_root, current, true);
  try {
    for (const action of current.actions) {
      const existing = readReceipt(catalog.context.coord_root, current.transaction_id, action);
      if (existing) continue;
      const provider = providerMap.get(action.family_id);
      if (!provider) throw new HarneryMaintenanceError("provider_unavailable", action.family_id);
      const mutation = await provider.apply({
        coord_root: catalog.context.coord_root,
        transaction_id: current.transaction_id,
        action,
        now,
      });
      writeReceipt(catalog.context.coord_root, current.transaction_id, action, mutation, now);
    }
    for (const [familyId, cursor] of Object.entries(current.next_cursors)) {
      writeFamilyCursor(catalog.context.coord_root, familyId, cursor, now);
    }
    current = updateTransaction(current, now, "committed");
    writeTransaction(catalog.context.coord_root, current, true);
    writeRunOutcome(catalog.context.coord_root, current, now);
    return current;
  } catch (error) {
    current = updateTransaction(current, now, "failed", [
      ...current.reason_codes,
      error instanceof HarneryMaintenanceError ? error.code : "provider_failed",
    ]);
    writeTransaction(catalog.context.coord_root, current, true);
    writeRunOutcome(catalog.context.coord_root, current, now);
    throw error;
  }
}

export async function runAutomaticMaintenanceSlice(
  catalog: HarneryStorageCatalog,
  providers: readonly HarneryMaintenanceProvider[],
  options: { now?: Date; budget?: HarneryMaintenanceBudget; execute?: boolean } = {},
): Promise<HarneryAutomaticMaintenanceResult> {
  const now = options.now ?? new Date();
  assertDate(now);
  const coordRoot = catalog.context.coord_root;
  if (maintenanceDisabled(coordRoot)) return emptyAutomatic("disabled");
  const pressure = readPressureSummary(coordRoot);
  if (!pressure?.families.some(({ needs_maintenance }) => needs_maintenance)) {
    return emptyAutomatic("no-pressure");
  }
  const cursor = readDailyCursor(coordRoot);
  if (cursor?.state === "complete" && now.getTime() - Date.parse(cursor.claimed_at) < DAY_MS) {
    return emptyAutomatic("fresh");
  }
  const leasePath = join(resolve(coordRoot), ".harnery", "maintenance", "cursors", "daily-lease");
  let lease: ReturnType<typeof acquireNoClobberLease>;
  try {
    lease = acquireNoClobberLease({
      path: leasePath,
      scope: "storage-maintenance-daily",
      authoritySha256: sha256(JSON.stringify(pressure)),
      staleAfterMs: DEFAULT_STALE_MS,
      now: () => now.getTime(),
    });
  } catch {
    return emptyAutomatic("contended");
  }
  try {
    const refreshed = readDailyCursor(coordRoot);
    if (
      refreshed?.state === "complete" &&
      now.getTime() - Date.parse(refreshed.claimed_at) < DAY_MS
    ) {
      return emptyAutomatic("fresh");
    }
    if (refreshed?.state === "running" && refreshed.transaction_id) {
      const resumed = options.execute
        ? await executeStorageMaintenance(catalog, providers, refreshed.transaction_id, {
            yes: true,
            now,
            allow_destructive: false,
          })
        : readMaintenanceTransaction(coordRoot, refreshed.transaction_id);
      if (resumed.state === "committed")
        writeDailyCursor(coordRoot, now, "complete", resumed.transaction_id);
      return automaticResult(resumed, resumed.state === "committed" ? "committed" : "planned");
    }
    const transactionId = `auto-${now.toISOString().slice(0, 10)}-${randomUUID()}`;
    writeDailyCursor(coordRoot, now, "running", transactionId);
    const transaction = await planStorageMaintenance(catalog, providers, pressure, {
      now,
      budget: options.budget,
      persist: true,
      transaction_id: transactionId,
    });
    if (!options.execute || transaction.actions.length === 0) {
      writeDailyCursor(coordRoot, now, "complete", transaction.transaction_id);
      return automaticResult(transaction, "planned");
    }
    const committed = await executeStorageMaintenance(
      catalog,
      providers,
      transaction.transaction_id,
      {
        yes: true,
        now,
        allow_destructive: false,
      },
    );
    writeDailyCursor(coordRoot, now, "complete", committed.transaction_id);
    return automaticResult(committed, "committed");
  } finally {
    lease.release();
  }
}

export function readMaintenanceTransaction(
  coordRoot: string,
  transactionId: string,
): HarneryMaintenanceTransaction {
  assertSafeId(transactionId, "transaction id");
  const path = transactionPath(coordRoot, transactionId);
  const value = readJsonFile(path) as HarneryMaintenanceTransaction;
  validateTransaction(value);
  return value;
}

export function listMaintenanceTransactions(coordRoot: string): HarneryMaintenanceTransaction[] {
  const root = transactionsRoot(coordRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".json") && SAFE_ID.test(name.slice(0, -5)))
    .map((name) => readMaintenanceTransaction(coordRoot, name.slice(0, -5)))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export function writePressureSummary(
  coordRoot: string,
  summary: HarneryStoragePressureSummary,
): void {
  validatePressure(summary);
  atomicJson(pressurePath(coordRoot), summary, true);
}

export function readPressureSummary(coordRoot: string): HarneryStoragePressureSummary | undefined {
  const path = pressurePath(coordRoot);
  if (!existsSync(path)) return undefined;
  const summary = readJsonFile(path) as HarneryStoragePressureSummary;
  validatePressure(summary);
  return summary;
}

function providerRegistry(
  catalog: HarneryStorageCatalog,
  providers: readonly HarneryMaintenanceProvider[],
): Map<string, HarneryMaintenanceProvider> {
  const result = new Map<string, HarneryMaintenanceProvider>();
  for (const provider of providers) {
    assertSafeId(provider.family_id, "maintenance provider family id");
    if (!catalog.get(provider.family_id))
      throw new HarneryMaintenanceError("unknown_family", provider.family_id);
    if (result.has(provider.family_id))
      throw new HarneryMaintenanceError("duplicate_provider", provider.family_id);
    if (provider.budget) intersectBudget(DEFAULT_MAINTENANCE_BUDGET, provider.budget);
    result.set(provider.family_id, provider);
  }
  return result;
}

function validateAction(action: HarneryMaintenanceAction, expectedFamily: string): void {
  assertSafeId(action.action_id, "action id");
  assertSafeId(action.family_id, "action family id");
  if (action.family_id !== expectedFamily)
    throw new HarneryMaintenanceError("action_family_mismatch", action.action_id);
  if (
    !SAFE_ID.test(action.kind) ||
    typeof action.target_ref !== "string" ||
    action.target_ref.length > 512
  ) {
    throw new HarneryMaintenanceError("invalid_action", action.action_id);
  }
  if (
    !Number.isSafeInteger(action.files) ||
    action.files < 0 ||
    !Number.isSafeInteger(action.bytes) ||
    action.bytes < 0
  ) {
    throw new HarneryMaintenanceError("invalid_action_budget", action.action_id);
  }
  if (action.expected_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(action.expected_sha256)) {
    throw new HarneryMaintenanceError("invalid_action_digest", action.action_id);
  }
}

function validateTransaction(value: HarneryMaintenanceTransaction): void {
  if (value?.schema !== HARNERY_MAINTENANCE_TRANSACTION_SCHEMA)
    throw new HarneryMaintenanceError("invalid_transaction", "schema");
  assertSafeId(value.transaction_id, "transaction id");
  assertDate(new Date(value.created_at));
  assertDate(new Date(value.updated_at));
  validateBudget(value.budget);
  if (!Array.isArray(value.actions) || !Array.isArray(value.reason_codes))
    throw new HarneryMaintenanceError("invalid_transaction", "arrays");
  for (const action of value.actions) validateAction(action, action.family_id);
  if (new Set(value.actions.map(({ action_id }) => action_id)).size !== value.actions.length) {
    throw new HarneryMaintenanceError("duplicate_action", value.transaction_id);
  }
}

function validatePressure(value: HarneryStoragePressureSummary): void {
  if (value?.schema !== HARNERY_MAINTENANCE_PRESSURE_SCHEMA || !Array.isArray(value.families)) {
    throw new HarneryMaintenanceError("invalid_pressure_summary", "unsupported pressure summary");
  }
  assertDate(new Date(value.captured_at));
  for (const row of value.families) {
    assertSafeId(row.family_id, "pressure family id");
    if (
      !Number.isSafeInteger(row.logical_bytes) ||
      row.logical_bytes < 0 ||
      !Number.isSafeInteger(row.regular_files) ||
      row.regular_files < 0
    ) {
      throw new HarneryMaintenanceError("invalid_pressure_summary", row.family_id);
    }
    assertDate(new Date(row.observed_at));
  }
}

function readReceipt(
  coordRoot: string,
  transactionId: string,
  action: HarneryMaintenanceAction,
): HarneryMaintenanceReceipt | undefined {
  const path = receiptPath(coordRoot, transactionId, action.action_id);
  if (!existsSync(path)) return undefined;
  const receipt = readJsonFile(path) as HarneryMaintenanceReceipt;
  if (
    receipt.schema !== HARNERY_MAINTENANCE_RECEIPT_SCHEMA ||
    receipt.transaction_id !== transactionId ||
    receipt.action_id !== action.action_id ||
    receipt.action_sha256 !== sha256(stableJson(action))
  ) {
    throw new HarneryMaintenanceError("receipt_mismatch", action.action_id);
  }
  return receipt;
}

function writeReceipt(
  coordRoot: string,
  transactionId: string,
  action: HarneryMaintenanceAction,
  mutation: HarneryMaintenanceMutation,
  now: Date,
): void {
  const receipt: HarneryMaintenanceReceipt = {
    schema: HARNERY_MAINTENANCE_RECEIPT_SCHEMA,
    transaction_id: transactionId,
    action_id: action.action_id,
    family_id: action.family_id,
    action_sha256: sha256(stableJson(action)),
    outcome: mutation.outcome,
    output_sha256: mutation.output_sha256,
    detail: mutation.detail,
    committed_at: now.toISOString(),
  };
  const path = receiptPath(coordRoot, transactionId, action.action_id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeExclusiveDurable(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

function writeTransaction(
  coordRoot: string,
  transaction: HarneryMaintenanceTransaction,
  replace: boolean,
): void {
  validateTransaction(transaction);
  const path = transactionPath(coordRoot, transaction.transaction_id);
  if (!replace && existsSync(path))
    throw new HarneryMaintenanceError("transaction_exists", transaction.transaction_id);
  atomicJson(path, transaction, true);
}

function updateTransaction(
  transaction: HarneryMaintenanceTransaction,
  now: Date,
  state: HarneryMaintenanceTransaction["state"],
  reasonCodes = transaction.reason_codes,
): HarneryMaintenanceTransaction {
  return {
    ...transaction,
    updated_at: now.toISOString(),
    state,
    dry_run: state === "planned",
    reason_codes: [...new Set(reasonCodes)].sort(),
  };
}

function writeRunOutcome(
  coordRoot: string,
  transaction: HarneryMaintenanceTransaction,
  now: Date,
): void {
  const root = join(resolve(coordRoot), ".harnery", "logs", "storage-maintenance");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const active = join(root, "active.jsonl");
  if (existsSync(active) && statSync(active).size > 1_048_576) {
    renameSync(active, join(root, `sealed-${now.toISOString().replaceAll(/[:.]/g, "-")}.jsonl`));
  }
  appendFileSync(
    active,
    `${JSON.stringify({ ts: now.toISOString(), transaction_id: transaction.transaction_id, state: transaction.state, actions: transaction.actions.length, files: transaction.actions.reduce((n, action) => n + action.files, 0), bytes: transaction.actions.reduce((n, action) => n + action.bytes, 0), reason_codes: transaction.reason_codes })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

interface DailyCursor {
  schema: typeof HARNERY_MAINTENANCE_CURSOR_SCHEMA;
  state: "running" | "complete";
  claimed_at: string;
  transaction_id: string;
}

function readDailyCursor(coordRoot: string): DailyCursor | undefined {
  const path = join(resolve(coordRoot), ".harnery", "maintenance", "cursors", "daily.json");
  if (!existsSync(path)) return undefined;
  const cursor = readJsonFile(path) as DailyCursor;
  if (cursor.schema !== HARNERY_MAINTENANCE_CURSOR_SCHEMA || !SAFE_ID.test(cursor.transaction_id)) {
    throw new HarneryMaintenanceError("invalid_cursor", "daily cursor");
  }
  return cursor;
}

function writeDailyCursor(
  coordRoot: string,
  now: Date,
  state: DailyCursor["state"],
  transactionId: string,
): void {
  atomicJson(
    join(resolve(coordRoot), ".harnery", "maintenance", "cursors", "daily.json"),
    {
      schema: HARNERY_MAINTENANCE_CURSOR_SCHEMA,
      state,
      claimed_at: now.toISOString(),
      transaction_id: transactionId,
    },
    true,
  );
}

function readFamilyCursor(coordRoot: string, familyId: string): string | undefined {
  const path = join(resolve(coordRoot), ".harnery", "maintenance", "cursors", `${familyId}.json`);
  if (!existsSync(path)) return undefined;
  const value = readJsonFile(path) as { schema?: string; cursor?: string };
  return value.schema === HARNERY_MAINTENANCE_CURSOR_SCHEMA && typeof value.cursor === "string"
    ? boundedCursor(value.cursor)
    : undefined;
}

function writeFamilyCursor(coordRoot: string, familyId: string, cursor: string, now: Date): void {
  atomicJson(
    join(resolve(coordRoot), ".harnery", "maintenance", "cursors", `${familyId}.json`),
    {
      schema: HARNERY_MAINTENANCE_CURSOR_SCHEMA,
      family_id: familyId,
      cursor: boundedCursor(cursor),
      updated_at: now.toISOString(),
    },
    true,
  );
}

function maintenanceDisabled(coordRoot: string): boolean {
  const env = process.env.HARNERY_STORAGE_MAINTENANCE?.toLowerCase();
  return (
    env === "0" ||
    env === "false" ||
    existsSync(join(resolve(coordRoot), ".harnery", "maintenance.disabled"))
  );
}

function remainingBudget(
  budget: HarneryMaintenanceBudget,
  actions: readonly HarneryMaintenanceAction[],
  started: number,
): HarneryMaintenanceBudget {
  return {
    max_duration_ms: Math.max(0, budget.max_duration_ms - (Date.now() - started)),
    max_files: Math.max(0, budget.max_files - actions.reduce((n, action) => n + action.files, 0)),
    max_bytes: Math.max(0, budget.max_bytes - actions.reduce((n, action) => n + action.bytes, 0)),
  };
}

function fitsBudget(
  action: HarneryMaintenanceAction,
  budget: HarneryMaintenanceBudget,
  actions: readonly HarneryMaintenanceAction[],
  started: number,
): boolean {
  const remaining = remainingBudget(budget, actions, started);
  return (
    remaining.max_duration_ms > 0 &&
    action.files <= remaining.max_files &&
    action.bytes <= remaining.max_bytes
  );
}

function validateBudget(value: HarneryMaintenanceBudget): HarneryMaintenanceBudget {
  for (const [key, amount] of Object.entries(value)) {
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new HarneryMaintenanceError("invalid_budget", key);
  }
  return { ...value };
}

function intersectBudget(
  global: HarneryMaintenanceBudget,
  provider: Partial<HarneryMaintenanceBudget> | undefined,
): HarneryMaintenanceBudget {
  const result = {
    max_duration_ms: Math.min(
      global.max_duration_ms,
      provider?.max_duration_ms ?? global.max_duration_ms,
    ),
    max_files: Math.min(global.max_files, provider?.max_files ?? global.max_files),
    max_bytes: Math.min(global.max_bytes, provider?.max_bytes ?? global.max_bytes),
  };
  return validateBudget(result);
}

function boundedCursor(value: string): string {
  if (value.length === 0 || value.length > 2_048)
    throw new HarneryMaintenanceError("invalid_cursor", "family cursor");
  return value;
}

function automaticResult(
  transaction: HarneryMaintenanceTransaction,
  reason: "planned" | "committed",
): HarneryAutomaticMaintenanceResult {
  return {
    ran: true,
    reason,
    transaction_id: transaction.transaction_id,
    actions: transaction.actions.length,
    files: transaction.actions.reduce((n, action) => n + action.files, 0),
    bytes: transaction.actions.reduce((n, action) => n + action.bytes, 0),
  };
}

function emptyAutomatic(
  reason: HarneryAutomaticMaintenanceResult["reason"],
): HarneryAutomaticMaintenanceResult {
  return { ran: false, reason, actions: 0, files: 0, bytes: 0 };
}

function transactionsRoot(coordRoot: string): string {
  return join(resolve(coordRoot), ".harnery", "maintenance", "transactions");
}

function transactionPath(coordRoot: string, transactionId: string): string {
  assertSafeId(transactionId, "transaction id");
  return join(transactionsRoot(coordRoot), `${transactionId}.json`);
}

function receiptPath(coordRoot: string, transactionId: string, actionId: string): string {
  assertSafeId(transactionId, "transaction id");
  assertSafeId(actionId, "action id");
  return join(
    resolve(coordRoot),
    ".harnery",
    "maintenance",
    "receipts",
    transactionId,
    `${actionId}.json`,
  );
}

function pressurePath(coordRoot: string): string {
  return join(resolve(coordRoot), ".harnery", "maintenance", "pressure.json");
}

function readJsonFile(path: string): unknown {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_JSON_BYTES
  ) {
    throw new HarneryMaintenanceError("unsafe_state_file", basename(path));
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomicJson(path: string, value: unknown, fsync: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (fsync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function writeExclusiveDurable(path: string, value: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeId(value: string, label: string): void {
  if (typeof value !== "string" || !SAFE_ID.test(value))
    throw new HarneryMaintenanceError("invalid_id", label);
}

function assertDate(value: Date): void {
  if (!Number.isFinite(value.getTime()))
    throw new HarneryMaintenanceError("invalid_time", "invalid timestamp");
}

export class HarneryMaintenanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarneryMaintenanceError";
  }
}
