import { closeSync, type FSWatcher, fstatSync, realpathSync, watch } from "node:fs";
import { opendir } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { coordRoot } from "./coord-reader";
import { resolveDir } from "./file-tree";
import { resolveFile } from "./files";
import { thumbnailActivity } from "./thumbnail-activity";
import { canRenderThumbnail } from "./thumbnail-renderers";
import { serveFileThumbnail, thumbnailQueueStatus } from "./thumbnail-service";

interface Options {
  root: string;
  debounceMs?: number;
  scanIntervalMs?: number;
  tickMs?: number;
  enqueue?: (relative: string) => Promise<number>;
  busy?: () => boolean;
}
interface Watched {
  watcher: FSWatcher;
  versions: Map<string, string>;
  force?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Watch recent artifact workspaces and recently browsed folders, never the whole repository. */
export function createThumbnailBackground(options: Options) {
  const { root } = options;
  const debounceMs = options.debounceMs ?? 750;
  const watched = new Map<string, Watched>();
  const folders = new Map<string, number>();
  const pending = new Map<string, number>();
  const scanning = new Set<string>();
  const dirty = new Set<string>();
  let rootWatcher: FSWatcher | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let refreshing = false;
  let pumping = false;
  const enqueue =
    options.enqueue ??
    (async (relative: string) => {
      const response = await serveFileThumbnail(
        new Request(
          `http://thumbnail.invalid/api/file/thumbnail?path=${encodeURIComponent(relative)}`,
        ),
        { root, priority: "background", waitMs: 0 },
      );
      await response.arrayBuffer();
      return response.status;
    });
  const busy =
    options.busy ??
    (() => {
      const status = thumbnailQueueStatus();
      return status.visible || status.pending >= 4;
    });

  function schedule(relative: string) {
    if (closed) return;
    pending.delete(relative);
    pending.set(relative, Date.now() + debounceMs);
    if (pending.size > 256) pending.delete(pending.keys().next().value!);
  }

  async function scan(relative: string, depth = 0, seed = false, force = false) {
    if (closed) return;
    if (scanning.has(relative)) {
      dirty.add(relative);
      return;
    }
    const checked = resolveDir(relative, { root });
    if (!checked.ok) return;
    scanning.add(relative);
    try {
      let entry = watched.get(relative);
      const firstScan = !entry;
      if (!entry) {
        if (watched.size >= 64) return;
        const watcher = watch(checked.real, { persistent: false }, (_event, filename) => {
          const state = watched.get(relative);
          if (!state || closed) return;
          clearTimeout(state.timer);
          state.force ||= filename?.toString().startsWith(".thumbnail-preview-") ?? false;
          state.timer = setTimeout(() => {
            const force = state.force;
            state.force = false;
            void scan(relative, depth, false, force);
          }, debounceMs);
          state.timer.unref?.();
        });
        entry = { watcher, versions: new Map() };
        watched.set(relative, entry);
        watcher.on("error", () => {
          watcher.close();
          watched.delete(relative);
        });
      }
      const next = new Map<string, string>();
      const directory = await opendir(checked.real);
      let count = 0;
      let seeds = 0;
      for await (const item of directory) {
        if (closed || ++count > 128) break;
        if (count % 8 === 0) await yieldTurn();
        if (item.name.startsWith(".")) continue;
        const child = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory() && depth < 2) {
          if (watched.has(child) || watched.size < 64)
            await scan(child, depth + 1, seed || !firstScan);
          continue;
        }
        if (!item.isFile()) continue;
        const file = resolveFile(child, { root });
        if (!file.ok) continue;
        try {
          if (!canRenderThumbnail(file.category, file.relPath)) continue;
          const stat = fstatSync(file.fd);
          const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          next.set(child, version);
          const previous = entry.versions.get(child);
          if (
            force ||
            (previous !== undefined && previous !== version) ||
            (previous === undefined && (!firstScan || (seed && seeds++ < 6)))
          )
            schedule(child);
        } finally {
          closeSync(file.fd);
        }
      }
      entry.versions = next;
    } catch {
      // Removal or replacement during discovery is retried on the next bounded refresh.
    } finally {
      scanning.delete(relative);
      if (dirty.delete(relative) && !closed) void scan(relative, depth);
    }
  }

