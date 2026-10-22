/**
 * Cross-machine peer messages (ADR 0222). A ping whose recipient lives on
 * another machine is queued here and published as part of this machine's
 * mail ref, `refs/harnery/mail/<machine>`, on the same origin the presence
 * refs use. Each machine writes only its own ref, so force-pushing it never
 * races another writer.
 *
 * The ref is a parentless commit whose message is one JSON blob:
 *   outbox — messages this machine sent that the recipient machine has not
 *            acknowledged yet;
 *   acks   — ids of messages this machine imported from other machines.
 *
 * The recipient machine imports envelopes addressed to it into the ordinary
 * per-instance inbox (keeping the sender's message id, so a re-import is a
 * no-op) and acknowledges them in its own ref. The sender drops an
 * acknowledged message from its outbox; the recipient stops acknowledging
 * once the sender's ref no longer lists it. Delivery is therefore
 * at-least-once into a deduplicating inbox.
 *
 * Local state is one append-only log, `.harnery/mail/log.jsonl`, updated
 * under the durable-history lease so concurrent hooks on one machine agree.
 * Repo access is the trust boundary, exactly as for presence: anyone who can
 * push to origin can publish a mail ref.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { presenceEnabled } from "../config.ts";
import type { HarneryInboxMessageRecordV1 } from "../inbox/contract.ts";
import { HARNERY_INBOX_RECORD_SCHEMA, HarneryInboxCapacityError } from "../inbox/contract.ts";
import type { HarneryInboxService } from "../inbox/service.ts";
import { readCrashSafeJsonlFile, updateCrashSafeJsonlFile } from "../storage/durable-history.ts";
import {
  hasOrigin,
  MAIL_REF_PREFIX,
  pushMachineRef,
  readMachineRefs,
  sanitizeRefComponent,
  writePresenceCommit,
} from "./git.ts";

export const HARNERY_MAIL_ENVELOPE_SCHEMA = "harnery.mail-envelope/v1" as const;
const MAIL_LOG_SCHEMA = "harnery.mail-log/v1" as const;

/** An unacknowledged message stops being offered after this long. */
export const MAIL_TTL_MS = 14 * 24 * 60 * 60_000;
/** While a message is still unacknowledged, re-push at least this often, so a
 * detached push that failed heals without anyone noticing. */
const MAIL_KEEPALIVE_SECS = 600;
const MAX_OUTBOX = 100;
/** Hook-driven imports run at most this often (the presence fetch is 60s). */
const IMPORT_INTERVAL_SECS = 30;
const MAX_LOG_RECORDS = 20_000;
const MAX_LOG_RECORD_BYTES = 16_384;

export interface HarneryMailEnvelopeV1 {
  schema: typeof HARNERY_MAIL_ENVELOPE_SCHEMA;
  message_id: string;
  from_machine: string;
  to_machine: string;
  sender_instance_id: string | null;
  sender_display_name: string;
  recipient_instance_id: string;
  recipient_display_name: string;
  created_at: string;
  body: string;
  body_bytes: number;
}

export interface HarneryMailBlobV1 {
  v: 1;
  machine: string;
  published_at: string;
  outbox: HarneryMailEnvelopeV1[];
  acks: string[];
}

type MailLogRecord =
  | {
      schema: typeof MAIL_LOG_SCHEMA;
      kind: "outbound";
      at: string;
      envelope: HarneryMailEnvelopeV1;
    }
  | { schema: typeof MAIL_LOG_SCHEMA; kind: "delivered"; at: string; message_id: string }
  | { schema: typeof MAIL_LOG_SCHEMA; kind: "expired"; at: string; message_id: string }
  | {
      schema: typeof MAIL_LOG_SCHEMA;
      kind: "imported";
      at: string;
      message_id: string;
      from_machine: string;
      sender_instance_id: string | null;
      sender_display_name: string;
    }
  | { schema: typeof MAIL_LOG_SCHEMA; kind: "released"; at: string; message_id: string };

