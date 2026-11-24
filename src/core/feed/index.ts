/**
 * Agent feed (ADR 0274): one time-ordered list of the messages agents send each
 * other and the journal entries they write, so a person can read what happened
 * in order instead of opening each session.
 *
 * This module reads only this machine's own records:
 *   - `.harnery/inbox/<recipient>.jsonl`: every ping delivered to an agent on
 *     this machine, including pings imported from other machines' mail refs;
 *   - `.harnery/mail/log.jsonl`: pings this machine sent to other machines;
 *   - `.harnery/journal/*.md` and `.harnery/journal/archived/*.md`.
 *
 * Other machines' items arrive through the shared feed refs
 * (`src/core/presence/feed.ts`). Everything here is read-only and never throws:
 * an unreadable file is skipped.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { JOURNAL_CATEGORIES, type JournalCategory, parseJournal } from "../journal/codec.ts";

export const FEED_ITEM_SCHEMA = "harnery.feed-item/v1" as const;

export interface FeedAgentRef {
  /** Display name without the `agent-` prefix, e.g. `Tessa`. */
  name: string;
  instance_id: string | null;
  machine: string;
}

export interface FeedMessageItem {
  kind: "message";
  /** The inbox message id; identical on the sending and receiving machine. */
  id: string;
  at: string;
  from: FeedAgentRef;
  to: FeedAgentRef;
  body: string;
  /** True when a shared copy clamped the body. */
  body_truncated?: boolean;
}

export interface FeedJournalItem {
  kind: "journal";
  /** Content hash, so a journal and its later archive copy collapse to one item. */
  id: string;
  at: string;
  agent: FeedAgentRef;
  category: JournalCategory;
  body: string;
  body_truncated?: boolean;
}

export type FeedItem = FeedMessageItem | FeedJournalItem;

export interface LocalFeedOptions {
  /** Oldest instant to include. Default: seven days before `now`. */
  since?: Date;
  now?: Date;
  /** Newest items kept after sorting. Default 5000. */
  limit?: number;
  /** Override the machine label (tests). */
  machine?: string;
}

export interface FeedReadResult {
  items: FeedItem[];
  /** Files skipped because they could not be read or parsed. */
  skipped_files: number;
  /** Items dropped by `limit`. */
  dropped: number;
}

const DAY_MS = 24 * 60 * 60_000;
export const FEED_DEFAULT_WINDOW_MS = 7 * DAY_MS;
const DEFAULT_LIMIT = 5_000;
const PARENT_COPY_PREFIX = "[Parent copy for ";
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Strip the `agent-` display prefix so journal and ping names match. */
export function feedAgentName(raw: string | null | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) return "unknown";
  return name.replace(/^agent-/i, "") || "unknown";
}

/** Stable id for a journal entry, independent of which file holds it. */
export function journalItemId(
  instanceId: string | null,
  name: string,
  atIso: string,
  category: string,
  body: string,
): string {
  const h = createHash("sha256")
    .update([instanceId ?? name, atIso, category, body].join("\u0000"))
    .digest("hex");
  return `j_${h.slice(0, 24)}`;
}

