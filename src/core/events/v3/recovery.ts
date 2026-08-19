import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import { readEventV3ControlState } from "./control.ts";
import {
  digestEventV3AuthorityDirectoryV3,
  inspectInvalidActiveAuthorityV3,
  readLedgerV3,
} from "./reader.ts";
import {
  type EventV3RecoveryFailure,
  type EventV3RecoveryIntent,
  type EventV3RecoveryReceipt,
  eventV3RecoveryRecordsRoot,
  listEventV3RecoveryReceipts,
  readEventV3RecoveryIntent,
  readEventV3RecoveryReceipt,
  validateEventV3RecoveryIntent,
  validateEventV3RecoveryReceipt,
} from "./recovery-record.ts";

export interface RecoverInvalidEventLedgerV3Input {
  coordRoot: string;
  harneryBuild: string;
  hostBuild: string;
  configDigest: `sha256:${string}`;
  approvalRecordId: string;
  now?: () => Date;
}

export interface RecoverInvalidEventLedgerV3Result {
  state: "recovered" | "already_recovered";
  receipt: EventV3RecoveryReceipt;
}

/**
 * Preserve one failed active authority intact and start a clean epoch.
 *
 * The durable intent makes retries idempotent across the archive, genesis,
 * activation, and receipt publication boundaries. Event bytes are never
 * copied into the new authority or retained in the recovery metadata.
 */
export function recoverInvalidEventLedgerV3(
  input: RecoverInvalidEventLedgerV3Input,
): RecoverInvalidEventLedgerV3Result {
  const root = resolve(input.coordRoot);
  const current = readEventV3ControlState(root);
  const committed = listEventV3RecoveryReceipts(root);
  if (current.state === "active") {
    const genesisId = current.genesis.event.payload.genesis_id;
    const existing = committed.find(({ new_authority }) => new_authority.genesis_id === genesisId);
    if (existing) {
      removePendingIntent(root, existing.recovery_id);
      return { state: "already_recovered", receipt: existing };
    }
  }

  const pending = listPendingRecoveryIntents(root);
  if (pending.length > 1) throw new Error("event_v3_recovery_has_multiple_pending_intents");
  let intent = pending[0];
  let archivedEpoch: string | undefined;

  if (current.state === "invalid") {
    if (current.reason !== "ledger_integrity_failure") {
      throw new Error(`event_v3_recovery_requires_ledger_integrity_failure:${current.reason}`);
    }
    const failure = inspectInvalidActiveAuthorityV3(root, current.reason);
    const recoveryId = recoveryIdFor(failure);
    if (intent && intent.recovery_id !== recoveryId) {
      throw new Error("event_v3_recovery_pending_intent_conflicts_with_failed_authority");
    }
    intent ??= publishRecoveryIntent(root, {
      format: "harnery-event-v3-recovery-intent",
      format_version: 1,
      recovery_id: recoveryId,
      created_at: (input.now ?? (() => new Date()))().toISOString(),
      approval_record_id: input.approvalRecordId,
      harnery_build: input.harneryBuild,
      host_build: input.hostBuild,
      config_digest: input.configDigest,
      failure,
    });
    const initialized = initializeEventLedgerV3({
      coordRoot: root,
      harneryBuild: intent.harnery_build,
      hostBuild: intent.host_build,
      configDigest: intent.config_digest,
      approvalRecordId: intent.approval_record_id,
      forceNewEpoch: true,
      now: () => new Date(intent.created_at),
    });
    archivedEpoch = initialized.archived_epoch;
  } else if (intent) {
    const initialized = initializeEventLedgerV3({
      coordRoot: root,
      harneryBuild: intent.harnery_build,
      hostBuild: intent.host_build,
      configDigest: intent.config_digest,
      approvalRecordId: intent.approval_record_id,
      resumeCandidate: true,
      now: () => new Date(intent.created_at),
    });
    archivedEpoch = initialized.archived_epoch;
  } else {
    throw new Error(`event_v3_recovery_not_required:${current.state}`);
  }

  if (!intent) throw new Error("event_v3_recovery_intent_unavailable");
  return {
    state: "recovered",
    receipt: commitRecoveryReceipt(root, intent, archivedEpoch, input.now),
  };
}

function recoveryIdFor(failure: EventV3RecoveryFailure): `rcv_${string}` {
  const digest = createRecoveryDigest(failure);
  return `rcv_${digest.slice(7, 39)}`;
}

