/**
 * Name-addressed durable mailbox.
 *
 * Peer messaging used to require a live recipient: the sender resolved a name
 * to a running instance and wrote into that instance's journal. Two failures
 * followed from that. A message to a name whose session had ended was refused
 * outright, so the sender spent a long sequence of discovery calls looking for
 * somewhere else to put it. A message to a live peer was accepted but never
 * shown to them, because nothing surfaces another session's journal.
 *
 * This module addresses the durable persona name instead of the instance, so a
 * message can be queued before its recipient exists. Delivery happens on the
 * recipient's side: their next SessionStart or prompt drains the queue, shows
 * the messages, and records them in their journal.
 *
 * Storage: `.harnery/mailbox/<slug>.jsonl`, one JSON record per line, appended
 * by senders and removed by an atomic claim on the recipient's side. Delivered
 * records are appended to `.harnery/mailbox/delivered/<slug>.jsonl` for audit.
 *
 * Related but distinct: `core/inbox` is an instance-keyed transport with a
 * storage-framework service behind it. This mailbox is name-keyed, file-only,
 * and follows the same shape as council manifests and journals.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { lookupByName } from "../../lib/identities/index.ts";
import { resolveBinName } from "../config.ts";
import { readLiveCoordinationRows } from "./state/live-coordination-view.ts";
import { COORD_NAMES } from "./state/names.ts";

export const MAILBOX_MESSAGE_SCHEMA = "harnery.mailbox-message/v1" as const;

/** Per-message body ceiling. Larger payloads belong in a managed artifact, with
 * the path sent as the message. */
export const MAX_BODY_BYTES = 4000;
/** Pending messages held for one name before senders are refused. */
export const MAX_PENDING = 25;
/** Delivered-archive ceiling; the file is truncated from the head past this. */
const MAX_DELIVERED_BYTES = 256 * 1024;

export interface MailboxMessageV1 {
  schema: typeof MAILBOX_MESSAGE_SCHEMA;
  message_id: string;
  /** Bare display name the sender addressed (registry casing when known). */
  to_name: string;
  from_name: string;
  from_instance_id: string;
  created_at: string;
  body: string;
  /** True when the sender already appended this to a live recipient's journal,
   * so the drain surfaces it without writing a duplicate entry. */
  journaled: boolean;
}

export type MailboxCapacityReason = "body_limit" | "pending_limit";

export class MailboxCapacityError extends Error {
  constructor(
    readonly reason_code: MailboxCapacityReason,
    readonly current: number,
    readonly limit: number,
  ) {
    super(
      `mailbox capacity ${reason_code}: ${current}/${limit}; write the payload to a managed artifact and send its path instead`,
    );
    this.name = "MailboxCapacityError";
  }
}

/** Strip an `agent-` prefix and normalize to the registry's bare form. */
export function bareAgentName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith("agent-") ? trimmed.slice("agent-".length) : trimmed;
}

/** Filesystem-safe slug for a name. Rejects anything that could escape the
 * mailbox directory rather than sanitizing it into a different agent's file. */
function slugFor(name: string): string {
  const bare = bareAgentName(name).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(bare)) {
    throw new Error(`invalid agent name for mailbox addressing: ${JSON.stringify(name)}`);
  }
  return bare;
}

export function mailboxDir(coordRoot: string): string {
  return resolve(coordRoot, ".harnery", "mailbox");
}

export function mailboxPath(coordRoot: string, name: string): string {
  return join(mailboxDir(coordRoot), `${slugFor(name)}.jsonl`);
}

function deliveredPath(coordRoot: string, name: string): string {
  return join(mailboxDir(coordRoot), "delivered", `${slugFor(name)}.jsonl`);
}

function parseLines(content: string): MailboxMessageV1[] {
  const out: MailboxMessageV1[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as MailboxMessageV1;
      if (parsed?.schema === MAILBOX_MESSAGE_SCHEMA) out.push(parsed);
    } catch {
      /* skip a torn line rather than losing the whole mailbox */
    }
  }
  return out;
}

/** Every name a message may be addressed to: live sessions, the durable
 * identity registry, and the built-in name pool. A name outside all three is a
 * typo, and queueing it would silently swallow the message. */
export function isAddressableName(coordRoot: string, name: string): boolean {
  const bare = bareAgentName(name).toLowerCase();
  if (!bare) return false;
  if (COORD_NAMES.some((n) => n.toLowerCase() === bare)) return true;
  if (lookupByName(bare, coordRoot)) return true;
  try {
    return readLiveCoordinationRows(coordRoot).some((r) => (r.name ?? "").toLowerCase() === bare);
  } catch {
    return false;
  }
}

/** Names close enough to a miss to be worth suggesting (prefix or one edit). */
export function suggestNames(coordRoot: string, name: string, limit = 5): string[] {
  const bare = bareAgentName(name).toLowerCase();
  const known = new Set<string>(COORD_NAMES);
  try {
    for (const row of readLiveCoordinationRows(coordRoot)) if (row.name) known.add(row.name);
  } catch {
    /* live rows are advisory here */
  }
  const scored: Array<{ name: string; distance: number }> = [];
  for (const candidate of known) {
    const lower = candidate.toLowerCase();
    if (lower.startsWith(bare.slice(0, 2)) || editDistance(lower, bare) <= 2) {
      scored.push({ name: candidate, distance: editDistance(lower, bare) });
    }
  }
  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const curr = [i, ...Array.from({ length: cols - 1 }, () => 0)];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[cols - 1]!;
}

export interface QueueInput {
  coordRoot: string;
  toName: string;
  fromName: string;
  fromInstanceId: string;
  body: string;
  journaled?: boolean;
}

