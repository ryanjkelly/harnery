"use client";

/**
 * ⌘K / Ctrl-K fuzzy file-search palette for /browse. Debounced search against
 * /api/file/search (cached, deny-aware index). Keyboard-driven on desktop
 * (↑/↓/↵/esc) and fully touch-usable on mobile, where it renders full-screen
 * and is reachable from the always-visible search button in the tree header.
 * Selecting a result hands the path to the page, which opens + reveals it.
 */

import { RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSearch } from "@/lib/file-viewer/client";
import type { SearchMatch } from "@/lib/file-viewer/types";
import { iconForFile } from "./file-icons";

export function SearchPalette({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (relPath: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{ total: number; truncated: boolean }>({
    total: 0,
    truncated: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset + focus whenever the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setMatches([]);
    setActive(0);
    setMeta({ total: 0, truncated: false });
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Debounced search on query change.
  useEffect(() => {
    if (!open) return;
    if (debounce.current) clearTimeout(debounce.current);
    const q = query.trim();
    if (!q) {
      setMatches([]);
      setLoading(false);
      setMeta({ total: 0, truncated: false });
      return;
    }
    setLoading(true);
    debounce.current = setTimeout(async () => {
      const res = await fetchSearch(q, 50);
      if (res.ok) {
        setMatches(res.data.matches);
        setMeta({ total: res.data.total, truncated: res.data.truncated });
      } else {
        setMatches([]);
        setMeta({ total: 0, truncated: false });
      }
      setActive(0);
      setLoading(false);
    }, 140);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, open]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = useCallback(
    (m?: SearchMatch) => {
      const pick = m ?? matches[active];
      if (pick) onSelect(pick.relPath);
    },
    [matches, active, onSelect],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose();
    }
  };

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close is a mouse convenience; Esc is wired on the input.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a click-to-close target only; the dialog below carries role + focus.
    <div
      className="fixed inset-0 z-60 flex items-start justify-center bg-black/60 sm:p-6 sm:pt-[12vh]"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop-close on inner clicks; not itself a control. */}
      <div
        role="dialog"
        aria-label="Search files"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col overflow-hidden border border-border bg-card shadow-2xl sm:h-auto sm:max-h-[70vh] sm:max-w-xl sm:rounded-xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search files by name…"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {loading && (
            <RefreshCw className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <ul ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {query.trim() === "" ? (
            <li className="px-4 py-6 text-center text-xs text-muted-foreground/70">
              Type to search files across the repo.
            </li>
          ) : loading && matches.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-muted-foreground/70">Searching…</li>
          ) : matches.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-muted-foreground/70">No matches.</li>
          ) : (
            matches.map((m, i) => (
              <ResultRow
                key={m.relPath}
                match={m}
                index={i}
                active={i === active}
                onActivate={() => setActive(i)}
                onChoose={() => choose(m)}
              />
            ))
          )}
        </ul>

        {matches.length > 0 && (
          <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground/70">
            <span className="tabular-nums">
              {meta.total.toLocaleString()}
              {meta.truncated ? "+" : ""} match{meta.total === 1 ? "" : "es"}
            </span>
            <span className="hidden sm:inline">↑↓ navigate · ↵ open · esc close</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultRow({
  match,
  index,
  active,
  onActivate,
  onChoose,
}: {
  match: SearchMatch;
  index: number;
  active: boolean;
  onActivate: () => void;
  onChoose: () => void;
}) {
  const slash = match.relPath.lastIndexOf("/");
  const base = slash >= 0 ? match.relPath.slice(slash + 1) : match.relPath;
  const dir = slash >= 0 ? match.relPath.slice(0, slash) : "";
  const Icon = iconForFile(base);
  return (
    <li data-idx={index}>
      <button
        type="button"
        onClick={onChoose}
        onMouseEnter={onActivate}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
          active ? "bg-muted" : ""
        }`}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground/60" />
        <span className="truncate font-mono text-[13px] text-foreground">{base}</span>
        {dir && (
          <span className="truncate font-mono text-[11px] text-muted-foreground/60">{dir}</span>
        )}
      </button>
    </li>
  );
}
