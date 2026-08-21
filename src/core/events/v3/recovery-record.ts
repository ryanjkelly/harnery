import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJsonV3 } from "./canonical.ts";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RECOVERY_ID_PATTERN = /^rcv_[a-f0-9]{32}$/;

export interface EventV3RecoveryDiagnostic {
  code: string;
  segment_ordinal: number;
  byte_offset: number;
  event_id?: string;
}

export interface EventV3RecoveryFailure {
  control_reason: string;
  authority_digest: `sha256:${string}`;
  active_digest: `sha256:${string}`;
  active_bytes: number;
  validated_prefix_digest: `sha256:${string}`;
  validated_prefix_bytes: number;
  diagnostic: EventV3RecoveryDiagnostic;
}

export interface EventV3RecoveryIntent {
  format: "harnery-event-v3-recovery-intent";
  format_version: 1;
  recovery_id: `rcv_${string}`;
  created_at: string;
  approval_record_id: string;
  harnery_build: string;
  host_build: string;
  config_digest: `sha256:${string}`;
  failure: EventV3RecoveryFailure;
}

export interface EventV3RecoveryReceipt {
  format: "harnery-event-v3-recovery-receipt";
  format_version: 1;
  recovery_id: `rcv_${string}`;
  created_at: string;
  completed_at: string;
  approval_record_id: string;
  failure: EventV3RecoveryFailure;
  archive_directory: string;
  new_authority: {
    genesis_id: string;
    activation_id: string;
  };
}

export function eventV3RecoveryRecordsRoot(coordRoot: string): string {
  return join(resolve(coordRoot), ".harnery", "ledgers", "v3-recoveries");
}

export function listEventV3RecoveryReceipts(coordRoot: string): EventV3RecoveryReceipt[] {
  const root = eventV3RecoveryRecordsRoot(coordRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".committed.json"))
    .sort()
    .map((name) => readEventV3RecoveryReceipt(join(root, name)));
}

export function readEventV3RecoveryIntent(path: string): EventV3RecoveryIntent {
  return readCanonicalRecord(path, validateIntent, "V3 recovery intent");
}

export function readEventV3RecoveryReceipt(path: string): EventV3RecoveryReceipt {
  return readCanonicalRecord(path, validateReceipt, "V3 recovery receipt");
}

export function validateEventV3RecoveryIntent(value: unknown): EventV3RecoveryIntent {
  return validateIntent(value);
}

export function validateEventV3RecoveryReceipt(value: unknown): EventV3RecoveryReceipt {
  return validateReceipt(value);
}

function readCanonicalRecord<T>(path: string, validate: (value: unknown) => T, label: string): T {
  let text: string;
  let parsed: unknown;
  try {
    text = readFileSync(path, "utf8");
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is missing or malformed`);
  }
  const value = validate(parsed);
  if (text !== `${canonicalJsonV3(value)}\n`) throw new Error(`${label} is not canonical`);
  return value;
}

function validateIntent(value: unknown): EventV3RecoveryIntent {
  const record = object(value, "V3 recovery intent is invalid");
  exactKeys(
    record,
    [
      "approval_record_id",
      "config_digest",
      "created_at",
      "failure",
      "format",
      "format_version",
      "harnery_build",
      "host_build",
      "recovery_id",
    ],
    "V3 recovery intent",
  );
  if (
    record.format !== "harnery-event-v3-recovery-intent" ||
    record.format_version !== 1 ||
    !recoveryId(record.recovery_id) ||
    !timestamp(record.created_at) ||
    !safeText(record.approval_record_id, 200) ||
    !safeText(record.harnery_build, 120) ||
    !safeText(record.host_build, 120) ||
    !sha256(record.config_digest)
  ) {
    throw new Error("V3 recovery intent values are invalid");
  }
  return {
    ...(record as unknown as EventV3RecoveryIntent),
    failure: validateFailure(record.failure),
  };
}

function validateReceipt(value: unknown): EventV3RecoveryReceipt {
  const record = object(value, "V3 recovery receipt is invalid");
  exactKeys(
    record,
    [
      "approval_record_id",
      "archive_directory",
      "completed_at",
      "created_at",
      "failure",
      "format",
      "format_version",
      "new_authority",
      "recovery_id",
    ],
    "V3 recovery receipt",
  );
  const authority = object(record.new_authority, "V3 recovery new authority is invalid");
  exactKeys(authority, ["activation_id", "genesis_id"], "V3 recovery new authority");
  if (
    record.format !== "harnery-event-v3-recovery-receipt" ||
    record.format_version !== 1 ||
    !recoveryId(record.recovery_id) ||
    !timestamp(record.created_at) ||
    !timestamp(record.completed_at) ||
    Date.parse(String(record.completed_at)) < Date.parse(String(record.created_at)) ||
    !safeText(record.approval_record_id, 200) ||
    typeof record.archive_directory !== "string" ||
    !/^epoch-[0-9]+(?:-[0-9]+)?$/.test(record.archive_directory) ||
    typeof authority.genesis_id !== "string" ||
    !/^gex_[a-zA-Z0-9._-]+$/.test(authority.genesis_id) ||
    typeof authority.activation_id !== "string" ||
    !/^act_[a-zA-Z0-9._-]+$/.test(authority.activation_id)
  ) {
    throw new Error("V3 recovery receipt values are invalid");
  }
  return {
    ...(record as unknown as EventV3RecoveryReceipt),
    failure: validateFailure(record.failure),
    new_authority: authority as unknown as EventV3RecoveryReceipt["new_authority"],
  };
}

function validateFailure(value: unknown): EventV3RecoveryFailure {
  const record = object(value, "V3 recovery failure is invalid");
  exactKeys(
    record,
    [
      "active_bytes",
      "active_digest",
      "authority_digest",
      "control_reason",
      "diagnostic",
      "validated_prefix_bytes",
      "validated_prefix_digest",
    ],
    "V3 recovery failure",
  );
  const diagnostic = object(record.diagnostic, "V3 recovery diagnostic is invalid");
  const diagnosticKeys =
    diagnostic.event_id === undefined
      ? ["byte_offset", "code", "segment_ordinal"]
      : ["byte_offset", "code", "event_id", "segment_ordinal"];
  exactKeys(diagnostic, diagnosticKeys, "V3 recovery diagnostic");
  if (
    !safeText(record.control_reason, 120) ||
    !sha256(record.authority_digest) ||
    !sha256(record.active_digest) ||
    !nonnegativeInteger(record.active_bytes) ||
    !sha256(record.validated_prefix_digest) ||
    !nonnegativeInteger(record.validated_prefix_bytes) ||
    Number(record.validated_prefix_bytes) > Number(record.active_bytes) ||
    !safeText(diagnostic.code, 120) ||
    !nonnegativeInteger(diagnostic.segment_ordinal) ||
    !nonnegativeInteger(diagnostic.byte_offset) ||
    (diagnostic.event_id !== undefined && !safeText(diagnostic.event_id, 160))
  ) {
    throw new Error("V3 recovery failure values are invalid");
  }
  return {
    ...(record as unknown as EventV3RecoveryFailure),
    diagnostic: diagnostic as unknown as EventV3RecoveryDiagnostic,
  };
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(record).sort().join("\0") !== expected.join("\0")) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function sha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function recoveryId(value: unknown): value is `rcv_${string}` {
  return typeof value === "string" && RECOVERY_ID_PATTERN.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