interface MailProjection {
  /** Sent, neither acknowledged nor expired, oldest first. */
  outbox: Array<{ at: string; envelope: HarneryMailEnvelopeV1 }>;
  /** Imported and still acknowledged, keyed by message id. */
  acks: Map<string, { at: string; from_machine: string }>;
  /** Every message id this machine has imported, released or not. */
  imported: Set<string>;
  /** Senders seen in imported mail, so a reply resolves after they go idle. */
  senders: Map<string, { name: string; machine: string; at: string }>;
  delivered: number;
  expired: number;
}

/** This machine's mail identity: the same sanitized label as its ref. */
export function mailMachine(): string {
  return sanitizeRefComponent(resolveMachineLabel());
}

function mailDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "mail");
}

function logPath(coordRoot: string): string {
  return join(mailDir(coordRoot), "log.jsonl");
}

const LOG_OPTIONS = { max_record_bytes: MAX_LOG_RECORD_BYTES, max_records: MAX_LOG_RECORDS };

function stamp(now: Date): string {
  return now.toISOString();
}

function projectMail(records: readonly MailLogRecord[]): MailProjection {
  const outbound = new Map<string, { at: string; envelope: HarneryMailEnvelopeV1 }>();
  const acks = new Map<string, { at: string; from_machine: string }>();
  const imported = new Set<string>();
  const senders = new Map<string, { name: string; machine: string; at: string }>();
  let delivered = 0;
  let expired = 0;
  for (const record of records) {
    if (record?.schema !== MAIL_LOG_SCHEMA) continue;
    switch (record.kind) {
      case "outbound":
        outbound.set(record.envelope.message_id, { at: record.at, envelope: record.envelope });
        break;
      case "delivered":
        if (outbound.delete(record.message_id)) delivered++;
        break;
      case "expired":
        if (outbound.delete(record.message_id)) expired++;
        break;
      case "imported":
        imported.add(record.message_id);
        acks.set(record.message_id, { at: record.at, from_machine: record.from_machine });
        if (record.sender_instance_id) {
          senders.set(record.sender_instance_id, {
            name: record.sender_display_name,
            machine: record.from_machine,
            at: record.at,
          });
        }
        break;
      case "released":
        acks.delete(record.message_id);
        break;
    }
  }
  return { outbox: [...outbound.values()], acks, imported, senders, delivered, expired };
}

function readMailLog(coordRoot: string): MailLogRecord[] {
  try {
    return readCrashSafeJsonlFile<MailLogRecord>(logPath(coordRoot), LOG_OPTIONS);
  } catch {
    return [];
  }
}

function updateMailLog<R>(
  coordRoot: string,
  update: (projection: MailProjection) => { append?: MailLogRecord[]; result: R },
): R {
  mkdirSync(mailDir(coordRoot), { recursive: true });
  return updateCrashSafeJsonlFile<MailLogRecord, R>(logPath(coordRoot), LOG_OPTIONS, (records) =>
    update(projectMail(records)),
  );
}

export interface QueueMailInput {
  messageId: string;
  toMachine: string;
  senderInstanceId: string | null;
  senderName: string;
  recipientInstanceId: string;
  recipientName: string;
  body: string;
  maxBodyBytes: number;
  now?: Date;
}

