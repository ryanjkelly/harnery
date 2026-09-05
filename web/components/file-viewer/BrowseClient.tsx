"use client";

import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Clock3,
  FileCheck2,
  Folder,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Pin,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentChip } from "@/components/AgentChip";
import { usePaletteFileOpenOverride } from "@/components/palette/PaletteProvider";
import { Tooltip } from "@/components/ui/tooltip";
import type { BrowseSearchResult, BrowseWorkspaces } from "@/lib/browse-types";
import { createLiveRefreshScheduler } from "@/lib/live-refresh-scheduler";
import { useLiveSignal } from "@/lib/useLiveSignal";
import {
  addRecent,
  type BrowseLocation,
  type BrowserEntry,
  type BrowseSort,
  type BrowseView,
  browseHref,
  displayName,
  type FileFilter,
  fileCategory,
  filterEntries,
  inBrowseScope,
  parentDirectory,
  readBrowseLocation,
} from "./browse-model";
import { FileViewerPane } from "./FileViewerPane";
import { iconForFile } from "./file-icons";

export interface BrowseScope {
  label: string;
  roots: string[];
}
interface Listing {
  dir: string;
  entries: BrowserEntry[];
  workspace?: BrowserEntry;
}
const BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40";
const SELECT =
  "min-w-0 rounded-md border border-border bg-background px-2 py-2 text-xs outline-none focus:ring-2 focus:ring-ring";