/** Newest first, ties broken by id so order is deterministic. */
export function sortFeedItems(items: FeedItem[]): FeedItem[] {
  return items.sort((a, b) => {
    const d = Date.parse(b.at) - Date.parse(a.at);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}

/**
 * Merge item lists, keeping one item per id. When both copies exist, the one
 * with an untruncated body wins, then the first seen.
 */
export function mergeFeedItems(...lists: FeedItem[][]): FeedItem[] {
  const byId = new Map<string, FeedItem>();
  for (const list of lists) {
    for (const item of list) {
      const prior = byId.get(item.id);
      if (!prior || (prior.body_truncated && !item.body_truncated)) byId.set(item.id, item);
    }
  }
  return sortFeedItems([...byId.values()]);
}

function readLines(path: string): unknown[] | null {
  try {
    const out: unknown[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn or foreign line is skipped, not fatal */
      }
    }
    return out;
  } catch {
    return null;
  }
}

function modifiedSince(path: string, sinceMs: number): boolean {
  try {
    return statSync(path).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

function listFiles(dir: string, ext: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function inWindow(at: string, sinceMs: number, nowMs: number): boolean {
  const t = Date.parse(at);
  return Number.isFinite(t) && t >= sinceMs && t <= nowMs + DAY_MS;
}

function readInboxItems(
  coordRoot: string,
  machine: string,
  sinceMs: number,
  nowMs: number,
  counters: { skipped: number },
): FeedItem[] {
  const items: FeedItem[] = [];
  for (const path of listFiles(join(coordRoot, ".harnery", "inbox"), ".jsonl")) {
    if (!modifiedSince(path, sinceMs)) continue;
    const records = readLines(path);
    if (!records) {
      counters.skipped++;
      continue;
    }
    for (const raw of records) {
      const r = raw as Record<string, unknown>;
      if (r?.kind !== "message") continue;
      const id = str(r.message_id);
      const at = str(r.created_at);
      const body = str(r.body);
      if (!id || !at || body === null || !inWindow(at, sinceMs, nowMs)) continue;
      if (body.startsWith(PARENT_COPY_PREFIX)) continue;
      items.push({
        kind: "message",
        id,
        at,
        from: {
          name: feedAgentName(str(r.sender_display_name)),
          instance_id: str(r.sender_instance_id),
          machine: str(r.sender_machine) ?? machine,
        },
        to: {
          name: feedAgentName(str(r.recipient_display_name)),
          instance_id: str(r.recipient_instance_id),
          machine,
        },
        body,
      });
    }
  }
  return items;
}

function readOutboundMail(
  coordRoot: string,
  sinceMs: number,
  nowMs: number,
  counters: { skipped: number },
): FeedItem[] {
  const path = join(coordRoot, ".harnery", "mail", "log.jsonl");
  if (!existsSync(path)) return [];
  const records = readLines(path);
  if (!records) {
    counters.skipped++;
    return [];
  }
  const items: FeedItem[] = [];
  for (const raw of records) {
    const r = raw as Record<string, unknown>;
    if (r?.kind !== "outbound") continue;
    const e = r.envelope as Record<string, unknown> | undefined;
    if (!e) continue;
    const id = str(e.message_id);
    const at = str(e.created_at);
    const body = str(e.body);
    if (!id || !at || body === null || !inWindow(at, sinceMs, nowMs)) continue;
    if (body.startsWith(PARENT_COPY_PREFIX)) continue;
    items.push({
      kind: "message",
      id,
      at,
      from: {
        name: feedAgentName(str(e.sender_display_name)),
        instance_id: str(e.sender_instance_id),
        machine: str(e.from_machine) ?? "unknown",
      },
      to: {
        name: feedAgentName(str(e.recipient_display_name)),
        instance_id: str(e.recipient_instance_id),
        machine: str(e.to_machine) ?? "unknown",
      },
      body,
    });
  }
  return items;
}

function instanceIdFromJournalFile(path: string): string | null {
  const base = path.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? "";
  const m = UUIDISH.exec(base);
  return m ? m[0].toLowerCase() : base || null;
}

function readJournalItems(
  coordRoot: string,
  machine: string,
  sinceMs: number,
  nowMs: number,
  counters: { skipped: number },
): FeedItem[] {
  const dir = join(coordRoot, ".harnery", "journal");
  const paths = [...listFiles(dir, ".md"), ...listFiles(join(dir, "archived"), ".md")];
  const categories = new Set<string>(JOURNAL_CATEGORIES);
  const items: FeedItem[] = [];
  for (const path of paths) {
    if (!modifiedSince(path, sinceMs)) continue;
    let doc: ReturnType<typeof parseJournal>;
    try {
      doc = parseJournal(path, readFileSync(path, "utf8"));
    } catch {
      counters.skipped++;
      continue;
    }
    const instanceId = instanceIdFromJournalFile(path);
    const name = feedAgentName(doc.header.name);
    const agentMachine = doc.header.machine?.trim() || machine;
    for (const entry of doc.entries) {
      if (!categories.has(entry.category)) continue;
      if (!inWindow(entry.ts_iso, sinceMs, nowMs)) continue;
      const body = entry.body.trim();
      if (!body) continue;
      items.push({
        kind: "journal",
        id: journalItemId(instanceId, name, entry.ts_iso, entry.category, body),
        at: new Date(Date.parse(entry.ts_iso)).toISOString(),
        agent: { name, instance_id: instanceId, machine: agentMachine },
        category: entry.category,
        body,
      });
    }
  }
  return items;
}

/** This machine's messages and journal entries, newest first. Never throws. */
export function readLocalFeed(coordRoot: string, opts: LocalFeedOptions = {}): FeedReadResult {
  const counters = { skipped: 0 };
  try {
    const now = opts.now ?? new Date();
    const nowMs = now.getTime();
    const sinceMs = (opts.since ?? new Date(nowMs - FEED_DEFAULT_WINDOW_MS)).getTime();
    const machine = opts.machine ?? resolveMachineLabel();
    const merged = mergeFeedItems(
      readInboxItems(coordRoot, machine, sinceMs, nowMs, counters),
      readOutboundMail(coordRoot, sinceMs, nowMs, counters),
      readJournalItems(coordRoot, machine, sinceMs, nowMs, counters),
    );
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const dropped = Math.max(0, merged.length - limit);
    return { items: merged.slice(0, limit), skipped_files: counters.skipped, dropped };
  } catch {
    return { items: [], skipped_files: counters.skipped, dropped: 0 };
  }
}
