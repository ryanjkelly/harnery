import type { HarneryConversationCatalog } from "./catalog.ts";
import type {
  HarneryConversationCitation,
  HarneryConversationQueryHit,
  HarneryConversationQueryRequest,
  HarneryConversationQueryResult,
  HarneryConversationRecordV1,
  HarneryConversationSourceSnapshot,
  HarneryConversationSummary,
  HarneryNativeConversationRecord,
} from "./contract.ts";
import { normalizeConversationRecord } from "./normalize.ts";

export async function queryConversationCatalog(
  catalog: HarneryConversationCatalog,
  request: HarneryConversationQueryRequest,
): Promise<HarneryConversationQueryResult> {
  validateRequest(request);
  const started = performance.now();
  const deadline = started + request.budgets.max_wall_ms;
  const controller = new AbortController();
  const records: HarneryConversationRecordV1[] = [];
  const snapshots: HarneryConversationSourceSnapshot[] = [];
  let decodedBytes = 0;
  let sourceRecords = 0;
  let sourceTruncation: HarneryConversationQueryResult["truncation_reason"];
  const providers = request.provider_id ? [catalog.require(request.provider_id)] : catalog.list();
  try {
    providerLoop: for (const provider of providers) {
      if (!provider.capabilities.can_list || !provider.capabilities.can_stream_source) continue;
      if (deadlineExpired(deadline)) {
        sourceTruncation = "wall_budget";
        break;
      }
      let summaries: readonly HarneryConversationSummary[];
      try {
        summaries = await beforeDeadline(
          provider.list(request.project_scope_id, { signal: controller.signal }),
          deadline,
          controller,
        );
      } catch (error) {
        if (!isWallBudgetError(error)) throw error;
        sourceTruncation = "wall_budget";
        break;
      }
      for (const summary of summaries) {
        if (deadlineExpired(deadline)) {
          controller.abort();
          sourceTruncation = "wall_budget";
          break providerLoop;
        }
        if (summary.project_scope_id !== request.project_scope_id) continue;
        if (request.conversation_id && summary.conversation_id !== request.conversation_id)
          continue;
        let snapshot: HarneryConversationSourceSnapshot;
        try {
          snapshot = await beforeDeadline(
            provider.snapshot(request.project_scope_id, summary.conversation_id, {
              signal: controller.signal,
            }),
            deadline,
            controller,
          );
        } catch (error) {
          if (!isWallBudgetError(error)) throw error;
          sourceTruncation = "wall_budget";
          break providerLoop;
        }
        snapshots.push(snapshot);
        let sequence = 0;
        const iterator = provider
          .stream(request.project_scope_id, summary.conversation_id, {
            signal: controller.signal,
          })
          [Symbol.asyncIterator]();
        let iteratorCompleted = false;
        try {
          while (true) {
            if (sourceRecords >= request.budgets.max_source_records) {
              sourceTruncation = "record_budget";
              break;
            }
            let next: IteratorResult<HarneryNativeConversationRecord>;
            try {
              next = await beforeDeadline(iterator.next(), deadline, controller);
            } catch (error) {
              if (!isWallBudgetError(error)) throw error;
              sourceTruncation = "wall_budget";
              break;
            }
            if (next.done) {
              iteratorCompleted = true;
              break;
            }
            sourceRecords += 1;
            sequence += 1;
            const native = next.value;
            const rawBytes =
              typeof native.content === "string" ? Buffer.byteLength(native.content) : 0;
            if (decodedBytes + rawBytes > request.budgets.max_decoded_bytes) {
              sourceTruncation = "byte_budget";
              break;
            }
            if (deadlineExpired(deadline)) {
              controller.abort();
              sourceTruncation = "wall_budget";
              break;
            }
            const normalized = normalizeConversationRecord({
              capabilities: provider.capabilities,
              snapshot,
              native,
              captured_at: snapshot.observed_at,
              sequence,
            });
            decodedBytes += rawBytes;
            if (deadlineExpired(deadline)) {
              controller.abort();
              sourceTruncation = "wall_budget";
              break;
            }
            if (normalized.record) records.push(normalized.record);
          }
        } finally {
          if (!iteratorCompleted) requestIteratorReturn(iterator);
        }
        if (sourceTruncation) break providerLoop;
      }
    }
  } finally {
    if (sourceTruncation) controller.abort();
  }
  const result = queryConversationRecords(records, snapshots, request, { started_at: started });
  if (!sourceTruncation || result.truncated) return result;
  return { ...result, truncated: true, truncation_reason: sourceTruncation };
}

