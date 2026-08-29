import {
  HARNERY_STORAGE_HEALTH_SCHEMA,
  type HarneryStorageFamilyHealth,
  type HarneryStorageHealthReport,
  type HarneryStorageInventoryReport,
  type HarneryStorageReasonCode,
} from "./contract.ts";

const DEGRADED_REASONS = new Set<HarneryStorageReasonCode>([
  "hard_link_ambiguous",
  "overlapping_registration",
  "special_file_rejected",
  "symlink_rejected",
  "unreadable_path",
  "unregistered_path",
  "wrong_root_type",
]);

/** Project a read-only inventory into reason-coded health without probing bodies. */
export function storageHealth(
  inventory: HarneryStorageInventoryReport,
): HarneryStorageHealthReport {
  const families = inventory.families.map(familyHealth);
  const issueReasons = inventory.issues.map(({ reason_code }) => reason_code);
  const reasons = new Set<HarneryStorageReasonCode>(issueReasons);
  for (const family of families) for (const reason of family.reason_codes) reasons.add(reason);
  const status =
    issueReasons.some((reason) => DEGRADED_REASONS.has(reason)) ||
    families.some((family) => family.status === "degraded")
      ? "degraded"
      : families.some((family) => family.status === "unknown")
        ? "unknown"
        : "healthy";
  return {
    schema: HARNERY_STORAGE_HEALTH_SCHEMA,
    captured_at: inventory.captured_at,
    inventory_schema: inventory.schema,
    status,
    reason_codes: [...reasons].sort(),
    families,
    issues: inventory.issues,
  };
}

function familyHealth(
  family: HarneryStorageInventoryReport["families"][number],
): HarneryStorageFamilyHealth {
  const reasons = new Set(family.reason_codes);
  if (family.state === "delegated") reasons.add("delegated_inventory_unavailable");
  if (family.state === "dormant") reasons.add("root_dormant");
  const degraded = [...reasons].some((reason) => DEGRADED_REASONS.has(reason));
  return {
    family_id: family.family_id,
    policy_version: family.policy_version,
    status: degraded
      ? "degraded"
      : family.state === "dormant" ||
          family.state === "delegated" ||
          family.state === "unavailable" ||
          family.reason_codes.includes("allocated_bytes_unavailable")
        ? "unknown"
        : family.state === "partial"
          ? "unknown"
          : "healthy",
    reason_codes: [...reasons].sort(),
    maintenance: family.maintenance,
  };
}
