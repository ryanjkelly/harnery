import { loadThumbnail, type ThumbnailPriority } from "./thumbnail-loader";

type DecodedThumbnail = { url: string; bytes: number; dispose: () => void };
export type ThumbnailLease = {
  ready: Promise<DecodedThumbnail | null>;
  release: () => void;
  invalidate: () => void;
};

/** Retention limits exclude images still leased by visible cards: never revoke an in-use URL. */
export function createThumbnailCache(options: {
  load: (
    path: string,
    version: string,
    signal: AbortSignal,
    deadline: number,
    priority: ThumbnailPriority,
  ) => Promise<Blob | null>;
  decode: (blob: Blob) => Promise<DecodedThumbnail>;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
}) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 64;
  const maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
  const ttl = options.ttlMs ?? 30_000;
  type Entry = {
    key: string;
    version: string;
    refs: number;
    controller: AbortController;
    ready: Promise<DecodedThumbnail | null>;
    value: DecodedThumbnail | null;
    pending: boolean;
    retired: boolean;
    expires: number;
    timer?: ReturnType<typeof setTimeout>;
  };
  const entries = new Map<string, Entry>();
  const dispose = (entry: Entry) => {
    entry.value?.dispose();
    entry.value = null;
  };
  const retire = (entry: Entry) => {
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    entry.retired = true;
    clearTimeout(entry.timer);
    if (!entry.refs) {
      entry.controller.abort();
      dispose(entry);
    }
  };
  const prune = () => {
    for (const entry of entries.values()) if (entry.expires <= now()) retire(entry);
    let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.value?.bytes ?? 0), 0);
    // Map order is last acquisition order. Retire oldest entries first; pinned leases
    // finish normally but cannot be reused by another card once outside the budget.
    for (const entry of entries.values()) {
      if (entries.size <= maxEntries && bytes <= maxBytes) break;
      bytes -= entry.value?.bytes ?? 0;
      retire(entry);
    }
  };
  const clear = () => {
    for (const entry of entries.values()) retire(entry);
  };
  return {
    clear,
    acquire(
      scope: string,
      path: string,
      version: string,
      deadline: number,
      priority: ThumbnailPriority = "visible",
    ): ThumbnailLease {
      prune();
      const key = JSON.stringify([scope, path]);
      let entry = entries.get(key);
      if (entry && entry.version !== version) {
        retire(entry);
        entry = undefined;
      }
      if (!entry) {
        const created: Entry = {
          key,
          version,
          refs: 0,
          controller: new AbortController(),
          ready: Promise.resolve(null),
          value: null,
          pending: true,
          retired: false,
          expires: Number.POSITIVE_INFINITY,
        };
        entry = created;
        entries.set(key, created);
        created.ready = Promise.resolve()
          .then(() => options.load(path, version, created.controller.signal, deadline, priority))
          .then(async (blob) => {
            if (!blob || created.controller.signal.aborted) return null;
            const value = await options.decode(blob);
            if (created.controller.signal.aborted) {
              value.dispose();
              return null;
            }
            created.value = value;
            created.expires = now() + ttl;
            if (!created.retired) created.timer = setTimeout(() => retire(created), ttl);
            prune();
            return value;
          })
          .finally(() => {
            created.pending = false;
            if (!created.value) retire(created);
          });
      }
      entry.refs += 1;
      entries.delete(key);
      entries.set(key, entry);
      prune();
      const leased = entry;
      let released = false;
      return {
        ready: leased.ready,
        invalidate: () => retire(leased),
        release: () => {
          if (released) return;
          released = true;
          leased.refs -= 1;
          if (!leased.refs && (leased.pending || leased.retired || leased.expires <= now()))
            retire(leased);
          prune();
        },
      };
    },
  };
}

async function decode(blob: Blob): Promise<DecodedThumbnail> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const dispose = () => {
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  };
  image.src = url;
  try {
    await image.decode();
    return { url, bytes: blob.size + image.naturalWidth * image.naturalHeight * 4, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

const cache = createThumbnailCache({
  load: (path, version, signal, deadline, priority) =>
    loadThumbnail(path, version, signal, deadline, fetch, priority),
  decode,
});

// One dashboard origin is bound to one server project. No persistent browser storage:
// navigation can reuse only recently authorized versions in this document's memory.
export const clearThumbnailCache = cache.clear;
export function acquireThumbnail(
  path: string,
  version: string,
  deadline: number,
  priority: ThumbnailPriority,
) {
  return cache.acquire(window.location.origin, path, version, deadline, priority);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") cache.clear();
  });
  window.addEventListener("pagehide", cache.clear);
}
