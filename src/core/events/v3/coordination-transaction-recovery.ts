import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import {
  type AuthorityTransactionV3,
  authorityRecoveryIntentPathV3,
  readAuthorityTransactionV3,
} from "./authority-outbox.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import {
  findPendingCoordinationTransactionV3,
  withPendingCoordinationTransactionRecoveryV3,
} from "./producers/coordination-recorder.ts";
import { readLedgerV3 } from "./reader.ts";
import { ensureEventV3Layout } from "./writer.ts";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TX_PATTERN = /^txn_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANCE_PATTERN = /^inst_[a-zA-Z0-9._-]{1,128}$/;
const PRODUCER_STATE_PATTERN = /^hid_[a-f0-9]{64}\.json$/;
const APPROVAL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;

export type CoordinationTransactionRecoveryStep =
  | "intent_published"
  | "transaction_quarantined"
  | "producer_pending_cleared"
  | "outbox_ready_removed"
  | "receipt_committed";

interface CoordinationTransactionQuarantineCommonV3 {
  transaction_id: `txn_${string}`;
  transaction_digest: `sha256:${string}`;
  event_id: string;
  event_row_digest: `sha256:${string}`;
  actor_instance_id: string;
  subject_instance_id: string;
  mutation_kind: string;
  expected_prior_state_digest: `sha256:${string}`;
  desired_state_digest: `sha256:${string}`;
  observed_current_state_digest: `sha256:${string}`;
  approval_record_id: string;
  producer_state_file: string;
  reason: "current_state_conflict";
  created_at: string;
}

export interface CoordinationTransactionQuarantineIntentV3
  extends CoordinationTransactionQuarantineCommonV3 {
  format: "harnery-v3-coordination-transaction-quarantine-intent";
  format_version: 1;
}

export interface CoordinationTransactionQuarantineReceiptV3
  extends CoordinationTransactionQuarantineCommonV3 {
  format: "harnery-v3-coordination-transaction-quarantine-receipt";
  format_version: 1;
  completed_at: string;
  quarantine_file: string;
}

export interface QuarantineConflictingCoordinationTransactionV3Input {
  transaction_id: string;
  actor_instance_id: string;
  observed_current_state_digest: `sha256:${string}`;
  approval_record_id: string;
  now?: () => Date;
  onStep?: (step: CoordinationTransactionRecoveryStep) => void;
}

/**
 * Abandon one authority transaction only after proving that normal recovery is
 * impossible and that its event never entered the ledger or ready spool.
 */
