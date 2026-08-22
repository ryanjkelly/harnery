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
 * Mobile (< md): one pane at a time — tree, or the viewer with a back-to-tree
 * + search bar. The tree auto-reveals + scrolls to the selection.
 */

import { ChevronLeft, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { openCommandPalette } from "@/components/palette/CommandPalette";
import { usePaletteFileOpenOverride } from "@/components/palette/PaletteProvider";
import { DirectoryTree } from "./DirectoryTree";
import { FileViewerPane } from "./FileViewerPane";

export function BrowseClient({
  initialPath,
  initialDirectory,
}: {
  initialPath: string | null;
  initialDirectory: string | null;
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

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={`${
          mobileView === "tree" ? "flex" : "hidden"
        } w-full shrink-0 flex-col overflow-hidden border-r border-border md:flex md:w-72`}
      >
        <SearchTrigger onClick={openSearch} />
        <div className="min-h-0 flex-1 overflow-auto">
          <DirectoryTree
            selectedPath={selected}
            revealDirectory={selected ? null : initialDirectory}
            onSelect={select}
          />
        </div>
      </aside>

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
