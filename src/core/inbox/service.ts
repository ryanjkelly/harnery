import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readCrashSafeJsonlFile, updateCrashSafeJsonlFile } from "../storage/durable-history.ts";
import {
  HARNERY_INBOX_RECORD_SCHEMA,
  HARNERY_INBOX_STATUS_SCHEMA,
  HarneryInboxCapacityError,
  type HarneryInboxLimits,
  type HarneryInboxMessageRecordV1,
  type HarneryInboxRecordV1,
  type HarneryInboxStatusV1,
  type HarneryInboxSurfaceBudget,
  type HarneryInboxSurfaceResult,
} from "./contract.ts";

export interface HarneryInboxServiceOptions {
  coord_root: string;
  limits: HarneryInboxLimits;
  now?: () => Date;
  id?: () => string;
}

export interface HarneryInboxSendInput {
  sender_instance_id: string;
  sender_display_name: string;
  recipient_instance_id: string;
  recipient_display_name: string;
  body: string;
}

export interface HarneryInboxSendReceipt {
  state: "queued";
  message_id: string;
  body_bytes: number;
  synced: true;
}

export class HarneryInboxService {
  readonly #options: HarneryInboxServiceOptions;

  constructor(options: HarneryInboxServiceOptions) {
    validateLimits(options.limits);
    this.#options = options;
  }

