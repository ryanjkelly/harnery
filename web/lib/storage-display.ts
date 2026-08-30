const DECIMAL_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

const TERM_HELP: Record<string, string> = {
  "Storage footprint":
    "Everything Harnery can identify as its storage, summarized without opening or reading the stored file contents.",
  "Logical footprint":
    "The sum of each file's recorded content length. This is measured usage, not a configured maximum, and it can differ from physical disk space.",
  "Regular files":
    "Ordinary files only. Directories, symbolic links, sockets, and other special filesystem entries are not counted here.",
  "Registered roots":
    "Filesystem locations the storage catalog knows how to inventory. A root can contain one file or an entire directory tree.",
  "Storage catalog":
    "Harnery's registry of storage families, roots, owners, lifecycles, and maintenance rules.",
  "Storage family":
    "A named group of files that share one purpose, owner, lifecycle, and maintenance policy.",
  "Storage class":
    "A lifecycle and safety category, such as operational logs, durable history, or repairable cache.",
  "Inventory contract":
    "The safety rules the scanner must follow: read metadata only, reject symlinks, and report uncertainty instead of guessing.",
  "Metadata only":
    "The scanner reads names, sizes, file types, and timestamps. It does not open files or read their stored records.",
  "Allocated bytes":
    "Physical disk blocks assigned to files. The filesystem did not provide this measurement here, so logical size remains available while physical usage is unknown.",
  "Footprint by storage class":
    "The logical footprint grouped by why the files exist and how safely they can be repaired or removed.",
  "Scan scope": "The locations examined and the rules used during this inventory capture.",
  "Coordination root":
    "The main .harnery storage tree for this checkout, including coordination state and local Harnery data.",
  "Registered external roots":
    "Cataloged Harnery storage that lives outside the main .harnery directory.",
  Traversal:
    "How the scanner walked registered directories. The inventory uses bounded, metadata-only filesystem traversal.",
  Concurrency: "The maximum number of filesystem entries the scanner examined at the same time.",
  "Content read": "Whether the scanner opened file bodies. A safe storage inventory reports no.",
  "Path mode":
    "How paths are exposed in the report. Aggregate labels describe storage without publishing private absolute paths.",
  "Log storage budgets":
    "Per-log-family limits for retained bytes and age. These limits do not cap Harnery's total storage footprint.",
  "Managed usage":
    "Log bytes inside roots that the catalog can safely attribute to this family and manage under its retention policy.",
  Unmanaged:
    "Bytes associated with this family that are visible to inventory but outside the roots maintenance can safely control.",
  Retention: "Whether this log family has an enforceable age-and-size retention policy.",
  "Bytes source":
    "Where the effective byte limit came from, such as a user override or the built-in default.",
  "Age source":
    "Where the effective maximum age came from, such as a user override or the built-in default.",
  Reasons:
    "Reason codes explain why a measurement, status, or maintenance decision is not fully healthy.",
  "Registered families": "Every storage family currently declared in Harnery's canonical catalog.",
  Family: "The stable machine-readable identifier for one storage family.",
  Class: "The family's lifecycle and safety category.",
  Status:
    "Inventory health plus whether the expected storage is present, absent, degraded, or unknown.",
  Files: "The number of ordinary files attributed to this family or root.",
  Logical:
    "File-content length reported by filesystem metadata. It is measured usage, not a storage limit.",
  Allocated:
    "Physical disk space assigned by the filesystem. This can be unavailable or differ from logical size.",
  Maintenance:
    "Whether Harnery can safely plan retention work for this family. The page itself never deletes anything.",
  "Root label": "A safe catalog label for a filesystem location. It is not file content.",
  Ownership:
    "Which side controls the root: Harnery itself, the host repository, or another delegated provider.",
  State: "What inventory could prove about the current storage location or policy.",
  Owner: "The subsystem responsible for the family and its contract.",
  Provider: "The inventory implementation that supplies this family's measurements.",
  Policy: "The versioned storage policy used to interpret and maintain this family.",
  Format: "The on-disk file or record format used by the family.",
  Durability: "How important it is to preserve this data and whether it can be reconstructed.",
  Sensitivity: "The privacy classification of the stored data.",
  Writer: "The process or ownership model allowed to create and update these files.",
  Consumers: "The commands, services, or views that read this family.",
  Roots: "How many registered filesystem locations belong to this family.",
  "Safety boundary":
    "This page can observe storage only. Destructive maintenance still requires a dry run, an exact transaction, and explicit confirmation in the CLI.",
  Schemas:
    "Versioned report contracts that keep the CLI, tests, and dashboard interpreting the same fields.",
  Captured:
    "When this inventory snapshot was measured. Results are cached briefly, so this is not a live byte counter.",
  Maximum: "The effective limit for this one log family, not for Harnery as a whole.",
  Age: "The oldest log data this one family should retain under its effective policy.",
};

