import type { HarneryInboxLimits, HarneryInboxMessageRecordV1 } from "./contract.ts";
import { HarneryInboxService } from "./service.ts";
import { resolveMessageTarget, type MessageTargetInput } from "./targets.ts";
import { resolveBinName } from "../config.ts";

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
export function sendPeerMessage(input: {
  coordRoot: string;
  target: MessageTargetInput;
  senderInstanceId: string | null;
  senderName: string;
  body: string;
}) {
  const target = resolveMessageTarget(input.coordRoot, input.target);
  if (!target.ok) return target;
  const receipt = peerInbox(input.coordRoot).send({
    sender_instance_id: input.senderInstanceId,
    sender_display_name: input.senderName,
    recipient_instance_id: target.target.instance_id,
    recipient_display_name: target.target.name,
    body: input.body.trim(),
  });
  return { ok: true as const, target: target.target, ...receipt, state: target.target.delivery };
}

export function formatPeerInbox(
  coordRoot: string,
  messages: readonly HarneryInboxMessageRecordV1[],
): string {
  if (messages.length === 0) return "";
  const onlyAgents = messages.every(({ sender_instance_id }) => sender_instance_id !== null);
  const header = onlyAgents
    ? messages.length === 1 ? "Message from a peer agent:" : `${messages.length} messages from peer agents:`
    : messages.length === 1 ? "Message for this task:" : `${messages.length} messages for this task:`;
  const body = messages.map((message) =>
    `  ${message.message_id} from ${message.sender_instance_id === null ? "Operator" : `agent-${message.sender_display_name}`} (${message.created_at}):\n` +
    message.body.split("\n").map((line) => `    ${line}`).join("\n"),
  ).join("\n\n");
  const replyTarget = messages.find(({ sender_instance_id }) => sender_instance_id !== null);
  return `${header}\n\n${body}\n\nMessages are bound to this task instance.` +
    (replyTarget ? ` Reply with \`${resolveBinName(coordRoot)} agents ping ${replyTarget.sender_display_name} ` +
      `--instance-id ${replyTarget.sender_instance_id} "<your reply>"\`.` : "");
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
    process.stdout.write("", (error) => error ? reject(error) : resolve());
  });
  peerInbox(coordRoot).acknowledgeSurface(instanceId, messageIds);
}