class ConversationWallBudgetError extends Error {}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  controller: AbortController,
): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    controller.abort();
    throw new ConversationWallBudgetError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ConversationWallBudgetError());
      }, remaining);
    });
    const result = await Promise.race([operation, timeout]);
    if (deadlineExpired(deadline)) {
      controller.abort();
      throw new ConversationWallBudgetError();
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function deadlineExpired(deadline: number): boolean {
  return performance.now() >= deadline;
}

function isWallBudgetError(error: unknown): error is ConversationWallBudgetError {
  return error instanceof ConversationWallBudgetError;
}

function requestIteratorReturn<T>(iterator: AsyncIterator<T>): void {
  try {
    const returned = iterator.return?.();
    if (returned) void Promise.resolve(returned).catch(() => undefined);
  } catch {
    // A provider cleanup failure cannot widen the query budget or replace its reason code.
  }
}

export function queryConversationRecords(
  inputRecords: readonly HarneryConversationRecordV1[],
  snapshots: readonly HarneryConversationSourceSnapshot[],
  request: HarneryConversationQueryRequest,
  internal: { started_at?: number } = {},
): HarneryConversationQueryResult {
  validateRequest(request);
  const started = internal.started_at ?? performance.now();
  const records = [...inputRecords].sort(
    (left, right) =>
      left.project_scope_id.localeCompare(right.project_scope_id) ||
      left.provider_id.localeCompare(right.provider_id) ||
      left.conversation_id.localeCompare(right.conversation_id) ||
      left.sequence - right.sequence ||
      left.record_id.localeCompare(right.record_id),
  );
  const regex = request.regex
    ? compileRegex(request.regex, request.budgets.max_regex_chars)
    : undefined;
  const hits: HarneryConversationQueryHit[] = [];
  let scannedRecords = 0;
  let decodedBytes = 0;
  let truncation: HarneryConversationQueryResult["truncation_reason"];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!structuredMatch(record, request)) continue;
    if (scannedRecords >= request.budgets.max_source_records) {
      truncation = "record_budget";
      break;
    }
    if (decodedBytes + record.content_bytes > request.budgets.max_decoded_bytes) {
      truncation = "byte_budget";
      break;
    }
    if (performance.now() - started > request.budgets.max_wall_ms) {
      truncation = "wall_budget";
      break;
    }
    scannedRecords += 1;
    decodedBytes += record.content_bytes;
    if (request.text && !record.content.includes(request.text)) continue;
    if (regex && !regex.test(record.content)) continue;
    if (hits.length >= Math.min(request.limit, request.budgets.max_matches)) {
      truncation = "match_budget";
      break;
    }
    hits.push({
      record,
      citation: citation(record),
      neighbors: neighbors(records, index, request.context_before ?? 0, request.context_after ?? 0),
    });
  }
  return {
    schema: "harnery.conversation-query/v1",
    request,
    hits,
    scanned_records: scannedRecords,
    decoded_bytes: decodedBytes,
    truncated: truncation !== undefined,
    ...(truncation ? { truncation_reason: truncation } : {}),
    snapshots: [...snapshots].sort((left, right) =>
      left.snapshot_id.localeCompare(right.snapshot_id),
    ),
  };
}

export function citation(record: HarneryConversationRecordV1): HarneryConversationCitation {
  return {
    record_id: record.record_id,
    provider_id: record.provider_id,
    conversation_id: record.conversation_id,
    role: record.role,
    occurred_at: record.occurred_at,
    native_conversation_id: record.source.native_conversation_id,
    ...(record.source.native_record_id ? { native_record_id: record.source.native_record_id } : {}),
    content_digest: record.content_digest,
  };
}

function structuredMatch(
  record: HarneryConversationRecordV1,
  request: HarneryConversationQueryRequest,
): boolean {
  return (
    record.project_scope_id === request.project_scope_id &&
    (!request.provider_id || record.provider_id === request.provider_id) &&
    (!request.role || record.role === request.role) &&
    (!request.session_id || record.session_id === request.session_id) &&
    (!request.conversation_id || record.conversation_id === request.conversation_id) &&
    (!request.record_id || record.record_id === request.record_id) &&
    (!request.since || record.occurred_at >= new Date(request.since).toISOString()) &&
    (!request.until || record.occurred_at <= new Date(request.until).toISOString())
  );
}

function neighbors(
  records: readonly HarneryConversationRecordV1[],
  index: number,
  before: number,
  after: number,
): HarneryConversationRecordV1[] {
  const target = records[index]!;
  return records
    .slice(Math.max(0, index - before), index + after + 1)
    .filter(
      (record) =>
        record.record_id !== target.record_id &&
        record.project_scope_id === target.project_scope_id &&
        record.provider_id === target.provider_id &&
        record.conversation_id === target.conversation_id,
    );
}

function compileRegex(pattern: string, maxChars: number): RegExp {
  if (pattern.length === 0 || pattern.length > maxChars)
    throw new Error("conversation regex limit");
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) throw new Error("unsafe nested conversation regex");
  return new RegExp(pattern, "iu");
}

function validateRequest(request: HarneryConversationQueryRequest): void {
  if (!request.project_scope_id) throw new Error("conversation query requires project_scope_id");
  for (const [field, value] of Object.entries({ limit: request.limit, ...request.budgets })) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`invalid conversation ${field}`);
  }
  if (request.role && request.role !== "user" && request.role !== "assistant") {
    throw new Error("excluded conversation role");
  }
  if (request.text && request.regex)
    throw new Error("conversation query accepts text or regex, not both");
}
