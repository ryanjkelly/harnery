/**
 * Shared agent feed (ADR 0274): a read-only, cross-machine copy of each
 * machine's recent agent messages and journal entries, carried on the presence
 * git-refs transport (ADR 0016) beside the shared docket (ADR 0255).
 *
 * Inboxes, the mail log, and journals live in each machine's `.harnery/`, which
 * is never committed, so a dashboard can only see what reached its own machine.
 * With `feed.share: true` in the project config, each machine publishes a
 * bounded blob of its recent feed to `refs/harnery/feed/<machine>`. Other
 * machines fetch the namespace with presence and merge those items into their
 * own feed, removing duplicates by item id.
 *
 * Every entry point is fail-silent: a malformed blob is skipped, a failed push
 * or fetch leaves local behavior unchanged, and nothing here throws into a hook.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { feedShareEnabled, presenceEnabled } from "../config.ts";
import {
  type FeedAgentRef,
  type FeedItem,
  feedAgentName,
  readLocalFeed,
  sortFeedItems,
} from "../feed/index.ts";
import { JOURNAL_CATEGORIES, type JournalCategory } from "../journal/codec.ts";
import { docketMachineId } from "./docket.ts";
import {
  FEED_REF_PREFIX,
  hasOrigin,
  pushMachineRef,
  readMachineRefs,
  sanitizeRefComponent,
  writePresenceCommit,
} from "./git.ts";

export { feedShareEnabled } from "../config.ts";

export const FEED_BLOB_VERSION = 1 as const;

export interface FeedLimits {
  /** Items older than this are not published. */
  windowDays: number;
  items: number;
  /** Per-item body clamp, in characters. */
  body: number;
  /** Hard ceiling on the serialized blob; oldest items drop first. */
  bytes: number;
}

export const FEED_LIMITS: Readonly<FeedLimits> = {
  windowDays: 3,
  items: 400,
  body: 1_500,
  bytes: 192 * 1024,
};

/** Re-publish at least this often so peers can tell "unchanged" from "gone". */
const KEEPALIVE_SECS = 1_800;
/** Feed changes on most turns; one push a minute is enough for a reader. */
const MIN_PUSH_INTERVAL_SECS = 60;
/** A feed older than this is flagged stale (its machine stopped publishing). */
export const FEED_STALE_SECS = 3 * KEEPALIVE_SECS;
/** A feed older than this is not shown at all. */
const FEED_EXPIRE_SECS = 14 * 24 * 3600;

export interface FeedBlob {
  v: typeof FEED_BLOB_VERSION;
  kind: "feed";
  machine: string;
  machine_id: string;
  published_at: string;
  /** True when this machine turned sharing off; peers show nothing from it. */
  withdrawn?: boolean;
  items: FeedItem[];
  /** Items left out by the item or byte cap. */
  truncated: number;
}

interface FeedState {
  basis_hash?: string;
  pushed_at?: string;
  ref?: string;
  had_items?: boolean;
  withdrawn?: boolean;
}

function presenceDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "presence");
}

function statePath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "feed-state.json");
}

function readState(coordRoot: string): FeedState {
  try {
    return JSON.parse(readFileSync(statePath(coordRoot), "utf8")) as FeedState;
  } catch {
    return {};
  }
}

function writeState(coordRoot: string, state: FeedState): void {
  try {
    mkdirSync(presenceDir(coordRoot), { recursive: true });
    const p = statePath(coordRoot);
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, p);
  } catch {
    /* best-effort */
  }
}

/** Read the feed state's last ref without creating anything (ref inventory). */
export function readFeedStateRef(coordRoot: string): string | null {
  const ref = readState(coordRoot).ref;
  return typeof ref === "string" && ref === sanitizeRefComponent(ref) ? ref : null;
}

// ─── Build ──────────────────────────────────────────────────────────────────

