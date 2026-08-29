export type HarneryStorageClass =
  | "canonical-authority"
  | "recovery-state"
  | "operational-log"
  | "debug-log"
  | "durable-object-history"
  | "repairable-cache"
  | "managed-artifact";

export type HarneryStorageFormat = "canonical-ndjson" | "jsonl" | "text" | "json" | "files";

export type HarneryStorageSensitivity = "private" | "internal-metadata" | "public";
export type HarneryStorageDurability =
  | "immutable"
  | "crash-safe"
  | "best-effort"
  | "reconstructable";
export type HarneryStorageWriterModel = "single-process" | "multi-process" | "object-owned";
export type HarneryLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface HarneryStorageContext {
  coord_root: string;
  project_root?: string;
  conversation_source_roots?: readonly HarneryStorageRoot[];
}

/**
 * A provider partition is a logical, disjoint view of a shared physical root.
 * It is valid only when the named provider declares that partition.
 */
export interface HarneryStorageRoot {
  path: string;
  kind: "file" | "directory";
  match: "exact" | "subtree" | "pattern" | "provider-partition";
  partition?: string;
  include?: readonly string[];
  ownership?: "harnery" | "host" | "external";
}

export interface HarneryStorageBudget {
  limit: number | null;
  unit: "milliseconds" | "bytes" | "files" | "records";
  unbounded_reason?: string;
}

export interface HarneryStoragePolicy {
  schema: "harnery.storage-policy/v1";
  policy_version: string;
  writes: "active" | "disabled";
  rotation: {
    mode: "none" | "size" | "owner-protocol";
    max_segment_bytes: HarneryStorageBudget;
    max_open_age: HarneryStorageBudget;
  };
  retention: {
    status: "active" | "proposed" | "inactive";
    mode: "indefinite" | "oldest-sealed" | "owner-lifecycle" | "ttl" | "expired-only" | "delegated";
    max_age: HarneryStorageBudget;
    max_bytes: HarneryStorageBudget;
    max_files: HarneryStorageBudget;
    max_records: HarneryStorageBudget;
    reason: string;
  };
  records: {
    max_record_bytes: HarneryStorageBudget;
  };
  privacy: {
    sensitivity: HarneryStorageSensitivity;
    content: "metadata-only" | "owner-content" | "public-content";
    forbidden_fields: readonly string[];
  };
  failure_behavior: "fail-closed" | "best-effort" | "reject-before-write" | "owner-protocol";
  reconstruction_source?: string;
}

export interface HarneryLogBufferPolicy {
  max_bytes: number;
  max_records: number;
  flush_interval_ms: number;
  high_severity_reserve_bytes: number;
}

export interface HarneryLogLeasePolicy {
  acquisition_timeout_ms: number;
  retry_backoff_ms: number;
  stale_owner_ms: number;
}

export interface HarneryLogStormPolicy {
  enabled: boolean;
  window_ms: number;
  max_exemplars: number;
  reason?: string;
}

export interface HarneryLogSyncPolicy {
  mode: "append" | "fdatasync";
}

export interface HarneryStderrPolicy {
  minimum_level: HarneryLogLevel | "off";
}

export interface HarneryStorageProvider {
  provider_id: string;
  kind: "filesystem" | "delegated";
  inventory: "filesystem" | "delegated";
  maintenance: "none" | "storage" | "delegated";
  lifecycle_authority: string;
  partitions?: readonly string[];
}

export interface HarneryStorageFamily {
  id: string;
  owner: string;
  storage_class: HarneryStorageClass;
  roots(context: HarneryStorageContext): readonly HarneryStorageRoot[];
  format: HarneryStorageFormat;
  sensitivity: HarneryStorageSensitivity;
  durability: HarneryStorageDurability;
  writer_model: HarneryStorageWriterModel;
  default_level?: HarneryLogLevel;
  buffer_policy?: HarneryLogBufferPolicy;
  lease_policy?: HarneryLogLeasePolicy;
  storm_policy?: HarneryLogStormPolicy;
  sync_policy?: HarneryLogSyncPolicy;
  stderr_policy?: HarneryStderrPolicy;
  policy: HarneryStoragePolicy;
  consumers: readonly string[];
  provider: HarneryStorageProvider;
}

export interface HarneryLoggerBinding {
  component_id: string;
  family_id: string;
}

