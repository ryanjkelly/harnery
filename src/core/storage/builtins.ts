import { join, resolve } from "node:path";
import type {
  HarneryLogLevel,
  HarneryStorageBudget,
  HarneryStorageContext,
  HarneryStorageFamily,
  HarneryStoragePolicy,
  HarneryStorageProvider,
  HarneryStorageRoot,
  HarneryStorageSensitivity,
} from "./contract.ts";
import { HARNERY_STRUCTURED_LOG_PROVIDER_ID } from "./contract.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MIB = 1_024 * 1_024;
const PRIVATE_FORBIDDEN_FIELDS = [
  "prompt",
  "command",
  "tool_input",
  "tool_output",
  "response_body",
  "secret",
] as const;

const OWNER_PROTOCOL_LINKS = {
  symbolic_links: "reject",
  hard_links: "allow",
} as const;
const MANAGED_CONTENT_LINKS = {
  symbolic_links: "skip",
  hard_links: "allow",
} as const;

const LOG_PARTITIONS = [
  "agent-operational",
  "web-performance",
  "semantic-service",
  "resource-observer",
  "supervisor",
  "governor-service",
  "presence-relay",
  "tunnel-process",
  "workflow-operational",
  "storage-maintenance",
  "agent-hook-debug",
  "agent-coord-debug",
  "dev-scratch",
  "metrics",
] as const;

const STRUCTURED_LOG_PROVIDER: HarneryStorageProvider = {
  provider_id: HARNERY_STRUCTURED_LOG_PROVIDER_ID,
  kind: "filesystem",
  inventory: "filesystem",
  maintenance: "storage",
  lifecycle_authority: "storage segment and metrics manifests",
  partitions: LOG_PARTITIONS,
};

const V3_ARCHIVE_PROVIDER: HarneryStorageProvider = {
  provider_id: "event-v3-archive-provider",
  kind: "filesystem",
  inventory: "filesystem",
  maintenance: "none",
  lifecycle_authority: "Event Ledger V3 logical authority reader",
  partitions: ["canonical", "support"],
};

export function harneryStorageFamilies(): readonly HarneryStorageFamily[] {
  return Object.freeze([
    ...eventFamilies(),
    ...maintenanceFamilies(),
    ...logFamilies(),
    ...durableHistoryFamilies(),
    ...cacheFamilies(),
    ...artifactFamilies(),
    ...conversationFamilies(),
  ]);
}