export interface QueueResult {
  message: MailboxMessageV1;
  path: string;
  pending: number;
}

/**
 * Append one message to a name's mailbox. Throws `MailboxCapacityError` when
 * the body or the pending queue is over its ceiling; the caller turns that into
 * an actionable CLI error.
 */
export function queueMailboxMessage(input: QueueInput): QueueResult {
  const body = input.body.trim();
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new MailboxCapacityError("body_limit", bodyBytes, MAX_BODY_BYTES);
  }

  const path = mailboxPath(input.coordRoot, input.toName);
  mkdirSync(mailboxDir(input.coordRoot), { recursive: true });
  const existing = existsSync(path) ? parseLines(readFileSync(path, "utf8")) : [];
  if (existing.length >= MAX_PENDING) {
    throw new MailboxCapacityError("pending_limit", existing.length, MAX_PENDING);
  }

  // Preserve registry casing when the persona is known, so the recipient sees
  // their own name spelled the way it is everywhere else.
  const identity = lookupByName(input.toName, input.coordRoot);
  const message: MailboxMessageV1 = {
    schema: MAILBOX_MESSAGE_SCHEMA,
    message_id: randomUUID(),
    to_name: identity?.name ?? bareAgentName(input.toName),
    from_name: input.fromName,
    from_instance_id: input.fromInstanceId,
    created_at: new Date().toISOString(),
    body,
    journaled: input.journaled ?? false,
  };
  appendFileSync(path, `${JSON.stringify(message)}\n`, "utf8");
  return { message, path, pending: existing.length + 1 };
}

/** Pending messages for a name, without claiming them. */
export function peekMailbox(coordRoot: string, name: string): MailboxMessageV1[] {
  let path: string;
  try {
    path = mailboxPath(coordRoot, name);
  } catch {
    return [];
  }
  if (!existsSync(path)) return [];
  try {
    return parseLines(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Claim and return every pending message for a name.
 *
 * The claim is an atomic rename, so two sessions sharing a name cannot deliver
 * the same message twice: whichever rename wins owns the batch. Claimed records
 * are appended to the delivered archive before the claim file is removed, so a
 * crash between the two leaves an auditable copy rather than a silent loss.
 */
export function drainMailbox(coordRoot: string, name: string): MailboxMessageV1[] {
  let path: string;
  try {
    path = mailboxPath(coordRoot, name);
  } catch {
    return [];
  }
  // Heal first: a claim file left by a crashed reader may hold the only copy of
  // a message for this very name, and sweeping after the existence check would
  // skip it whenever the live queue is empty.
  sweepStaleClaims(coordRoot);
  if (!existsSync(path)) return [];

  const claim = `${path}.claim-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, claim);
  } catch {
    // Another reader claimed it first, or the file vanished. Either way there
    // is nothing for this caller to deliver.
    return [];
  }

  let messages: MailboxMessageV1[] = [];
  try {
    messages = parseLines(readFileSync(claim, "utf8"));
  } catch {
    messages = [];
  }

  if (messages.length > 0) {
    try {
      const archive = deliveredPath(coordRoot, name);
      mkdirSync(join(mailboxDir(coordRoot), "delivered"), { recursive: true });
      const deliveredAt = new Date().toISOString();
      appendFileSync(
        archive,
        `${messages.map((m) => JSON.stringify({ ...m, delivered_at: deliveredAt })).join("\n")}\n`,
        "utf8",
      );
      trimArchive(archive);
    } catch {
      /* audit copy is best-effort; never block delivery on it */
    }
  }

  try {
    unlinkSync(claim);
  } catch {
    /* a leftover claim is re-queued by the next drain's sweep */
  }
  return messages;
}

/** Re-queue any claim file left behind by a crashed reader (older than 5 min),
 * so a killed session cannot strand a message. Runs at the head of every drain. */
function sweepStaleClaims(coordRoot: string): void {
  const dir = mailboxDir(coordRoot);
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - 5 * 60_000;
  try {
    for (const file of readdirSync(dir)) {
      const marker = file.indexOf(".jsonl.claim-");
      if (marker === -1) continue;
      const full = join(dir, file);
      let mtime: number;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > cutoff) continue;
      const owner = join(dir, `${file.slice(0, marker)}.jsonl`);
      try {
        const content = readFileSync(full, "utf8");
        if (content.trim())
          appendFileSync(owner, content.endsWith("\n") ? content : `${content}\n`);
        unlinkSync(full);
      } catch {
        /* skip; next sweep retries */
      }
    }
  } catch {
    /* directory read is best-effort */
  }
}

function trimArchive(path: string): void {
  try {
    if (statSync(path).size <= MAX_DELIVERED_BYTES) return;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length / 2));
    writeFileSync(path, `${keep.join("\n")}\n`, "utf8");
  } catch {
    /* trimming is housekeeping, never load-bearing */
  }
}

/** Render a drained batch as the context block a recipient reads. */
export function formatMailboxDelivery(
  coordRoot: string,
  messages: readonly MailboxMessageV1[],
): string {
  if (messages.length === 0) return "";
  const bin = resolveBinName(coordRoot);
  const header =
    messages.length === 1
      ? `Message from a peer agent (delivered now, recorded in your journal):`
      : `${messages.length} messages from peer agents (delivered now, recorded in your journal):`;
  const body = messages
    .map((m) => {
      const when = m.created_at.replace("T", " ").replace(/\.\d+Z$/, "Z");
      return `  from agent-${m.from_name} (${when}):\n${indent(m.body)}`;
    })
    .join("\n\n");
  return `${header}\n\n${body}\n\nReply with \`${bin} agents ping ${messages[0]!.from_name} "<your reply>"\`; it reaches them whether or not their session is still running.`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
