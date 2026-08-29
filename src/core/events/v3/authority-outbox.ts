import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import type { EventV3 } from "./contract.ts";
import { assertEventV3 } from "./validate.ts";
import { ensureEventV3Layout, eventV3Paths, writeEventV3 } from "./writer.ts";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const INSTANCE_PATTERN = /^inst_[a-zA-Z0-9._-]{1,128}$/;
const TX_PATTERN = /^txn_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REASON_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export type AuthorityMutationV3 =
  | {
      kind: "task.transition";
      state: "set" | "cleared";
      task_fingerprint?: `sha256:${string}`;
    }
  | {
      kind: "lifecycle.transition";
      state: "active" | "blocked" | "done";
      reason_code?: string;
    }
  | {
      kind: "claim.transition";
      operation: "acquired" | "released";
      target_fingerprint: `sha256:${string}`;
      access: "read" | "write";
    }
  | {
      kind: "identity.assume";
      identity_id: string;
    }
  | {
      kind: "decision.resolve";
      decision_id: string;
      outcome: "approved" | "denied" | "deferred";
    }
  | {
      kind: "wait.start";
      wait_id: string;
      wait_kind:
        | "permission"
        | "approval"
        | "decision"
        | "operator_input"
        | "dependency"
        | "scheduled";
    }
  | {
      kind: "wait.end";
      wait_id: string;
      outcome:
        | "succeeded"
        | "failed"
        | "cancelled"
        | "timed_out"
        | "denied"
        | "interrupted"
        | "unknown";
    };

export interface PrepareAuthorityTransactionV3Input {
  transaction_id?: `txn_${string}`;
  expected_prior_state_digest: `sha256:${string}`;
  desired_state_digest: `sha256:${string}`;
  actor_instance_id: string;
  subject_instance_id: string;
  mutation: AuthorityMutationV3;
  event: EventV3;
}

export interface AuthorityTransactionV3 {
  format: "harnery-event-v3-authority-transaction";
  format_version: 1;
  transaction_id: `txn_${string}`;
  expected_prior_state_digest: `sha256:${string}`;
  desired_state_digest: `sha256:${string}`;
  actor_instance_id: string;
  subject_instance_id: string;
  mutation: AuthorityMutationV3;
  event_id: string;
  event_row: string;
}

export interface AuthorityReceiptV3 {
  format: "harnery-event-v3-authority-receipt";
  format_version: 1;
  transaction_id: `txn_${string}`;
  transaction_digest: `sha256:${string}`;
  desired_state_digest: `sha256:${string}`;
  event_id: string;
  event_row_digest: `sha256:${string}`;
  committed_at: string;
}

export interface AuthorityReconcilerV3 {
  readStateDigest: () => `sha256:${string}`;
  apply: (mutation: AuthorityMutationV3, transactionId: string) => void;
  now?: () => Date;
}

/** Durably publish the full transaction before any authority-bearing state mutation. */
export function prepareAuthorityTransactionV3(
  coordRoot: string,
  input: PrepareAuthorityTransactionV3Input,
): AuthorityTransactionV3 {
  return publishAuthorityTransactionV3(coordRoot, buildAuthorityTransactionV3(input));
}

/** Build and validate an authority transaction without touching durable state. */
export function buildAuthorityTransactionV3(
  input: PrepareAuthorityTransactionV3Input,
): AuthorityTransactionV3 {
  assertEventV3(input.event);
  const transaction: AuthorityTransactionV3 = {
    format: "harnery-event-v3-authority-transaction",
    format_version: 1,
    transaction_id: input.transaction_id ?? `txn_${randomUUID()}`,
    expected_prior_state_digest: input.expected_prior_state_digest,
    desired_state_digest: input.desired_state_digest,
    actor_instance_id: input.actor_instance_id,
    subject_instance_id: input.subject_instance_id,
    mutation: input.mutation,
    event_id: input.event.event_id,
    event_row: `${canonicalJsonV3(input.event)}\n`,
  };
  validateTransaction(transaction);
  return transaction;
}