/** Queue one message for another machine. The caller publishes afterwards. */
export function queueMail(coordRoot: string, input: QueueMailInput): HarneryMailEnvelopeV1 {
  const bodyBytes = Buffer.byteLength(input.body);
  if (bodyBytes === 0 || bodyBytes > input.maxBodyBytes) {
    throw new HarneryInboxCapacityError("message_body_limit", bodyBytes, input.maxBodyBytes);
  }
  const now = input.now ?? new Date();
  const envelope: HarneryMailEnvelopeV1 = {
    schema: HARNERY_MAIL_ENVELOPE_SCHEMA,
    message_id: input.messageId,
    from_machine: mailMachine(),
    to_machine: sanitizeRefComponent(input.toMachine),
    sender_instance_id: input.senderInstanceId,
    sender_display_name: input.senderName,
    recipient_instance_id: input.recipientInstanceId,
    recipient_display_name: input.recipientName,
    created_at: stamp(now),
    body: input.body,
    body_bytes: bodyBytes,
  };
  return updateMailLog(coordRoot, (projection) => {
    if (projection.outbox.length >= MAX_OUTBOX) {
      throw new HarneryInboxCapacityError(
        "pending_count_limit",
        projection.outbox.length,
        MAX_OUTBOX,
      );
    }
    return {
      append: [{ schema: MAIL_LOG_SCHEMA, kind: "outbound", at: stamp(now), envelope }],
      result: envelope,
    };
  });
}

export type MailPublishResult =
  | { status: "published"; machine: string; outbox: number; acks: number; sha: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

interface MailPublishState {
  hash?: string;
  pushed_at?: string;
  empty?: boolean;
}

function statePath(coordRoot: string): string {
  return join(mailDir(coordRoot), "publish-state.json");
}

function readState(coordRoot: string): MailPublishState {
  try {
    return JSON.parse(readFileSync(statePath(coordRoot), "utf8")) as MailPublishState;
  } catch {
    return {};
  }
}

function writeState(coordRoot: string, state: MailPublishState): void {
  try {
    mkdirSync(mailDir(coordRoot), { recursive: true });
    const p = statePath(coordRoot);
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, p);
  } catch {
    /* best-effort: the keepalive re-push covers a lost state write */
  }
}

/** Expire stale outbound mail, then return the blob this machine should publish. */
function currentBlob(coordRoot: string, now: Date): HarneryMailBlobV1 {
  const projection = updateMailLog(coordRoot, (p) => {
    const cutoff = now.getTime() - MAIL_TTL_MS;
    const stale = p.outbox.filter(({ at }) => Date.parse(at) < cutoff);
    return {
      append: stale.map(({ envelope }) => ({
        schema: MAIL_LOG_SCHEMA,
        kind: "expired" as const,
        at: stamp(now),
        message_id: envelope.message_id,
      })),
      result: { ...p, outbox: p.outbox.filter(({ at }) => Date.parse(at) >= cutoff) },
    };
  });
  return {
    v: 1,
    machine: mailMachine(),
    published_at: stamp(now),
    outbox: projection.outbox.map(({ envelope }) => envelope),
    acks: [...projection.acks.keys()].sort(),
  };
}

/**
 * Publish this machine's mail ref when its content changed, or as a keepalive
 * while messages are still unacknowledged. A machine that never sent or
 * received cross-machine mail never creates the ref.
 */
