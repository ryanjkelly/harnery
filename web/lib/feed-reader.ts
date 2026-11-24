/**
 * Read side for the agent feed page (ADR 0274): this machine's messages and
 * journal entries merged with every other machine's shared feed.
 *
 * Local items come from `.harnery/` through the core reader; remote items come
 * from the locally fetched `refs/harnery/feed/*`. Nothing here fetches, writes,
 * or throws into a page render: any failure degrades to an empty snapshot with
 * a reason.
 */

import { presenceEnabled } from "../../src/core/config";
import {
  type FeedItem,
  type FeedReadResult,
  type LocalFeedOptions,
  mergeFeedItems,
  readLocalFeed,
} from "../../src/core/feed/index";
import {
  feedShareEnabled,
  type RemoteFeedsResult,
  readRemoteFeeds,
} from "../../src/core/presence/feed";
import { resolveMachineLabel } from "../../src/lib/machine";

export type { FeedAgentRef, FeedItem } from "./feed-items";
export { feedItemAgents, feedItemMachines } from "./feed-items";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export const FEED_WINDOWS = {
  "24h": DAY_MS,
  "3d": 3 * DAY_MS,
  "7d": 7 * DAY_MS,
} as const;

export type FeedWindow = keyof typeof FEED_WINDOWS;
export const DEFAULT_FEED_WINDOW: FeedWindow = "3d";

/** Remote machines publish only their last three days. */
export const REMOTE_FEED_WINDOW_MS = 3 * DAY_MS;

/** Rows rendered at most; the oldest beyond this are dropped and counted. */
export const FEED_RENDER_CAP = 3_000;

export function parseFeedWindow(raw: string | string[] | undefined | null): FeedWindow {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value in FEED_WINDOWS ? (value as FeedWindow) : DEFAULT_FEED_WINDOW;
}

/** One place items came from: this machine, or one remote feed ref. */
export interface FeedSource {
  key: string;
  label: string;
  local: boolean;
  items: number;
  /** Null for this machine, which is read live. */
  publishedAt: string | null;
  ageSecs: number | null;
  stale: boolean;
  /** Items the publisher left out to stay under its caps. */
  truncated: number;
}

export interface FeedSnapshot {
  items: FeedItem[];
  /** This machine's label, for "shown when not this machine" decisions. */
  machine: string;
  windowMs: number;
  since: string;
  sources: FeedSource[];
  /** Presence carries the feed refs; off means no remote items can arrive. */
  presence: boolean;
  /** Whether the project shares feeds (`feed.share`). */
  sharing: boolean;
  /** Local files that could not be read or parsed. */
  skippedFiles: number;
  /** Remote refs whose blob could not be parsed. */
  malformedRefs: string[];
  /** Items left out by the local read limit or the render cap. */
  dropped: number;
  /** Set when reading failed outright; the rest of the snapshot is empty. */
  error: string | null;
}

/** Injection seam for tests; production callers use the defaults. */
export interface FeedReaderDeps {
  now?: Date;
  machine?: string;
  renderCap?: number;
  presenceEnabled?: (root: string) => boolean;
  feedShareEnabled?: (root: string) => boolean;
  readLocalFeed?: (root: string, opts: LocalFeedOptions) => FeedReadResult;
  readRemoteFeeds?: (root: string, opts: { now?: Date }) => RemoteFeedsResult;
}

const MALFORMED = new Set(["invalid_json", "invalid_blob", "unsupported_version"]);

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function inWindow(item: FeedItem, sinceMs: number): boolean {
  const t = Date.parse(item.at);
  return Number.isFinite(t) && t >= sinceMs;
}

export function readFeedSnapshot(
  root: string,
  opts: { windowMs?: number } = {},
  deps: FeedReaderDeps = {},
): FeedSnapshot {
  const now = deps.now ?? new Date();
  const windowMs = opts.windowMs ?? FEED_WINDOWS[DEFAULT_FEED_WINDOW];
  const sinceMs = now.getTime() - windowMs;
  const since = new Date(sinceMs).toISOString();
  const machine = deps.machine ?? safe(() => resolveMachineLabel(), "this machine");
  const presence = safe(() => (deps.presenceEnabled ?? presenceEnabled)(root), false);
  const sharing = safe(() => (deps.feedShareEnabled ?? feedShareEnabled)(root), false);
  const base: FeedSnapshot = {
    items: [],
    machine,
    windowMs,
    since,
    sources: [],
    presence,
    sharing,
    skippedFiles: 0,
    malformedRefs: [],
    dropped: 0,
    error: null,
  };

  try {
    const local = (deps.readLocalFeed ?? readLocalFeed)(root, {
      since: new Date(sinceMs),
      now,
      machine,
    });
    const sources: FeedSource[] = [
      {
        key: "local",
        label: machine,
        local: true,
        items: local.items.length,
        publishedAt: null,
        ageSecs: null,
        stale: false,
        truncated: 0,
      },
    ];
    const lists: FeedItem[][] = [local.items];
    const malformedRefs: string[] = [];

    if (presence) {
      const remote = safe(() => (deps.readRemoteFeeds ?? readRemoteFeeds)(root, { now }), {
        feeds: [],
        skipped: [],
      });
      for (const s of remote.skipped) if (MALFORMED.has(s.reason)) malformedRefs.push(s.ref);
      const labelCounts = new Map<string, number>();
      for (const f of remote.feeds)
        labelCounts.set(f.machine, (labelCounts.get(f.machine) ?? 0) + 1);
      for (const f of remote.feeds) {
        const items = f.items.filter((item) => inWindow(item, sinceMs));
        lists.push(items);
        const duplicate = (labelCounts.get(f.machine) ?? 0) > 1 || f.machine === machine;
        sources.push({
          key: `ref:${f.ref}`,
          label: duplicate ? `${f.machine} (${f.ref})` : f.machine,
          local: false,
          items: items.length,
          publishedAt: f.published_at,
          ageSecs: f.age_secs,
          stale: f.stale,
          truncated: f.truncated,
        });
      }
    }

    const merged = mergeFeedItems(...lists);
    const cap = deps.renderCap ?? FEED_RENDER_CAP;
    const capped = merged.length > cap ? merged.slice(0, cap) : merged;
    return {
      ...base,
      items: capped,
      sources,
      skippedFiles: local.skipped_files,
      malformedRefs,
      dropped: local.dropped + (merged.length - capped.length),
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