function eventFamilies(): HarneryStorageFamily[] {
  return [
    family({
      id: "event-v3-canonical-active",
      owner: "Event Ledger V3 authority",
      storage_class: "canonical-authority",
      roots: (context) => [
        exact(context, ".harnery/ledgers/v3/active.ndjson", "file"),
        exact(context, ".harnery/ledgers/v3/catalog.json", "file"),
        exact(context, ".harnery/ledgers/v3/genesis.json", "file"),
        exact(context, ".harnery/ledgers/v3/activation.json", "file"),
        subtree(context, ".harnery/ledgers/v3/segments"),
      ],
      format: "canonical-ndjson",
      durability: "immutable",
      writer_model: "multi-process",
      policy: authorityPolicy("event-v3-canonical-v1"),
      consumers: ["Event Ledger V3 reader", "coordination projections", "recovery"],
      provider: filesystemProvider("event-v3-canonical-provider", "Event Ledger V3 authority"),
    }),
    family({
      id: "event-v3-canonical-archives",
      owner: "Event Ledger V3 authority",
      storage_class: "canonical-authority",
      roots: (context) => [
        partition(context, ".harnery/ledgers/v3-archives", "canonical", [
          "*/active.ndjson",
          "*/catalog.json",
          "*/genesis.json",
          "*/activation.json",
          "*/segments/**",
        ]),
      ],
      format: "canonical-ndjson",
      durability: "immutable",
      writer_model: "object-owned",
      policy: authorityPolicy("event-v3-archive-canonical-v1"),
      consumers: ["Event Ledger V3 logical authority reader", "recovery verifier"],
      provider: V3_ARCHIVE_PROVIDER,
    }),
    family({
      id: "event-v3-support-active",
      owner: "Event Ledger V3 producer recovery",
      storage_class: "recovery-state",
      roots: (context) => [
        subtree(context, ".harnery/ledgers/v3/diagnostics", OWNER_PROTOCOL_LINKS),
        subtree(context, ".harnery/ledgers/v3/diagnostic-summaries", OWNER_PROTOCOL_LINKS),
        subtree(context, ".harnery/ledgers/v3/private-producers", OWNER_PROTOCOL_LINKS),
        subtree(context, ".harnery/ledgers/v3/authority-outbox", OWNER_PROTOCOL_LINKS),
        subtree(context, ".harnery/ledgers/v3/authority-recoveries", OWNER_PROTOCOL_LINKS),
        subtree(context, ".harnery/ledgers/v3/intake", OWNER_PROTOCOL_LINKS),
        subtree(context, ".harnery/ledgers/v3/spool", OWNER_PROTOCOL_LINKS),
        subtree(context, ".harnery/ledgers/v3/quarantine", OWNER_PROTOCOL_LINKS),
        exact(context, ".harnery/ledgers/v3/append-lease", "directory"),
        exact(context, ".harnery/ledgers/v3/control-state-witness.json", "file"),
        exact(context, ".harnery/ledgers/v3/control-state-validation.json", "file"),
      ],
      format: "files",
      durability: "crash-safe",
      writer_model: "multi-process",
      policy: recoveryPolicy("event-v3-support-active-v1"),
      consumers: ["Event Ledger V3 producers", "doctor", "agents health", "recovery"],
      provider: filesystemProvider("event-v3-support-provider", "Event Ledger V3 recovery"),
    }),
    family({
      id: "event-v3-support-archives",
      owner: "Event Ledger V3 producer recovery",
      storage_class: "recovery-state",
      roots: (context) => [
        partition(
          context,
          ".harnery/ledgers/v3-archives",
          "support",
          [
            "*/diagnostics/**",
            "*/diagnostic-summaries/**",
            "*/private-producers/**",
            "*/authority-outbox/**",
            "*/authority-recoveries/**",
            "*/intake/**",
            "*/spool/**",
            "*/quarantine/**",
            "*/append-lease",
            "*/append-lease/**",
          ],
          OWNER_PROTOCOL_LINKS,
        ),
      ],
      format: "files",
      durability: "immutable",
      writer_model: "object-owned",
      policy: recoveryPolicy("event-v3-archive-support-v1"),
      consumers: ["Event Ledger V3 support reader", "recovery verifier", "agents health"],
      provider: V3_ARCHIVE_PROVIDER,
    }),
    family({
      id: "event-v3-recovery-records",
      owner: "Event Ledger V3 recovery",
      storage_class: "recovery-state",
      roots: (context) => [subtree(context, ".harnery/ledgers/v3-recoveries")],
      format: "json",
      durability: "crash-safe",
      writer_model: "single-process",
      policy: recoveryPolicy("event-v3-recovery-records-v1"),
      consumers: ["Event Ledger V3 reader", "recovery command"],
      provider: filesystemProvider("event-v3-recovery-provider", "Event Ledger V3 recovery"),
    }),
    family({
      id: "legacy-canonical-ledgers",
      owner: "legacy event ledger reader",
      storage_class: "canonical-authority",
      roots: (context) => [
        subtree(context, ".harnery/events.ndjson"),
        pattern(context, ".harnery", ["events*.ndjson*"]),
      ],
      format: "canonical-ndjson",
      durability: "immutable",
      writer_model: "object-owned",
      policy: authorityPolicy("legacy-canonical-ledgers-v1"),
      consumers: ["legacy ledger verifier", "migration inventory"],
      provider: filesystemProvider("legacy-ledger-provider", "legacy ledger verifier"),
    }),
    family({
      id: "event-v3-fingerprint-keys",
      owner: "Event Ledger V3 privacy boundary",
      storage_class: "recovery-state",
      roots: (context) => [exact(context, ".harnery/private/fingerprint-keys.json", "file")],
      format: "json",
      durability: "crash-safe",
      writer_model: "single-process",
      policy: recoveryPolicy("event-v3-fingerprint-keys-v1"),
      consumers: ["Event Ledger V3 fingerprinting", "recovery"],
      provider: filesystemProvider("fingerprint-key-provider", "Event Ledger V3 privacy boundary"),
    }),
  ];
}