  function requestRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void refresh();
    }, 200);
    refreshTimer.unref?.();
  }

  async function refresh() {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const relative = ".harnery/artifacts";
      const checked = resolveDir(relative, { root });
      const names: string[] = [];
      if (checked.ok) {
        if (!rootWatcher) {
          rootWatcher = watch(checked.real, { persistent: false }, requestRefresh);
          rootWatcher.on("error", () => {
            rootWatcher?.close();
            rootWatcher = undefined;
          });
        }
        const directory = await opendir(checked.real);
        let examined = 0;
        for await (const item of directory) {
          if (++examined > 4096) break;
          if (item.isDirectory() && !item.name.startsWith("."))
            names.push(`${relative}/${item.name}`);
        }
      }
      // Managed workspace names start with their creation date.
      const recent = names.sort().reverse().slice(0, 24);
      const selected = [...folders.keys(), ...recent];
      for (const [relative, entry] of watched) {
        if (selected.some((parent) => relative === parent || relative.startsWith(`${parent}/`)))
          continue;
        entry.watcher.close();
        clearTimeout(entry.timer);
        watched.delete(relative);
      }
      for (const [index, relative] of selected.entries()) {
        if (!watched.has(relative)) await scan(relative, 0, index < 2);
      }
    } catch {
      // A project without managed artifacts can still watch its browsed folders.
    } finally {
      refreshing = false;
    }
  }

  async function pump() {
    if (closed || pumping || busy()) return;
    const ready = [...pending.entries()].find(([, due]) => due <= Date.now());
    if (!ready) return;
    const [relative] = ready;
    pending.delete(relative);
    pumping = true;
    try {
      const status = await enqueue(relative);
      if (status === 503 || status === 409) schedule(relative);
    } catch {
      /* A later file event can retry failed transport. */
    } finally {
      pumping = false;
    }
  }

  const touch = (relative: string) => {
    if (relative === "." || relative === "") return; // Never speculate across the repository root.
    folders.delete(relative);
    folders.set(relative, Date.now());
    if (folders.size > 8) folders.delete(folders.keys().next().value!);
    if (!watched.has(relative)) {
      for (const [old, entry] of [...watched].reverse()) {
        if (watched.size < 56) break;
        if ([...folders.keys()].some((active) => old === active || old.startsWith(`${active}/`)))
          continue;
        entry.watcher.close();
        clearTimeout(entry.timer);
        watched.delete(old);
      }
      requestRefresh();
    }
  };
  thumbnailActivity.set(root, touch);
  const discovery = setInterval(() => {
    void refresh();
  }, options.scanIntervalMs ?? 30_000);
  const work = setInterval(() => {
    void pump();
  }, options.tickMs ?? 100);
  discovery.unref?.();
  work.unref?.();
  void refresh();
  return {
    touch,
    refresh,
    get pending() {
      return pending.size;
    },
    stop() {
      closed = true;
      clearInterval(discovery);
      clearInterval(work);
      clearTimeout(refreshTimer);
      rootWatcher?.close();
      for (const entry of watched.values()) {
        entry.watcher.close();
        clearTimeout(entry.timer);
      }
      watched.clear();
      pending.clear();
      if (thumbnailActivity.get(root) === touch) thumbnailActivity.delete(root);
    },
  };
}

const globalBackground = globalThis as typeof globalThis & {
  __harneryThumbnailBackgroundV1?: ReturnType<typeof createThumbnailBackground>;
};
export function startThumbnailBackground() {
  if (process.env.HARNERY_THUMBNAILS_PREGENERATE === "0") return;
  globalBackground.__harneryThumbnailBackgroundV1 ??= createThumbnailBackground({
    root: realpathSync(coordRoot()),
  });
}
