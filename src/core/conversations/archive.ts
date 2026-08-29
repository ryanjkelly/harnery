import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  appendDurableHistoryRecord,
  type DurableHistoryFaultBoundary,
  readDurableHistorySync,
} from "../storage/durable-history.ts";
import type {
  HarneryConversationAccessMode,
  HarneryConversationArchiveAuthorityMode,
  HarneryConversationProvider,
  HarneryConversationRecordV1,
  HarneryConversationSourceSnapshot,
} from "./contract.ts";
import { digest, normalizeConversationRecord } from "./normalize.ts";

export const HARNERY_CONVERSATION_MANIFEST_SCHEMA = "harnery.conversation-manifest/v1" as const;

export interface HarneryConversationArchiveManifest {
  schema: typeof HARNERY_CONVERSATION_MANIFEST_SCHEMA;
  policy_version: "conversation-archive-v1";
  provider_id: string;
  project_scope_id: string;
  conversation_id: string;
  source_snapshot_id: string;
  completeness: HarneryConversationSourceSnapshot["completeness"];
  omissions: readonly string[];
  record_count: number;
  logical_bytes: number;
  first_occurred_at?: string;
  last_occurred_at?: string;
  record_set_digest: `sha256:${string}`;
  authority_mode: HarneryConversationArchiveAuthorityMode;
  updated_at: string;
}

export interface CaptureConversationOptions {
  coord_root: string;
  project_scope_id: string;
  conversation_id: string;
  access_mode: HarneryConversationAccessMode;
  authority_mode: HarneryConversationArchiveAuthorityMode;
  now?: () => Date;
  fault?: (
    boundary:
      | DurableHistoryFaultBoundary
      | "after_record_append"
      | "before_manifest_publish"
      | "after_manifest_publish",
  ) => void;
}

export interface CaptureConversationResult {
  state: "disabled" | "source-only" | "captured";
  accepted: number;
  duplicates: number;
  omissions: readonly string[];
  manifest?: HarneryConversationArchiveManifest;
}

export async function captureProviderConversation(
  provider: HarneryConversationProvider,
  options: CaptureConversationOptions,
): Promise<CaptureConversationResult> {
  if (options.access_mode === "off") return result("disabled");
  if (options.access_mode === "source") return result("source-only");
  const objectDir = conversationArchiveDir(
    options.coord_root,
    provider.capabilities.provider_id,
    options.conversation_id,
  );
  mkdirSync(objectDir, { recursive: true, mode: 0o700 });
  const lease = join(objectDir, ".capture.lease");
  try {
    mkdirSync(lease, { mode: 0o700 });
  } catch {
    throw new Error(`conversation capture lease busy: ${options.conversation_id}`);
  }
  try {
    const snapshot = await provider.snapshot(options.project_scope_id, options.conversation_id);
    const existing = readConversationArchive(objectDir);
    const seen = new Map(existing.map((record) => [record.record_id, record.content_digest]));
    let accepted = 0;
    let duplicates = 0;
    const omissions = new Set(snapshot.omissions);
    let sequence = existing.at(-1)?.sequence ?? 0;
    for await (const native of provider.stream(options.project_scope_id, options.conversation_id)) {
      const normalized = normalizeConversationRecord({
        capabilities: provider.capabilities,
        snapshot,
        native,
        captured_at: (options.now?.() ?? new Date()).toISOString(),
        sequence: sequence + 1,
      });
      if (!normalized.record) {
        omissions.add(normalized.omission ?? "record_excluded");
        continue;
      }
      const prior = seen.get(normalized.record.record_id);
      if (prior) {
        if (prior !== normalized.record.content_digest) {
          throw new Error(`conversation record collision: ${normalized.record.record_id}`);
        }
        duplicates += 1;
        continue;
      }
      sequence += 1;
      normalized.record.sequence = sequence;
      appendDurableHistoryRecord(objectDir, normalized.record, {
        max_record_bytes: 1_048_576,
        max_segment_bytes: 8_388_608,
        fault: options.fault,
      });
      options.fault?.("after_record_append");
      seen.set(normalized.record.record_id, normalized.record.content_digest);
      accepted += 1;
    }
    const records = readConversationArchive(objectDir);
    const manifest = manifestFor(
      records,
      { ...snapshot, omissions: [...omissions].sort() },
      options.authority_mode,
      options.now?.() ?? new Date(),
    );
    options.fault?.("before_manifest_publish");
    publishManifest(objectDir, manifest);
    options.fault?.("after_manifest_publish");
    return { state: "captured", accepted, duplicates, omissions: [...omissions].sort(), manifest };
  } finally {
    rmSync(lease, { recursive: true, force: true });
  }
}