function maintenanceFamilies(): HarneryStorageFamily[] {
  return [
    family({
      id: "storage-maintenance-transactions",
      owner: "storage maintenance transaction manager",
      storage_class: "recovery-state",
      roots: (context) => [subtree(context, ".harnery/maintenance/transactions")],
      format: "json",
      durability: "crash-safe",
      writer_model: "single-process",
      policy: { ...recoveryPolicy("storage-maintenance-transactions-v1"), writes: "disabled" },
      consumers: ["storage recovery", "storage health"],
      provider: filesystemProvider("storage-transaction-provider", "storage maintenance"),
    }),
    family({
      id: "storage-maintenance-mutation-receipts",
      owner: "storage maintenance receipt writer",
      storage_class: "durable-object-history",
      roots: (context) => [subtree(context, ".harnery/maintenance/receipts")],
      format: "json",
      durability: "immutable",
      writer_model: "single-process",
      policy: { ...ownerHistoryPolicy("storage-mutation-receipts-v1"), writes: "disabled" },
      consumers: ["storage audit", "storage recovery", "storage health"],
      provider: filesystemProvider("storage-receipt-provider", "storage maintenance"),
    }),
    operationalFamily(
      "storage-maintenance-run-log",
      "storage maintenance runner",
      "storage-maintenance",
      14,
      64 * MIB,
      true,
    ),
    family({
      id: "storage-maintenance-cursors",
      owner: "storage maintenance scheduler",
      storage_class: "repairable-cache",
      roots: (context) => [subtree(context, ".harnery/maintenance/cursors")],
      format: "json",
      durability: "reconstructable",
      writer_model: "multi-process",
      policy: cachePolicy(
        "storage-maintenance-cursors-v1",
        "catalog inventory and maintenance receipts",
        true,
      ),
      consumers: ["storage scheduler", "storage health"],
      provider: filesystemProvider("storage-cursor-provider", "storage maintenance scheduler"),
    }),
    family({
      id: "storage-exports",
      owner: "storage export service",
      storage_class: "managed-artifact",
      roots: (context) => [subtree(context, ".harnery/exports")],
      format: "files",
      durability: "crash-safe",
      writer_model: "object-owned",
      policy: { ...artifactPolicy("storage-exports-v1"), writes: "disabled" },
      consumers: ["storage inventory", "storage query", "storage maintenance"],
      provider: filesystemInventoryDelegatedMaintenanceProvider(
        "storage-export-provider",
        "storage export manifests",
      ),
    }),
  ];
}

function logFamilies(): HarneryStorageFamily[] {
  return [
    operationalFamily(
      "agent-operational-log",
      "agent coordination services",
      "agent-operational",
      30,
      128 * MIB,
    ),
    withCurrentRoots(
      operationalFamily("web-performance-log", "dashboard server", "web-performance", 14, 64 * MIB),
      (context) => [pattern(context, ".harnery/logs", ["web-performance.jsonl*"])],
    ),
    withCurrentRoots(
      operationalFamily(
        "semantic-service-log",
        "semantic service",
        "semantic-service",
        30,
        128 * MIB,
      ),
      (context) => [exact(context, ".harnery/semantic/v2/service.log", "file")],
    ),
    operationalFamily(
      "resource-observer-log",
      "resource observer",
      "resource-observer",
      14,
      64 * MIB,
    ),
    operationalFamily("supervisor-log", "local supervisor", "supervisor", 14, 64 * MIB),
    withCurrentRoots(
      operationalFamily(
        "governor-service-log",
        "governor service",
        "governor-service",
        30,
        128 * MIB,
      ),
      (context) => [
        exact(context, ".harnery/governor-service/service.log", "file"),
        exact(context, ".harnery/governor-service/events.jsonl", "file"),
      ],
    ),
    withCurrentRoots(
      operationalFamily("presence-relay-log", "presence relay", "presence-relay", 14, 64 * MIB),
      (context) => [exact(context, ".harnery/presence/relay-daemon.log", "file")],
    ),
    withCurrentRoots(
      operationalFamily(
        "tunnel-process-log",
        "tunnel process manager",
        "tunnel-process",
        14,
        64 * MIB,
        true,
        "text",
      ),
      (context) => [
        patternAt(
          join(resolve(context.project_root ?? context.coord_root), ".cache", "tunnel"),
          ["*.log"],
          "external",
        ),
      ],
    ),
    operationalFamily(
      "workflow-operational-log",
      "workflow engine",
      "workflow-operational",
      30,
      128 * MIB,
      true,
    ),
    withCurrentRoots(
      debugFamily("agent-hook-debug-log", "hook adapter", "agent-hook-debug"),
      (context) => [pattern(context, ".harnery/debug", ["agent-hook*.ndjson"])],
    ),
    withCurrentRoots(
      debugFamily("agent-coord-debug-log", "coordination CLI", "agent-coord-debug"),
      (context) => [pattern(context, ".harnery/debug", ["agent-coord*.ndjson"])],
    ),
    debugFamily("dev-scratch", "explicit development invocation", "dev-scratch", "debug", true),
  ];
}