export function quarantineConflictingCoordinationTransactionV3(
  coordRoot: string,
  input: QuarantineConflictingCoordinationTransactionV3Input,
): CoordinationTransactionQuarantineReceiptV3 {
  assertTransactionId(input.transaction_id);
  assertInstanceId(input.actor_instance_id);
  assertDigest(input.observed_current_state_digest, "observed current state digest");
  assertApprovalRecordId(input.approval_record_id);
  const paths = recoveryPaths(coordRoot, input.transaction_id);
  ensureRecoveryLayout(paths);

  if (existsSync(paths.receipt)) {
    const receipt = readReceipt(paths.receipt);
    assertRecoveryBinding(receipt, input);
    removeIfExists(paths.intent);
    return receipt;
  }

  let intent: CoordinationTransactionQuarantineIntentV3;
  let transaction: AuthorityTransactionV3;
  let serializedTransaction: string;
  const recoveryAlreadyStarted = existsSync(paths.intent);
  if (recoveryAlreadyStarted) {
    intent = readIntent(paths.intent);
    assertRecoveryBinding(intent, input);
    ({ transaction, serialized: serializedTransaction } = readQuarantinedOrReadyTransaction(paths));
    assertTransactionMatchesIntent(transaction, serializedTransaction, intent);
  } else {
    if (!existsSync(paths.ready)) {
      throw new Error("authority transaction is not ready for recovery");
    }
    transaction = readAuthorityTransactionV3(paths.ready);
    serializedTransaction = readFileSync(paths.ready, "utf8");
    if (transaction.actor_instance_id !== input.actor_instance_id) {
      throw new Error("authority transaction actor does not match the recovery target");
    }
    if (
      input.observed_current_state_digest === transaction.expected_prior_state_digest ||
      input.observed_current_state_digest === transaction.desired_state_digest
    ) {
      throw new Error("authority transaction is still reconcilable and cannot be quarantined");
    }
    assertEventNeverCommitted(coordRoot, transaction.event_id, paths.committed);
    const pending = findPendingCoordinationTransactionV3(coordRoot, transaction.transaction_id);
    if (!pending) throw new Error("authority transaction has no matching pending producer state");
    if (canonicalJsonV3(pending.transaction) !== canonicalJsonV3(transaction)) {
      throw new Error("authority outbox and producer state transactions do not match");
    }
    const createdAt = (input.now ?? (() => new Date()))().toISOString();
    intent = {
      format: "harnery-v3-coordination-transaction-quarantine-intent",
      format_version: 1,
      ...transactionFacts(transaction, serializedTransaction),
      observed_current_state_digest: input.observed_current_state_digest,
      approval_record_id: input.approval_record_id,
      producer_state_file: pending.producer_state_file,
      reason: "current_state_conflict",
      created_at: createdAt,
    };
  }

  return withPendingCoordinationTransactionRecoveryV3(
    coordRoot,
    intent.producer_state_file,
    transaction,
    recoveryAlreadyStarted,
    ({ clearPending }) => {
      assertEventNeverCommitted(coordRoot, transaction.event_id, paths.committed);
      publishCanonicalExclusive(paths.intent, intent);
      input.onStep?.("intent_published");

      publishSerializedExclusive(paths.quarantine, serializedTransaction);
      input.onStep?.("transaction_quarantined");

      clearPending();
      input.onStep?.("producer_pending_cleared");

      if (existsSync(paths.ready)) {
        if (readFileSync(paths.ready, "utf8") !== serializedTransaction) {
          throw new Error("authority ready transaction changed during recovery");
        }
        unlinkSync(paths.ready);
        fsyncParentDirectory(paths.ready);
      }
      input.onStep?.("outbox_ready_removed");

      const receipt: CoordinationTransactionQuarantineReceiptV3 = {
        format: "harnery-v3-coordination-transaction-quarantine-receipt",
        format_version: 1,
        ...commonIntentFields(intent),
        completed_at: (input.now ?? (() => new Date()))().toISOString(),
        quarantine_file: `quarantine/${input.transaction_id}.json`,
      };
      if (Date.parse(receipt.completed_at) < Date.parse(receipt.created_at)) {
        throw new Error("authority transaction recovery clock moved backwards");
      }
      publishCanonicalExclusive(paths.receipt, receipt);
      input.onStep?.("receipt_committed");
      removeIfExists(paths.intent);
      return receipt;
    },
  );
}

function transactionFacts(
  transaction: AuthorityTransactionV3,
  serialized: string,
): Pick<
  CoordinationTransactionQuarantineCommonV3,
  | "transaction_id"
  | "transaction_digest"
  | "event_id"
  | "event_row_digest"
  | "actor_instance_id"
  | "subject_instance_id"
  | "mutation_kind"
  | "expected_prior_state_digest"
  | "desired_state_digest"
> {
  return {
    transaction_id: transaction.transaction_id,
    transaction_digest: sha256V3(serialized),
    event_id: transaction.event_id,
    event_row_digest: sha256V3(transaction.event_row),
    actor_instance_id: transaction.actor_instance_id,
    subject_instance_id: transaction.subject_instance_id,
    mutation_kind: transaction.mutation.kind,
    expected_prior_state_digest: transaction.expected_prior_state_digest,
    desired_state_digest: transaction.desired_state_digest,
  };
}

function commonIntentFields(
  intent: CoordinationTransactionQuarantineIntentV3,
): CoordinationTransactionQuarantineCommonV3 {
  const { format: _format, format_version: _formatVersion, ...common } = intent;
  return common;
}

