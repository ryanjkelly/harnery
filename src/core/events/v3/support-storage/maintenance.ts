import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalJsonV3 } from "../canonical.ts";
import type { EventV3SupportInventoryEntry } from "./inventory.ts";
import { digestEventV3LogicalAuthority } from "./logical-authority.ts";
import type { EventV3SupportFamily, EventV3SupportVerificationMode } from "./pack-contract.ts";
import { assertEventV3SupportPackAuthority } from "./pack-contract.ts";
import { verifyEventV3SupportPack } from "./pack-reader.ts";
import { writeEventV3SupportPack } from "./pack-writer.ts";

export type EventV3SupportTransactionState =
  | "planned"
  | "shadow-written"
  | "shadow-verified"
  | "replacement-ready"
  | "replacement-active"
  | "committed";

export interface EventV3SupportTransactionSource {
  relative_path: string;
  bytes: number;
  digest: `sha256:${string}`;
  family: EventV3SupportFamily;
  recorded_at?: string;
  diagnostic_category?: string;
  diagnostic_reason?: string;
}

export interface EventV3SupportMaintenanceTransaction {
  format: "harnery-event-v3-support-maintenance";
  format_version: 1;
  transaction_id: `vst_${string}`;
  sequence: number;
  state: EventV3SupportTransactionState;
  created_at: string;
  updated_at: string;
  catalog_version: string;
  policy_version: string;
  authority: {
    root: string;
    root_id: string;
    genesis_id: string;
    state: "active" | "archived";
    verification_mode: EventV3SupportVerificationMode;
    source_authority_digest?: `sha256:${string}`;
  };
  sources: EventV3SupportTransactionSource[];
  shadow?: {
    manifest_path: string;
    payload_path: string;
    pack_id: `vsp_${string}`;
  };
  authorization?: {
    exact_transaction_id: `vst_${string}`;
    authorized_at: string;
  };
}

export interface PlanEventV3SupportTransactionInput {
  transaction_root: string;
  authority_root: string;
  root_id: string;
  genesis_id: string;
  authority_state: "active" | "archived";
  source_authority_digest?: `sha256:${string}`;
  entries: EventV3SupportInventoryEntry[];
  catalog_version: string;
  policy_version: string;
  now: string;
}

/** Freeze a content-free exact source set. No pack is written and no source is changed. */
export async function planEventV3SupportTransaction(
  input: PlanEventV3SupportTransactionInput,
): Promise<EventV3SupportMaintenanceTransaction> {
  if (input.entries.length === 0) throw new Error("event_v3_support_transaction_empty");
  if (input.entries.some((entry) => entry.disposition !== "pack-eligible")) {
    throw new Error("event_v3_support_transaction_contains_ineligible_source");
  }
  const verificationMode: EventV3SupportVerificationMode =
    input.authority_state === "archived" ? "archive-logical-authority" : "active-frozen-files";
  if (verificationMode === "archive-logical-authority" && !input.source_authority_digest) {
    throw new Error("event_v3_support_transaction_archive_digest_required");
  }
  if (verificationMode === "active-frozen-files" && input.source_authority_digest) {
    throw new Error("event_v3_support_transaction_active_digest_forbidden");
  }
  const authorityRoot = await safeAuthorityRoot(input.authority_root);
  const sources = input.entries
    .map((entry) => ({
      relative_path: entry.relative_path,
      bytes: entry.bytes,
      digest: entry.digest,
      family: entry.family,
      ...(entry.observed.recorded_at ? { recorded_at: entry.observed.recorded_at } : {}),
    }))
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const transactionId = `vst_${createHash("sha256")
    .update(
      canonicalJsonV3({
        authority_root: authorityRoot,
        root_id: input.root_id,
        genesis_id: input.genesis_id,
        verification_mode: verificationMode,
        source_authority_digest: input.source_authority_digest ?? null,
        sources,
        catalog_version: input.catalog_version,
        policy_version: input.policy_version,
      }),
    )
    .digest("hex")
    .slice(0, 32)}` as const;
  const transaction: EventV3SupportMaintenanceTransaction = {
    format: "harnery-event-v3-support-maintenance",
    format_version: 1,
    transaction_id: transactionId,
    sequence: 1,
    state: "planned",
    created_at: input.now,
    updated_at: input.now,
    catalog_version: input.catalog_version,
    policy_version: input.policy_version,
    authority: {
      root: authorityRoot,
      root_id: input.root_id,
      genesis_id: input.genesis_id,
      state: input.authority_state,
      verification_mode: verificationMode,
      ...(input.source_authority_digest
        ? { source_authority_digest: input.source_authority_digest }
        : {}),
    },
    sources,
  };
  const directory = transactionDirectory(input.transaction_root, transactionId);
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readEventV3SupportTransaction(input.transaction_root, transactionId);
    if (canonicalTransactionIdentity(existing) !== canonicalTransactionIdentity(transaction)) {
      throw new Error("event_v3_support_transaction_id_conflict");
    }
    return existing;
  }
  await chmod(directory, 0o700);
  await publishState(directory, transaction);
  return transaction;
}

