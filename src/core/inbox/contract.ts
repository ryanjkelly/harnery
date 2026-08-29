export const HARNERY_INBOX_RECORD_SCHEMA = "harnery.inbox-record/v1" as const;
export const HARNERY_INBOX_STATUS_SCHEMA = "harnery.inbox-status/v1" as const;

export interface HarneryInboxLimits {
  max_message_body_bytes: number;
  max_pending_count: number;
  max_pending_bytes: number;
  max_history_bytes: number;
  max_history_records: number;
  warning_pressure_ratio: number;
  max_surface_count: number;
  max_surface_bytes: number;
  max_surface_tokens: number;
  surfaced_grace_ms: number;
  terminal_grace_ms: number;
}

export interface HarneryInboxMessageRecordV1 {
  schema: typeof HARNERY_INBOX_RECORD_SCHEMA;
  kind: "message";
  message_id: string;
  sender_instance_id: string;
  sender_display_name: string;
  recipient_instance_id: string;
  recipient_display_name: string;
  created_at: string;
  body: string;
  body_bytes: number;
}

export interface HarneryInboxSurfacedRecordV1 {
  schema: typeof HARNERY_INBOX_RECORD_SCHEMA;
  kind: "surfaced";
  message_id: string;
  surfaced_at: string;
}

export type HarneryInboxRecordV1 = HarneryInboxMessageRecordV1 | HarneryInboxSurfacedRecordV1;

export interface HarneryInboxStatusV1 {
  schema: typeof HARNERY_INBOX_STATUS_SCHEMA;
  recipient_instance_id: string;
  pending_count: number;
  pending_bytes: number;
  total_history_bytes: number;
  oldest_pending_at?: string;
  pressure: "normal" | "warning" | "exhausted";
  last_surface_at?: string;
  last_compaction_at?: string;
}

export type HarneryInboxCapacityReason =
  | "message_body_limit"
  | "pending_count_limit"
  | "pending_bytes_limit"
  | "history_bytes_limit";

export class HarneryInboxCapacityError extends Error {
  constructor(
    readonly reason_code: HarneryInboxCapacityReason,
    readonly current: number,
    readonly limit: number,
  ) {
    super(
      `inbox capacity ${reason_code}: ${current}/${limit}; use a managed artifact for larger payloads`,
    );
  }
}

export interface HarneryInboxSurfaceBudget {
  max_count: number;
  max_bytes: number;
  max_tokens: number;
}

export interface HarneryInboxSurfaceResult {
  emitted: readonly HarneryInboxMessageRecordV1[];
  remaining_pending_count: number;
  remaining_pending_bytes: number;
  repeated_after_crash_possible: true;
}
