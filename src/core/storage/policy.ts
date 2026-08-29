import type {
  HarneryStorageBudget,
  HarneryStorageFamily,
  HarneryStoragePolicy,
} from "./contract.ts";

export class HarneryStoragePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarneryStoragePolicyError";
  }
}

const UNITS = new Set(["milliseconds", "bytes", "files", "records"]);
const RETENTION_MODES = new Set([
  "indefinite",
  "oldest-sealed",
  "owner-lifecycle",
  "ttl",
  "expired-only",
  "delegated",
]);

export function validateStoragePolicy(
  value: unknown,
  label = "storage policy",
): asserts value is HarneryStoragePolicy {
  const policy = record(value, `${label} must be an object`);
  if (policy.schema !== "harnery.storage-policy/v1") fail(label, "has an unsupported schema");
  if (!identifier(policy.policy_version)) fail(label, "has an invalid policy_version");
  if (policy.writes !== "active" && policy.writes !== "disabled") {
    fail(label, "has an invalid writes state");
  }

  const rotation = record(policy.rotation, `${label}.rotation must be an object`);
  if (!new Set(["none", "size", "owner-protocol"]).has(String(rotation.mode))) {
    fail(label, "has an invalid rotation mode");
  }
  budget(rotation.max_segment_bytes, "bytes", `${label}.rotation.max_segment_bytes`);
  budget(rotation.max_open_age, "milliseconds", `${label}.rotation.max_open_age`);

  const retention = record(policy.retention, `${label}.retention must be an object`);
  if (!new Set(["active", "proposed", "inactive"]).has(String(retention.status))) {
    fail(label, "has an invalid retention status");
  }
  if (!RETENTION_MODES.has(String(retention.mode))) fail(label, "has an invalid retention mode");
  budget(retention.max_age, "milliseconds", `${label}.retention.max_age`);
  budget(retention.max_bytes, "bytes", `${label}.retention.max_bytes`);
  budget(retention.max_files, "files", `${label}.retention.max_files`);
  budget(retention.max_records, "records", `${label}.retention.max_records`);
  if (!nonempty(retention.reason)) fail(label, "must explain its retention rule");

  const records = record(policy.records, `${label}.records must be an object`);
  budget(records.max_record_bytes, "bytes", `${label}.records.max_record_bytes`);

  const privacy = record(policy.privacy, `${label}.privacy must be an object`);
  if (!new Set(["private", "internal-metadata", "public"]).has(String(privacy.sensitivity))) {
    fail(label, "has an invalid privacy sensitivity");
  }
  if (!new Set(["metadata-only", "owner-content", "public-content"]).has(String(privacy.content))) {
    fail(label, "has an invalid privacy content class");
  }
  if (
    !Array.isArray(privacy.forbidden_fields) ||
    privacy.forbidden_fields.some((field) => !nonempty(field)) ||
    new Set(privacy.forbidden_fields).size !== privacy.forbidden_fields.length
  ) {
    fail(label, "has invalid forbidden_fields");
  }
  if (
    !new Set(["fail-closed", "best-effort", "reject-before-write", "owner-protocol"]).has(
      String(policy.failure_behavior),
    )
  ) {
    fail(label, "has an invalid failure_behavior");
  }
  if (policy.reconstruction_source !== undefined && !nonempty(policy.reconstruction_source)) {
    fail(label, "has an invalid reconstruction_source");
  }
}

export function validateFamilyPolicy(family: HarneryStorageFamily): void {
  validateStoragePolicy(family.policy, `storage family ${family.id} policy`);
  if (family.policy.privacy.sensitivity !== family.sensitivity) {
    throw new HarneryStoragePolicyError(
      `storage family ${family.id} policy sensitivity does not match its descriptor`,
    );
  }
  if (family.storage_class === "repairable-cache" && !family.policy.reconstruction_source) {
    throw new HarneryStoragePolicyError(
      `storage family ${family.id} repairable cache must name its reconstruction source`,
    );
  }
  if (
    (family.storage_class === "operational-log" || family.storage_class === "debug-log") &&
    family.policy.retention.status === "active" &&
    family.policy.retention.mode === "indefinite"
  ) {
    throw new HarneryStoragePolicyError(
      `storage family ${family.id} active log retention cannot be indefinite`,
    );
  }
}

function budget(value: unknown, unit: HarneryStorageBudget["unit"], label: string): void {
  const candidate = record(value, `${label} must be an object`);
  if (!UNITS.has(String(candidate.unit)) || candidate.unit !== unit) {
    throw new HarneryStoragePolicyError(`${label} must use ${unit}`);
  }
  if (candidate.limit === null) {
    if (!nonempty(candidate.unbounded_reason)) {
      throw new HarneryStoragePolicyError(`${label} is unbounded without a reason`);
    }
    return;
  }
  if (!Number.isSafeInteger(candidate.limit) || (candidate.limit as number) <= 0) {
    throw new HarneryStoragePolicyError(`${label} limit must be a positive safe integer or null`);
  }
  if (candidate.unbounded_reason !== undefined) {
    throw new HarneryStoragePolicyError(`${label} has a limit and an unbounded_reason`);
  }
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HarneryStoragePolicyError(message);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(label: string, detail: string): never {
  throw new HarneryStoragePolicyError(`${label} ${detail}`);
}
