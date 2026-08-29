import { randomUUID } from "node:crypto";
import type { HarneryConversationRecordV1 } from "./contract.ts";

export const HARNERY_CONVERSATION_PURGE_PLAN_SCHEMA = "harnery.conversation-purge-plan/v1" as const;

export interface HarneryConversationPurgePlan {
  schema: typeof HARNERY_CONVERSATION_PURGE_PLAN_SCHEMA;
  transaction_id: string;
  project_scope_id: string;
  conversation_id?: string;
  before?: string;
  record_ids: readonly string[];
  record_digests: readonly string[];
  remove_bytes: number;
  retained_record_count: number;
  external_source_state: "adapter-owned-copy-may-remain";
  dry_run: true;
  executable: false;
}

export function planConversationPurge(input: {
  records: readonly HarneryConversationRecordV1[];
  project_scope_id: string;
  conversation_id?: string;
  before?: string;
  transaction_id?: string;
}): HarneryConversationPurgePlan {
  const selected = input.records.filter(
    (record) =>
      record.project_scope_id === input.project_scope_id &&
      (!input.conversation_id || record.conversation_id === input.conversation_id) &&
      (!input.before || record.occurred_at < new Date(input.before).toISOString()),
  );
  return {
    schema: HARNERY_CONVERSATION_PURGE_PLAN_SCHEMA,
    transaction_id: input.transaction_id ?? `cpurge_${randomUUID()}`,
    project_scope_id: input.project_scope_id,
    ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
    ...(input.before ? { before: new Date(input.before).toISOString() } : {}),
    record_ids: selected.map(({ record_id }) => record_id).sort(),
    record_digests: selected.map(({ content_digest }) => content_digest).sort(),
    remove_bytes: selected.reduce((sum, record) => sum + record.content_bytes, 0),
    retained_record_count: input.records.length - selected.length,
    external_source_state: "adapter-owned-copy-may-remain",
    dry_run: true,
    executable: false,
  };
}

export function validatePurgeExecutionRequest(
  plan: HarneryConversationPurgePlan,
  transactionId: string | undefined,
  yes: boolean,
): {
  accepted: false;
  reason_code: "confirmation_required" | "transaction_mismatch" | "execution_disabled";
} {
  if (!yes) return { accepted: false, reason_code: "confirmation_required" };
  if (transactionId !== plan.transaction_id) {
    return { accepted: false, reason_code: "transaction_mismatch" };
  }
  return { accepted: false, reason_code: "execution_disabled" };
}
