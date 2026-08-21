/**
 * Recently-opened palette targets, persisted to localStorage. Powers the
 * "Recent" section shown when the command palette opens with an empty query.
 * Navigation-only: we record an href (or a viewer file path), a display
 * title, and a coarse kind that drives the row icon — never anything
 * sensitive. Newest first, deduped by href, capped.
 */

export type RecentKind =
  | "route"
  | "agent"
  | "council"
  | "decision"
  | "work"
  | "workflow"
  | "goal"
  | "file";

export interface RecentEntry {
  /** Display label for the row. */
  title: string;
  /** In-app destination. `file:` entries hold the repo-relative path instead. */
  href: string;
  /** Coarse category — selects the row icon. */
  kind?: RecentKind;
  /** Epoch ms, stamped at record time. Ordering + "time ago" only. */
  at?: number;
}

const KEY = "harnery.palette.recents.v1";
const CAP = 7;

function read(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is RecentEntry =>
        !!e &&
        typeof (e as RecentEntry).href === "string" &&
        typeof (e as RecentEntry).title === "string",
    );
  } catch {
    return [];
  }
}

/** Read the recents list (newest first). Empty on the server. */
export function getRecents(): RecentEntry[] {
  return read();
}

/** Record (or bump to newest) a navigation target. No-op on the server. */
export function recordRecent(entry: RecentEntry): void {
  if (typeof window === "undefined") return;
  const next = [{ ...entry, at: Date.now() }, ...read().filter((e) => e.href !== entry.href)].slice(
    0,
    CAP,
  );
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — recents are best-effort */
  }
}

/** Wipe the recents list. No-op on the server. */
export function clearRecents(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