function durableHistoryFamilies(): HarneryStorageFamily[] {
  const definitions = [
    ["workflow-run-history", "workflow engine", ".harnery/workflows"],
    ["work-item-history", "durable work service", ".harnery/work"],
    ["governor-history", "governor service", ".harnery/governors"],
    ["council-history", "council service", ".harnery/councils"],
    ["decision-history", "decision service", ".harnery/decisions"],
    ["journal-history", "journal service", ".harnery/journal"],
    ["identity-history", "identity service", ".harnery/identities"],
  ] as const;
  const histories = definitions.map(([id, owner, root]) =>
    family({
      id,
      owner,
      storage_class: "durable-object-history",
      roots: (context) => [subtree(context, root)],
      format: "files",
      durability: "crash-safe",
      writer_model: "object-owned",
      policy: ownerHistoryPolicy(`${id}-v1`),
      consumers: [owner, "storage inventory", "storage health"],
      provider: filesystemProvider(`${id}-provider`, owner),
    }),
  );
  return [
    ...histories,
    family({
      id: "project-configuration",
      owner: "Harnery configuration service",
      storage_class: "durable-object-history",
      roots: (context) => [exact(context, ".harnery/config.jsonc", "file")],
      format: "json",
      durability: "crash-safe",
      writer_model: "object-owned",
      policy: ownerHistoryPolicy("project-configuration-v1"),
      consumers: ["Harnery commands", "adapters", "embedding hosts"],
      provider: filesystemProvider("configuration-provider", "Harnery configuration service"),
    }),
    family({
      id: "coord-message-inbox",
      owner: "coordination core message service",
      storage_class: "durable-object-history",
      roots: (context) => [subtree(context, ".harnery/inbox")],
      format: "jsonl",
      durability: "crash-safe",
      writer_model: "multi-process",
      policy: inboxPolicy(),
      consumers: [
        "prompt context",
        "agents inbox list",
        "agents inbox watch",
        "coordination core message service",
        "storage inventory",
        "storage health",
      ],
      provider: filesystemProvider("coord-message-provider", "recipient instance lifecycle"),
    }),
  ];
}