const CLASS_HELP: Record<string, string> = {
  "canonical-authority":
    "Source-of-truth state. Losing or casually deleting it could change what Harnery believes is authoritative.",
  "recovery-state": "State used to resume, repair, or safely reconcile interrupted work.",
  "durable-object-history": "Long-lived records whose history should survive ordinary cleanup.",
  "operational-log": "Logs used to operate and diagnose running Harnery services.",
  "debug-log":
    "Shorter-lived diagnostic output intended for troubleshooting rather than authority.",
  "repairable-cache": "Derived data that can be rebuilt from a more authoritative source.",
  "managed-artifact":
    "Agent-created working evidence with an explicit owner and retention lifecycle.",
};

const STATE_HELP: Record<string, string> = {
  healthy: "Inventory found no reported problem for this item.",
  degraded:
    "Inventory completed, but at least one measurement or ownership condition needs attention. This does not by itself mean data is lost.",
  unknown:
    "The available evidence could not prove a healthy or unhealthy result, so Harnery did not guess.",
  present: "The registered storage exists and inventory could inspect its metadata.",
  absent: "The registered storage location does not currently exist.",
  eligible: "Maintenance can safely include this family under its registered policy.",
  ineligible: "Maintenance cannot safely include this family under the current contract.",
  within_budget: "Managed usage is at or below this log family's effective limit.",
  over_budget: "Managed usage is above this log family's effective limit.",
  active: "This storage or policy is currently active.",
  dormant: "A configuration exists, but the corresponding storage family is not currently active.",
  blocked: "A safety or authority condition prevents the requested maintenance path.",
  unavailable:
    "Inventory could not obtain this measurement or state from the filesystem or provider.",
};

const REASON_HELP: Record<string, string> = {
  allocated_bytes_unavailable:
    "The filesystem did not provide physical block usage. Logical file sizes are still measured.",
  hard_link_ambiguous:
    "One physical file may have multiple directory entries, so physical ownership cannot be attributed without risking a double count.",
  symlink_rejected:
    "The scanner found a symbolic link and deliberately did not follow it across a storage ownership boundary.",
  unregistered_path:
    "The path appears inside Harnery's storage area but no catalog entry currently claims it.",
  delegated_inventory_unavailable:
    "Another provider owns this inventory, and it did not supply a usable measurement for this capture.",
  maintenance_not_registered:
    "This family is inventoried, but no maintenance provider is registered to change or prune it.",
  root_dormant:
    "A log-budget override names a family or root that is not active in the current storage catalog.",
  hard_link_counted_once:
    "Multiple directory entries point to one physical file. Inventory counted its content once.",
};

export function storageTermHelp(term: string): string {
  return TERM_HELP[term] ?? `Plain-language help for the storage field “${term}”.`;
}

export function storageClassHelp(storageClass: string): string {
  return CLASS_HELP[storageClass] ?? `Storage class: ${formatReasonLabel(storageClass)}.`;
}

export function storageStateHelp(state: string): string {
  return STATE_HELP[state] ?? `Storage state: ${formatReasonLabel(state)}.`;
}

export function storageReasonHelp(reason: string): string {
  return REASON_HELP[reason] ?? `Inventory reason code: ${formatReasonLabel(reason)}.`;
}

export function formatReasonLabel(reason: string): string {
  return reason.replaceAll("_", " ");
}

export function formatStorageBytes(value: number | null): string {
  if (value == null) return "unavailable";
  const { amount, unit } = scale(value, 1000, DECIMAL_UNITS);
  if (unit === "B") return `${Math.round(amount).toLocaleString()} B`;
  const digits = amount >= 100 ? 1 : 2;
  return `${amount.toLocaleString("en-US", {
    minimumFractionDigits: unit === "GB" || unit === "TB" ? digits : 0,
    maximumFractionDigits: digits,
  })} ${unit}`;
}

export function storageByteHelp(value: number | null): string {
  if (value == null) return "This byte measurement is unavailable.";
  return `Exact measurement: ${value.toLocaleString("en-US")} bytes. Decimal: ${formatPrecise(value, 1000, DECIMAL_UNITS)}. Binary: ${formatPrecise(value, 1024, BINARY_UNITS)}. GB uses powers of 1,000; GiB uses powers of 1,024.`;
}

function formatPrecise(
  value: number,
  base: number,
  units: readonly [string, string, string, string, string],
): string {
  const { amount, unit } = scale(value, base, units);
  if (unit === "B") return `${Math.round(amount).toLocaleString("en-US")} B`;
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${unit}`;
}

function scale(
  value: number,
  base: number,
  units: readonly [string, string, string, string, string],
): { amount: number; unit: string } {
  let amount = value;
  let unitIndex = 0;
  while (amount >= base && unitIndex < units.length - 1) {
    amount /= base;
    unitIndex += 1;
  }
  return { amount, unit: units[unitIndex] };
}