function assertEventNeverCommitted(
  coordRoot: string,
  eventId: string,
  committedReceiptPath: string,
): void {
  if (existsSync(committedReceiptPath)) {
    throw new Error("authority transaction already has a committed receipt");
  }
  if (readLedgerV3(coordRoot).events.some(({ event }) => event.event_id === eventId)) {
    throw new Error("authority transaction event is already present in the ledger");
  }
  const spool = ensureEventV3Layout(coordRoot).spool;
  for (const name of readdirSync(spool)
    .filter((entry) => entry.endsWith(".ready"))
    .sort()) {
    let event: unknown;
    try {
      event = JSON.parse(readFileSync(join(spool, name), "utf8"));
    } catch {
      throw new Error("V3 ready spool is unreadable during authority recovery");
    }
    if (
      event &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as Record<string, unknown>).event_id === eventId
    ) {
      throw new Error("authority transaction event is already present in the ready spool");
    }
  }
}

function readQuarantinedOrReadyTransaction(paths: ReturnType<typeof recoveryPaths>): {
  transaction: AuthorityTransactionV3;
  serialized: string;
} {
  const path = existsSync(paths.quarantine) ? paths.quarantine : paths.ready;
  if (!existsSync(path)) throw new Error("authority transaction recovery lost its durable record");
  return { transaction: readAuthorityTransactionV3(path), serialized: readFileSync(path, "utf8") };
}

function assertTransactionMatchesIntent(
  transaction: AuthorityTransactionV3,
  serialized: string,
  intent: CoordinationTransactionQuarantineIntentV3,
): void {
  const facts = transactionFacts(transaction, serialized);
  for (const [key, value] of Object.entries(facts)) {
    if (intent[key as keyof typeof intent] !== value) {
      throw new Error("authority transaction recovery intent no longer matches its transaction");
    }
  }
}

function assertRecoveryBinding(
  record: CoordinationTransactionQuarantineIntentV3 | CoordinationTransactionQuarantineReceiptV3,
  input: QuarantineConflictingCoordinationTransactionV3Input,
): void {
  if (
    record.transaction_id !== input.transaction_id ||
    record.actor_instance_id !== input.actor_instance_id ||
    record.approval_record_id !== input.approval_record_id
  ) {
    throw new Error("authority transaction recovery record does not match this request");
  }
}

function recoveryPaths(coordRoot: string, transactionId: string) {
  const ledger = ensureEventV3Layout(coordRoot);
  const root = join(ledger.root, "authority-recoveries");
  return {
    root,
    quarantineRoot: join(root, "quarantine"),
    intent: authorityRecoveryIntentPathV3(coordRoot, transactionId),
    receipt: join(root, `${transactionId}.committed.json`),
    quarantine: join(root, "quarantine", `${transactionId}.json`),
    ready: join(ledger.authorityOutbox, `${transactionId}.ready.json`),
    committed: join(ledger.authorityOutbox, `${transactionId}.committed.json`),
  };
}