export function publishMail(
  coordRoot: string,
  opts: { force?: boolean; sync?: boolean; now?: Date } = {},
): MailPublishResult {
  try {
    if (!presenceEnabled(coordRoot)) return { status: "skipped", reason: "disabled" };
    // A machine that never sent or received cross-machine mail has no log;
    // the hook path stops here without spawning git.
    if (!existsSync(logPath(coordRoot))) return { status: "skipped", reason: "no mail" };
    if (!hasOrigin(coordRoot)) return { status: "skipped", reason: "no origin remote" };
    const now = opts.now ?? new Date();
    const blob = currentBlob(coordRoot, now);
    const empty = blob.outbox.length === 0 && blob.acks.length === 0;
    const hash = createHash("sha256")
      .update(JSON.stringify([blob.outbox.map((e) => e.message_id), blob.acks]))
      .digest("hex");
    const state = readState(coordRoot);
    if (!opts.force) {
      if (empty && (state.empty ?? true)) return { status: "skipped", reason: "nothing to carry" };
      const pushedAt = Date.parse(state.pushed_at ?? "");
      const sincePush = Number.isFinite(pushedAt)
        ? (now.getTime() - pushedAt) / 1000
        : Number.POSITIVE_INFINITY;
      if (state.hash === hash && (blob.outbox.length === 0 || sincePush < MAIL_KEEPALIVE_SECS)) {
        return { status: "skipped", reason: "unchanged" };
      }
    }
    const sha = writePresenceCommit(coordRoot, JSON.stringify(blob));
    if (!sha) return { status: "error", error: "commit-tree failed" };
    const push = pushMachineRef(coordRoot, MAIL_REF_PREFIX, blob.machine, sha, {
      sync: opts.sync,
    });
    if (!push.ok) return { status: "error", error: push.error ?? "push failed" };
    writeState(coordRoot, { hash, pushed_at: stamp(now), empty });
    return {
      status: "published",
      machine: blob.machine,
      outbox: blob.outbox.length,
      acks: blob.acks.length,
      sha,
    };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

function parseBlob(machine: string, message: string): HarneryMailBlobV1 | null {
  try {
    const blob = JSON.parse(message) as HarneryMailBlobV1;
    if (blob?.v !== 1 || sanitizeRefComponent(String(blob.machine)) !== machine) return null;
    if (!Number.isFinite(Date.parse(blob.published_at))) return null;
    if (!Array.isArray(blob.outbox) || !Array.isArray(blob.acks)) return null;
    return blob;
  } catch {
    return null;
  }
}

function validEnvelope(envelope: HarneryMailEnvelopeV1, from: string, self: string): boolean {
  return (
    envelope?.schema === HARNERY_MAIL_ENVELOPE_SCHEMA &&
    envelope.from_machine === from &&
    envelope.to_machine === self &&
    typeof envelope.message_id === "string" &&
    typeof envelope.recipient_instance_id === "string" &&
    typeof envelope.body === "string" &&
    Buffer.byteLength(envelope.body) === envelope.body_bytes
  );
}

export interface MailImportResult {
  received: number;
  delivered: number;
  released: number;
  rejected: number;
  published?: MailPublishResult["status"];
}

/**
 * Apply every locally-fetched peer mail ref: import envelopes addressed to
 * this machine, record acknowledgements of this machine's outbox, and stop
 * acknowledging messages their sender has dropped. Reads only local refs;
 * `fetchPresence` brings them in. Never throws.
 */
export function importMail(
  coordRoot: string,
  inbox: HarneryInboxService,
  opts: { now?: Date; publish?: boolean; throttle?: boolean } = {},
): MailImportResult {
  const result: MailImportResult = { received: 0, delivered: 0, released: 0, rejected: 0 };
  try {
    if (!presenceEnabled(coordRoot)) return result;
    const now = opts.now ?? new Date();
    if (opts.throttle && !importDue(coordRoot, now)) return result;
    const self = mailMachine();
    const peers = readMachineRefs(coordRoot, MAIL_REF_PREFIX)
      .filter(({ machine }) => machine !== self)
      .map(({ machine, message }) => ({ machine, blob: parseBlob(machine, message) }))
      .filter((peer): peer is { machine: string; blob: HarneryMailBlobV1 } => peer.blob !== null);
    if (peers.length === 0) return result;

    updateMailLog(coordRoot, (projection) => {
      const append: MailLogRecord[] = [];
      const pending = new Map(projection.outbox.map((o) => [o.envelope.message_id, o.envelope]));
      for (const { machine, blob } of peers) {
        const listed = new Set<string>();
        for (const envelope of blob.outbox) {
          if (!validEnvelope(envelope, machine, self)) continue;
          listed.add(envelope.message_id);
          if (projection.imported.has(envelope.message_id)) continue;
          if (!receive(inbox, envelope, result)) continue;
          append.push({
            schema: MAIL_LOG_SCHEMA,
            kind: "imported",
            at: stamp(now),
            message_id: envelope.message_id,
            from_machine: machine,
            sender_instance_id: envelope.sender_instance_id,
            sender_display_name: envelope.sender_display_name,
          });
        }
        for (const id of blob.acks) {
          if (pending.get(id)?.to_machine !== machine) continue;
          pending.delete(id);
          append.push({
            schema: MAIL_LOG_SCHEMA,
            kind: "delivered",
            at: stamp(now),
            message_id: id,
          });
          result.delivered++;
        }
        const publishedAt = Date.parse(blob.published_at);
        for (const [id, ack] of projection.acks) {
          if (ack.from_machine !== machine || listed.has(id)) continue;
          if (publishedAt <= Date.parse(ack.at)) continue;
          append.push({
            schema: MAIL_LOG_SCHEMA,
            kind: "released",
            at: stamp(now),
            message_id: id,
          });
          result.released++;
        }
      }
      return { append, result: undefined };
    });

    if (opts.publish !== false && result.received + result.delivered + result.released > 0) {
      result.published = publishMail(coordRoot, { now }).status;
    }
  } catch {
    /* mail must never break a hook */
  }
  return result;
}

/** Hooks import at most once per interval: refs only change when the
 * throttled presence fetch lands, so checking every prompt spawns git for
 * nothing. The stamp is touched first so concurrent hooks do not stampede. */
function importDue(coordRoot: string, now: Date): boolean {
  const path = join(mailDir(coordRoot), "import-stamp");
  try {
    if ((now.getTime() - statSync(path).mtimeMs) / 1000 < IMPORT_INTERVAL_SECS) return false;
  } catch {
    /* no stamp yet → import */
  }
  try {
    mkdirSync(mailDir(coordRoot), { recursive: true });
    writeFileSync(path, "", "utf8");
    utimesSync(path, now, now);
  } catch {
    /* best-effort */
  }
  return true;
}

/** Inbox append for one envelope. A full inbox leaves the message unacknowledged
 * so the sender keeps offering it; a malformed one is acknowledged and dropped. */
function receive(
  inbox: HarneryInboxService,
  envelope: HarneryMailEnvelopeV1,
  result: MailImportResult,
): boolean {
  const record: HarneryInboxMessageRecordV1 = {
    schema: HARNERY_INBOX_RECORD_SCHEMA,
    kind: "message",
    message_id: envelope.message_id,
    sender_instance_id: envelope.sender_instance_id,
    sender_display_name: envelope.sender_display_name,
    sender_machine: envelope.from_machine,
    recipient_instance_id: envelope.recipient_instance_id,
    recipient_display_name: envelope.recipient_display_name,
    created_at: envelope.created_at,
    body: envelope.body,
    body_bytes: envelope.body_bytes,
  };
  try {
    if (inbox.receive(record) === "received") result.received++;
    return true;
  } catch (error) {
    if (error instanceof HarneryInboxCapacityError && error.reason_code !== "message_body_limit") {
      return false;
    }
    result.rejected++;
    return true;
  }
}

export interface RemoteSender {
  instance_id: string;
  name: string;
  machine: string;
}

/** Senders this machine has received mail from, so a reply can find them even
 * after their machine's presence goes quiet. */
export function knownRemoteSenders(coordRoot: string): RemoteSender[] {
  return [...projectMail(readMailLog(coordRoot)).senders].map(([instance_id, s]) => ({
    instance_id,
    name: s.name,
    machine: s.machine,
  }));
}

export interface MailStatus {
  machine: string;
  outbox: Array<{
    message_id: string;
    to_machine: string;
    recipient: string;
    queued_at: string;
  }>;
  acks: number;
  delivered: number;
  expired: number;
}

export function mailStatus(coordRoot: string): MailStatus {
  const projection = projectMail(readMailLog(coordRoot));
  return {
    machine: mailMachine(),
    outbox: projection.outbox.map(({ at, envelope }) => ({
      message_id: envelope.message_id,
      to_machine: envelope.to_machine,
      recipient: envelope.recipient_display_name,
      queued_at: at,
    })),
    acks: projection.acks.size,
    delivered: projection.delivered,
    expired: projection.expired,
  };
}
