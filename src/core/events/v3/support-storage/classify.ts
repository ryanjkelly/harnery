import type { EventV3SupportFamily } from "./pack-contract.ts";

export type EventV3SupportDisposition =
  | "live-required"
  | "recovery-required"
  | "pack-eligible"
  | "quarantine"
  | "unsupported";

export const EVENT_V3_SUPPORT_CLASSIFICATION_REASONS = [
  "active_committed_receipt_deferred",
  "active_epoch_family_not_enabled",
  "archive_has_ready_authority_transaction",
  "authority_lease_live",
  "authority_ready_active",
  "command_state_lease_live",
  "command_state_open",
  "command_state_pending",
  "committed_receipt_grace_not_elapsed",
  "committed_receipt_reconciled",
  "diagnostic_consumer_window_elapsed",
  "diagnostic_timestamp_mismatch",
  "diagnostic_within_loose_window",
  "epoch_not_enabled_for_maintenance_slice",
  "event_reference_cross_epoch",
  "event_reference_unresolved",
  "file_contract_invalid",
  "file_not_owner_only",
  "file_not_regular",
  "finalization_not_complete",
  "maintenance_transaction_owns_path",
  "producer_pending_reference",
  "recovery_bound_archive_not_enabled",
  "receipt_digest_mismatch",
  "receipt_has_ready_sibling",
  "sealed_terminal_state",
  "stale_writer_grace_not_elapsed",
  "transaction_digest_mismatch",
  "turn_not_sealed",
  "unknown_support_family",
] as const;

export type EventV3SupportClassificationReason =
  (typeof EVENT_V3_SUPPORT_CLASSIFICATION_REASONS)[number];

export interface EventV3SupportClassificationEvidence {
  family?: EventV3SupportFamily;
  authority_state: "active" | "archived";
  recovery_bound?: boolean;
  recovery_packing_enabled?: boolean;
  epoch_maintenance_enabled?: boolean;
  active_session_tee_enabled?: boolean;
  active_committed_receipt_enabled?: boolean;
  file_regular?: boolean;
  file_owner_only?: boolean;
  contract_valid?: boolean;
  maintenance_owned?: boolean;
  recorded_at?: string;
  filename_recorded_at?: string;
  now: string;
  maximum_loose_consumer_window_ms?: number;
  fixed_consumer_grace_ms?: number;
  writer_tolerance_ms?: number;
  terminal?: boolean;
  pending?: boolean;
  turn_sealed?: boolean;
  finalization_complete?: boolean;
  event_references_resolved?: boolean;
  event_references_same_epoch?: boolean;
  lease_live?: boolean;
  stale_writer_grace_elapsed?: boolean;
  ready_sibling?: boolean;
  producer_pending_reference?: boolean;
  event_row_digest_matches?: boolean;
  transaction_digest_matches?: boolean;
  receipt_grace_elapsed?: boolean;
  archive_has_ready_transaction?: boolean;
}

export interface EventV3SupportClassification {
  disposition: EventV3SupportDisposition;
  reasons: EventV3SupportClassificationReason[];
}

export const EVENT_V3_DIAGNOSTIC_CONSUMER_WINDOW_MS = 48 * 60 * 60 * 1000;
export const EVENT_V3_DIAGNOSTIC_FIXED_GRACE_MS = 24 * 60 * 60 * 1000;

/** The only disposition decision point for V3 support files. */
export function classifyEventV3Support(
  evidence: EventV3SupportClassificationEvidence,
): EventV3SupportClassification {
  if (!evidence.family) return result("unsupported", ["unknown_support_family"]);
  if (evidence.file_regular === false) return result("quarantine", ["file_not_regular"]);
  if (evidence.file_owner_only === false) return result("quarantine", ["file_not_owner_only"]);
  if (evidence.contract_valid === false) return result("quarantine", ["file_contract_invalid"]);
  if (evidence.maintenance_owned) {
    return result("live-required", ["maintenance_transaction_owns_path"]);
  }
  if (evidence.archive_has_ready_transaction) {
    return result("quarantine", ["archive_has_ready_authority_transaction"]);
  }
  if (evidence.recovery_bound && !evidence.recovery_packing_enabled) {
    return result("recovery-required", ["recovery_bound_archive_not_enabled"]);
  }
  if (!evidence.epoch_maintenance_enabled) {
    return result("live-required", ["epoch_not_enabled_for_maintenance_slice"]);
  }

  switch (evidence.family) {
    case "diagnostic":
      return classifyDiagnostic(evidence);
    case "session-tee":
      return classifyCommandState(evidence);
    case "authority-ready":
      return evidence.authority_state === "active"
        ? result("recovery-required", ["authority_ready_active"])
        : result("quarantine", ["archive_has_ready_authority_transaction"]);
    case "authority-committed":
      return classifyCommittedReceipt(evidence);
    case "authority-residue":
      return result("quarantine", ["file_contract_invalid"]);
  }
}