function ensureRecoveryLayout(paths: ReturnType<typeof recoveryPaths>): void {
  for (const path of [paths.root, paths.quarantineRoot]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

function publishCanonicalExclusive(path: string, value: unknown): void {
  publishSerializedExclusive(path, `${canonicalJsonV3(value)}\n`);
}

function publishSerializedExclusive(path: string, serialized: string): void {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== serialized) {
      throw new Error("authority transaction recovery record conflicts with an existing record");
    }
    return;
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
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

function readIntent(path: string): CoordinationTransactionQuarantineIntentV3 {
  return readCanonicalRecord(path, validateIntent);
}

function readReceipt(path: string): CoordinationTransactionQuarantineReceiptV3 {
  return readCanonicalRecord(path, validateReceipt);
}

function readCanonicalRecord<T>(path: string, validate: (value: unknown) => T): T {
  let text: string;
  let parsed: unknown;
  try {
    text = readFileSync(path, "utf8");
    parsed = JSON.parse(text);
  } catch {
    throw new Error("authority transaction recovery record is malformed");
  }
  const value = validate(parsed);
  if (text !== `${canonicalJsonV3(value)}\n`) {
    throw new Error("authority transaction recovery record is not canonical");
  }
  return value;
}

function validateIntent(value: unknown): CoordinationTransactionQuarantineIntentV3 {
  const record = validateCommon(value, ["format", "format_version"]);
  if (
    record.format !== "harnery-v3-coordination-transaction-quarantine-intent" ||
    record.format_version !== 1
  ) {
    throw new Error("authority transaction recovery intent is invalid");
  }
  return record as unknown as CoordinationTransactionQuarantineIntentV3;
}

function validateReceipt(value: unknown): CoordinationTransactionQuarantineReceiptV3 {
  const record = validateCommon(value, [
    "completed_at",
    "format",
    "format_version",
    "quarantine_file",
  ]);
  if (
    record.format !== "harnery-v3-coordination-transaction-quarantine-receipt" ||
    record.format_version !== 1 ||
    !timestamp(record.completed_at) ||
    Date.parse(String(record.completed_at)) < Date.parse(String(record.created_at)) ||
    record.quarantine_file !== `quarantine/${record.transaction_id}.json`
  ) {
    throw new Error("authority transaction recovery receipt is invalid");
  }
  return record as unknown as CoordinationTransactionQuarantineReceiptV3;
}

function validateCommon(value: unknown, extraKeys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("authority transaction recovery record is invalid");
  }
  const record = value as Record<string, unknown>;
  const commonKeys = [
    "actor_instance_id",
    "approval_record_id",
    "created_at",
    "desired_state_digest",
    "event_id",
    "event_row_digest",
    "expected_prior_state_digest",
    "mutation_kind",
    "observed_current_state_digest",
    "producer_state_file",
    "reason",
    "subject_instance_id",
    "transaction_digest",
    "transaction_id",
  ];
  if (Object.keys(record).sort().join("\0") !== [...commonKeys, ...extraKeys].sort().join("\0")) {
    throw new Error("authority transaction recovery record has unsupported fields");
  }
  if (
    typeof record.transaction_id !== "string" ||
    !TX_PATTERN.test(record.transaction_id) ||
    typeof record.transaction_digest !== "string" ||
    !SHA256_PATTERN.test(record.transaction_digest) ||
    typeof record.event_id !== "string" ||
    record.event_id.length === 0 ||
    typeof record.event_row_digest !== "string" ||
    !SHA256_PATTERN.test(record.event_row_digest) ||
    typeof record.actor_instance_id !== "string" ||
    !INSTANCE_PATTERN.test(record.actor_instance_id) ||
    typeof record.subject_instance_id !== "string" ||
    !INSTANCE_PATTERN.test(record.subject_instance_id) ||
    typeof record.mutation_kind !== "string" ||
    record.mutation_kind.length === 0 ||
    typeof record.expected_prior_state_digest !== "string" ||
    !SHA256_PATTERN.test(record.expected_prior_state_digest) ||
    typeof record.desired_state_digest !== "string" ||
    !SHA256_PATTERN.test(record.desired_state_digest) ||
    typeof record.observed_current_state_digest !== "string" ||
    !SHA256_PATTERN.test(record.observed_current_state_digest) ||
    typeof record.approval_record_id !== "string" ||
    !APPROVAL_PATTERN.test(record.approval_record_id) ||
    typeof record.producer_state_file !== "string" ||
    !PRODUCER_STATE_PATTERN.test(record.producer_state_file) ||
    record.reason !== "current_state_conflict" ||
    !timestamp(record.created_at)
  ) {
    throw new Error("authority transaction recovery record values are invalid");
  }
  return record;
}

function assertTransactionId(value: string): asserts value is `txn_${string}` {
  if (!TX_PATTERN.test(value)) throw new Error("authority transaction ID is invalid");
}

function assertInstanceId(value: string): void {
  if (!INSTANCE_PATTERN.test(value)) throw new Error("authority recovery actor is invalid");
}

function assertDigest(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function assertApprovalRecordId(value: string): void {
  if (!APPROVAL_PATTERN.test(value)) throw new Error("approval record ID is invalid");
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function removeIfExists(path: string): void {
  if (!existsSync(path)) return;
  unlinkSync(path);
  fsyncParentDirectory(path);
}