function cacheFamilies(): HarneryStorageFamily[] {
  const definitions = [
    ["active-agent-projection", ".harnery/active", "Event Ledger V3 and native heartbeats"],
    ["pid-map-cache", ".harnery/pid-map", "active native process observations"],
    ["remote-presence-cache", ".harnery/presence/remote", "presence relay observations"],
    ["event-v3-live-display", ".harnery/live/v3", "Event Ledger V3 canonical events"],
  ] as const;
  return [
    ...definitions.map(([id, root, source]) =>
      family({
        id,
        owner: `${id} owner`,
        storage_class: "repairable-cache",
        roots: (context) => [subtree(context, root)],
        format: "files",
        durability: "reconstructable",
        writer_model: "multi-process",
        policy: cachePolicy(`${id}-v1`, source),
        consumers: [id, "storage inventory", "storage health"],
        provider: filesystemProvider(`${id}-provider`, source),
      }),
    ),
    family({
      id: "semantic-cache",
      owner: "semantic service",
      storage_class: "repairable-cache",
      roots: (context) => [
        exact(context, ".harnery/semantic/v2/manifest.json", "file"),
        subtree(context, ".harnery/semantic/v2/agents"),
        subtree(context, ".harnery/semantic/v2/cache"),
        exact(context, ".harnery/semantic/v2/service.json", "file"),
        exact(context, ".harnery/semantic/v2/stop.json", "file"),
        exact(context, ".harnery/semantic/v2/lease.json", "file"),
      ],
      format: "files",
      durability: "reconstructable",
      writer_model: "multi-process",
      policy: cachePolicy("semantic-cache-v1", "canonical events and source documents"),
      consumers: ["semantic service", "storage inventory", "storage health"],
      provider: filesystemProvider(
        "semantic-cache-provider",
        "canonical events and source documents",
      ),
    }),
    family({
      id: "resource-observer-cache",
      owner: "resource observer",
      storage_class: "repairable-cache",
      roots: (context) => [subtree(context, ".harnery/resources")],
      format: "json",
      durability: "reconstructable",
      writer_model: "object-owned",
      policy: cachePolicy("resource-observer-cache-v1", "local process and machine samples"),
      consumers: ["resource observer", "dashboard", "storage inventory", "storage health"],
      provider: filesystemProvider(
        "resource-observer-cache-provider",
        "local process and machine samples",
      ),
    }),
    family({
      id: "supervisor-cache",
      owner: "local supervisor",
      storage_class: "repairable-cache",
      roots: (context) => [subtree(context, ".harnery/supervisor")],
      format: "json",
      durability: "reconstructable",
      writer_model: "object-owned",
      policy: cachePolicy(
        "supervisor-cache-v1",
        "local resources, service health, log cursors, and anomaly projections",
      ),
      consumers: ["local supervisor", "dashboard", "storage inventory", "storage health"],
      provider: filesystemProvider(
        "supervisor-cache-provider",
        "bounded local diagnostic observations",
      ),
    }),
    family({
      id: "structured-log-metrics",
      owner: "structured log provider",
      storage_class: "repairable-cache",
      roots: (context) => [partition(context, ".harnery/logs", "metrics", ["*/metrics.json"])],
      format: "json",
      durability: "reconstructable",
      writer_model: "multi-process",
      policy: cachePolicy(
        "structured-log-metrics-v1",
        "structured log segments and immutable metric summary deltas",
        true,
      ),
      consumers: ["structured log provider", "storage health", "logs list"],
      provider: STRUCTURED_LOG_PROVIDER,
    }),
  ];
}

function artifactFamilies(): HarneryStorageFamily[] {
  return [
    family({
      id: "managed-artifacts",
      owner: "artifact service",
      storage_class: "managed-artifact",
      roots: (context) => [subtree(context, ".harnery/artifacts", MANAGED_CONTENT_LINKS)],
      format: "files",
      durability: "crash-safe",
      writer_model: "object-owned",
      policy: artifactPolicy("managed-artifacts-v1"),
      consumers: ["artifact service", "artifact janitor", "storage inventory"],
      provider: filesystemInventoryDelegatedMaintenanceProvider(
        "artifact-provider",
        "artifact manifests and owner protection",
      ),
    }),
    family({
      id: "captured-images",
      owner: "image capture service",
      storage_class: "managed-artifact",
      roots: (context) => [subtree(context, ".harnery/images")],
      format: "files",
      durability: "crash-safe",
      writer_model: "object-owned",
      policy: artifactPolicy("captured-images-v1"),
      consumers: ["image capture", "image janitor", "storage inventory"],
      provider: filesystemInventoryDelegatedMaintenanceProvider(
        "image-provider",
        "image manifests and reference protection",
      ),
    }),
  ];
}