export interface HarneryHostStorageExclusion {
  owner: string;
  root: HarneryStorageRoot;
  reason: string;
  external_lifecycle_authority: string;
}

export interface HarneryHostStorageRegistration {
  families?: readonly HarneryStorageFamily[];
  logger_bindings?: readonly HarneryLoggerBinding[];
  exclusions?: readonly HarneryHostStorageExclusion[];
}

export interface HarneryRegisteredStorageFamily extends HarneryStorageFamily {
  source: "harnery" | "host";
  resolved_roots: readonly HarneryStorageRoot[];
}

export const HARNERY_STORAGE_INVENTORY_SCHEMA = "harnery.storage-inventory/v1" as const;
export const HARNERY_STORAGE_HEALTH_SCHEMA = "harnery.storage-health/v1" as const;

export type HarneryStorageReasonCode =
  | "allocated_bytes_unavailable"
  | "delegated_inventory_unavailable"
  | "hard_link_ambiguous"
  | "host_exclusion"
  | "maintenance_delegated"
  | "maintenance_not_registered"
  | "maintenance_policy_inactive"
  | "overlapping_registration"
  | "provider_unavailable"
  | "root_dormant"
  | "special_file_rejected"
  | "symlink_rejected"
  | "unreadable_path"
  | "unregistered_path"
  | "wrong_root_type";

export type HarneryStorageMeasurement =
  | { state: "observed"; unit: "files" | "bytes"; value: number }
  | {
      state: "unavailable";
      unit: "files" | "bytes";
      reason_code: HarneryStorageReasonCode;
    };

export interface HarneryStorageInventoryTotals {
  regular_files: HarneryStorageMeasurement;
  logical_bytes: HarneryStorageMeasurement;
  allocated_bytes: HarneryStorageMeasurement;
}

export interface HarneryStorageRootInventory {
  root_index: number;
  root_label: string;
  ownership: "harnery" | "host" | "external";
  state: "present" | "dormant" | "delegated" | "unavailable" | "partial";
  reason_codes: readonly HarneryStorageReasonCode[];
  totals: HarneryStorageInventoryTotals;
}

export interface HarneryStorageFamilyInventory {
  family_id: string;
  source: "harnery" | "host";
  storage_class: HarneryStorageClass;
  policy_version: string;
  provider_id: string;
  inventory: "filesystem" | "delegated";
  maintenance: {
    state: "eligible" | "ineligible" | "delegated";
    reason_code?: HarneryStorageReasonCode;
  };
  state: "present" | "dormant" | "delegated" | "unavailable" | "partial";
  reason_codes: readonly HarneryStorageReasonCode[];
  totals: HarneryStorageInventoryTotals;
  roots: readonly HarneryStorageRootInventory[];
}

export interface HarneryStorageIssueSummary {
  reason_code: HarneryStorageReasonCode;
  count: number;
  maintenance_eligible: false;
}

export interface HarneryStorageInventoryReport {
  schema: typeof HARNERY_STORAGE_INVENTORY_SCHEMA;
  captured_at: string;
  privacy: {
    content_read: false;
    path_mode: "aggregate-labels";
  };
  scan: {
    mode: "streaming-lstat";
    max_concurrency: number;
    project_filesystem_scope: ".harnery-and-registered-external-roots";
  };
  filter: { family_id?: string; storage_class?: HarneryStorageClass };
  filesystem_totals: HarneryStorageInventoryTotals;
  scope_totals: {
    coordination_root: HarneryStorageInventoryTotals;
    registered_external_roots: HarneryStorageInventoryTotals;
  };
  families: readonly HarneryStorageFamilyInventory[];
  issues: readonly HarneryStorageIssueSummary[];
}

export interface HarneryStorageFamilyHealth {
  family_id: string;
  policy_version: string;
  status: "healthy" | "degraded" | "unknown";
  reason_codes: readonly HarneryStorageReasonCode[];
  maintenance: HarneryStorageFamilyInventory["maintenance"];
}

export interface HarneryStorageHealthReport {
  schema: typeof HARNERY_STORAGE_HEALTH_SCHEMA;
  captured_at: string;
  inventory_schema: typeof HARNERY_STORAGE_INVENTORY_SCHEMA;
  status: "healthy" | "degraded" | "unknown";
  reason_codes: readonly HarneryStorageReasonCode[];
  families: readonly HarneryStorageFamilyHealth[];
  issues: readonly HarneryStorageIssueSummary[];
}
