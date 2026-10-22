import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type AgentParentReference,
  resolveAgentParentReference,
} from "../agents/state/parent-reference.ts";
import { resolveBinName } from "../config.ts";
import { type CoordinationViewV3, readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../events/v3/live-route-observer.ts";
import { publishMail, queueMail } from "../presence/mail.ts";
import { updateCrashSafeJsonlFile } from "../storage/durable-history.ts";
import {
  HarneryInboxCapacityError,
  type HarneryInboxLimits,
  HarneryInboxMessageConflictError,
  HarneryInboxMessageHistoryMissingError,
  type HarneryInboxMessageRecordV1,
} from "./contract.ts";
import { HarneryInboxService, stableInboxMessageId } from "./service.ts";
import {
  type MessageTargetInput,
  type MessageTargetResult,
  resolveMessageTarget,
  resolveRemoteMessageTarget,
} from "./targets.ts";

const DAY = 24 * 60 * 60_000;

/** Preserve the existing ping body/count bounds. Pending messages have no TTL;
 * the lifecycle planner protects them through the idle finalization window. */
export const PEER_INBOX_LIMITS: HarneryInboxLimits = {
  max_message_body_bytes: 4_000,
  max_pending_count: 25,
  max_pending_bytes: 100_000,
  max_history_bytes: 1024 * 1024,
  max_history_records: 10_000,
  warning_pressure_ratio: 0.8,
  max_surface_count: 10,
  max_surface_bytes: 16_000,
  max_surface_tokens: 4_000,
  surfaced_grace_ms: 7 * DAY,
  terminal_grace_ms: 7 * DAY,
};

export function peerInbox(coordRoot: string): HarneryInboxService {
  return new HarneryInboxService({ coord_root: coordRoot, limits: PEER_INBOX_LIMITS });
}

/** CLI and web use this one path. A receipt proves a synced append, never that
 * a process is awake or that the recipient has noticed the message. */
export interface PeerMessageInput {
  coordRoot: string;
  target: MessageTargetInput;
  senderInstanceId: string | null;
  senderName: string;
  body: string;
  /** Reuse the same caller-owned ID after a crash, with identical intent. */
  operationId?: string;
  /** A caller with an ambiguous prior dispatch must not create a new plan. */
  operationReplayOnly?: boolean;
}

type PeerTarget = Extract<MessageTargetResult, { ok: true }>["target"];
export type PeerRecipientResult =
  | {
      ok: true;
      target: PeerTarget;
      state: "written-live" | "queued" | "remote" | "duplicate";
      message_id: string;
      body_bytes: number;
      synced: true;
      published?: boolean;
      publish_error?: string;
      delivery_state?: "pending" | "delivered" | "expired";
    }
  | {
      ok: false;
      code: string;
      message: string;
      target?: PeerTarget;
      candidates?: string[];
      failure_stage?: "addressing" | "transport" | "operation";
    };
type ParentCopyResult = PeerRecipientResult | { state: "skipped"; reason: string };
export type PeerMessageResult = PeerRecipientResult & {
  operation_id: string;
  child: PeerRecipientResult;
  parent_reference: AgentParentReference;
  parent_copy: ParentCopyResult;
  complete: boolean;
};
interface RecipientPlan {
  target: PeerTarget;
  generation_id?: string;
  body: string;
}
interface RoutingPlan {
  kind: "plan";
  schema: "harnery.peer-routing/v1";
  request_sha256: string;
  sender_instance_id: string | null;
  sender_name: string;
  require_live: boolean;
  child: RecipientPlan;
  parent_reference: AgentParentReference;
  parent: RecipientPlan | ParentCopyResult;
}
type OperationRecord =
  | RoutingPlan
  | { kind: "started"; recipient: "child" | "parent" }
  | { kind: "result"; recipient: "child" | "parent"; result: PeerRecipientResult };
const OPERATION_LIMITS = { max_record_bytes: 24_000, max_records: 5 };

/** One frozen routing intent, child first, then at most its direct parent.
 * Receipts establish durable writes, never attention or a process wake. */
export function sendPeerMessage(input: PeerMessageInput): PeerMessageResult {
  const operationId = input.operationId ?? randomUUID();
  const unknown: AgentParentReference = { state: "unknown", reason: "original_target_unresolved" };
  const refused = (code: string, message: string): PeerMessageResult => {
    const child = { ok: false as const, code, message };
    return {
      ...child,
      child,
      operation_id: operationId,
      parent_reference: unknown,
      parent_copy: { state: "skipped", reason: "original_target_unresolved" },
      complete: false,
    };
  };
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(operationId))
    return refused("invalid_operation_id", "Supply a bounded opaque operation ID.");
  if (input.operationReplayOnly && !input.operationId)
    return refused("invalid_operation_id", "Replay-only requires the original operation ID.");
  if (!input.body.trim()) return refused("empty_message", "message is required (and non-empty)");
  const request = hash(
    JSON.stringify({
      target: {
        name: input.target.name ?? null,
        instance: input.target.instanceId ?? null,
        generation: input.target.generationId ?? null,
        require_live: input.target.requireLive ?? false,
      },
      sender: input.senderInstanceId,
      sender_name: input.senderName,
      body: input.body,
    }),
  );
  const path = join(input.coordRoot, ".harnery", "peer-operations", `${hash(operationId)}.jsonl`);
  let plan: RoutingPlan;
  try {
    const prepared = updateCrashSafeJsonlFile<OperationRecord, RoutingPlan | PeerRecipientResult>(
      path,
      OPERATION_LIMITS,
      (records) => {
        if (records.length) {
          validateOperationRecords(records, operationId);
          const existing = records[0];
          if (existing?.kind !== "plan" || existing.schema !== "harnery.peer-routing/v1")
            throw new Error("routing operation has no valid frozen plan");
          if (existing.request_sha256 !== request)
            return {
              result: {
                ok: false,
                code: "operation_conflict",
                message: "Operation ID already binds different sender, body or target intent.",
              },
            };
          return { result: existing };
        }
        if (input.operationReplayOnly)
          return {
            result: {
              ok: false,
              code: "message_history_unknown",
              message: "The original routing plan is unavailable; no recipient was resubmitted.",
            },
          };
        const view = readCoordinationViewV3(input.coordRoot);
        let target = resolveMessageTarget(input.coordRoot, input.target, { view });
        if (!target.ok && target.code === "no_peer") {
          target = resolveRemoteMessageTarget(input.coordRoot, input.target) ?? target;
        }
        if (!target.ok) return { result: target };
        const generation = selectedGeneration(view, target.target.instance_id);
        const reference = target.target.machine
          ? { state: "unknown" as const, reason: "remote_parent_evidence_unavailable" }
          : resolveAgentParentReference(
              input.coordRoot,
              { instance_id: target.target.instance_id, generation_id: generation?.generation_id },
              { view },
            );
        const child = {
          target: target.target,
          generation_id: generation?.generation_id,
          body: input.body,
        };
        let parent: RoutingPlan["parent"] = {
          state: "skipped",
          reason: reference.state === "verified" ? "parent_not_addressable" : reference.reason,
        };
        if (reference.state === "verified" && reference.addressable) {
          const parentTarget = resolveMessageTarget(
            input.coordRoot,
            {
              instanceId: reference.parent_v3_instance_id,
              generationId: reference.parent_generation_id ?? undefined,
              requireLive: input.target.requireLive,
              now: input.target.now,
            },
            { view },
          );
          const body = `[Parent copy for agent-${target.target.name} (${target.target.instance_id})]\n${input.body}`;
          parent = !parentTarget.ok
            ? parentTarget
            : Buffer.byteLength(body) > PEER_INBOX_LIMITS.max_message_body_bytes
              ? {
                  ok: false,
                  code: "parent_copy_overflow",
                  message:
                    "The parent marker and unchanged message exceed the 4000-byte message limit.",
                  target: parentTarget.target,
                }
              : {
                  target: parentTarget.target,
                  generation_id: reference.parent_generation_id ?? undefined,
                  body,
                };
        }
        const created: RoutingPlan = {
          kind: "plan",
          schema: "harnery.peer-routing/v1",
          request_sha256: request,
          sender_instance_id: input.senderInstanceId,
          sender_name: input.senderName,
          require_live: input.target.requireLive ?? false,
          child,
          parent_reference: reference,
          parent,
        };
        return { append: [created], result: created };
      },
    );
    if (!("kind" in prepared))
      return {
        ...prepared,
        child: prepared,
        operation_id: operationId,
        parent_reference: unknown,
        parent_copy: { state: "skipped", reason: "original_target_unresolved" },
        complete: false,
      };
    plan = prepared;
  } catch (error) {
    return refused(
      "operation_unavailable",
      error instanceof Error ? error.message : "Routing plan unavailable.",
    );
  }
  const resolvePlanned = (recipient: RecipientPlan) =>
    recipient.target.machine
      ? resolveRemoteMessageTarget(input.coordRoot, {
          instanceId: recipient.target.instance_id,
          requireLive: plan.require_live,
          now: input.target.now,
        })
      : resolveMessageTarget(input.coordRoot, {
          instanceId: recipient.target.instance_id,
          generationId: recipient.generation_id,
          requireLive: plan.require_live,
          now: input.target.now,
        });
  const deliver = (
    role: "child" | "parent",
    recipient: RecipientPlan,
    childOutcome?: PeerRecipientResult,
  ): PeerRecipientResult => {
    try {
      // Persist intent before transport. An interrupted prior attempt is only
      // reconcilable from retained transport history, never from its absence.
      const started = updateCrashSafeJsonlFile<
        OperationRecord,
        { replay: boolean } | PeerRecipientResult
      >(path, OPERATION_LIMITS, (records) => {
        validateOperationRecords(records, operationId);
        const prior = records.find((r) => r.kind === "result" && r.recipient === role);
        if (prior?.kind === "result") return { result: prior.result };
        // Historical receipts win; a new parent append requires the original
        // child identity to remain safely addressable now.
        if (role === "parent") {
          const currentChild = resolvePlanned(plan.child);
          if (
            (childOutcome && !childOutcome.ok && childOutcome.failure_stage !== "transport") ||
            !currentChild?.ok ||
            currentChild.target.machine !== plan.child.target.machine
          ) {
            return {
              result: {
                ok: false,
                target: recipient.target,
                failure_stage: "addressing",
                code: "parent_copy_suppressed",
                message: "Parent copy suppressed because the original task lost safe addressing.",
              },
            };
          }
        }
        if (records.some((r) => r.kind === "started" && r.recipient === role))
          return { result: { replay: true } };
        return { append: [{ kind: "started", recipient: role }], result: { replay: false } };
      });
      if ("ok" in started) return started;
      return updateCrashSafeJsonlFile<OperationRecord, PeerRecipientResult>(
        path,
        OPERATION_LIMITS,
        (records) => {
          validateOperationRecords(records, operationId);
          const frozen = records[0];
          if (frozen?.kind !== "plan" || frozen.request_sha256 !== request)
            throw new Error("routing operation plan changed");
          const prior = records.find((r) => r.kind === "result" && r.recipient === role);
          if (prior?.kind === "result") return { result: prior.result };
          const current = resolvePlanned(recipient);
          let result: PeerRecipientResult;
          if (!current?.ok || current.target.machine !== recipient.target.machine) {
            result =
              current && !current.ok
                ? { ...current, target: recipient.target, failure_stage: "addressing" }
                : {
                    ok: false,
                    target: recipient.target,
                    code: "recipient_changed",
                    failure_stage: "addressing",
                    message:
                      "The frozen recipient is no longer safely addressable on the same machine.",
                  };
          } else {
            try {
              result = deliverPeerRecipient(
                input.coordRoot,
                plan,
                recipient,
                operationId,
                current.target.delivery,
                started.replay,
              );
            } catch (error) {
              result = recipientError(error, recipient.target);
            }
          }
          // A concurrent first attempt may still finish. Retain the start and
          // report uncertainty, without turning absence into a permanent result.
          if (!result.ok && result.code === "message_history_unknown") return { result };
          return { append: [{ kind: "result", recipient: role, result }], result };
        },
      );
    } catch (error) {
      return recipientError(error, recipient.target, "operation");
    }
  };
  const child = deliver("child", plan.child);
  const parent = "body" in plan.parent ? deliver("parent", plan.parent, child) : plan.parent;
  return {
    ...child,
    child,
    operation_id: operationId,
    parent_reference: plan.parent_reference,
    parent_copy: parent,
    complete: child.ok && (!("ok" in parent) || parent.ok),
  };
}