function conversationFamilies(): HarneryStorageFamily[] {
  return [
    family({
      id: "adapter-native-conversations",
      owner: "adapter-native conversation providers",
      storage_class: "durable-object-history",
      roots: (context) => context.conversation_source_roots ?? [],
      format: "files",
      durability: "immutable",
      writer_model: "object-owned",
      policy: delegatedHistoryPolicy("adapter-native-conversations-v1"),
      consumers: ["conversation query", "conversation archive"],
      provider: delegatedProvider(
        "native-conversation-provider",
        "adapter-native conversation lifecycle",
      ),
    }),
    family({
      id: "conversation-archive",
      owner: "conversation archive service",
      storage_class: "durable-object-history",
      roots: (context) => [subtree(context, ".harnery/conversations/archive")],
      format: "jsonl",
      durability: "crash-safe",
      writer_model: "object-owned",
      policy: { ...ownerHistoryPolicy("conversation-archive-v1"), writes: "disabled" },
      consumers: ["conversation query", "context pack", "conversation lifecycle"],
      provider: filesystemProvider("conversation-archive-provider", "conversation lifecycle"),
    }),
    family({
      id: "conversation-search-index",
      owner: "conversation query service",
      storage_class: "repairable-cache",
      roots: (context) => [subtree(context, ".harnery/conversations/index")],
      format: "files",
      durability: "reconstructable",
      writer_model: "object-owned",
      policy: cachePolicy(
        "conversation-search-index-v1",
        "adapter-native conversation source or Harnery conversation archive",
        true,
      ),
      consumers: ["conversation query"],
      provider: filesystemProvider("conversation-index-provider", "conversation query service"),
    }),
  ];
}

function operationalFamily(
  id: string,
  owner: string,
  partitionName: (typeof LOG_PARTITIONS)[number],
  proposedDays: 14 | 30,
  proposedBytes: number,
  disabled = false,
  format: "jsonl" | "text" = "jsonl",
): HarneryStorageFamily {
  return family({
    id,
    owner,
    storage_class: "operational-log",
    roots: (context) => [partition(context, ".harnery/logs", partitionName)],
    format,
    durability: "best-effort",
    writer_model: "multi-process",
    default_level: "info",
    policy: logPolicy(`${id}-v1`, proposedDays, proposedBytes, disabled),
    consumers: [owner, "logs query", "storage health"],
    provider: STRUCTURED_LOG_PROVIDER,
  });
}

function debugFamily(
  id: string,
  owner: string,
  partitionName: (typeof LOG_PARTITIONS)[number],
  defaultLevel: HarneryLogLevel = "debug",
  disabled = false,
): HarneryStorageFamily {
  return family({
    id,
    owner,
    storage_class: "debug-log",
    roots: (context) => [partition(context, ".harnery/logs", partitionName)],
    format: "jsonl",
    durability: "best-effort",
    writer_model: "multi-process",
    default_level: defaultLevel,
    policy: logPolicy(`${id}-v1`, 7, 64 * MIB, disabled),
    consumers: [owner, "logs query", "storage health"],
    provider: STRUCTURED_LOG_PROVIDER,
  });
}

function family(
  input: Omit<HarneryStorageFamily, "sensitivity"> & {
    sensitivity?: HarneryStorageSensitivity;
  },
): HarneryStorageFamily {
  return { ...input, sensitivity: input.sensitivity ?? input.policy.privacy.sensitivity };
}

function withCurrentRoots(
  descriptor: HarneryStorageFamily,
  currentRoots: (context: HarneryStorageContext) => readonly HarneryStorageRoot[],
): HarneryStorageFamily {
  const futureRoots = descriptor.roots;
  return {
    ...descriptor,
    roots: (context) => [...futureRoots(context), ...currentRoots(context)],
  };
}

function exact(
  context: HarneryStorageContext,
  relativePath: string,
  kind: "file" | "directory",
): HarneryStorageRoot {
  return { path: storagePath(context, relativePath), kind, match: "exact", ownership: "harnery" };
}

function subtree(
  context: HarneryStorageContext,
  relativePath: string,
  linkHandling?: HarneryStorageRoot["link_handling"],
): HarneryStorageRoot {
  return {
    path: storagePath(context, relativePath),
    kind: "directory",
    match: "subtree",
    ownership: "harnery",
    ...(linkHandling ? { link_handling: linkHandling } : {}),
  };
}

function pattern(
  context: HarneryStorageContext,
  relativePath: string,
  include: readonly string[],
): HarneryStorageRoot {
  return patternAt(storagePath(context, relativePath), include, "harnery");
}

function patternAt(
  path: string,
  include: readonly string[],
  ownership: HarneryStorageRoot["ownership"],
): HarneryStorageRoot {
  return {
    path,
    kind: "directory",
    match: "pattern",
    include,
    ownership,
  };
}

