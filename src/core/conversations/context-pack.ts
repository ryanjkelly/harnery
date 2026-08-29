import type { HarneryConversationContextPack, HarneryConversationQueryResult } from "./contract.ts";

export function buildConversationContextPack(
  result: HarneryConversationQueryResult,
  budget: { max_tokens: number; max_bytes: number },
): HarneryConversationContextPack {
  if (
    !Number.isSafeInteger(budget.max_tokens) ||
    budget.max_tokens <= 0 ||
    !Number.isSafeInteger(budget.max_bytes) ||
    budget.max_bytes <= 0
  ) {
    throw new Error("invalid conversation context budget");
  }
  const ordered = new Map(
    result.hits
      .flatMap((hit) => [...hit.neighbors, hit.record])
      .sort(
        (left, right) =>
          left.provider_id.localeCompare(right.provider_id) ||
          left.conversation_id.localeCompare(right.conversation_id) ||
          left.sequence - right.sequence,
      )
      .map((record) => [record.record_id, record]),
  );
  const excerpts: HarneryConversationContextPack["excerpts"][number][] = [];
  let bytes = 0;
  let tokens = 0;
  let truncated = result.truncated;
  for (const record of ordered.values()) {
    const recordBytes = Buffer.byteLength(record.content);
    const recordTokens = Math.ceil(recordBytes / 4);
    if (bytes + recordBytes > budget.max_bytes || tokens + recordTokens > budget.max_tokens) {
      truncated = true;
      break;
    }
    excerpts.push({
      citation: {
        record_id: record.record_id,
        provider_id: record.provider_id,
        conversation_id: record.conversation_id,
        role: record.role,
        occurred_at: record.occurred_at,
        native_conversation_id: record.source.native_conversation_id,
        ...(record.source.native_record_id
          ? { native_record_id: record.source.native_record_id }
          : {}),
        content_digest: record.content_digest,
      },
      content: record.content,
      sequence: record.sequence,
    });
    bytes += recordBytes;
    tokens += recordTokens;
  }
  return {
    schema: "harnery.conversation-context-pack/v1",
    boundary: "untrusted-historical-data",
    automatic_injection: false,
    project_scope_id: result.request.project_scope_id,
    excerpts,
    completeness: result.snapshots.map((snapshot) => ({
      provider_id: snapshot.provider_id,
      conversation_id: snapshot.conversation_id,
      completeness: snapshot.completeness,
      omissions: snapshot.omissions,
    })),
    bytes,
    estimated_tokens: tokens,
    truncated,
  };
}
