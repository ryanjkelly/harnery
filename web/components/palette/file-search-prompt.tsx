"use client";

/**
 * The shared "Search files" drill-down prompt — used by the Actions section
 * and by programmatic open-into-file-search (`openCommandPalette({view:
 * "files"})`, the /browse entry points). Suggestions come from the same
 * debounced `/api/file/search` the old /browse palette used; selection routes
 * through the palette's file-open indirection (page override or overlay).
 */

import { FileText, Folder, Info } from "lucide-react";
import type { PaletteItem, PalettePrompt } from "./PaletteProvider";

export function buildFileSearchPrompt(openPath: (relPath: string) => void): PalettePrompt {
  return {
    title: "Search files",
    placeholder: "fuzzy path, e.g. web/nav or readme",
    submitLabel: "Open",
    hint: "Type to search the repo file index.",
    suggestAsync: async (value: string): Promise<PaletteItem[]> => {
      const q = value.trim();
      if (!q) return [];
      const { fetchSearch } = await import("@/lib/file-viewer/client");
      const res = await fetchSearch(q, 30);
      if (!res.ok) return [];
      const items: PaletteItem[] = res.data.matches.map((m) => ({
        key: `file-${m.relPath}`,
        label: m.relPath.split("/").pop() ?? m.relPath,
        description: m.relPath,
        icon:
          m.kind === "dir" ? <Folder size={14} aria-hidden /> : <FileText size={14} aria-hidden />,
        onSelect: () => {
          if (m.kind === "dir")
            window.location.assign(`/browse?dir=${encodeURIComponent(m.relPath)}`);
          else openPath(m.relPath);
        },
        recent: {
          title: m.relPath.split("/").pop() ?? m.relPath,
          href:
            m.kind === "dir"
              ? `/browse?dir=${encodeURIComponent(m.relPath)}`
              : `/files?path=${encodeURIComponent(m.relPath)}`,
          kind: "file" as const,
        },
      }));
      if (res.data.truncated || res.data.indexing) {
        items.push({
          key: "file-search-coverage",
          label: res.data.indexing ? "Search index is updating" : "More results may be available",
          description: "Open Files to narrow the search and see its coverage.",
          icon: <Info size={14} aria-hidden />,
          onSelect: () => window.location.assign(`/browse?q=${encodeURIComponent(q)}`),
        });
      }
      return items;
    },
    onSubmit: (value: string) => {
      const q = value.trim();
      if (q) openPath(q.replace(/^\.?\//, ""));
    },
  };
}