function classifyDiagnostic(
  evidence: EventV3SupportClassificationEvidence,
): EventV3SupportClassification {
  if (!evidence.recorded_at || !evidence.filename_recorded_at) {
    return result("quarantine", ["file_contract_invalid"]);
  }
  const recorded = Date.parse(evidence.recorded_at);
  const filename = Date.parse(evidence.filename_recorded_at);
  const now = Date.parse(evidence.now);
  if (![recorded, filename, now].every(Number.isFinite)) {
    return result("quarantine", ["file_contract_invalid"]);
  }
  const tolerance = evidence.writer_tolerance_ms ?? 1000;
  if (Math.abs(recorded - filename) > tolerance) {
    return result("quarantine", ["diagnostic_timestamp_mismatch"]);
  }
  const consumer =
    evidence.maximum_loose_consumer_window_ms ?? EVENT_V3_DIAGNOSTIC_CONSUMER_WINDOW_MS;
  const grace = evidence.fixed_consumer_grace_ms ?? EVENT_V3_DIAGNOSTIC_FIXED_GRACE_MS;
  if (now - recorded < consumer + grace) {
    return result("live-required", ["diagnostic_within_loose_window"]);
  }
  return result("pack-eligible", ["diagnostic_consumer_window_elapsed"]);
}

function classifyCommandState(
  evidence: EventV3SupportClassificationEvidence,
): EventV3SupportClassification {
  if (evidence.authority_state === "active" && !evidence.active_session_tee_enabled) {
    return result("live-required", ["active_epoch_family_not_enabled"]);
  }
  if (!evidence.terminal) return result("recovery-required", ["command_state_open"]);
  if (evidence.pending) return result("recovery-required", ["command_state_pending"]);
  if (!evidence.turn_sealed) return result("recovery-required", ["turn_not_sealed"]);
  if (!evidence.finalization_complete) {
    return result("recovery-required", ["finalization_not_complete"]);
  }
  if (!evidence.event_references_resolved) {
    return result("quarantine", ["event_reference_unresolved"]);
  }
  if (!evidence.event_references_same_epoch) {
    return result("quarantine", ["event_reference_cross_epoch"]);
  }
  if (evidence.lease_live) return result("recovery-required", ["command_state_lease_live"]);
  if (!evidence.stale_writer_grace_elapsed) {
    return result("live-required", ["stale_writer_grace_not_elapsed"]);
  }
  return result("pack-eligible", ["sealed_terminal_state"]);
}

function classifyCommittedReceipt(
  evidence: EventV3SupportClassificationEvidence,
): EventV3SupportClassification {
  if (evidence.authority_state === "active" && !evidence.active_committed_receipt_enabled) {
    return result("live-required", ["active_committed_receipt_deferred"]);
  }
  if (evidence.ready_sibling) return result("recovery-required", ["receipt_has_ready_sibling"]);
  if (evidence.producer_pending_reference) {
    return result("recovery-required", ["producer_pending_reference"]);
  }
  if (!evidence.event_references_resolved) {
    return result("quarantine", ["event_reference_unresolved"]);
  }
  if (!evidence.event_references_same_epoch) {
    return result("quarantine", ["event_reference_cross_epoch"]);
  }
  if (!evidence.event_row_digest_matches) {
    return result("quarantine", ["receipt_digest_mismatch"]);
  }
  if (!evidence.transaction_digest_matches) {
    return result("quarantine", ["transaction_digest_mismatch"]);
  }
  if (evidence.lease_live) return result("recovery-required", ["authority_lease_live"]);
  if (!evidence.receipt_grace_elapsed) {
    return result("live-required", ["committed_receipt_grace_not_elapsed"]);
  }
  return result("pack-eligible", ["committed_receipt_reconciled"]);
}

function result(
  disposition: EventV3SupportDisposition,
  reasons: EventV3SupportClassificationReason[],
): EventV3SupportClassification {
  return { disposition, reasons: [...new Set(reasons)].sort() };
}
