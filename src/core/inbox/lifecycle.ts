import type { HarneryInboxLimits, HarneryInboxRecordV1 } from "./contract.ts";
import { project } from "./service.ts";

export const HARNERY_INBOX_COMPACTION_PLAN_SCHEMA = "harnery.inbox-compaction-plan/v1" as const;

export type HarneryRecipientLifecycle = "active" | "resumable" | "terminal";

export interface HarneryInboxCompactionPlan {
  schema: typeof HARNERY_INBOX_COMPACTION_PLAN_SCHEMA;
  recipient_instance_id: string;
  action: "none" | "compact-surfaced" | "prune-terminal";
  reason_code:
    | "pending_protected"
    | "active_recipient"
    | "surfaced_grace"
    | "terminal_grace"
    | "eligible";
  remove_record_count: number;
  retained_record_count: number;
  protected_pending_count: number;
  dry_run: true;
}

export function planInboxCompaction(input: {
  recipient_instance_id: string;
  records: readonly HarneryInboxRecordV1[];
  lifecycle: HarneryRecipientLifecycle;
  terminal_at?: string;
  now: Date;
  limits: HarneryInboxLimits;
}): HarneryInboxCompactionPlan {
  const projection = project(input.records);
  const surfacedAt = new Map<string, number>();
  for (const record of input.records) {
    if (record.kind === "surfaced")
      surfacedAt.set(record.message_id, Date.parse(record.surfaced_at));
  }
  const compactableIds = new Set(
    [...surfacedAt]
      .filter(([, timestamp]) => input.now.getTime() - timestamp >= input.limits.surfaced_grace_ms)
      .map(([id]) => id),
  );
  const compactableRecords = input.records.filter((record) =>
    compactableIds.has(record.message_id),
  ).length;
  if (input.lifecycle === "terminal") {
    if (projection.pending.length > 0) {
      return plan(
        input,
        "none",
        "pending_protected",
        0,
        input.records.length,
        projection.pending.length,
      );
    }
    const terminalAt = input.terminal_at ? Date.parse(input.terminal_at) : Number.NaN;
    if (
      !Number.isFinite(terminalAt) ||
      input.now.getTime() - terminalAt < input.limits.terminal_grace_ms
    ) {
      return plan(input, "none", "terminal_grace", 0, input.records.length, 0);
    }
    return plan(input, "prune-terminal", "eligible", input.records.length, 0, 0);
  }
  if (compactableRecords === 0) {
    return plan(
      input,
      "none",
      surfacedAt.size > 0 ? "surfaced_grace" : "active_recipient",
      0,
      input.records.length,
      projection.pending.length,
    );
  }
  return plan(
    input,
    "compact-surfaced",
    "eligible",
    compactableRecords,
    input.records.length - compactableRecords,
    projection.pending.length,
  );
}

function plan(
  input: { recipient_instance_id: string },
  action: HarneryInboxCompactionPlan["action"],
  reason_code: HarneryInboxCompactionPlan["reason_code"],
  remove_record_count: number,
  retained_record_count: number,
  protected_pending_count: number,
): HarneryInboxCompactionPlan {
  return {
    schema: HARNERY_INBOX_COMPACTION_PLAN_SCHEMA,
    recipient_instance_id: input.recipient_instance_id,
    action,
    reason_code,
    remove_record_count,
    retained_record_count,
    protected_pending_count,
    dry_run: true,
  };
}
