"use client";

/**
 * The shared "Search files" drill-down prompt — used by the Actions section
 * and by programmatic open-into-file-search (`openCommandPalette({view:
 * "files"})`, the /browse entry points). Suggestions come from the same
 * debounced `/api/file/search` the old /browse palette used; selection routes
 * through the palette's file-open indirection (page override or overlay).
 */

import { FileText } from "lucide-react";
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
      return res.data.matches.map((m) => ({
        key: `file-${m.relPath}`,
        label: m.relPath,
        icon: <FileText size={14} aria-hidden />,
        onSelect: () => openPath(m.relPath),
        recent: {
          title: m.relPath.split("/").pop() ?? m.relPath,
          href: `/files?path=${encodeURIComponent(m.relPath)}`,
          kind: "file" as const,
        },
      }));
    },
    onSubmit: (value: string) => {
      const q = value.trim();
      if (q) openPath(q.replace(/^\.?\//, ""));
    },
  };
}
