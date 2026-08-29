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
