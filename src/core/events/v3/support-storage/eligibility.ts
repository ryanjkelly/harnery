import type { EventV3SupportInventoryEntry } from "./inventory.ts";

export interface EventV3AuthorityPackingCandidate {
  authority_root: string;
  state: "active" | "archived";
  genesis_id: string;
  recovery_receipt_id?: string;
  has_ready_transaction: boolean;
  has_pending_producer_state: boolean;
  has_maintenance_transaction: boolean;
  regular_file_count: number;
  entries: EventV3SupportInventoryEntry[];
}

export interface EventV3AuthorityPackingGate {
  eligible: boolean;
  reasons: string[];
}

export function assessEventV3AuthorityPackingGate(
  candidate: EventV3AuthorityPackingCandidate,
  options: { allow_active?: boolean; allow_recovery_bound?: boolean } = {},
): EventV3AuthorityPackingGate {
  const reasons: string[] = [];
  if (candidate.state === "active" && !options.allow_active)
    reasons.push("active_epoch_not_enabled");
  if (candidate.recovery_receipt_id && !options.allow_recovery_bound) {
    reasons.push("recovery_bound_archive_not_enabled");
  }
  if (candidate.has_ready_transaction) reasons.push("ready_authority_transaction_present");
  if (candidate.has_pending_producer_state) reasons.push("pending_producer_state_present");
  if (candidate.has_maintenance_transaction) reasons.push("maintenance_transaction_present");
  if (candidate.entries.length === 0) reasons.push("no_support_files");
  if (candidate.entries.some((entry) => entry.disposition !== "pack-eligible")) {
    reasons.push("support_entry_not_pack_eligible");
  }
  return { eligible: reasons.length === 0, reasons: reasons.sort() };
}

/** Choose one deterministic smallest unbound archive canary; never mutate it. */
export function planEventV3ArchiveCanary(candidates: EventV3AuthorityPackingCandidate[]): {
  candidate?: EventV3AuthorityPackingCandidate;
  rejected: Array<{ authority_root: string; reasons: string[] }>;
} {
  const rejected: Array<{ authority_root: string; reasons: string[] }> = [];
  const eligible: EventV3AuthorityPackingCandidate[] = [];
  for (const candidate of candidates) {
    const gate = assessEventV3AuthorityPackingGate(candidate);
    if (gate.eligible) eligible.push(candidate);
    else rejected.push({ authority_root: candidate.authority_root, reasons: gate.reasons });
  }
  eligible.sort(
    (left, right) =>
      left.regular_file_count - right.regular_file_count ||
      left.authority_root.localeCompare(right.authority_root),
  );
  return { candidate: eligible[0], rejected };
}
