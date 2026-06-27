"use client";

/**
 * /browse split-pane: directory tree (left) + inline file viewer (right). Owns
 * the selected path and mirrors it to `?file=<rel>` via replaceState (no history
 * spam, and Back/Forward re-reads it). Deliberately uses `?file=` rather than
 * the overlay's `?path=` so the globally-mounted FileViewerProvider does NOT
 * also pop its modal on top of this page.
 *
 * Mobile (< md): one pane at a time — the tree, or the viewer with a back-to-
 * tree bar. Desktop (md+): both panes side by side.
 */

import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DirectoryTree } from "./DirectoryTree";
import { FileViewerPane } from "./FileViewerPane";

export function BrowseClient({ initialPath }: { initialPath: string | null }) {
  const [selected, setSelected] = useState<string | null>(initialPath);
  const [mobileView, setMobileView] = useState<"tree" | "file">(initialPath ? "file" : "tree");

  const select = useCallback((relPath: string) => {
    setSelected(relPath);
    setMobileView("file");
    const u = new URL(window.location.href);
    u.searchParams.set("file", relPath);
    window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
  }, []);

  // Back/Forward → re-read ?file= so browser nav syncs the pane.
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(window.location.search).get("file");
      setSelected(p);
      if (p) setMobileView("file");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={`${
          mobileView === "tree" ? "flex" : "hidden"
        } w-full shrink-0 flex-col overflow-auto border-r border-border md:flex md:w-72`}
      >
        <DirectoryTree selectedPath={selected} onSelect={select} />
      </aside>

      <section
        className={`${mobileView === "file" ? "flex" : "hidden"} min-w-0 flex-1 flex-col md:flex`}
      >
        <button
          type="button"
          onClick={() => setMobileView("tree")}
          className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground md:hidden"
        >
          <ChevronLeft className="size-3.5" /> Files
        </button>
        <FileViewerPane path={selected} />
      </section>
    </div>
  );
}