function partition(
  context: HarneryStorageContext,
  relativePath: string,
  partitionName: string,
  include: readonly string[] = [
    `${partitionName}/active.jsonl`,
    `${partitionName}/active.log`,
    `${partitionName}/segments/**`,
    `${partitionName}/manifests/**`,
  ],
  linkHandling?: HarneryStorageRoot["link_handling"],
): HarneryStorageRoot {
  return {
    path: storagePath(context, relativePath),
    kind: "directory",
    match: "provider-partition",
    partition: partitionName,
    include,
    ownership: "harnery",
    ...(linkHandling ? { link_handling: linkHandling } : {}),
  };
}

function storagePath(context: HarneryStorageContext, relativePath: string): string {
  return join(resolve(context.coord_root), ...relativePath.split("/"));
}

function filesystemProvider(providerId: string, authority: string): HarneryStorageProvider {
  return {
    provider_id: providerId,
    kind: "filesystem",
    inventory: "filesystem",
    maintenance: "none",
    lifecycle_authority: authority,
  };
}

function delegatedProvider(providerId: string, authority: string): HarneryStorageProvider {
  return {
    provider_id: providerId,
    kind: "delegated",
    inventory: "delegated",
    maintenance: "delegated",
    lifecycle_authority: authority,
  };
}

function filesystemInventoryDelegatedMaintenanceProvider(
  providerId: string,
  authority: string,
): HarneryStorageProvider {
  return {
    provider_id: providerId,
    kind: "filesystem",
    inventory: "filesystem",
    maintenance: "delegated",
    lifecycle_authority: authority,
  };
}

function authorityPolicy(version: string): HarneryStoragePolicy {
  return policy(version, "active", "private", "owner-content", {
    status: "inactive",
    mode: "indefinite",
    maxAge: unbounded("milliseconds", "canonical authority retention needs a separate decision"),
    maxBytes: unbounded("bytes", "canonical authority is retained indefinitely"),
    maxFiles: unbounded("files", "canonical segments are authority"),
    maxRecords: unbounded("records", "canonical records are authority"),
    reason: "Canonical authority is immutable and has no destructive retention.",
  });
}

function recoveryPolicy(version: string): HarneryStoragePolicy {
  return policy(version, "active", "private", "metadata-only", {
    status: "inactive",
    mode: "owner-lifecycle",
    maxAge: unbounded("milliseconds", "recovery eligibility is proof-based, not age-based"),
    maxBytes: unbounded("bytes", "recovery evidence remains until a separate decision"),
    maxFiles: unbounded("files", "recovery state must fail closed"),
    maxRecords: unbounded("records", "recovery state must fail closed"),
    reason: "Recovery state remains owner-controlled and is never deleted by generic age.",
  });
}

function ownerHistoryPolicy(version: string): HarneryStoragePolicy {
  return policy(version, "active", "private", "owner-content", {
    status: "inactive",
    mode: "owner-lifecycle",
    maxAge: unbounded("milliseconds", "the owning object controls terminal eligibility"),
    maxBytes: unbounded("bytes", "no generic durable-history byte policy is activated"),
    maxFiles: unbounded("files", "no generic durable-history file policy is activated"),
    maxRecords: unbounded("records", "no generic durable-history record policy is activated"),
    reason: "Durable history follows its owning product object's lifecycle.",
  });
}

function delegatedHistoryPolicy(version: string): HarneryStoragePolicy {
  const result = ownerHistoryPolicy(version);
  result.retention.mode = "delegated";
  result.retention.reason = "The external source owns lifecycle and is never maintained by path.";
  return result;
}

function inboxPolicy(): HarneryStoragePolicy {
  const result = policy("coord-message-inbox-v1", "disabled", "private", "owner-content", {
    status: "inactive",
    mode: "owner-lifecycle",
    maxAge: unbounded("milliseconds", "recipient lifecycle grace is not activated yet"),
    maxBytes: bounded(64 * MIB, "bytes"),
    maxFiles: bounded(10_000, "files"),
    maxRecords: bounded(10_000, "records"),
    reason:
      "Recipient lifecycle protects pending messages; compaction removes only surfaced records.",
  });
  result.records.max_record_bytes = bounded(24 * 1_024, "bytes");
  result.failure_behavior = "reject-before-write";
  return result;
}