const MODIFIED_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const LABELS: Record<BrowseView, string> = {
  recent: "Recent work",
  deliverables: "Deliverables",
  pinned: "Pinned folders",
  repository: "Repository",
  folder: "Folder",
};
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`browse:${key}`, JSON.stringify(value));
  } catch {
    /* Storage is optional. */
  }
}
function saved<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(`browse:${key}`) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load files (${response.status}).`);
  return response.json() as Promise<T>;
}

export function BrowseClient({
  initialPath,
  scope,
}: {
  initialPath: string | null;
  scope: BrowseScope | null;
}) {
  const [location, setLocation] = useState<BrowseLocation>(() =>
    readBrowseLocation("", initialPath),
  );
  const [ready, setReady] = useState(false);
  const [catalog, setCatalog] = useState<BrowseWorkspaces>({ entries: [], partial: false });
  const [listing, setListing] = useState<Listing | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<"folder" | "descendants" | "repository">("folder");
  const [searchResult, setSearchResult] = useState<BrowseSearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FileFilter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [owner, setOwner] = useState("");
  const [sort, setSort] = useState<BrowseSort>("date");
  const [mode, setMode] = useState<"list" | "grid">("list");
  const [pins, setPins] = useState<string[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [highlight, setHighlight] = useState<string | null>(initialPath);
  const [fullPreview, setFullPreview] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(48);
  const cache = useRef(new Map<string, { at: number; data: Listing }>());
  const listArea = useRef<HTMLDivElement>(null);
  const folderMode = location.view === "folder" || location.view === "repository";
  const remoteSearch = query.trim().length > 0 && searchScope !== "folder";

  useEffect(() => {
    const restore = () => {
      const next = readBrowseLocation(window.location.search);
      const params = new URLSearchParams(window.location.search);
      setLocation(next);
      setHighlight(next.file);
      setQuery(params.get("q") ?? "");
      const search = params.get("search");
      setSearchScope(
        search === "folder" || search === "descendants" || search === "repository"
          ? search
          : params.has("q")
            ? params.has("dir")
              ? "descendants"
              : "repository"
            : "folder",
      );
      setFullPreview(false);
    };
    restore();
    for (const [key, setter] of [
      ["pins", setPins],
      ["recents", setRecents],
    ] as const) {
      const stored = saved<unknown>(key, []);
      if (Array.isArray(stored))
        setter(
          stored
            .filter((p): p is string => typeof p === "string")
            .slice(0, key === "pins" ? 30 : 12),
        );
    }
    if (saved<string>("mode", "list") === "grid") setMode("grid");
    setShowHidden(saved<boolean>("show-hidden", false) === true);
    const width = saved("preview-width", 48);
    if (typeof width === "number" && Number.isFinite(width))
      setPreviewWidth(Math.max(30, Math.min(70, width)));
    const storedSort = saved("sort", "date");
    if (["name", "date", "type"].includes(storedSort)) setSort(storedSort as BrowseSort);
    setReady(true);
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const refresh = useCallback(() => {
    cache.current.clear();
    setRevision((value) => value + 1);
  }, []);
  const liveScheduler = useMemo(
    () =>
      createLiveRefreshScheduler(
        () => {
          if (document.visibilityState === "visible") refresh();
        },
        30_000,
        {
          now: Date.now,
          setTimeout: (callback, ms) => window.setTimeout(callback, ms),
          clearTimeout: (id) => window.clearTimeout(id as number),
        },
      ),
    [refresh],
  );
  useEffect(() => () => liveScheduler.cancel(), [liveScheduler]);
  const liveEvents = useMemo(
    () => ({ hello: () => {}, ping: () => {}, refresh: () => liveScheduler.request() }),
    [liveScheduler],
  );
  useLiveSignal({
    streamUrl: "/api/stream",
    events: liveEvents,
    onFallbackChange: () => liveScheduler.request(),
  });
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") liveScheduler.request();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [liveScheduler]);

  const navigate = useCallback((next: BrowseLocation, keepSearch = false) => {
    const url = new URL(window.location.href);
    if (!keepSearch) {
      url.searchParams.delete("q");
      url.searchParams.delete("search");
    }
    const href = browseHref(url.href, next);
    if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`)
      window.history.pushState(window.history.state, "", href);
    setLocation(next);
    setHighlight(next.file);
    setFullPreview(false);
    if (!keepSearch) {
      setQuery("");
      setSearchResult(null);
      setSearchScope("folder");
      setOwner("");
    }
  }, []);
  useEffect(() => {
    if (!ready) return;
    const url = new URL(window.location.href);
    if (query) {
      url.searchParams.set("q", query);
      url.searchParams.set("search", searchScope);
    } else {
      url.searchParams.delete("q");
      url.searchParams.delete("search");
    }
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [query, searchScope, ready]);
  const openFile = useCallback(
    (path: string, keepView = false) => {
      navigate(
        keepView
          ? { ...location, file: path }
          : { view: "folder", dir: parentDirectory(path), file: path },
        keepView,
      );
      setRecents((paths) => {
        const next = addRecent(paths, path);
        save("recents", next);
        return next;
      });
    },
    [location, navigate],
  );
  usePaletteFileOpenOverride(openFile);
  const openEntry = useCallback(
    (entry: BrowserEntry) => {
      if (entry.kind === "dir") navigate({ view: "folder", dir: entry.relPath, file: null });
      else openFile(entry.relPath, folderMode && !remoteSearch);
    },
    [navigate, openFile, folderMode, remoteSearch],
  );
  const closePreview = () => {
    navigate({ ...location, file: null }, true);
    listArea.current?.focus();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly invalidates the catalog after refresh signals.
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError(null);
    get<BrowseWorkspaces>("/api/file/workspaces", controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setCatalog(data);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setCatalogError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [ready, revision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly invalidates the current directory after refresh signals.
  useEffect(() => {
    if (!ready || !folderMode) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const cached = cache.current.get(location.dir);
    setListing((previous) => cached?.data ?? (previous?.dir === location.dir ? previous : null));
    setError(null);
    if (cached && Date.now() - cached.at < 30_000) {
      setLoading(false);
      return;
    }
    setLoading(true);
    get<Listing>(`/api/file/list?dir=${encodeURIComponent(location.dir)}`, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (cache.current.size >= 40)
          cache.current.delete(cache.current.keys().next().value as string);
        cache.current.set(location.dir, { at: Date.now(), data });
        setListing(data);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [ready, folderMode, location.dir, revision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: manual refresh retries a partial or failed search.
  useEffect(() => {
    setSearchResult(null);
    setSearchError(null);
    if (!remoteSearch) {
      setSearchLoading(false);
      return;
    }
    const controller = new AbortController();
    setSearchLoading(true);
    const started = Date.now();
    let delay = 250;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      const params = new URLSearchParams({ q: query.trim(), limit: "200" });
      if (searchScope === "descendants" && folderMode) params.set("dir", location.dir);
      try {
        const data = await get<BrowseSearchResult>(`/api/file/search?${params}`, controller.signal);
        if (controller.signal.aborted) return;
        setSearchResult(data);
        if (
          data.indexing &&
          Date.now() - started < 20_000 &&
          document.visibilityState === "visible"
        ) {
          timer = setTimeout(run, delay);
          delay = Math.min(1_000, delay * 2);
        } else setSearchLoading(false);
      } catch (err) {
        if (!controller.signal.aborted) {
          setSearchError((err as Error).message);
          setSearchLoading(false);
        }
      }
    };
    timer = setTimeout(run, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchScope, remoteSearch, folderMode, location.dir, revision]);

  const workspaces = useMemo(
    () => catalog.entries.filter((entry) => inBrowseScope(entry.relPath, scope?.roots)),
    [catalog.entries, scope],
  );
  const workspaceByPath = useMemo(
    () => new Map(catalog.entries.map((entry) => [entry.relPath, entry])),
    [catalog.entries],
  );
  const currentWorkspace =
    listing?.dir === location.dir
      ? (listing.workspace ?? workspaceByPath.get(location.dir))
      : undefined;
  const sourceEntries = useMemo<BrowserEntry[]>(() => {
    if (remoteSearch)
      return (searchResult?.matches ?? [])
        .filter(
          (entry) => searchScope === "repository" || inBrowseScope(entry.relPath, scope?.roots),
        )
        .map((entry) => ({ ...entry, name: entry.relPath.split("/").pop() ?? entry.relPath }));
    if (folderMode)
      return listing?.dir === location.dir
        ? listing.entries.map((entry) => workspaceByPath.get(entry.relPath) ?? entry)
        : [];
    if (location.view === "pinned")
      return pins
        .filter((path) => inBrowseScope(path, scope?.roots))
        .map(
          (path) =>
            workspaceByPath.get(path) ?? {
              name: path.split("/").pop() || "Repository",
              relPath: path,
              kind: "dir",
            },
        );
    if (location.view === "deliverables")
      return workspaces.filter((entry) => entry.deliveryItems?.length);
    return workspaces;
  }, [
    remoteSearch,
    searchResult,
    searchScope,
    scope,
    folderMode,
    listing,
    location.dir,
    location.view,
    pins,
    workspaceByPath,
    workspaces,
  ]);
  const entries = useMemo(
    () =>
      filterEntries(
        sourceEntries.filter(
          (entry) =>
            (!owner || entry.owner === owner) &&
            (showHidden || !entry.name.startsWith(".") || entry.relPath === location.file),
        ),
        remoteSearch ? "" : query,
        filter,
        sort,
      ),
    [sourceEntries, owner, remoteSearch, query, filter, sort, showHidden, location.file],
  );
  const previewFiles = entries.filter((entry) => entry.kind === "file");
  const previewIndex = previewFiles.findIndex((entry) => entry.relPath === location.file);
  const adjacentPreview = (delta: number) => {
    const entry = previewFiles[previewIndex + delta];
    if (entry) openFile(entry.relPath, true);
  };
  const owners = useMemo(
    () => [...new Set(sourceEntries.flatMap((entry) => (entry.owner ? [entry.owner] : [])))].sort(),
    [sourceEntries],
  );
  const activeError = remoteSearch ? searchError : folderMode ? error : catalogError;
  const busy = remoteSearch ? searchLoading : folderMode ? loading : catalogLoading;
  const currentTitle = folderMode
    ? currentWorkspace
      ? displayName(currentWorkspace)
      : location.dir.split("/").pop() || "Repository"
    : scope && location.view === "recent"
      ? scope.label
      : LABELS[location.view];
  const togglePin = (path: string) =>
    setPins((paths) => {
      const next = paths.includes(path)
        ? paths.filter((p) => p !== path)
        : [...paths, path].slice(-30);
      save("pins", next);
      return next;
    });
  const onListKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input,select,textarea,[contenteditable=true]")
    )
      return;
    if (event.key === "Escape" && location.file) {
      event.preventDefault();
      closePreview();
      return;
    }
    const index = entries.findIndex((entry) => entry.relPath === highlight);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const entry =
        entries[
          Math.max(0, Math.min(entries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
        ];
      if (entry) {
        setHighlight(entry.relPath);
        listArea.current
          ?.querySelector<HTMLElement>(`[data-entry-index="${entries.indexOf(entry)}"]`)
          ?.focus();
        if (location.file && entry.kind === "file") openFile(entry.relPath, true);
      }
    } else if ((event.key === " " || event.key === "Enter") && index >= 0) {
      event.preventDefault();
      openEntry(entries[index]);
    }
  };
  const sidebarItem = (view: BrowseView, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => navigate({ view, dir: "", file: null })}
      aria-current={location.view === view ? "page" : undefined}
      className={`${BUTTON} shrink-0 justify-start whitespace-nowrap ${location.view === view ? "bg-muted font-medium text-foreground" : "text-muted-foreground"}`}
    >
      {icon}
      {LABELS[view]}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      <aside
        aria-label="File locations"
        className={`shrink-0 border-b border-border bg-muted/10 lg:w-48 lg:border-r lg:border-b-0 ${fullPreview ? "hidden" : ""}`}
      >
        <nav className="flex gap-1 overflow-x-auto p-2 lg:flex-col lg:p-3">
          <p className="mb-2 hidden px-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground lg:block">
            Workspace
          </p>
          {sidebarItem("recent", <Clock3 className="size-4" />)}
          {sidebarItem("deliverables", <FileCheck2 className="size-4" />)}
          {sidebarItem("pinned", <Pin className="size-4" />)}
          {sidebarItem("repository", <Folder className="size-4" />)}
          <div className="hidden border-t border-border my-3 lg:block" />
          <a href="/images" className={`${BUTTON} justify-start text-muted-foreground`}>
            <ImageIcon className="size-4" />
            Images
          </a>
          <a href="/storage" className={`${BUTTON} justify-start text-muted-foreground`}>
            <HardDrive className="size-4" />
            Storage
          </a>
        </nav>
        {recents.length > 0 && (
          <div className="hidden border-t border-border px-3 pt-4 lg:block">
            <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Recently opened
            </p>
            {recents
              .filter((path) => inBrowseScope(path, scope?.roots))
              .slice(0, 5)
              .map((path) => (
                <Tooltip key={path} content={path} triggerClassName="w-full min-w-0 max-w-full">
                  <button
                    type="button"
                    onClick={() => openFile(path)}
                    className="w-full min-w-0 truncate rounded px-2 py-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {path.split("/").pop()}
                  </button>
                </Tooltip>
              ))}
          </div>
        )}
      </aside>
      <div
        className="flex min-h-0 min-w-0 flex-1"
        style={{ "--preview-width": `${previewWidth}%` } as CSSProperties}
      >
        <section
          aria-label="File browser"
          className={`min-h-0 min-w-0 flex-1 flex-col ${fullPreview ? "hidden" : location.file ? "hidden lg:flex" : "flex"}`}
        >
          <header className="shrink-0 border-b border-border px-4 py-4 sm:px-5">
            {scope && (
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate">{scope.label}</span>
                <a
                  className="ml-auto shrink-0 underline underline-offset-4 hover:text-foreground"
                  href={
                    location.file ? `/browse?file=${encodeURIComponent(location.file)}` : "/browse"
                  }
                >
                  All workspaces
                </a>
              </div>
            )}
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="break-words text-xl font-semibold tracking-tight">{currentTitle}</h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  {folderMode
                    ? currentWorkspace?.purpose ||
                      "Open a file to preview. Use arrow keys to move between files."
                    : location.view === "deliverables"
                      ? "Finished outputs, grouped by the work that produced them."
                      : location.view === "pinned"
                        ? "Your saved folders, ready to reopen."
                        : "Find a workspace, then explore its files and finished outputs."}
                </p>
              </div>
              <IconButton label="Refresh files" onClick={refresh}>
                <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
              </IconButton>
              {folderMode && (
                <IconButton
                  label={pins.includes(location.dir) ? "Unpin this folder" : "Pin this folder"}
                  onClick={() => togglePin(location.dir)}
                  pressed={pins.includes(location.dir)}
                >
                  <Pin className="size-4" />
                </IconButton>
              )}
            </div>
            {folderMode && (
              <nav
                aria-label="Folder breadcrumb"
                className="mt-3 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-xs"
              >
                <IconButton
                  label="Up one folder"
                  disabled={!location.dir}
                  onClick={() =>
                    navigate({ view: "folder", dir: parentDirectory(location.dir), file: null })
                  }
                >
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <button
                  type="button"
                  className="rounded px-1 py-1 text-muted-foreground hover:text-foreground"
                  onClick={() => navigate({ view: "repository", dir: "", file: null })}
                >
                  Repository
                </button>
                {location.dir
                  .split("/")
                  .filter(Boolean)
                  .map((part, index, parts) => (
                    <span
                      key={parts.slice(0, index + 1).join("/")}
                      className="flex items-center gap-1"
                    >
                      <ChevronRight className="size-3 text-muted-foreground" />
                      <Tooltip content={part}>
                        <button
                          type="button"
                          onClick={() =>
                            navigate({
                              view: "folder",
                              dir: parts.slice(0, index + 1).join("/"),
                              file: null,
                            })
                          }
                          className="max-w-56 truncate rounded px-1 py-1 hover:bg-muted"
                        >
                          {part}
                        </button>
                      </Tooltip>
                    </span>
                  ))}
              </nav>
            )}
          </header>
          <div className="shrink-0 space-y-2 border-b border-border px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                aria-label="Search files and workspaces"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={folderMode ? "Filter this folder…" : "Find work, a file, or an agent…"}
                className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
              />
              {query && (
                <IconButton label="Clear search" onClick={() => setQuery("")}>
                  <X className="size-3.5" />
                </IconButton>
              )}
              <select
                aria-label="Search scope"
                className="max-w-40 bg-background py-2 text-xs text-muted-foreground outline-none"
                value={searchScope}
                onChange={(event) => setSearchScope(event.target.value as typeof searchScope)}
              >
                <option value="folder">{folderMode ? "This folder" : "This view"}</option>
                {folderMode && <option value="descendants">Include subfolders</option>}
                <option value="repository">Entire repository</option>
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="File type"
                className={SELECT}
                value={filter}
                onChange={(event) => setFilter(event.target.value as FileFilter)}
              >
                <option value="all">All types</option>
                <option value="dir">Folders</option>
                <option value="image">Images</option>
                <option value="video">Videos</option>
                <option value="document">Documents</option>
                <option value="code">Code & other files</option>
              </select>
              {owners.length > 1 && (
                <select
                  aria-label="Filter by agent"
                  className={`${SELECT} max-w-44`}
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                >
                  <option value="">All agents</option>
                  {owners.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              <select
                aria-label="Sort files"
                className={SELECT}
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as BrowseSort);
                  save("sort", event.target.value);
                }}
              >
                <option value="date">Newest first</option>
                <option value="name">Name A–Z</option>
                <option value="type">File type</option>
              </select>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => {
                    setShowHidden(event.target.checked);
                    save("show-hidden", event.target.checked);
                  }}
                  className="accent-foreground"
                />
                Show hidden files
              </label>
              <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
                {busy ? "Loading…" : `${entries.length} ${entries.length === 1 ? "item" : "items"}`}
              </span>
              <div className="flex rounded-md border border-border">
                <IconButton
                  label="List view"
                  pressed={mode === "list"}
                  onClick={() => {
                    setMode("list");
                    save("mode", "list");
                  }}
                >
                  <List className="size-4" />
                </IconButton>
                <IconButton
                  label="Grid view"
                  pressed={mode === "grid"}
                  onClick={() => {
                    setMode("grid");
                    save("mode", "grid");
                  }}
                >
                  <LayoutGrid className="size-4" />
                </IconButton>
              </div>
            </div>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: this is a scrollable collection with delegated keyboard navigation, not a form fieldset. */}
          <div
            ref={listArea}
            role="group"
            aria-label="Folder contents"
            tabIndex={-1}
            onKeyDown={onListKey}
            className="min-h-0 flex-1 overflow-auto outline-none"
          >
            {activeError && (
              <div role="alert" className="m-4 rounded-lg border border-border p-4 text-sm">
                {activeError}
                <button type="button" onClick={refresh} className={`${BUTTON} ml-2 underline`}>
                  Try again
                </button>
              </div>
            )}
            {((remoteSearch && (searchResult?.truncated || searchResult?.indexing)) ||
              (!folderMode && catalog.partial)) && (
              <p
                role="status"
                className="border-b border-border bg-muted/30 px-5 py-3 text-xs text-muted-foreground"
              >
                {remoteSearch
                  ? searchResult?.indexing
                    ? "The search index is updating. Results may be incomplete; refresh to check again."
                    : `Showing the first ${searchResult?.matches.length ?? 0} matches. Narrow your search to see more specific results.`
                  : "Some workspaces could not be included. Refresh to try again."}
              </p>
            )}
            {!remoteSearch && !query && currentWorkspace?.deliveryItems?.length ? (
              <div className="border-b border-border bg-muted/15 px-4 py-4 sm:px-5">
                <div className="mb-3 flex items-center gap-2 text-xs font-medium">
                  <FileCheck2 className="size-4 text-emerald-400" />
                  Deliverables
                  <span className="text-muted-foreground">
                    {currentWorkspace.deliveryItems.length}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {currentWorkspace.deliveryItems.map((item) => (
                    <button
                      type="button"
                      key={item.relPath}
                      onClick={() =>
                        openEntry({
                          name: item.label,
                          relPath: item.relPath,
                          kind: item.kind === "dir" ? "dir" : "file",
                        })
                      }
                      className="flex max-w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm hover:border-ring/50 hover:bg-muted"
                    >
                      <FileCheck2 className="size-4 shrink-0 text-emerald-400" />
                      <span className="truncate">{item.label}</span>
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {busy && !entries.length ? (
              <div
                role="status"
                className="flex items-center justify-center gap-2 p-16 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" />
                Loading files…
              </div>
            ) : !entries.length && !activeError ? (
              <div className="px-6 py-16 text-center">
                <FolderOpen className="mx-auto mb-3 size-9 text-muted-foreground/50" />
                <h2 className="text-sm font-medium">
                  {remoteSearch && searchResult?.indexing
                    ? "Search is still indexing"
                    : query || filter !== "all"
                      ? "No matching files"
                      : location.view === "pinned"
                        ? "Keep useful folders close"
                        : location.view === "deliverables"
                          ? "No deliverables yet"
                          : "Nothing here yet"}
                </h2>
                <p className="mx-auto mt-2 max-w-sm text-xs text-muted-foreground">
                  {remoteSearch && searchResult?.indexing
                    ? "The repository index is still being prepared. Refresh to check for results."
                    : query || filter !== "all"
                      ? "Try a different name, clear the type filter, or search the entire repository."
                      : location.view === "pinned"
                        ? "Open any folder and use the pin button to save it here."
                        : location.view === "deliverables"
                          ? "Workspaces with a delivery manifest will appear here."
                          : "Open Repository to explore the project, or refresh when new work is available."}
                </p>
                {remoteSearch && searchResult?.indexing && (
                  <button
                    type="button"
                    onClick={refresh}
                    className={`${BUTTON} mt-4 border border-border`}
                  >
                    Refresh search
                  </button>
                )}
              </div>
            ) : (
              <div
                className={
                  mode === "grid"
                    ? "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 p-4"
                    : "divide-y divide-border/50"
                }
              >
                {entries.map((entry, index) => (
                  <EntryRow
                    key={entry.relPath}
                    entry={entry}
                    index={index}
                    grid={mode === "grid"}
                    selected={highlight === entry.relPath || location.file === entry.relPath}
                    showPath={remoteSearch || !folderMode}
                    onOpen={openEntry}
                    onFocus={setHighlight}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="hidden shrink-0 border-t border-border px-5 py-2 text-[11px] text-muted-foreground lg:block">
            ↑ ↓ Navigate<span className="mx-3">Space Preview</span>Esc Close preview
          </div>
        </section>
        {location.file && (
          <>
            {!fullPreview && (
              // biome-ignore lint/a11y/useSemanticElements: the focusable drag splitter requires pointer capture and keyboard resizing.
              <div
                role="separator"
                aria-label="Resize preview"
                aria-orientation="vertical"
                aria-valuenow={previewWidth}
                aria-valuemin={30}
                aria-valuemax={70}
                tabIndex={0}
                onKeyDown={(event) => {
                  const delta = event.key === "ArrowLeft" ? 2 : event.key === "ArrowRight" ? -2 : 0;
                  if (delta) {
                    event.preventDefault();
                    const next = Math.max(30, Math.min(70, previewWidth + delta));
                    setPreviewWidth(next);
                    save("preview-width", next);
                  }
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
                  if (bounds)
                    setPreviewWidth(
                      Math.max(
                        30,
                        Math.min(70, ((bounds.right - event.clientX) / bounds.width) * 100),
                      ),
                    );
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  save("preview-width", previewWidth);
                }}
                className="hidden w-1 shrink-0 cursor-col-resize touch-none border-l border-border hover:bg-ring/40 focus:bg-ring/40 lg:block"
              />
            )}
            <section
              aria-label="File preview"
              className={`flex min-h-0 min-w-0 flex-1 flex-col ${fullPreview ? "" : "lg:w-[var(--preview-width)] lg:flex-none"}`}
              onKeyDown={(event) => {
                if (
                  event.key === "Escape" &&
                  !(
                    event.target instanceof HTMLElement &&
                    event.target.closest("input,textarea,[contenteditable=true]")
                  )
                ) {
                  event.preventDefault();
                  closePreview();
                }
              }}
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-2">
                <button
                  type="button"
                  className={`${BUTTON} mr-auto text-muted-foreground`}
                  onClick={closePreview}
                >
                  <ArrowLeft className="size-3.5" />
                  Files
                </button>
                <IconButton
                  label="Previous file"
                  disabled={previewIndex <= 0}
                  onClick={() => adjacentPreview(-1)}
                >
                  <ArrowLeft className="size-4" />
                </IconButton>
                <IconButton
                  label="Next file"
                  disabled={previewIndex < 0 || previewIndex >= previewFiles.length - 1}
                  onClick={() => adjacentPreview(1)}
                >
                  <ArrowRight className="size-4" />
                </IconButton>
                <IconButton
                  label={fullPreview ? "Restore split view" : "Expand preview"}
                  onClick={() => setFullPreview((value) => !value)}
                >
                  {fullPreview ? (
                    <Minimize2 className="size-4" />
                  ) : (
                    <Maximize2 className="size-4" />
                  )}
                </IconButton>
                <IconButton label="Close preview" onClick={closePreview}>
                  <PanelRightClose className="size-4" />
                </IconButton>
              </div>
              <FileViewerPane path={location.file} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={`${BUTTON} ${pressed ? "bg-muted text-foreground" : "text-muted-foreground"}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}
const EntryRow = memo(function EntryRow({
  entry,
  index,
  grid,
  selected,
  showPath,
  onOpen,
  onFocus,
}: {
  entry: BrowserEntry;
  index: number;
  grid: boolean;
  selected: boolean;
  showPath: boolean;
  onOpen: (entry: BrowserEntry) => void;
  onFocus: (path: string) => void;
}) {
  const Icon = entry.kind === "dir" ? Folder : iconForFile(entry.name);
  const [failedThumbnail, setFailedThumbnail] = useState(false);
  const thumbnail =
    fileCategory(entry) === "image" &&
    !entry.name.toLowerCase().endsWith(".svg") &&
    !failedThumbnail;
  const date = entry.mtime ? new Date(entry.mtime) : null;
  const formattedDate = date && !Number.isNaN(date.getTime()) ? MODIFIED_DATE.format(date) : null;
  const subtitle = entry.purpose || (showPath ? entry.relPath : null);
  return (
    <div
      className={`${grid ? "overflow-hidden rounded-lg border border-border" : ""} ${selected ? "bg-muted ring-1 ring-inset ring-ring/40" : "hover:bg-muted/40"}`}
    >
      <button
        type="button"
        data-entry-index={index}
        onClick={() => onOpen(entry)}
        onFocus={() => onFocus(entry.relPath)}
        aria-label={`${entry.kind === "dir" ? "Open folder" : "Preview"} ${displayName(entry)}`}
        className={`w-full min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${grid ? "block p-3" : "flex items-center gap-3 px-4 py-3 sm:px-5"}`}
      >
        <div
          className={
            grid
              ? "mb-3 flex h-28 items-center justify-center overflow-hidden rounded-md bg-muted/30"
              : "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/40"
          }
        >
          {thumbnail ? (
            // biome-ignore lint/performance/noImgElement: the thumbnail endpoint already emits bounded optimized WebP; Next Image would re-encode it.
            <img
              src={`/api/file/thumbnail?path=${encodeURIComponent(entry.relPath)}`}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setFailedThumbnail(true)}
              className="size-full object-contain"
            />
          ) : (
            <Icon
              className={grid ? "size-10 text-muted-foreground/70" : "size-4 text-muted-foreground"}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <span className="block break-words text-sm font-medium leading-5">
            {displayName(entry)}
          </span>
          {subtitle && (
            <span className="mt-1 block truncate text-xs text-muted-foreground">{subtitle}</span>
          )}
        </div>
        {!grid && (
          <div className="ml-3 hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
            {formattedDate && <div>{formattedDate}</div>}
            {entry.kind === "file" && entry.size !== undefined && (
              <div className="mt-1 tabular-nums">{formatBytes(entry.size)}</div>
            )}
            {entry.deliveryItems?.length ? (
              <div className="mt-1">{entry.deliveryItems.length} outputs</div>
            ) : null}
          </div>
        )}
        {!grid && entry.kind === "dir" && (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {(entry.owner || (grid && (formattedDate || entry.deliveryItems?.length))) && (
        <div
          className={`flex flex-wrap items-center gap-3 pb-3 text-xs text-muted-foreground ${grid ? "px-3" : "pl-16 pr-5"}`}
        >
          {entry.owner && <AgentChip name={entry.owner} className="text-xs" />}
          {grid && formattedDate && <span>{formattedDate}</span>}
          {grid && entry.deliveryItems?.length ? (
            <span className="ml-auto">{entry.deliveryItems.length} outputs</span>
          ) : null}
        </div>
      )}
    </div>
  );
});
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