function clampBody<T extends FeedItem>(item: T, max: number): T {
  if (item.body.length <= max) return item;
  return { ...item, body: `${item.body.slice(0, max - 1)}…`, body_truncated: true };
}

export interface BuildFeedOptions {
  now?: Date;
  machine?: string;
  machineId?: string;
  limits?: Partial<FeedLimits>;
}

export interface BuiltFeed {
  blob: FeedBlob;
  basisHash: string;
  json: string;
}

/** Build this machine's feed blob from its local inboxes, mail log, and journals. */
export function buildFeedBlob(coordRoot: string, opts: BuildFeedOptions = {}): BuiltFeed {
  const limits = { ...FEED_LIMITS, ...opts.limits };
  const now = opts.now ?? new Date();
  const machine = opts.machine ?? resolveMachineLabel();
  const local = readLocalFeed(coordRoot, {
    now,
    machine,
    since: new Date(now.getTime() - limits.windowDays * 86_400_000),
  });
  let items = local.items.map((item) => clampBody(item, limits.body));
  let truncated = Math.max(0, items.length - limits.items);
  items = items.slice(0, limits.items);
  const basisHash = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  const make = (list: FeedItem[], cut: number): FeedBlob => ({
    v: FEED_BLOB_VERSION,
    kind: "feed",
    machine,
    machine_id: opts.machineId ?? "000000000000",
    published_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    items: list,
    truncated: cut,
  });
  let blob = make(items, truncated);
  let json = JSON.stringify(blob);
  // Newest first, so dropping from the end loses the oldest items.
  while (Buffer.byteLength(json) > limits.bytes && items.length > 0) {
    const drop = Math.max(1, Math.ceil(items.length * 0.1));
    items = items.slice(0, items.length - drop);
    truncated += drop;
    blob = make(items, truncated);
    json = JSON.stringify(blob);
  }
  return { blob, basisHash, json };
}

function withdrawnBlob(machine: string, machineId: string, now: Date): BuiltFeed {
  const blob: FeedBlob = {
    v: FEED_BLOB_VERSION,
    kind: "feed",
    machine,
    machine_id: machineId,
    published_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    withdrawn: true,
    items: [],
    truncated: 0,
  };
  return { blob, basisHash: "withdrawn", json: JSON.stringify(blob) };
}

// ─── Publish ────────────────────────────────────────────────────────────────

export type FeedPublishResult =
  | { status: "published"; machine: string; ref: string; items: number }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

/**
 * Pick the ref component to publish under: the sanitized machine label, or
 * `<label>-<id prefix>` when another fresh machine already holds that label.
 */
export function chooseFeedRef(
  coordRoot: string,
  machine: string,
  machineId: string,
  previous: string | undefined,
  now: Date = new Date(),
): string {
  const base = sanitizeRefComponent(machine);
  const suffixed = sanitizeRefComponent(`${machine}-${machineId.slice(0, 6)}`);
  if (previous === suffixed) return suffixed;
  try {
    for (const { machine: ref, message } of readMachineRefs(coordRoot, FEED_REF_PREFIX)) {
      if (ref !== base) continue;
      const blob = parseFeedBlob(message);
      if (!blob || blob.machine_id === machineId) return base;
      const age = (now.getTime() - Date.parse(blob.published_at)) / 1000;
      return age <= FEED_STALE_SECS ? suffixed : base;
    }
  } catch {
    /* unreadable refs: keep the plain label */
  }
  return base;
}

/**
 * Publish this machine's feed blob when sharing is on and it changed (or the
 * keepalive elapsed). Turning sharing off publishes one withdrawal so peers stop
 * showing the old copy. Never throws.
 */