/** Publish an already-built transaction exactly, preserving its pre-minted event. */
export function publishAuthorityTransactionV3(
  coordRoot: string,
  transaction: AuthorityTransactionV3,
): AuthorityTransactionV3 {
  validateTransaction(transaction);
  const paths = ensureEventV3Layout(coordRoot);
  const readyPath = authorityReadyPath(paths.authorityOutbox, transaction.transaction_id);
  const serialized = `${canonicalJsonV3(transaction)}\n`;
  if (existsSync(readyPath)) {
    if (readFileSync(readyPath, "utf8") !== serialized) {
      throw new Error("authority transaction ID conflicts with another ready transaction");
    }
    return transaction;
  }
  try {
    publishExclusive(readyPath, serialized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(readyPath, "utf8") !== serialized) {
      throw new Error("authority transaction ID conflicts with another ready transaction");
    }
  }
  return transaction;
}

/** Apply or recognize the desired state, durably submit its event, then leave a hash-only receipt. */
export function reconcileAuthorityTransactionV3(
  coordRoot: string,
  transactionId: string,
  reconciler: AuthorityReconcilerV3,
): AuthorityReceiptV3 {
  assertTransactionId(transactionId);
  const paths = ensureEventV3Layout(coordRoot);
  const committedPath = authorityCommittedPath(paths.authorityOutbox, transactionId);
  if (existsSync(committedPath)) return readAuthorityReceiptV3(committedPath);
  const readyPath = authorityReadyPath(paths.authorityOutbox, transactionId);
  const transaction = readAuthorityTransactionV3(readyPath);
  const current = reconciler.readStateDigest();
  if (current === transaction.expected_prior_state_digest) {
    reconciler.apply(transaction.mutation, transaction.transaction_id);
  } else if (current !== transaction.desired_state_digest) {
    throw new Error("authority transaction prior state conflicts with current state");
  }
  if (reconciler.readStateDigest() !== transaction.desired_state_digest) {
    throw new Error("authority transaction did not reach its declared desired state");
  }
  const event = JSON.parse(transaction.event_row) as unknown;
  assertEventV3(event);
  writeEventV3(coordRoot, event);
  const receipt: AuthorityReceiptV3 = {
    format: "harnery-event-v3-authority-receipt",
    format_version: 1,
    transaction_id: transaction.transaction_id,
    transaction_digest: sha256V3(`${canonicalJsonV3(transaction)}\n`),
    desired_state_digest: transaction.desired_state_digest,
    event_id: transaction.event_id,
    event_row_digest: sha256V3(transaction.event_row),
    committed_at: (reconciler.now ?? (() => new Date()))().toISOString(),
  };
  try {
    publishExclusive(committedPath, `${canonicalJsonV3(receipt)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readAuthorityReceiptV3(committedPath);
  }
  unlinkSync(readyPath);
  fsyncParentDirectory(readyPath);
  return receipt;
}

export function listPendingAuthorityTransactionsV3(coordRoot: string): AuthorityTransactionV3[] {
  const outbox = eventV3Paths(coordRoot).authorityOutbox;
  if (!existsSync(outbox)) return [];
  return readdirSync(outbox)
    .filter((name) => name.endsWith(".ready.json"))
    .sort()
    .map((name) => readAuthorityTransactionV3(join(outbox, name)));
}

export function authorityRecoveryIntentPathV3(coordRoot: string, transactionId: string): string {
  assertTransactionId(transactionId);
  return join(eventV3Paths(coordRoot).root, "authority-recoveries", `${transactionId}.ready.json`);
}

export function readAuthorityTransactionV3(path: string): AuthorityTransactionV3 {
  const serialized = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("authority transaction is malformed");
  }
  const transaction = validateTransaction(parsed);
  if (`${canonicalJsonV3(transaction)}\n` !== serialized) {
    throw new Error("authority transaction is not canonical");
  }
  return transaction;
}

export function readAuthorityReceiptV3(path: string): AuthorityReceiptV3 {
  const serialized = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("authority receipt is malformed");
  }
  const receipt = validateReceipt(parsed);
  if (`${canonicalJsonV3(receipt)}\n` !== serialized) {
    throw new Error("authority receipt is not canonical");
  }
  return receipt;
}

function validateTransaction(value: unknown): AuthorityTransactionV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("authority transaction envelope is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
    "actor_instance_id\0desired_state_digest\0event_id\0event_row\0expected_prior_state_digest\0format\0format_version\0mutation\0subject_instance_id\0transaction_id"
  ) {
    throw new Error("authority transaction has unsupported fields");
  }
  if (
    record.format !== "harnery-event-v3-authority-transaction" ||
    record.format_version !== 1 ||
    typeof record.transaction_id !== "string" ||
    typeof record.expected_prior_state_digest !== "string" ||
    typeof record.desired_state_digest !== "string" ||
    typeof record.actor_instance_id !== "string" ||
    typeof record.subject_instance_id !== "string" ||
    typeof record.event_id !== "string" ||
    typeof record.event_row !== "string"
  ) {
    throw new Error("authority transaction values are invalid");
  }
  assertTransactionId(record.transaction_id);
  if (
    !SHA256_PATTERN.test(record.expected_prior_state_digest) ||
    !SHA256_PATTERN.test(record.desired_state_digest) ||
    !INSTANCE_PATTERN.test(record.actor_instance_id) ||
    !INSTANCE_PATTERN.test(record.subject_instance_id)
  ) {
    throw new Error("authority transaction authority fields are invalid");
  }
  const mutation = validateMutation(record.mutation);
  let event: unknown;
  try {
    event = JSON.parse(record.event_row);
  } catch {
    throw new Error("authority transaction event row is malformed");
  }
  assertEventV3(event);
  if (record.event_id !== event.event_id || `${canonicalJsonV3(event)}\n` !== record.event_row) {
    throw new Error("authority transaction event row is not canonical or mismatched");
  }
  const transaction = { ...(record as unknown as AuthorityTransactionV3), mutation };
  validateTransactionBinding(transaction, event);
  return transaction;
}

function validateMutation(value: unknown): AuthorityMutationV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("authority mutation is invalid");
  }
  const mutation = value as Record<string, unknown>;
  if (mutation.kind === "task.transition") {
    const allowed =
      mutation.task_fingerprint === undefined ? "kind\0state" : "kind\0state\0task_fingerprint";
    if (
      Object.keys(mutation).sort().join("\0") !== allowed ||
      !["set", "cleared"].includes(String(mutation.state)) ||
      (mutation.state === "set" &&
        (typeof mutation.task_fingerprint !== "string" ||
          !SHA256_PATTERN.test(mutation.task_fingerprint))) ||
      (mutation.state === "cleared" && mutation.task_fingerprint !== undefined)
    ) {
      throw new Error("authority task mutation is invalid");
    }
  } else if (mutation.kind === "lifecycle.transition") {
    const allowed = mutation.reason_code === undefined ? "kind\0state" : "kind\0reason_code\0state";
    if (
      Object.keys(mutation).sort().join("\0") !== allowed ||
      !["active", "blocked", "done"].includes(String(mutation.state)) ||
      (mutation.reason_code !== undefined &&
        (typeof mutation.reason_code !== "string" || !REASON_PATTERN.test(mutation.reason_code)))
    ) {
      throw new Error("authority lifecycle mutation is invalid");
    }
  } else if (mutation.kind === "claim.transition") {
    if (
      Object.keys(mutation).sort().join("\0") !== "access\0kind\0operation\0target_fingerprint" ||
      !["read", "write"].includes(String(mutation.access)) ||
      !["acquired", "released"].includes(String(mutation.operation)) ||
      typeof mutation.target_fingerprint !== "string" ||
      !SHA256_PATTERN.test(mutation.target_fingerprint)
    ) {
      throw new Error("authority claim mutation is invalid");
    }
  } else if (mutation.kind === "identity.assume") {
    if (
      Object.keys(mutation).sort().join("\0") !== "identity_id\0kind" ||
      typeof mutation.identity_id !== "string" ||
      !SAFE_ID_PATTERN.test(mutation.identity_id)
    ) {
      throw new Error("authority identity mutation is invalid");
    }
  } else if (mutation.kind === "decision.resolve") {
    if (
      Object.keys(mutation).sort().join("\0") !== "decision_id\0kind\0outcome" ||
      typeof mutation.decision_id !== "string" ||
      !SAFE_ID_PATTERN.test(mutation.decision_id) ||
      !["approved", "denied", "deferred"].includes(String(mutation.outcome))
    ) {
      throw new Error("authority decision mutation is invalid");
    }
  } else if (mutation.kind === "wait.start") {
    if (
      Object.keys(mutation).sort().join("\0") !== "kind\0wait_id\0wait_kind" ||
      typeof mutation.wait_id !== "string" ||
      !SAFE_ID_PATTERN.test(mutation.wait_id) ||
      !["permission", "approval", "decision", "operator_input", "dependency", "scheduled"].includes(
        String(mutation.wait_kind),
      )
    ) {
      throw new Error("authority wait-start mutation is invalid");
    }
  } else if (mutation.kind === "wait.end") {
    if (
      Object.keys(mutation).sort().join("\0") !== "kind\0outcome\0wait_id" ||
      typeof mutation.wait_id !== "string" ||
      !SAFE_ID_PATTERN.test(mutation.wait_id) ||
      ![
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "denied",
        "interrupted",
        "unknown",
      ].includes(String(mutation.outcome))
    ) {
      throw new Error("authority wait-end mutation is invalid");
    }
  } else {
    throw new Error("authority mutation kind is unsupported");
  }
  return mutation as unknown as AuthorityMutationV3;
}

function validateTransactionBinding(transaction: AuthorityTransactionV3, event: EventV3): void {
  if (
    event.scope.instance_id !== transaction.actor_instance_id ||
    event.provenance.attribution.state !== "verified" ||
    event.provenance.attribution.observer_instance_id !== transaction.actor_instance_id ||
    event.provenance.attribution.subject_instance_id !== transaction.subject_instance_id
  ) {
    throw new Error("authority transaction attribution does not match its event");
  }
  const mutation = transaction.mutation;
  if (mutation.kind === "task.transition") {
    if (
      event.event_type !== "coord.task_changed" ||
      event.payload.actor_instance_id !== transaction.actor_instance_id ||
      event.payload.subject_instance_id !== transaction.subject_instance_id ||
      event.payload.authority.transaction_id !== transaction.transaction_id ||
      event.payload.new_state !== mutation.state ||
      event.payload.reason_fingerprint?.digest !== mutation.task_fingerprint
    ) {
      throw new Error("authority task transaction does not match its event");
    }
    return;
  }
  if (mutation.kind === "lifecycle.transition") {
    if (
      event.event_type !== "coord.lifecycle_changed" ||
      event.payload.actor_instance_id !== transaction.actor_instance_id ||
      event.payload.subject_instance_id !== transaction.subject_instance_id ||
      event.payload.authority.transaction_id !== transaction.transaction_id ||
      event.payload.new_state !== mutation.state ||
      event.payload.reason !== (mutation.reason_code ?? "lifecycle_transition")
    ) {
      throw new Error("authority lifecycle transaction does not match its event");
    }
    return;
  }
  if (mutation.kind === "claim.transition") {
    const operation = mutation.operation;
    if (
      event.event_type !== "coord.claim_changed" ||
      event.payload.actor_instance_id !== transaction.actor_instance_id ||
      event.payload.subject_instance_id !== transaction.subject_instance_id ||
      event.payload.authority.transaction_id !== transaction.transaction_id ||
      event.payload.operation !== operation ||
      event.payload.target.fingerprint.digest !== mutation.target_fingerprint ||
      event.payload.access !== mutation.access
    ) {
      throw new Error("authority claim transaction does not match its event");
    }
    return;
  }
  if (mutation.kind === "identity.assume") {
    if (
      event.event_type !== "coord.identity_attested" ||
      event.payload.actor_instance_id !== transaction.actor_instance_id ||
      event.payload.subject_instance_id !== transaction.subject_instance_id ||
      event.payload.authority.transaction_id !== transaction.transaction_id ||
      event.payload.identity_id !== mutation.identity_id
    ) {
      throw new Error("authority identity transaction does not match its event");
    }
    return;
  }
  if (mutation.kind === "decision.resolve") {
    if (
      event.event_type !== "decision.state_changed" ||
      event.payload.authority.transaction_id !== transaction.transaction_id ||
      event.payload.decision_id !== mutation.decision_id ||
      event.payload.new_state !== mutation.outcome
    ) {
      throw new Error("authority decision transaction does not match its event");
    }
    return;
  }
  if (mutation.kind === "wait.start") {
    if (
      event.event_type !== "wait.started" ||
      event.payload.authority_reference !== transaction.transaction_id ||
      event.payload.wait_id !== mutation.wait_id ||
      event.payload.kind !== mutation.wait_kind
    ) {
      throw new Error("authority wait-start transaction does not match its event");
    }
    return;
  }
  if (mutation.kind !== "wait.end") {
    throw new Error("authority transaction mutation binding is unsupported");
  }
  if (
    event.event_type !== "wait.ended" ||
    event.payload.resolution_reference !== transaction.transaction_id ||
    event.payload.wait_id !== mutation.wait_id ||
    event.payload.outcome !== mutation.outcome
  ) {
    throw new Error("authority wait-end transaction does not match its event");
  }
}

function validateReceipt(value: unknown): AuthorityReceiptV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("authority receipt is invalid");
  }
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join("\0") !==
      "committed_at\0desired_state_digest\0event_id\0event_row_digest\0format\0format_version\0transaction_digest\0transaction_id" ||
    receipt.format !== "harnery-event-v3-authority-receipt" ||
    receipt.format_version !== 1 ||
    typeof receipt.transaction_id !== "string" ||
    typeof receipt.transaction_digest !== "string" ||
    typeof receipt.desired_state_digest !== "string" ||
    typeof receipt.event_id !== "string" ||
    typeof receipt.event_row_digest !== "string" ||
    typeof receipt.committed_at !== "string" ||
    !SHA256_PATTERN.test(receipt.transaction_digest) ||
    !SHA256_PATTERN.test(receipt.desired_state_digest) ||
    !SHA256_PATTERN.test(receipt.event_row_digest) ||
    Number.isNaN(Date.parse(receipt.committed_at))
  ) {
    throw new Error("authority receipt values are invalid");
  }
  assertTransactionId(receipt.transaction_id);
  return receipt as unknown as AuthorityReceiptV3;
}

function publishExclusive(path: string, serialized: string): void {
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

function authorityReadyPath(outbox: string, transactionId: string): string {
  assertTransactionId(transactionId);
  return join(outbox, `${transactionId}.ready.json`);
}

function authorityCommittedPath(outbox: string, transactionId: string): string {
  assertTransactionId(transactionId);
  return join(outbox, `${transactionId}.committed.json`);
}

function assertTransactionId(value: string): void {
  if (!TX_PATTERN.test(value)) throw new Error("authority transaction ID is invalid");
}