export async function writeEventV3SupportTransactionShadow(input: {
  transaction_root: string;
  transaction_id: string;
  minimum_harnery_version: string;
  now: string;
}): Promise<EventV3SupportMaintenanceTransaction> {
  const transaction = await readEventV3SupportTransaction(
    input.transaction_root,
    exactTransactionId(input.transaction_id),
  );
  if (transaction.state !== "planned") throw new Error("event_v3_support_shadow_state_invalid");
  await assertFrozenSources(transaction);
  const directory = transactionDirectory(input.transaction_root, transaction.transaction_id);
  const shadowDirectory = join(directory, "shadow");
  const written = await writeEventV3SupportPack({
    authority_root: transaction.authority.root,
    output_directory: shadowDirectory,
    root_id: transaction.authority.root_id,
    genesis_id: transaction.authority.genesis_id,
    verification_mode: transaction.authority.verification_mode,
    ...(transaction.authority.source_authority_digest
      ? { source_authority_digest: transaction.authority.source_authority_digest }
      : {}),
    sources: transaction.sources,
    minimum_harnery_version: input.minimum_harnery_version,
    created_at: transaction.created_at,
  });
  return transition(transaction, input.transaction_root, "shadow-written", input.now, {
    shadow: {
      manifest_path: relative(directory, written.manifest_path).replaceAll("\\", "/"),
      payload_path: relative(directory, written.payload_path).replaceAll("\\", "/"),
      pack_id: written.manifest.pack_id,
    },
  });
}

export async function verifyEventV3SupportTransactionShadow(input: {
  transaction_root: string;
  transaction_id: string;
  expected_current_genesis_id: string;
  now: string;
}): Promise<EventV3SupportMaintenanceTransaction> {
  const transaction = await readEventV3SupportTransaction(
    input.transaction_root,
    exactTransactionId(input.transaction_id),
  );
  if (transaction.state !== "shadow-written") {
    throw new Error("event_v3_support_shadow_verify_state_invalid");
  }
  if (transaction.authority.genesis_id !== input.expected_current_genesis_id) {
    throw new Error("event_v3_support_transaction_genesis_mismatch");
  }
  if (!transaction.shadow) throw new Error("event_v3_support_shadow_missing");
  await assertFrozenSources(transaction);
  const directory = transactionDirectory(input.transaction_root, transaction.transaction_id);
  const manifestPath = containedTransactionPath(directory, transaction.shadow.manifest_path);
  const validated = await verifyEventV3SupportPack(manifestPath);
  assertEventV3SupportPackAuthority(validated.manifest, {
    root_id: transaction.authority.root_id,
    genesis_id: transaction.authority.genesis_id,
    verification_mode: transaction.authority.verification_mode,
  });
  if (validated.entries !== transaction.sources.length) {
    throw new Error("event_v3_support_shadow_authority_mismatch");
  }
  if (transaction.authority.verification_mode === "archive-logical-authority") {
    const currentDigest = await digestEventV3LogicalAuthority(transaction.authority.root);
    if (currentDigest !== transaction.authority.source_authority_digest) {
      throw new Error("event_v3_support_shadow_archive_digest_mismatch");
    }
  }
  return transition(transaction, input.transaction_root, "shadow-verified", input.now);
}