export function readConversationArchive(
  objectDirOrCoordRoot: string,
  providerId?: string,
  conversationId?: string,
): HarneryConversationRecordV1[] {
  const objectDir =
    providerId && conversationId
      ? conversationArchiveDir(objectDirOrCoordRoot, providerId, conversationId)
      : objectDirOrCoordRoot;
  return readDurableHistorySync<HarneryConversationRecordV1>(objectDir, {
    max_record_bytes: 1_048_576,
    max_records: 1_000_000,
  });
}

export function reconcileConversationArchive(input: {
  coord_root: string;
  provider_id: string;
  conversation_id: string;
  snapshot: HarneryConversationSourceSnapshot;
  authority_mode: HarneryConversationArchiveAuthorityMode;
  now: Date;
}): HarneryConversationArchiveManifest {
  const objectDir = conversationArchiveDir(
    input.coord_root,
    input.provider_id,
    input.conversation_id,
  );
  const manifest = manifestFor(
    readConversationArchive(objectDir),
    input.snapshot,
    input.authority_mode,
    input.now,
  );
  publishManifest(objectDir, manifest);
  return manifest;
}

export function loadConversationManifest(
  coordRoot: string,
  providerId: string,
  conversationId: string,
): HarneryConversationArchiveManifest | undefined {
  const path = join(conversationArchiveDir(coordRoot, providerId, conversationId), "manifest.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as HarneryConversationArchiveManifest;
    if (parsed.schema !== HARNERY_CONVERSATION_MANIFEST_SCHEMA) throw new Error("unknown schema");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`conversation manifest invalid: ${(error as Error).message}`);
  }
}

export function conversationArchiveDir(
  coordRoot: string,
  providerId: string,
  conversationId: string,
): string {
  const provider = opaque(providerId);
  const conversation = digest(`${providerId}\0${conversationId}`).slice("sha256:".length, 38);
  return join(resolve(coordRoot), ".harnery", "conversations", provider, conversation);
}

function manifestFor(
  records: readonly HarneryConversationRecordV1[],
  snapshot: HarneryConversationSourceSnapshot,
  authorityMode: HarneryConversationArchiveAuthorityMode,
  now: Date,
): HarneryConversationArchiveManifest {
  return {
    schema: HARNERY_CONVERSATION_MANIFEST_SCHEMA,
    policy_version: "conversation-archive-v1",
    provider_id: snapshot.provider_id,
    project_scope_id: snapshot.project_scope_id,
    conversation_id: snapshot.conversation_id,
    source_snapshot_id: snapshot.snapshot_id,
    completeness: snapshot.completeness,
    omissions: [...snapshot.omissions],
    record_count: records.length,
    logical_bytes: records.reduce((sum, record) => sum + record.content_bytes, 0),
    ...(records[0] ? { first_occurred_at: records[0].occurred_at } : {}),
    ...(records.at(-1) ? { last_occurred_at: records.at(-1)!.occurred_at } : {}),
    record_set_digest: digest(records.map((record) => record.record_id).join("\n")),
    authority_mode: authorityMode,
    updated_at: now.toISOString(),
  };
}

function publishManifest(objectDir: string, manifest: HarneryConversationArchiveManifest): void {
  const path = join(objectDir, "manifest.json");
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function opaque(value: string): string {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(value)) throw new Error(`invalid provider id: ${value}`);
  return value;
}

function result(state: "disabled" | "source-only"): CaptureConversationResult {
  return { state, accepted: 0, duplicates: 0, omissions: [] };
}
