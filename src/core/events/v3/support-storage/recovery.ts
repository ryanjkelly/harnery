import {
  digestEventV3LogicalAuthority,
  iterateEventV3LogicalAuthority,
} from "./logical-authority.ts";

export interface VerifyEventV3RecoveryBoundArchiveInput {
  authority_root: string;
  expected_authority_digest: `sha256:${string}`;
  expected_archive_directory?: string;
  archive_directory?: string;
  recovery_receipt_id: string;
}

/** Fail closed unless a recovery receipt still binds one complete logical authority. */
export async function verifyEventV3RecoveryBoundArchive(
  input: VerifyEventV3RecoveryBoundArchiveInput,
): Promise<{
  recovery_receipt_id: string;
  authority_digest: `sha256:${string}`;
  logical_files: number;
  packed_entries: number;
}> {
  if (
    input.expected_archive_directory !== undefined &&
    input.archive_directory !== input.expected_archive_directory
  ) {
    throw new Error("event_v3_support_recovery_archive_binding_mismatch");
  }
  const view = await iterateEventV3LogicalAuthority(input.authority_root);
  if (view.quarantined_packs.length > 0) {
    throw new Error("event_v3_support_recovery_pack_quarantined");
  }
  const digest = await digestEventV3LogicalAuthority(input.authority_root);
  if (digest !== input.expected_authority_digest) {
    throw new Error("event_v3_support_recovery_authority_digest_mismatch");
  }
  return {
    recovery_receipt_id: input.recovery_receipt_id,
    authority_digest: digest,
    logical_files: view.entries.length,
    packed_entries: view.packed_entries,
  };
}
