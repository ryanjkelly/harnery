import { createHash } from "node:crypto";
import type {
  HarneryConversationProviderCapabilities,
  HarneryConversationRecordV1,
  HarneryConversationSourceSnapshot,
  HarneryNativeConversationRecord,
} from "./contract.ts";

export interface NormalizeConversationResult {
  record?: HarneryConversationRecordV1;
  omission?: string;
}

export function normalizeConversationRecord(input: {
  capabilities: HarneryConversationProviderCapabilities;
  snapshot: HarneryConversationSourceSnapshot;
  native: HarneryNativeConversationRecord;
  captured_at: string;
  sequence: number;
}): NormalizeConversationResult {
  if (input.native.role !== "user" && input.native.role !== "assistant") {
    return { omission: `excluded_role:${input.native.role}` };
  }
  if (!input.capabilities.roles.includes(input.native.role)) {
    return { omission: `unsupported_role:${input.native.role}` };
  }
  const sourceContent = input.native.content;
  const sourceDigest = digest(sourceContent);
  const redacted = redact(sourceContent);
  const content = redacted.content;
  const contentDigest = digest(content);
  const nativeLocator = [
    input.capabilities.provider_id,
    input.native.native_conversation_id,
    input.native.native_record_id ?? "",
    String(input.native.native_sequence ?? ""),
    input.native.role,
    input.native.occurred_at,
    sourceDigest,
  ].join("\0");
  return {
    record: {
      schema: "harnery.conversation-record/v1",
      record_id: `cr_${digest(nativeLocator).slice("sha256:".length, 38)}`,
      provider_id: input.capabilities.provider_id,
      project_scope_id: input.snapshot.project_scope_id,
      conversation_id: input.snapshot.conversation_id,
      source_snapshot_id: input.snapshot.snapshot_id,
      ...(input.native.session_id ? { session_id: input.native.session_id } : {}),
      ...(input.native.turn_id ? { turn_id: input.native.turn_id } : {}),
      source: {
        native_conversation_id: input.native.native_conversation_id,
        ...(input.native.native_record_id
          ? { native_record_id: input.native.native_record_id }
          : {}),
        ...(input.native.native_sequence !== undefined
          ? { native_sequence: input.native.native_sequence }
          : {}),
        source_digest: sourceDigest,
      },
      sequence: input.sequence,
      occurred_at: new Date(input.native.occurred_at).toISOString(),
      captured_at: new Date(input.captured_at).toISOString(),
      role: input.native.role,
      content,
      content_bytes: Buffer.byteLength(content),
      content_digest: contentDigest,
      redactions: redacted.redactions,
      attachment_refs: [...(input.native.attachment_refs ?? [])],
      sensitivity: "private",
    },
  };
}

function redact(content: string): {
  content: string;
  redactions: HarneryConversationRecordV1["redactions"];
} {
  const pattern = /\b(?:sk|key|token|secret)[-_][a-zA-Z0-9_-]{8,}\b/giu;
  const redactions: HarneryConversationRecordV1["redactions"][number][] = [];
  let stored = "";
  let sourceOffset = 0;
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    const value = match[0];
    stored += content.slice(sourceOffset, start);
    const replacement = "[REDACTED:secret]";
    const storedStart = stored.length;
    stored += replacement;
    redactions.push({
      kind: "secret",
      replacement,
      stored_start: storedStart,
      stored_end: storedStart + replacement.length,
      source_bytes_removed: Buffer.byteLength(value),
    });
    sourceOffset = start + value.length;
  }
  stored += content.slice(sourceOffset);
  return { content: stored, redactions };
}

export function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
