import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  HARNERY_MAINTENANCE_RECEIPT_SCHEMA,
  HarneryMaintenanceError,
  type HarneryMaintenanceReceipt,
} from "./maintenance.ts";

export const HARNERY_RECEIPT_SEGMENT_MANIFEST_SCHEMA =
  "harnery.storage-maintenance-receipt-segment/v1" as const;

export interface HarneryReceiptConsolidationPlan {
  schema: typeof HARNERY_RECEIPT_SEGMENT_MANIFEST_SCHEMA;
  segment_id: string;
  created_at: string;
  source_count: number;
  source_bytes: number;
  source_paths_sha256: string;
  payload_sha256: string;
  payload_bytes: number;
  applied: boolean;
}

/**
 * Losslessly packs immutable maintenance receipts. The default is a pure plan;
 * source replacement requires both an exact consolidation id and `yes`.
 */
export function consolidateMutationReceipts(
  coordRoot: string,
  options: {
    now?: Date;
    threshold?: number;
    yes?: boolean;
    consolidation_id?: string;
  } = {},
): HarneryReceiptConsolidationPlan | undefined {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new HarneryMaintenanceError("invalid_time", "receipt consolidation");
  const threshold = options.threshold ?? 1_000;
  if (!Number.isSafeInteger(threshold) || threshold <= 1) {
    throw new HarneryMaintenanceError("invalid_threshold", "receipt consolidation threshold");
  }
  const root = join(resolve(coordRoot), ".harnery", "maintenance", "receipts");
  if (!existsSync(root)) return undefined;
  const files = receiptFiles(root);
  if (files.length < threshold) return undefined;
  const rows = files.map((path) => readReceipt(path));
  const payload = `${rows.map(({ receipt }) => JSON.stringify(receipt)).join("\n")}\n`;
  const relativePaths = rows.map(({ path }) => relative(root, path).split(sep).join("/")).sort();
  const segmentId =
    options.consolidation_id ?? `receipts-${now.toISOString().slice(0, 10)}-${randomUUID()}`;
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(segmentId)) {
    throw new HarneryMaintenanceError("invalid_id", "receipt consolidation id");
  }
  const plan: HarneryReceiptConsolidationPlan = {
    schema: HARNERY_RECEIPT_SEGMENT_MANIFEST_SCHEMA,
    segment_id: segmentId,
    created_at: now.toISOString(),
    source_count: rows.length,
    source_bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    source_paths_sha256: sha256(`${relativePaths.join("\n")}\n`),
    payload_sha256: sha256(payload),
    payload_bytes: Buffer.byteLength(payload),
    applied: false,
  };
  if (!options.yes) return plan;
  if (options.consolidation_id !== segmentId) {
    throw new HarneryMaintenanceError(
      "confirmation_required",
      "receipt replacement requires an exact consolidation id and --yes",
    );
  }
  const segments = join(root, "segments");
  mkdirSync(segments, { recursive: true, mode: 0o700 });
  const payloadPath = join(segments, `${segmentId}.jsonl`);
  const manifestPath = join(segments, `${segmentId}.manifest.json`);
  writeExclusiveDurable(payloadPath, payload);
  const observed = readFileSync(payloadPath);
  if (observed.byteLength !== plan.payload_bytes || sha256(observed) !== plan.payload_sha256) {
    throw new HarneryMaintenanceError("receipt_segment_mismatch", segmentId);
  }
  const committed = { ...plan, applied: true };
  writeExclusiveDurable(manifestPath, `${JSON.stringify(committed, null, 2)}\n`);
  for (const row of rows) {
    const current = readReceipt(row.path);
    if (current.digest !== row.digest) {
      throw new HarneryMaintenanceError("receipt_changed", relative(root, row.path));
    }
  }
  for (const row of rows) unlinkSync(row.path);
  return committed;
}

function receiptFiles(root: string): string[] {
  const result: string[] = [];
  for (const transaction of readdirSync(root, { withFileTypes: true })) {
    if (transaction.name === "segments") continue;
    const transactionPath = join(root, transaction.name);
    const transactionStat = lstatSync(transactionPath);
    if (!transaction.isDirectory() || transactionStat.isSymbolicLink()) continue;
    for (const file of readdirSync(transactionPath, { withFileTypes: true })) {
      if (!file.name.endsWith(".json")) continue;
      result.push(join(transactionPath, file.name));
    }
  }
  return result.sort();
}

function readReceipt(path: string): {
  path: string;
  bytes: number;
  digest: string;
  receipt: HarneryMaintenanceReceipt;
} {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 256 * 1_024) {
    throw new HarneryMaintenanceError("unsafe_receipt", path);
  }
  const bytes = readFileSync(path);
  const receipt = JSON.parse(bytes.toString("utf8")) as HarneryMaintenanceReceipt;
  if (
    receipt.schema !== HARNERY_MAINTENANCE_RECEIPT_SCHEMA ||
    typeof receipt.transaction_id !== "string" ||
    typeof receipt.action_id !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.action_sha256)
  ) {
    throw new HarneryMaintenanceError("invalid_receipt", path);
  }
  return { path, bytes: bytes.byteLength, digest: sha256(bytes), receipt };
}

function writeExclusiveDurable(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(path)) throw new HarneryMaintenanceError("segment_exists", path);
  renameSync(temporary, path);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