  send(input: HarneryInboxSendInput): HarneryInboxSendReceipt {
    const recipient = opaqueId(input.recipient_instance_id, "recipient instance");
    const bodyBytes = Buffer.byteLength(input.body);
    const limits = this.#options.limits;
    if (bodyBytes === 0 || bodyBytes > limits.max_message_body_bytes) {
      throw new HarneryInboxCapacityError(
        "message_body_limit",
        bodyBytes,
        limits.max_message_body_bytes,
      );
    }
    const record: HarneryInboxMessageRecordV1 = {
      schema: HARNERY_INBOX_RECORD_SCHEMA,
      kind: "message",
      message_id: `msg_${this.#options.id?.() ?? randomUUID()}`,
      sender_instance_id: opaqueId(input.sender_instance_id, "sender instance"),
      sender_display_name: boundedDisplay(input.sender_display_name),
      recipient_instance_id: recipient,
      recipient_display_name: boundedDisplay(input.recipient_display_name),
      created_at: now(this.#options).toISOString(),
      body: input.body,
      body_bytes: bodyBytes,
    };
    const path = inboxPath(this.#options.coord_root, recipient);
    return updateCrashSafeJsonlFile<HarneryInboxRecordV1, HarneryInboxSendReceipt>(
      path,
      readOptions(limits),
      (records) => {
        const projection = project(records);
        capacityCheck(projection, record, path, limits);
        return {
          append: [record],
          result: {
            state: "queued",
            message_id: record.message_id,
            body_bytes: bodyBytes,
            synced: true,
          },
        };
      },
    );
  }

  records(recipientInstanceId: string): HarneryInboxRecordV1[] {
    return readCrashSafeJsonlFile<HarneryInboxRecordV1>(
      inboxPath(this.#options.coord_root, opaqueId(recipientInstanceId, "recipient instance")),
      readOptions(this.#options.limits),
    );
  }

  pending(recipientInstanceId: string): HarneryInboxMessageRecordV1[] {
    return project(this.records(recipientInstanceId)).pending;
  }

  status(recipientInstanceId: string): HarneryInboxStatusV1 {
    const recipient = opaqueId(recipientInstanceId, "recipient instance");
    const path = inboxPath(this.#options.coord_root, recipient);
    const projection = project(this.records(recipient));
    const pendingBytes = projection.pending.reduce((sum, record) => sum + record.body_bytes, 0);
    const ratio = Math.max(
      projection.pending.length / this.#options.limits.max_pending_count,
      pendingBytes / this.#options.limits.max_pending_bytes,
    );
    return {
      schema: HARNERY_INBOX_STATUS_SCHEMA,
      recipient_instance_id: recipient,
      pending_count: projection.pending.length,
      pending_bytes: pendingBytes,
      total_history_bytes: existsSync(path) ? statSync(path).size : 0,
      ...(projection.pending[0] ? { oldest_pending_at: projection.pending[0].created_at } : {}),
      pressure:
        ratio >= 1
          ? "exhausted"
          : ratio >= this.#options.limits.warning_pressure_ratio
            ? "warning"
            : "normal",
      ...(projection.lastSurfaceAt ? { last_surface_at: projection.lastSurfaceAt } : {}),
    };
  }

  async surface(
    recipientInstanceId: string,
    emit: (messages: readonly HarneryInboxMessageRecordV1[]) => Promise<void> | void,
    budget: HarneryInboxSurfaceBudget = {
      max_count: this.#options.limits.max_surface_count,
      max_bytes: this.#options.limits.max_surface_bytes,
      max_tokens: this.#options.limits.max_surface_tokens,
    },
  ): Promise<HarneryInboxSurfaceResult> {
    validateSurfaceBudget(budget);
    const recipient = opaqueId(recipientInstanceId, "recipient instance");
    const selected = selectOldestFitting(this.pending(recipient), budget);
    await emit(selected);
    if (selected.length > 0) {
      const surfacedAt = now(this.#options).toISOString();
      updateCrashSafeJsonlFile<HarneryInboxRecordV1, void>(
        inboxPath(this.#options.coord_root, recipient),
        readOptions(this.#options.limits),
        (records) => {
          const stillPending = new Set(
            project(records).pending.map(({ message_id }) => message_id),
          );
          return {
            append: selected
              .filter(({ message_id }) => stillPending.has(message_id))
              .map(({ message_id }) => ({
                schema: HARNERY_INBOX_RECORD_SCHEMA,
                kind: "surfaced" as const,
                message_id,
                surfaced_at: surfacedAt,
              })),
            result: undefined,
          };
        },
      );
    }
    const remaining = this.pending(recipient);
    return {
      emitted: selected,
      remaining_pending_count: remaining.length,
      remaining_pending_bytes: remaining.reduce((sum, record) => sum + record.body_bytes, 0),
      repeated_after_crash_possible: true,
    };
  }
}

export function inboxPath(coordRoot: string, recipientInstanceId: string): string {
  const id = opaqueId(recipientInstanceId, "recipient instance");
  return join(resolve(coordRoot), ".harnery", "inbox", `${id}.jsonl`);
}

export function project(records: readonly HarneryInboxRecordV1[]): {
  pending: HarneryInboxMessageRecordV1[];
  surfaced: ReadonlySet<string>;
  lastSurfaceAt?: string;
} {
  const messages = new Map<string, HarneryInboxMessageRecordV1>();
  const surfaced = new Set<string>();
  let lastSurfaceAt: string | undefined;
  for (const record of records) {
    validateRecord(record);
    if (record.kind === "message") {
      if (messages.has(record.message_id))
        throw new Error(`duplicate inbox message ${record.message_id}`);
      messages.set(record.message_id, record);
    } else {
      if (!messages.has(record.message_id))
        throw new Error(`surfaced marker precedes ${record.message_id}`);
      surfaced.add(record.message_id);
      if (!lastSurfaceAt || record.surfaced_at > lastSurfaceAt) lastSurfaceAt = record.surfaced_at;
    }
  }
  return {
    pending: [...messages.values()].filter(({ message_id }) => !surfaced.has(message_id)),
    surfaced,
    ...(lastSurfaceAt ? { lastSurfaceAt } : {}),
  };
}

function selectOldestFitting(
  pending: readonly HarneryInboxMessageRecordV1[],
  budget: HarneryInboxSurfaceBudget,
): HarneryInboxMessageRecordV1[] {
  const selected: HarneryInboxMessageRecordV1[] = [];
  let bytes = 0;
  let tokens = 0;
  for (const record of pending) {
    const recordTokens = Math.ceil(record.body_bytes / 4);
    if (
      selected.length >= budget.max_count ||
      bytes + record.body_bytes > budget.max_bytes ||
      tokens + recordTokens > budget.max_tokens
    ) {
      break;
    }
    selected.push(record);
    bytes += record.body_bytes;
    tokens += recordTokens;
  }
  return selected;
}

function capacityCheck(
  projection: ReturnType<typeof project>,
  record: HarneryInboxMessageRecordV1,
  path: string,
  limits: HarneryInboxLimits,
): void {
  const pendingBytes = projection.pending.reduce((sum, item) => sum + item.body_bytes, 0);
  if (projection.pending.length + 1 > limits.max_pending_count) {
    throw new HarneryInboxCapacityError(
      "pending_count_limit",
      projection.pending.length,
      limits.max_pending_count,
    );
  }
  if (pendingBytes + record.body_bytes > limits.max_pending_bytes) {
    throw new HarneryInboxCapacityError(
      "pending_bytes_limit",
      pendingBytes,
      limits.max_pending_bytes,
    );
  }
  const nextHistoryBytes =
    (existsSync(path) ? statSync(path).size : 0) + Buffer.byteLength(`${JSON.stringify(record)}\n`);
  if (nextHistoryBytes > limits.max_history_bytes) {
    throw new HarneryInboxCapacityError(
      "history_bytes_limit",
      nextHistoryBytes,
      limits.max_history_bytes,
    );
  }
}

function readOptions(limits: HarneryInboxLimits) {
  return {
    max_record_bytes: Math.max(limits.max_message_body_bytes * 2, 4_096),
    max_records: limits.max_history_records,
  };
}

function now(options: HarneryInboxServiceOptions): Date {
  return options.now?.() ?? new Date();
}

function opaqueId(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new Error(`invalid ${field} id`);
  return value;
}

function boundedDisplay(value: string): string {
  const result = value.trim();
  if (result.length === 0 || Buffer.byteLength(result) > 256)
    throw new Error("invalid display name");
  return result;
}

function validateRecord(record: HarneryInboxRecordV1): void {
  if (record.schema !== HARNERY_INBOX_RECORD_SCHEMA) throw new Error("unknown inbox record schema");
  if (record.kind === "message" && Buffer.byteLength(record.body) !== record.body_bytes) {
    throw new Error(`inbox message ${record.message_id} has invalid body_bytes`);
  }
}

function validateLimits(limits: HarneryInboxLimits): void {
  for (const [field, value] of Object.entries(limits)) {
    if (field === "warning_pressure_ratio") continue;
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid inbox limit ${field}`);
  }
  if (limits.warning_pressure_ratio <= 0 || limits.warning_pressure_ratio >= 1) {
    throw new Error("warning_pressure_ratio must be between zero and one");
  }
}

function validateSurfaceBudget(budget: HarneryInboxSurfaceBudget): void {
  for (const value of Object.values(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid inbox surface budget");
  }
}