function selectedGeneration(view: CoordinationViewV3, instance: string) {
  const id = liveInstanceIdV3(instance);
  return (
    view.instances[id] ??
    Object.values(view.terminal_generations)
      .filter((row) => row.instance_id === id)
      .sort(
        (a, b) =>
          b.source_position.segment_ordinal - a.source_position.segment_ordinal ||
          b.source_position.byte_offset - a.source_position.byte_offset,
      )[0]
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateOperationRecords(records: readonly OperationRecord[], operationId: string): void {
  const plan = records[0];
  if (
    plan?.kind !== "plan" ||
    plan.schema !== "harnery.peer-routing/v1" ||
    typeof plan.request_sha256 !== "string" ||
    typeof plan.sender_name !== "string" ||
    (plan.sender_instance_id !== null && typeof plan.sender_instance_id !== "string") ||
    typeof plan.require_live !== "boolean"
  )
    throw new Error("Invalid routing operation plan.");
  const validRecipient = (r: RecipientPlan) =>
    typeof r.body === "string" &&
    r.target &&
    typeof r.target.instance_id === "string" &&
    typeof r.target.name === "string" &&
    (r.generation_id === undefined || typeof r.generation_id === "string");
  const validParent =
    "body" in plan.parent
      ? validRecipient(plan.parent)
      : "ok" in plan.parent
        ? plan.parent.ok === false &&
          typeof plan.parent.code === "string" &&
          typeof plan.parent.message === "string"
        : plan.parent.state === "skipped" && typeof plan.parent.reason === "string";
  if (!validRecipient(plan.child) || !validParent)
    throw new Error("Invalid frozen recipient plan.");
  const started = new Set<string>();
  const completed = new Set<string>();
  for (const row of records.slice(1)) {
    if (row.kind === "plan" || !["child", "parent"].includes(row.recipient))
      throw new Error("Invalid routing operation record.");
    if (row.kind === "started") {
      if (started.has(row.recipient)) throw new Error("Duplicate recipient start.");
      started.add(row.recipient);
      continue;
    }
    if (row.kind !== "result" || !started.has(row.recipient) || completed.has(row.recipient))
      throw new Error("Invalid recipient result sequence.");
    completed.add(row.recipient);
    const recipient = row.recipient === "child" ? plan.child : plan.parent;
    const result = row.result;
    if (!("body" in recipient) || !result || typeof result.ok !== "boolean")
      throw new Error("Invalid recipient result.");
    if (result.ok) {
      if (
        result.target?.instance_id !== recipient.target.instance_id ||
        result.message_id !== stableInboxMessageId(operationId, recipient.target.instance_id) ||
        result.body_bytes !== Buffer.byteLength(recipient.body) ||
        result.synced !== true ||
        !["written-live", "queued", "remote", "duplicate"].includes(result.state)
      )
        throw new Error("Recipient receipt does not match frozen intent.");
    } else if (typeof result.code !== "string" || typeof result.message !== "string") {
      throw new Error("Invalid recipient failure.");
    }
  }
}

function recipientError(
  error: unknown,
  target: PeerTarget,
  failureStage: "transport" | "operation" = "transport",
): PeerRecipientResult {
  return {
    ok: false,
    target,
    failure_stage: failureStage,
    code:
      error instanceof HarneryInboxCapacityError
        ? `inbox_${error.reason_code}`
        : error instanceof HarneryInboxMessageHistoryMissingError ||
            error instanceof HarneryInboxMessageConflictError
          ? error.reason_code
          : "recipient_delivery_failed",
    message: error instanceof Error ? error.message : "Recipient delivery failed.",
  };
}

function deliverPeerRecipient(
  coordRoot: string,
  plan: RoutingPlan,
  recipient: RecipientPlan,
  operationId: string,
  delivery: PeerTarget["delivery"],
  replayOnly: boolean,
): PeerRecipientResult {
  const target = recipient.target;
  const messageId = stableInboxMessageId(operationId, target.instance_id);
  if (target.machine) {
    // Cross-machine (ADR 0222): queue in this machine's mail ref and push it
    // now. A failed push keeps the message queued for the next hook publish.
    const queued = queueMail(coordRoot, {
      messageId,
      replayOnly,
      toMachine: target.machine,
      senderInstanceId: plan.sender_instance_id,
      senderName: plan.sender_name,
      recipientInstanceId: target.instance_id,
      recipientName: target.name,
      body: recipient.body,
      maxBodyBytes: PEER_INBOX_LIMITS.max_message_body_bytes,
    });
    const envelope = queued.envelope;
    if (queued.delivery_state === "expired")
      return {
        ok: false,
        target,
        code: "remote_message_expired",
        message: "The original remote message expired; it was not republished.",
      };
    const published =
      queued.delivery_state === "delivered"
        ? null
        : publishMail(coordRoot, { sync: true, force: true });
    return {
      ok: true as const,
      target,
      state: queued.state === "duplicate" ? "duplicate" : "remote",
      message_id: envelope.message_id,
      body_bytes: envelope.body_bytes,
      synced: true as const,
      delivery_state: queued.delivery_state,
      published: published?.status === "published",
      ...(published?.status === "error" ? { publish_error: published.error } : {}),
    };
  }
  const receipt = peerInbox(coordRoot).send({
    message_id: messageId,
    replay_only: replayOnly,
    sender_instance_id: plan.sender_instance_id,
    sender_display_name: plan.sender_name,
    recipient_instance_id: target.instance_id,
    recipient_display_name: target.name,
    body: recipient.body,
  });
  return {
    ok: true,
    target,
    ...receipt,
    state: receipt.state === "duplicate" ? "duplicate" : delivery,
  };
}

export function formatPeerInbox(
  coordRoot: string,
  messages: readonly HarneryInboxMessageRecordV1[],
): string {
  if (messages.length === 0) return "";
  const onlyAgents = messages.every(({ sender_instance_id }) => sender_instance_id !== null);
  const header = onlyAgents
    ? messages.length === 1
      ? "Message from a peer agent:"
      : `${messages.length} messages from peer agents:`
    : messages.length === 1
      ? "Message for this task:"
      : `${messages.length} messages for this task:`;
  const body = messages
    .map(
      (message) =>
        `  ${message.message_id} from ${message.sender_instance_id === null ? "Operator" : `agent-${message.sender_display_name}`}` +
        `${message.sender_machine ? ` on ${message.sender_machine}` : ""} (${message.created_at}):\n` +
        message.body
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
    )
    .join("\n\n");
  const replyTarget = messages.find(({ sender_instance_id }) => sender_instance_id !== null);
  return (
    `${header}\n\n${body}\n\nMessages are bound to this task instance.` +
    (replyTarget
      ? ` Reply with \`${resolveBinName(coordRoot)} agents ping ${replyTarget.sender_display_name} ` +
        `--instance-id ${replyTarget.sender_instance_id} "<your reply>"\`.`
      : "")
  );
}

/** Wait for every earlier stdout write to finish before acknowledging context.
 * If output fails, the caller throws and leaves the batch pending. */
export async function acknowledgeEmittedPeerInbox(
  coordRoot: string,
  instanceId: string,
  messageIds: readonly string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write("", (error) => (error ? reject(error) : resolve()));
  });
  peerInbox(coordRoot).acknowledgeSurface(instanceId, messageIds);
}
