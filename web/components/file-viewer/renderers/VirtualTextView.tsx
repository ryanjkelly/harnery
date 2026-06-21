"use client";

/**
 * Virtualized line view with in-file search (§ Phase 5 polish). Renders only the
 * visible window via @tanstack/react-virtual so a 5,000-line log stays smooth,
 * and ships a `/`-triggered search bar that highlights matches, counts them, and
 * scrolls to the current one via `scrollToIndex`. Search + virtualization are
 * built together here because scrolling to an off-screen match REQUIRES the
 * virtualizer (a plain highlight can't reach a line that isn't in the DOM).
 *
 * TextRenderer is now a thin wrapper over this; code/markdown keep their own
 * (Shiki/react-markdown) rendering.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

const ROW_HEIGHT = 20;

/** Split into lines once, dropping a single trailing-newline phantom. */
function toLines(text: string): string[] {
  if (text.length === 0) return [""];
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Render one line with case-insensitive `query` occurrences wrapped in <mark>;
 * the active match (when this is the current-match line) gets a brighter mark. */
function highlight(line: string, query: string, activeInLine: boolean): ReactNode {
  if (!query) return line || " ";
  const lower = line.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let n = 0;
  let idx = lower.indexOf(q);
  while (idx !== -1) {
    if (idx > i) parts.push(line.slice(i, idx));
    parts.push(
      <mark
        key={`m${n++}`}
        className={activeInLine ? "bg-amber-400 text-black" : "bg-amber-400/30 text-foreground"}
      >
        {line.slice(idx, idx + query.length)}
      </mark>,
    );
    i = idx + query.length;
    idx = lower.indexOf(q, i);
  }
  if (i < line.length) parts.push(line.slice(i));
  return parts.length ? parts : line || " ";
}

export default function VirtualTextView({ content }: { content: string }) {
  const lines = useMemo(() => toLines(content), [content]);
  const width = String(lines.length).length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Line indices containing the query (case-insensitive).
  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(q)) out.push(i);
    }
    return out;
  }, [lines, query]);

  const gotoMatch = useCallback(
    (n: number) => {
      if (matches.length === 0) return;
      const wrapped = ((n % matches.length) + matches.length) % matches.length;
      setCurrent(wrapped);
      virtualizer.scrollToIndex(matches[wrapped]!, { align: "center" });
    },
    [matches, virtualizer],
  );

  // matches recomputes only when query/lines change (NOT on match-navigation,
  // which only moves `current`), so jumping to the first match here fires on a
  // new search but never re-scrolls mid-navigation. gotoMatch is stable per matches.
  useEffect(() => {
    if (matches.length > 0) gotoMatch(0);
    else setCurrent(0);
  }, [matches, gotoMatch]);

  // `/` opens search (unless already typing somewhere); Enter / Shift-Enter
  // cycle matches; Esc closes search WITHOUT closing the overlay (stopPropagation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el && /^(input|textarea|select)$/i.test(el.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeMatchLine = matches.length > 0 ? matches[current] : -1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {searchOpen && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setSearchOpen(false);
                setQuery("");
              } else if (e.key === "Enter") {
                e.preventDefault();
                gotoMatch(current + (e.shiftKey ? -1 : 1));
              }
            }}
            placeholder="Find in file…"
            className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs text-foreground outline-none"
          />
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
            {matches.length === 0 ? (query ? "0" : "") : `${current + 1}/${matches.length}`}
          </span>
          <button
            type="button"
            onClick={() => gotoMatch(current - 1)}
            disabled={matches.length === 0}
            aria-label="Previous match"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => gotoMatch(current + 1)}
            disabled={matches.length === 0}
            aria-label="Next match"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
            aria-label="Close search"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[20px]"
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const line = lines[vi.index]!;
            const isActive = vi.index === activeMatchLine;
            return (
              <div
                key={vi.key}
                className="absolute flex w-full"
                style={{ transform: `translateY(${vi.start}px)`, height: `${ROW_HEIGHT}px` }}
              >
                <span
                  className="shrink-0 select-none border-r border-border/60 px-3 text-right tabular-nums text-muted-foreground/50"
                  style={{ minWidth: `${width + 2}ch` }}
                >
                  {vi.index + 1}
                </span>
                <span className="whitespace-pre break-all px-3 text-foreground/90">
                  {highlight(line, query, isActive)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