function cachePolicy(version: string, source: string, disabled = false): HarneryStoragePolicy {
  const result = policy(
    version,
    disabled ? "disabled" : "active",
    "internal-metadata",
    "metadata-only",
    {
      status: "inactive",
      mode: "ttl",
      maxAge: unbounded(
        "milliseconds",
        "owner-specific cache TTL is not activated by this catalog",
      ),
      maxBytes: unbounded("bytes", "owner-specific cache capacity remains in force"),
      maxFiles: unbounded("files", "owner-specific cache capacity remains in force"),
      maxRecords: unbounded("records", "the cache is reconstructed as a unit"),
      reason: "Cache removal is allowed only while its reconstruction source remains available.",
    },
  );
  result.reconstruction_source = source;
  return result;
}

function artifactPolicy(version: string): HarneryStoragePolicy {
  return policy(version, "active", "private", "owner-content", {
    status: "active",
    mode: "delegated",
    maxAge: unbounded("milliseconds", "manifest expiry and renewal control artifact age"),
    maxBytes: unbounded("bytes", "artifact owner budgets are manifest-specific"),
    maxFiles: unbounded("files", "artifact owner budgets are manifest-specific"),
    maxRecords: unbounded("records", "artifacts are managed objects, not records"),
    reason: "Existing artifact and image janitors enforce manifest and owner protection.",
  });
}

function logPolicy(
  version: string,
  proposedDays: 7 | 14 | 30,
  proposedBytes: number,
  disabled: boolean,
): HarneryStoragePolicy {
  const result = policy(
    version,
    disabled ? "disabled" : "active",
    "internal-metadata",
    "metadata-only",
    {
      status: "active",
      mode: "oldest-sealed",
      maxAge: bounded(proposedDays * DAY_MS, "milliseconds"),
      maxBytes: bounded(proposedBytes, "bytes"),
      maxFiles: unbounded("files", "segment count follows time and byte proposals"),
      maxRecords: unbounded("records", "record count follows time and byte proposals"),
      reason: `${proposedDays}-day and ${proposedBytes}-byte source-owned storage budget.`,
    },
  );
  result.rotation = {
    mode: "size",
    max_segment_bytes: bounded(10 * MIB, "bytes"),
    max_open_age: unbounded("milliseconds", "max_open_age awaits measured activation"),
  };
  result.records.max_record_bytes = bounded(64 * 1_024, "bytes");
  result.failure_behavior = "best-effort";
  return result;
}

function policy(
  version: string,
  writes: "active" | "disabled",
  sensitivity: HarneryStorageSensitivity,
  content: "metadata-only" | "owner-content" | "public-content",
  retention: {
    status: "active" | "proposed" | "inactive";
    mode: HarneryStoragePolicy["retention"]["mode"];
    maxAge: HarneryStorageBudget;
    maxBytes: HarneryStorageBudget;
    maxFiles: HarneryStorageBudget;
    maxRecords: HarneryStorageBudget;
    reason: string;
  },
): HarneryStoragePolicy {
  return {
    schema: "harnery.storage-policy/v1",
    policy_version: version,
    writes,
    rotation: {
      mode: "owner-protocol",
      max_segment_bytes: unbounded("bytes", "the owner protocol defines rotation"),
      max_open_age: unbounded("milliseconds", "the owner protocol defines open age"),
    },
    retention: {
      status: retention.status,
      mode: retention.mode,
      max_age: retention.maxAge,
      max_bytes: retention.maxBytes,
      max_files: retention.maxFiles,
      max_records: retention.maxRecords,
      reason: retention.reason,
    },
    records: {
      max_record_bytes: unbounded("bytes", "the owner schema defines record size"),
    },
    privacy: {
      sensitivity,
      content,
      forbidden_fields: content === "metadata-only" ? PRIVATE_FORBIDDEN_FIELDS : [],
    },
    failure_behavior: "owner-protocol",
  };
}

function bounded(limit: number, unit: HarneryStorageBudget["unit"]): HarneryStorageBudget {
  return { limit, unit };
}

function unbounded(
  unit: HarneryStorageBudget["unit"],
  unboundedReason: string,
): HarneryStorageBudget {
  return { limit: null, unit, unbounded_reason: unboundedReason };
}