export function publishFeed(
  coordRoot: string,
  opts: { force?: boolean; sync?: boolean; now?: Date } = {},
): FeedPublishResult {
  try {
    if (!presenceEnabled(coordRoot)) return { status: "skipped", reason: "presence disabled" };
    const state = readState(coordRoot);
    const sharing = feedShareEnabled(coordRoot);
    if (!sharing && (!state.pushed_at || state.withdrawn)) {
      return { status: "skipped", reason: "sharing off" };
    }
    const now = opts.now ?? new Date();
    const pushedAtMs = Date.parse(state.pushed_at ?? "");
    const sincePush = Number.isFinite(pushedAtMs)
      ? (now.getTime() - pushedAtMs) / 1000
      : Number.POSITIVE_INFINITY;
    // Hooks call this on every turn; skip the scan entirely inside the floor.
    if (!opts.force && sincePush < MIN_PUSH_INTERVAL_SECS) {
      return { status: "skipped", reason: "min push interval" };
    }
    if (!hasOrigin(coordRoot)) return { status: "skipped", reason: "no origin remote" };

    const machineId = docketMachineId(coordRoot);
    const machine = resolveMachineLabel();
    const built = sharing
      ? buildFeedBlob(coordRoot, { now, machine, machineId })
      : withdrawnBlob(machine, machineId, now);
    const hasItems = built.blob.items.length > 0;

    if (!opts.force && sharing) {
      if (!hasItems && !state.pushed_at) return { status: "skipped", reason: "nothing to share" };
      const unchanged = state.basis_hash === built.basisHash;
      if (unchanged && sincePush < KEEPALIVE_SECS) {
        return { status: "skipped", reason: "unchanged (within keepalive)" };
      }
    }

    const ref =
      !sharing && state.ref
        ? state.ref
        : chooseFeedRef(coordRoot, machine, machineId, state.ref, now);
    const sha = writePresenceCommit(coordRoot, built.json);
    if (!sha) return { status: "error", error: "commit-tree failed" };
    const push = pushMachineRef(coordRoot, FEED_REF_PREFIX, ref, sha, { sync: opts.sync });
    if (!push.ok) return { status: "error", error: push.error ?? "push failed" };

    writeState(coordRoot, {
      basis_hash: built.basisHash,
      pushed_at: now.toISOString(),
      ref,
      had_items: hasItems,
      withdrawn: !sharing,
    });
    return { status: "published", machine, ref, items: built.blob.items.length };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Read ───────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = 400): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

function validTime(v: unknown): string | null {
  const s = str(v, 64);
  return s && Number.isFinite(Date.parse(s)) ? s : null;
}

function parseAgent(raw: unknown): FeedAgentRef | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name, 120);
  const machine = str(raw.machine, 120);
  if (!name || !machine) return null;
  return { name: feedAgentName(name), instance_id: str(raw.instance_id, 120), machine };
}

const CATEGORIES = new Set<string>(JOURNAL_CATEGORIES);
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

function parseItem(raw: unknown): FeedItem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id, 200);
  const at = validTime(raw.at);
  const body = typeof raw.body === "string" ? raw.body.slice(0, FEED_LIMITS.body + 1) : null;
  if (!id || !ID_PATTERN.test(id) || !at || body === null) return null;
  const truncated = raw.body_truncated === true ? { body_truncated: true as const } : {};
  if (raw.kind === "message") {
    const from = parseAgent(raw.from);
    const to = parseAgent(raw.to);
    if (!from || !to) return null;
    return { kind: "message", id, at, from, to, body, ...truncated };
  }
  if (raw.kind === "journal") {
    const agent = parseAgent(raw.agent);
    const category = str(raw.category, 40);
    if (!agent || !category || !CATEGORIES.has(category)) return null;
    return {
      kind: "journal",
      id,
      at,
      agent,
      category: category as JournalCategory,
      body,
      ...truncated,
    };
  }
  return null;
}

type FeedParseFailure = "invalid_json" | "invalid_blob" | "unsupported_version";

