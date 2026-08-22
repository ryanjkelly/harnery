"use client";

/**
 * /browse split-pane: directory tree (left) + inline file viewer (right).
 * Owns the selected path and mirrors it to `?file=<rel>` via replaceState
 * (Back/Forward re-reads it). Uses `?file=` not the overlay's `?path=` so the
 * global FileViewerProvider doesn't also pop its modal here.
 *
 * File search is the global command palette's file prompt (⌘K anywhere; the
 * header buttons open straight into it). While this page is mounted it
 * registers a palette file-open override so a picked file lands in the
 * in-page pane instead of the overlay.
 *
 * `scope` (from `?agent=`) roots the tree at an agent's artifact workspaces
 * instead of the repo; a banner names the agent and links back to the full
 * repo view. The tree pane is width-adjustable on desktop via the drag handle
 * (persisted in localStorage).
 *
 * Mobile (< md): one pane at a time — tree, or the viewer with a back-to-tree
 * + search bar. The tree auto-reveals + scrolls to the selection.
 */

import { ChevronLeft, FolderTree, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openCommandPalette } from "@/components/palette/CommandPalette";
import { usePaletteFileOpenOverride } from "@/components/palette/PaletteProvider";
import { DirectoryTree } from "./DirectoryTree";
import { FileViewerPane } from "./FileViewerPane";

export interface BrowseScope {
  /** Banner text naming the scope (composed server-side: "Foo's artifacts",
   * a directory path, or the no-artifacts fallback notice). */
  label: string;
  /** Tree root directories (repo-relative), newest workspace first. */
  roots: string[];
}

const TREE_WIDTH_KEY = "browse:tree-width";
const TREE_WIDTH_DEFAULT = 288;
const TREE_WIDTH_MIN = 200;
const TREE_WIDTH_MAX = 640;

export function BrowseClient({
  initialPath,
  scope,
}: {
  initialPath: string | null;
  scope: BrowseScope | null;
}) {
  const [selected, setSelected] = useState<string | null>(initialPath);
  const [mobileView, setMobileView] = useState<"tree" | "file">(initialPath ? "file" : "tree");

  const select = useCallback((relPath: string) => {
    setSelected(relPath);
    setMobileView("file");
    const u = new URL(window.location.href);
    u.searchParams.set("file", relPath);
    window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
  }, []);

  // Palette file results select in-pane while this page is mounted.
  usePaletteFileOpenOverride(select);

  // Back/Forward → re-read ?file= so browser nav syncs the pane + reveal.
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(window.location.search).get("file");
      setSelected(p);
      if (p) setMobileView("file");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openSearch = useCallback(() => openCommandPalette({ view: "files" }), []);

  // Desktop tree-pane width: draggable handle, persisted across visits.
  const [treeWidth, setTreeWidth] = useState(TREE_WIDTH_DEFAULT);
  const treeWidthRef = useRef(TREE_WIDTH_DEFAULT);
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(TREE_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= TREE_WIDTH_MIN && saved <= TREE_WIDTH_MAX) {
      treeWidthRef.current = saved;
      setTreeWidth(saved);
    }
  }, []);
  const applyTreeWidth = useCallback((w: number) => {
    const clamped = Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(w)));
    treeWidthRef.current = clamped;
    setTreeWidth(clamped);
  }, []);
  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault(); // stop text selection while dragging
      const startX = e.clientX;
      const startW = treeWidthRef.current;
      const onMove = (ev: PointerEvent) => applyTreeWidth(startW + ev.clientX - startX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.localStorage.setItem(TREE_WIDTH_KEY, String(treeWidthRef.current));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [applyTreeWidth],
  );
  const resizeByKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
      if (!step) return;
      e.preventDefault();
      applyTreeWidth(treeWidthRef.current + step);
      window.localStorage.setItem(TREE_WIDTH_KEY, String(treeWidthRef.current));
    },
    [applyTreeWidth],
  );

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        style={{ "--tree-w": `${treeWidth}px` } as React.CSSProperties}
        className={`${
          mobileView === "tree" ? "flex" : "hidden"
        } w-full shrink-0 flex-col overflow-hidden border-r border-border md:flex md:w-[var(--tree-w)]`}
      >
        <SearchTrigger onClick={openSearch} />
        {scope && <ScopeBanner scope={scope} selected={selected} />}
        <div className="min-h-0 flex-1 overflow-auto">
          <DirectoryTree
            selectedPath={selected}
            roots={scope ? scope.roots : undefined}
            onSelect={select}
          />
        </div>
      </aside>

      {/* biome-ignore lint/a11y/useSemanticElements: a focusable window-splitter must be a div with role="separator" — an <hr> can't take focus or drag */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file tree"
        aria-valuenow={treeWidth}
        aria-valuemin={TREE_WIDTH_MIN}
        aria-valuemax={TREE_WIDTH_MAX}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeByKey}
        className="hidden w-1 shrink-0 cursor-col-resize touch-none outline-none hover:bg-border focus-visible:bg-ring/40 active:bg-ring/40 md:block"
      />

      <section
        className={`${mobileView === "file" ? "flex" : "hidden"} min-w-0 flex-1 flex-col md:flex`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5 md:hidden">
          <button
            type="button"
            onClick={() => setMobileView("tree")}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" /> Files
          </button>
          <button
            type="button"
            onClick={openSearch}
            aria-label="Search files"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <Search className="size-4" />
          </button>
        </div>
        <FileViewerPane path={selected} />
      </section>
    </div>
  );
}

/** Names the scope rooting the tree and links back to the unscoped repo view
 * (a full navigation so the server re-renders without the scope). */
function ScopeBanner({ scope, selected }: { scope: BrowseScope; selected: string | null }) {
  const fullRepoHref = selected ? `/browse?file=${encodeURIComponent(selected)}` : "/browse";
  const label = scope.label;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
      <FolderTree className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-muted-foreground" title={label}>
        {label}
      </span>
      <a
        href={fullRepoHref}
        className="ml-auto flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        title="Leave the artifact scope and browse the whole repo"
      >
        <X className="size-3" /> Full repo
      </a>
    </div>
  );
}

function SearchTrigger({ onClick }: { onClick: () => void }) {
  const [kbd, setKbd] = useState("");
  useEffect(() => {
    // Client-only (avoids SSR/hydration mismatch): label the shortcut per-OS.
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac/.test(navigator.userAgent);
    setKbd(isMac ? "⌘K" : "Ctrl K");
  }, []);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
    >
      <Search className="size-3.5 shrink-0" />
      <span className="flex-1">Search files…</span>
      {kbd && (
        <kbd className="hidden rounded border border-border px-1 py-0.5 font-mono text-[10px] sm:inline">
          {kbd}
        </kbd>
      )}
    </button>
  );
}