/** Record exact authorization only. Publication and source removal remain disabled. */
export async function authorizeEventV3SupportReplacement(input: {
  transaction_root: string;
  transaction_id: string;
  exact_transaction_id: string;
  yes: boolean;
  now: string;
}): Promise<EventV3SupportMaintenanceTransaction> {
  const transactionId = exactTransactionId(input.transaction_id);
  if (!input.yes) throw new Error("event_v3_support_replacement_yes_required");
  if (exactTransactionId(input.exact_transaction_id) !== transactionId) {
    throw new Error("event_v3_support_replacement_exact_transaction_mismatch");
  }
  const transaction = await readEventV3SupportTransaction(input.transaction_root, transactionId);
  if (transaction.state !== "shadow-verified") {
    throw new Error("event_v3_support_replacement_not_shadow_verified");
  }
  return transition(transaction, input.transaction_root, "replacement-ready", input.now, {
    authorization: { exact_transaction_id: transactionId, authorized_at: input.now },
  });
}

export interface EventV3SupportReplacementPlan {
  transaction_id: `vst_${string}`;
  enabled: false;
  final_manifest_path: string;
  final_payload_path: string;
  frozen_source_paths: string[];
  reason: "event_v3_support_replacement_activation_disabled";
}

/** Produce the canary replacement plan without publishing a pack or deleting a source. */
export async function planEventV3SupportReplacement(input: {
  transaction_root: string;
  transaction_id: string;
}): Promise<EventV3SupportReplacementPlan> {
  const transaction = await readEventV3SupportTransaction(
    input.transaction_root,
    exactTransactionId(input.transaction_id),
  );
  if (transaction.state !== "replacement-ready" || !transaction.shadow) {
    throw new Error("event_v3_support_replacement_not_ready");
  }
  const finalRoot = join(transaction.authority.root, "support-packs");
  return {
    transaction_id: transaction.transaction_id,
    enabled: false,
    final_manifest_path: join(finalRoot, `${transaction.shadow.pack_id}.manifest.json`),
    final_payload_path: join(finalRoot, `${transaction.shadow.pack_id}.ndjson.gz`),
    frozen_source_paths: transaction.sources.map(({ relative_path }) => relative_path),
    reason: "event_v3_support_replacement_activation_disabled",
  };
}

export function activateEventV3SupportReplacement(): never {
  throw new Error("event_v3_support_replacement_activation_disabled");
}

export async function recoverEventV3SupportTransaction(input: {
  transaction_root: string;
  transaction_id: string;
  expected_current_genesis_id: string;
}): Promise<{
  action: "write-shadow" | "verify-shadow" | "await-authorization" | "activation-disabled";
}> {
  const transaction = await readEventV3SupportTransaction(
    input.transaction_root,
    exactTransactionId(input.transaction_id),
  );
  if (transaction.authority.genesis_id !== input.expected_current_genesis_id) {
    throw new Error("event_v3_support_transaction_genesis_mismatch");
  }
  await assertFrozenSources(transaction);
  if (transaction.state === "planned") return { action: "write-shadow" };
  if (transaction.state === "shadow-written") {
    if (!transaction.shadow) throw new Error("event_v3_support_shadow_missing");
    const directory = transactionDirectory(input.transaction_root, transaction.transaction_id);
    await verifyEventV3SupportPack(
      containedTransactionPath(directory, transaction.shadow.manifest_path),
    );
    return { action: "verify-shadow" };
  }
  if (transaction.state === "shadow-verified") return { action: "await-authorization" };
  return { action: "activation-disabled" };
}

export async function readEventV3SupportTransaction(
  transactionRoot: string,
  transactionId: string,
): Promise<EventV3SupportMaintenanceTransaction> {
  const id = exactTransactionId(transactionId);
  const directory = transactionDirectory(transactionRoot, id);
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("event_v3_support_transaction_directory_invalid");
  }
  const names = (await readdir(directory))
    .filter((name) => /^state-\d{6}\.json$/.test(name))
    .sort();
  if (names.length === 0) throw new Error("event_v3_support_transaction_state_missing");
  let prior: EventV3SupportMaintenanceTransaction | undefined;
  for (const [index, name] of names.entries()) {
    const current = validateTransaction(
      JSON.parse(await readFile(join(directory, name), "utf8")) as unknown,
    );
    if (current.transaction_id !== id || current.sequence !== index + 1) {
      throw new Error("event_v3_support_transaction_sequence_invalid");
    }
    if (prior && !validTransition(prior.state, current.state)) {
      throw new Error("event_v3_support_transaction_transition_invalid");
    }
    prior = current;
  }
  return prior!;
}

