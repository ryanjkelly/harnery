"use client";

/**
 * Lazy, controlled directory tree for /browse. State (listings / usage /
 * expanded / loading) lives in refs on the root so the tree can be DRIVEN —
 * auto-expanding + scrolling to a deep-linked or search-selected file.
 *
 * Per level it fetches listDir (names + kinds + file sizes) and dirUsage (each
 * child directory's recursive byte total + file/folder counts), so every row
 * shows a size and a sibling-relative bar, and directories show their counts.
 * Denied/secret entries never arrive (lib/file-tree.ts filters them server-side).
 */

import { ChevronRight, Folder, FolderOpen, type LucideIcon, RefreshCw } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useReducer, useRef } from "react";
import { fetchList, fetchUsage } from "@/lib/file-viewer/client";
import type { DirEntry, DirUsage, DirUsageStats } from "@/lib/file-viewer/types";
import { iconForFile } from "./file-icons";

export function DirectoryTree({
  selectedPath,
  onSelect,
}: {
  selectedPath: string | null;
  onSelect: (relPath: string) => void;
}) {
  const listings = useRef(new Map<string, DirEntry[]>());
  const usage = useRef(new Map<string, DirUsage>());
  const expanded = useRef(new Set<string>());
  const loading = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const revealed = useRef<string | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);

  const loadDir = useCallback(async (dir: string) => {
    if (listings.current.has(dir) || loading.current.has(dir)) return;
    loading.current.add(dir);
    failed.current.delete(dir);
    force();
    const [list, use] = await Promise.all([fetchList(dir), fetchUsage(dir)]);
    loading.current.delete(dir);
    if (list.ok) listings.current.set(dir, list.data.entries);
    else failed.current.add(dir);
    if (use.ok) usage.current.set(dir, use.data);
    force();
  }, []);

  // Root load on mount.
  useEffect(() => {
    loadDir("");
  }, [loadDir]);

  const toggle = useCallback(
    (dir: string) => {
      if (expanded.current.has(dir)) expanded.current.delete(dir);
      else {
        expanded.current.add(dir);
        loadDir(dir);
      }
      force();
    },
    [loadDir],
  );

  // Auto-reveal: expand every ancestor of the selected path, then scroll the row
  // into view. Runs once per distinct selectedPath (manual clicks re-scroll, but
  // never collapse — reveal only ever adds to `expanded`).
  useEffect(() => {
    if (!selectedPath || revealed.current === selectedPath) return;
    revealed.current = selectedPath;
    const segs = selectedPath.split("/");
    const ancestors: string[] = [];
    for (let i = 0; i < segs.length - 1; i++) ancestors.push(segs.slice(0, i + 1).join("/"));
    (async () => {
      for (const a of ancestors) {
        expanded.current.add(a);
        await loadDir(a);
      }
      force();
      requestAnimationFrame(() => {
        const sel = `[data-tree-path="${selectedPath.replace(/["\\]/g, "\\$&")}"]`;
        document.querySelector(sel)?.scrollIntoView({ block: "nearest" });
      });
    })();
  }, [selectedPath, loadDir]);

  if (failed.current.has("")) {
    return <p className="p-3 text-xs text-muted-foreground">Couldn&apos;t load the file tree.</p>;
  }
  if (!listings.current.has("")) {
    return (
      <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <RefreshCw className="size-3.5 animate-spin" /> Loading tree…
      </p>
    );
  }

  function renderLevel(dir: string, depth: number): ReactNode {
    const entries = listings.current.get(dir);
    if (!entries) return null;
    const u = usage.current.get(dir);
    const bytesOf = (e: DirEntry) =>
      e.kind === "file" ? (e.size ?? 0) : (u?.children[e.name]?.totalBytes ?? 0);
    const maxBytes = entries.reduce((m, e) => Math.max(m, bytesOf(e)), 1);

    return entries.map((e) => {
      const isDir = e.kind === "dir";
      const open = isDir && expanded.current.has(e.relPath);
      const stats = isDir ? u?.children[e.name] : undefined;
      return (
        <Fragment key={e.relPath}>
          <Row
            entry={e}
            depth={depth}
            open={open}
            selected={!isDir && selectedPath === e.relPath}
            bytes={bytesOf(e)}
            maxBytes={maxBytes}
            stats={stats}
            isLoading={isDir && loading.current.has(e.relPath)}
            onClick={() => (isDir ? toggle(e.relPath) : onSelect(e.relPath))}
          />
          {open && renderChildren(e.relPath, depth + 1)}
        </Fragment>
      );
    });
  }

  function renderChildren(dir: string, depth: number): ReactNode {
    const indent = depth * 12 + 8;
    if (failed.current.has(dir)) {
      return (
        <p className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: `${indent}px` }}>
          Couldn&apos;t load.
        </p>
      );
    }
    const entries = listings.current.get(dir);
    if (!entries) return null; // still loading (spinner shows on the row)
    if (entries.length === 0) {
      return (
        <p
          className="py-1 text-xs italic text-muted-foreground/60"
          style={{ paddingLeft: `${indent}px` }}
        >
          empty
        </p>
      );
    }
    return renderLevel(dir, depth);
  }

  return <ul className="py-1">{renderLevel("", 0)}</ul>;
}

function Row({
  entry,
  depth,
  open,
  selected,
  bytes,
  maxBytes,
  stats,
  isLoading,
  onClick,
}: {
  entry: DirEntry;
  depth: number;
  open: boolean;
  selected: boolean;
  bytes: number;
  maxBytes: number;
  stats: DirUsageStats | undefined;
  isLoading: boolean;
  onClick: () => void;
}) {
  const isDir = entry.kind === "dir";
  const indent = depth * 12 + 8;
  const Icon: LucideIcon = isDir ? (open ? FolderOpen : Folder) : iconForFile(entry.name);
  const barPct = bytes > 0 ? Math.max(2, Math.min(100, Math.round((bytes / maxBytes) * 100))) : 0;
  const partial = stats?.partial ?? false;

  const meta = isDir
    ? stats
      ? `${partial ? "≥" : ""}${formatCount(stats.fileCount)} · ${formatBytes(stats.totalBytes)}`
      : ""
    : entry.size != null
      ? formatBytes(entry.size)
      : "";

  const title =
    isDir && stats
      ? `${stats.fileCount.toLocaleString()} files · ${stats.dirCount.toLocaleString()} folders · ${formatBytes(stats.totalBytes)}${partial ? " (capped — totals are a floor)" : ""}`
      : entry.relPath;

  return (
    <button
      type="button"
      data-tree-path={entry.relPath}
      onClick={onClick}
      aria-expanded={isDir ? open : undefined}
      title={title}
      className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left hover:bg-muted/50 ${
        selected ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
      }`}
      style={{ paddingLeft: `${indent}px` }}
    >
      {isDir ? (
        <ChevronRight
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <Icon className="size-4 shrink-0 text-muted-foreground/60" />
      <span className="truncate font-mono text-[13px]">{entry.name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 tabular-nums text-[10px] text-muted-foreground/70">
        {barPct > 0 && (
          <span className="hidden h-1 w-8 overflow-hidden rounded-sm bg-muted sm:block">
            <span className="block h-full bg-muted-foreground/40" style={{ width: `${barPct}%` }} />
          </span>
        )}
        {meta && <span>{meta}</span>}
        {isLoading && <RefreshCw className="size-3 animate-spin" />}
      </span>
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatCount(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}