function publishRecoveryIntent(root: string, value: EventV3RecoveryIntent): EventV3RecoveryIntent {
  const intent = validateEventV3RecoveryIntent(value);
  const records = eventV3RecoveryRecordsRoot(root);
  mkdirSync(records, { recursive: true, mode: 0o700 });
  chmodSync(records, 0o700);
  const path = recoveryIntentPath(records, intent.recovery_id);
  const serialized = `${canonicalJsonV3(intent)}\n`;
  if (existsSync(path)) {
    const existing = readEventV3RecoveryIntent(path);
    if (canonicalJsonV3(existing) !== canonicalJsonV3(intent)) {
      throw new Error("event_v3_recovery_intent_conflict");
    }
    return existing;
  }
  try {
    publishExclusive(path, serialized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readEventV3RecoveryIntent(path);
    if (canonicalJsonV3(existing) !== canonicalJsonV3(intent)) {
      throw new Error("event_v3_recovery_intent_conflict");
    }
    return existing;
  }
  return intent;
}

function commitRecoveryReceipt(
  root: string,
  intent: EventV3RecoveryIntent,
  archivedEpoch: string | undefined,
  now: RecoverInvalidEventLedgerV3Input["now"],
): EventV3RecoveryReceipt {
  const control = readEventV3ControlState(root);
  if (control.state !== "active") {
    throw new Error(`event_v3_recovery_new_authority_unavailable:${control.state}`);
  }
  const current = readLedgerV3(root, { authority: "active" });
  if (!current.complete) throw new Error("event_v3_recovery_new_authority_is_incomplete");
  const archive = archivedEpoch ?? findArchivedAuthority(root, intent.failure.authority_digest);
  if (!archive || digestEventV3AuthorityDirectoryV3(archive) !== intent.failure.authority_digest) {
    throw new Error("event_v3_recovery_failed_authority_digest_mismatch");
  }
  const receipt = validateEventV3RecoveryReceipt({
    format: "harnery-event-v3-recovery-receipt",
    format_version: 1,
    recovery_id: intent.recovery_id,
    created_at: intent.created_at,
    completed_at: (now ?? (() => new Date()))().toISOString(),
    approval_record_id: intent.approval_record_id,
    failure: intent.failure,
    archive_directory: basename(archive),
    new_authority: {
      genesis_id: control.genesis.event.payload.genesis_id,
      activation_id: control.activation.activation_id,
    },
  });
  const records = eventV3RecoveryRecordsRoot(root);
  const committedPath = recoveryReceiptPath(records, intent.recovery_id);
  const serialized = `${canonicalJsonV3(receipt)}\n`;
  if (existsSync(committedPath)) {
    const existing = readEventV3RecoveryReceipt(committedPath);
    if (canonicalJsonV3(existing) !== canonicalJsonV3(receipt)) {
      throw new Error("event_v3_recovery_receipt_conflict");
    }
    removePendingIntent(root, intent.recovery_id);
    return existing;
  }
  try {
    publishExclusive(committedPath, serialized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readEventV3RecoveryReceipt(committedPath);
    if (canonicalJsonV3(existing) !== canonicalJsonV3(receipt)) {
      throw new Error("event_v3_recovery_receipt_conflict");
    }
    removePendingIntent(root, intent.recovery_id);
    return existing;
  }
  removePendingIntent(root, intent.recovery_id);
  return receipt;
}

function removePendingIntent(root: string, recoveryId: string): void {
  const readyPath = recoveryIntentPath(eventV3RecoveryRecordsRoot(root), recoveryId);
  if (!existsSync(readyPath)) return;
  unlinkSync(readyPath);
  fsyncParentDirectory(readyPath);
}

function listPendingRecoveryIntents(root: string): EventV3RecoveryIntent[] {
  const records = eventV3RecoveryRecordsRoot(root);
  if (!existsSync(records)) return [];
  return readdirSync(records)
    .filter((name) => name.endsWith(".ready.json"))
    .sort()
    .map((name) => readEventV3RecoveryIntent(join(records, name)));
}

function findArchivedAuthority(root: string, digest: string): string | undefined {
  const archives = join(resolve(root), ".harnery", "ledgers", "v3-archives");
  if (!existsSync(archives)) return undefined;
  const matches = readdirSync(archives, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^epoch-[0-9]+(?:-[0-9]+)?$/.test(entry.name))
    .map((entry) => join(archives, entry.name))
    .filter((path) => digestEventV3AuthorityDirectoryV3(path) === digest);
  if (matches.length > 1) throw new Error("event_v3_recovery_archive_digest_is_ambiguous");
  return matches[0];
}

function createRecoveryDigest(failure: EventV3RecoveryFailure): `sha256:${string}` {
  return sha256V3(canonicalJsonV3(failure));
}

function recoveryIntentPath(records: string, recoveryId: string): string {
  return join(records, `${recoveryId}.ready.json`);
}

function recoveryReceiptPath(records: string, recoveryId: string): string {
  return join(records, `${recoveryId}.committed.json`);
}

function publishExclusive(path: string, serialized: string): void {
  const temporary = `${path}.tmp.${process.pid}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, path);
    fsyncParentDirectory(path);
    unlinkSync(temporary);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