async function assertFrozenSources(
  transaction: EventV3SupportMaintenanceTransaction,
): Promise<void> {
  const authorityReal = await realpath(transaction.authority.root);
  for (const source of transaction.sources) {
    const path = resolve(transaction.authority.root, ...source.relative_path.split("/"));
    const sourceReal = await realpath(path);
    if (relative(authorityReal, sourceReal).startsWith("..")) {
      throw new Error("event_v3_support_frozen_source_escape");
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("event_v3_support_frozen_source_not_regular");
    }
    const digest = await hashFile(path);
    if (stat.size !== source.bytes || digest !== source.digest) {
      throw new Error(`event_v3_support_frozen_source_mismatch:${source.relative_path}`);
    }
  }
}

async function transition(
  transaction: EventV3SupportMaintenanceTransaction,
  transactionRoot: string,
  state: EventV3SupportTransactionState,
  now: string,
  extension: Partial<Pick<EventV3SupportMaintenanceTransaction, "shadow" | "authorization">> = {},
): Promise<EventV3SupportMaintenanceTransaction> {
  if (!validTransition(transaction.state, state)) {
    throw new Error("event_v3_support_transaction_transition_invalid");
  }
  const next = validateTransaction({
    ...transaction,
    ...extension,
    sequence: transaction.sequence + 1,
    state,
    updated_at: now,
  });
  await publishState(transactionDirectory(transactionRoot, transaction.transaction_id), next);
  return next;
}

function validTransition(
  from: EventV3SupportTransactionState,
  to: EventV3SupportTransactionState,
): boolean {
  const order: EventV3SupportTransactionState[] = [
    "planned",
    "shadow-written",
    "shadow-verified",
    "replacement-ready",
    "replacement-active",
    "committed",
  ];
  return order.indexOf(to) === order.indexOf(from) + 1;
}

async function publishState(
  directory: string,
  transaction: EventV3SupportMaintenanceTransaction,
): Promise<void> {
  const path = join(directory, `state-${String(transaction.sequence).padStart(6, "0")}.json`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${canonicalJsonV3(transaction)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function transactionDirectory(root: string, id: string): string {
  return join(resolve(root), exactTransactionId(id));
}

function exactTransactionId(value: string): `vst_${string}` {
  if (!/^vst_[0-9a-f]{32}$/.test(value)) throw new Error("event_v3_support_transaction_id_invalid");
  return value as `vst_${string}`;
}

function containedTransactionPath(directory: string, relativePath: string): string {
  if (relativePath.includes("\\") || relativePath.split("/").includes("..")) {
    throw new Error("event_v3_support_transaction_path_invalid");
  }
  const path = resolve(directory, ...relativePath.split("/"));
  if (relative(directory, path).startsWith("..")) {
    throw new Error("event_v3_support_transaction_path_escape");
  }
  return path;
}

async function safeAuthorityRoot(root: string): Promise<string> {
  const path = resolve(root);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("event_v3_support_transaction_authority_invalid");
  }
  return realpath(path);
}

function validateTransaction(value: unknown): EventV3SupportMaintenanceTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("event_v3_support_transaction_invalid");
  }
  const transaction = value as EventV3SupportMaintenanceTransaction;
  if (
    transaction.format !== "harnery-event-v3-support-maintenance" ||
    transaction.format_version !== 1 ||
    !/^vst_[0-9a-f]{32}$/.test(transaction.transaction_id) ||
    !Number.isSafeInteger(transaction.sequence) ||
    transaction.sequence < 1 ||
    !Array.isArray(transaction.sources) ||
    transaction.sources.length === 0
  ) {
    throw new Error("event_v3_support_transaction_invalid");
  }
  return transaction;
}

function canonicalTransactionIdentity(transaction: EventV3SupportMaintenanceTransaction): string {
  return canonicalJsonV3({
    transaction_id: transaction.transaction_id,
    catalog_version: transaction.catalog_version,
    policy_version: transaction.policy_version,
    authority: transaction.authority,
    sources: transaction.sources,
  });
}

async function hashFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const current of createReadStream(path)) hash.update(current as Buffer);
  return `sha256:${hash.digest("hex")}`;
}