function parseFeedResult(message: string): { blob: FeedBlob } | { reason: FeedParseFailure } {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return { reason: "invalid_json" };
  }
  if (!isRecord(raw) || raw.kind !== "feed") return { reason: "invalid_blob" };
  if (raw.v !== FEED_BLOB_VERSION) return { reason: "unsupported_version" };
  const machine = str(raw.machine, 120);
  const machineId = str(raw.machine_id, 64);
  const publishedAt = validTime(raw.published_at);
  if (!machine || !machineId || !publishedAt) return { reason: "invalid_blob" };
  const items = Array.isArray(raw.items)
    ? raw.items
        .slice(0, FEED_LIMITS.items)
        .map(parseItem)
        .filter((i): i is FeedItem => i !== null)
    : [];
  const truncated =
    typeof raw.truncated === "number" && Number.isFinite(raw.truncated) && raw.truncated > 0
      ? Math.floor(raw.truncated)
      : 0;
  return {
    blob: {
      v: FEED_BLOB_VERSION,
      kind: "feed",
      machine,
      machine_id: machineId,
      published_at: publishedAt,
      ...(raw.withdrawn === true ? { withdrawn: true } : {}),
      items: sortFeedItems(items),
      truncated,
    },
  };
}

/** Validate a feed blob; drops malformed items, returns null for a bad blob. */
export function parseFeedBlob(message: string): FeedBlob | null {
  const parsed = parseFeedResult(message);
  return "blob" in parsed ? parsed.blob : null;
}

export interface RemoteFeed {
  ref: string;
  machine: string;
  machine_id: string;
  published_at: string;
  age_secs: number;
  stale: boolean;
  items: FeedItem[];
  truncated: number;
}

export interface SkippedFeedRef {
  ref: string;
  reason: FeedParseFailure | "withdrawn" | "self" | "expired";
}

export interface RemoteFeedsResult {
  feeds: RemoteFeed[];
  skipped: SkippedFeedRef[];
}

function readFeedMachineId(coordRoot: string): string | null {
  try {
    const id = readFileSync(join(presenceDir(coordRoot), "docket-machine-id"), "utf8").trim();
    return /^[a-f0-9]{12}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Every other machine's feed from the locally fetched refs, with a reason for
 * every skipped ref. Self, withdrawn, and expired feeds are excluded; stale ones
 * are kept and flagged. Never fetches, writes, or throws.
 */
export function readRemoteFeeds(
  coordRoot: string,
  opts: { now?: Date; includeSelf?: boolean } = {},
): RemoteFeedsResult {
  try {
    const now = (opts.now ?? new Date()).getTime();
    const selfId = readFeedMachineId(coordRoot);
    const feeds: RemoteFeed[] = [];
    const skipped: SkippedFeedRef[] = [];
    for (const { machine: ref, message } of readMachineRefs(coordRoot, FEED_REF_PREFIX)) {
      const parsed = parseFeedResult(message);
      if ("reason" in parsed) {
        skipped.push({ ref, reason: parsed.reason });
        continue;
      }
      const { blob } = parsed;
      if (blob.withdrawn) {
        skipped.push({ ref, reason: "withdrawn" });
        continue;
      }
      if (!opts.includeSelf && blob.machine_id === selfId) {
        skipped.push({ ref, reason: "self" });
        continue;
      }
      const ageSecs = Math.max(0, Math.floor((now - Date.parse(blob.published_at)) / 1000));
      if (ageSecs > FEED_EXPIRE_SECS) {
        skipped.push({ ref, reason: "expired" });
        continue;
      }
      feeds.push({
        ref,
        machine: blob.machine,
        machine_id: blob.machine_id,
        published_at: blob.published_at,
        age_secs: ageSecs,
        stale: ageSecs > FEED_STALE_SECS,
        items: blob.items,
        truncated: blob.truncated,
      });
    }
    feeds.sort((a, b) => a.ref.localeCompare(b.ref));
    skipped.sort((a, b) => a.ref.localeCompare(b.ref));
    return { feeds, skipped };
  } catch {
    return { feeds: [], skipped: [] };
  }
}
