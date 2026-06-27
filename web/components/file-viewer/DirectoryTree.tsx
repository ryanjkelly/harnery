"use client";

/**
 * Lazy directory tree for /browse. Fetches the repo root on mount, then one
 * /api/file/list call per directory the FIRST time it's expanded (collapse
 * keeps the cached children). Files emit onSelect(relPath); the page owns the
 * selection + the right-pane viewer. Denied/secret entries never arrive here
 * (lib/file-tree.ts filters them server-side), so the tree only shows what the
 * viewer can actually open.
 */

import { ChevronRight, File as FileIcon, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchList } from "@/lib/file-viewer/client";
import type { DirEntry } from "@/lib/file-viewer/types";

export function DirectoryTree({
  selectedPath,
  onSelect,
}: {
  selectedPath: string | null;
  onSelect: (relPath: string) => void;
}) {
  const [roots, setRoots] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    fetchList("").then((res) => {
      if (!live) return;
      if (res.ok) setRoots(res.data.entries);
      else setError(true);
    });
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return <p className="p-3 text-xs text-muted-foreground">Couldn&apos;t load the file tree.</p>;
  }
  if (roots === null) {
    return (
      <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <RefreshCw className="size-3.5 animate-spin" /> Loading tree…
      </p>
    );
  }
  if (roots.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground/60 italic">empty</p>;
  }
  return (
    <ul className="py-1">
      {roots.map((e) => (
        <TreeNode
          key={e.relPath}
          entry={e}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  depth,
  selectedPath,
  onSelect,
}: {
  entry: DirEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (relPath: string) => void;
}) {
  const isDir = entry.kind === "dir";
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const selected = !isDir && selectedPath === entry.relPath;
  const indent = depth * 12 + 8;

  const onClick = async () => {
    if (!isDir) {
      onSelect(entry.relPath);
      return;
    }
    if (!expanded && children === null) {
      setLoading(true);
      setError(false);
      const res = await fetchList(entry.relPath);
      setLoading(false);
      if (res.ok) setChildren(res.data.entries);
      else {
        setError(true);
        return;
      }
    }
    setExpanded((x) => !x);
  };

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-expanded={isDir ? expanded : undefined}
        title={entry.relPath}
        className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left hover:bg-muted/50 ${
          selected ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
        }`}
        style={{ paddingLeft: `${indent}px` }}
      >
        {isDir ? (
          <ChevronRight
            className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {isDir ? (
          expanded ? (
            <FolderOpen className="size-4 shrink-0 text-muted-foreground/70" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground/70" />
          )
        ) : (
          <FileIcon className="size-4 shrink-0 text-muted-foreground/50" />
        )}
        <span className="truncate font-mono text-[13px]">{entry.name}</span>
        {loading && <RefreshCw className="ml-auto size-3 shrink-0 animate-spin" />}
      </button>

      {isDir && expanded && (
        <DirChildren
          depth={depth}
          error={error}
          entries={children}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      )}
    </li>
  );
}

function DirChildren({
  depth,
  error,
  entries,
  selectedPath,
  onSelect,
}: {
  depth: number;
  error: boolean;
  entries: DirEntry[] | null;
  selectedPath: string | null;
  onSelect: (relPath: string) => void;
}) {
  const indent = (depth + 1) * 12 + 8;
  if (error) {
    return (
      <p className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: `${indent}px` }}>
        Couldn&apos;t load.
      </p>
    );
  }
  if (entries === null) return null;
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
  return (
    <ul>
      {entries.map((c) => (
        <TreeNode
          key={c.relPath}
          entry={c}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
