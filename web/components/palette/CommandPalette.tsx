"use client";

/**
 * Global ⌘K command palette. Sections come from the PaletteProvider registry
 * (routes, actions, catalogs) plus two synthesized ones: Recent (empty query)
 * and Open (the query parses as a workflow run id / instance UUID / repo
 * path). Items filter by AND-of-token literal/fuzzy matching over label +
 * description + subtitle + keywords, then rank within their section by match
 * quality + priority (lib/palette/score.ts).
 *
 * Interaction model:
 *   ⌘K / Ctrl-K   toggle (global; bound once here)
 *   /             open when not typing in a field
 *   ↑/↓ ⏎         navigate + select; ⌘⏎ / middle-click opens href in new tab
 *   drill-downs    an item with `prompt` pushes a text sub-view with its own
 *                  submit button + live suggestions; `pushItems` pushes a
 *                  pick-list. Backspace-on-empty and Esc pop one level.
 *
 * Renders full-screen on mobile (< sm) and as a centered panel on desktop —
 * same responsive pattern the old /browse file palette used.
 */

import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Clock,
  FileText,
  Scale,
  Search,
  Target,
  User,
  Users,
  Workflow,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFileViewer } from "@/components/file-viewer/FileViewerProvider";
import { paletteHomeSections } from "@/lib/palette/home";
import { parseIdInput } from "@/lib/palette/id-parser";
import { clearRecents, getRecents, type RecentEntry, recordRecent } from "@/lib/palette/recents";
import { APP_ROUTES } from "@/lib/palette/routes";
import { makePaletteScorer, matchesPaletteQuery, paletteMatchIndices } from "@/lib/palette/score";
import { buildFileSearchPrompt } from "./file-search-prompt";
import {
  PaletteFileOpenContext,
  type PaletteItem,
  type PalettePrompt,
  type PaletteSection,
  PaletteSectionsContext,
} from "./PaletteProvider";

const OPEN_EVENT = "harnery:open-command-palette";

/**
 * Fired every time the palette opens (⌘K or programmatic). Registrars whose
 * sections come from a fetch listen for this to revalidate, so a long-lived
 * tab picks up entities created after mount.
 */
export const COMMAND_PALETTE_OPENED_EVENT = "harnery:command-palette-opened";

export interface OpenPaletteOptions {
  /** Open straight into a named drill-down (currently: the file search). */
  view?: "files";
}

/** Open the global command palette programmatically. */
export function openCommandPalette(opts?: OpenPaletteOptions): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: opts ?? {} }));
}

/** Icon for a Recents row — the route's own icon when it's a route, else by kind. */
function recentIcon(entry: RecentEntry): ReactNode {
  if (entry.kind === "route") {
    const r = APP_ROUTES.find((x) => x.href === entry.href);
    if (r) return <r.icon size={14} aria-hidden />;
  }
  switch (entry.kind) {
    case "agent":
      return <User size={14} aria-hidden />;
    case "council":
      return <Users size={14} aria-hidden />;
    case "decision":
      return <Scale size={14} aria-hidden />;
    case "work":
      return <Briefcase size={14} aria-hidden />;
    case "workflow":
      return <Workflow size={14} aria-hidden />;
    case "goal":
      return <Target size={14} aria-hidden />;
    case "file":
      return <FileText size={14} aria-hidden />;
    default:
      return <Clock size={14} aria-hidden />;
  }
}

/** Coarse relative time for Recents metadata (captured at palette-open). */
function timeAgo(at?: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

function HighlightedMatch({ text, indices }: { text: string; indices: number[] | null }) {
  if (!indices?.length) return <>{text}</>;

  const matched = new Set(indices);
  const runs: { text: string; matched: boolean }[] = [];
  for (let start = 0; start < text.length; ) {
    const isMatched = matched.has(start);
    let end = start + 1;
    while (end < text.length && matched.has(end) === isMatched) end += 1;
    runs.push({ text: text.slice(start, end), matched: isMatched });
    start = end;
  }

  return (
    <>
      {runs.map((run, index) =>
        run.matched ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional segments of one string
          <mark key={index} className="bg-transparent font-semibold text-sky-400">
            {run.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional segments of one string
          <Fragment key={index}>{run.text}</Fragment>
        ),
      )}
    </>
  );
}

/** Suppress highlight marks when every token matched literally (no fuzzy leap). */
function fuzzyHighlightIndices(text: string, tokens: string[], match: number[] | null) {
  if (!match) return null;
  const lower = text.toLowerCase();
  return tokens.some((token) => !lower.includes(token)) ? match : null;
}

function itemHref(item: PaletteItem | undefined): string | undefined {
  return item?.href ?? item?.recent?.href;
}

/** A pushed sub-view: a text prompt or a small pick-list. */
type PaletteView =
  | { kind: "prompt"; prompt: PalettePrompt }
  | { kind: "list"; title: string; items: PaletteItem[] };

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const sections = useContext(PaletteSectionsContext);
  const fileOpenApi = useContext(PaletteFileOpenContext);
  const fileViewer = useFileViewer();

  // Wire the global overlay as the file-open fallback (pages may override).
  useEffect(() => {
    fileOpenApi?.setFallback((relPath) => fileViewer.open(relPath));
  }, [fileOpenApi, fileViewer]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [stack, setStack] = useState<PaletteView[]>([]);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [asyncSuggestions, setAsyncSuggestions] = useState<PaletteItem[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  const atRoot = stack.length === 0;
  const view = atRoot ? null : stack[stack.length - 1];

  // Ref-mirror of `open` so the once-registered keydown listener can branch
  // open-vs-close without re-subscribing on every toggle.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const pushView = useCallback((v: PaletteView) => {
    setStack((s) => [...s, v]);
    setQuery("");
    setAsyncSuggestions([]);
    setActiveIdx(v.kind === "prompt" ? -1 : 0);
  }, []);

  const popView = useCallback(() => {
    setStack((s) => s.slice(0, -1));
    setQuery("");
    setAsyncSuggestions([]);
    setActiveIdx(0);
  }, []);

  // The file-search prompt used by programmatic open ({view:"files"} — the
  // /browse entry points). The Actions registrar builds the same prompt.
  const fileSearchPrompt = useMemo<PalettePrompt>(
    () => buildFileSearchPrompt((relPath) => fileOpenApi?.openPath(relPath)),
    [fileOpenApi],
  );

  // Reset to a clean root view + snapshot recents. Called from the open paths
  // (event handlers, not an effect) so every open starts fresh.
  const reset = useCallback(
    (opts?: OpenPaletteOptions) => {
      setQuery("");
      setActiveIdx(0);
      setAsyncSuggestions([]);
      const intoFiles = opts?.view === "files";
      setStack(intoFiles ? [{ kind: "prompt", prompt: fileSearchPrompt }] : []);
      if (intoFiles) setActiveIdx(-1);
      setRecents(getRecents());
      window.dispatchEvent(new Event(COMMAND_PALETTE_OPENED_EVENT));
    },
    [fileSearchPrompt],
  );

  // ⌘K / Ctrl-K toggle, slash open, and programmatic open via custom event.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      const typing = e
        .composedPath()
        .some(
          (target) =>
            target instanceof HTMLElement &&
            (target.isContentEditable ||
              target.matches("input, textarea, select, [role=textbox], [role=combobox]")),
        );
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing) {
        e.preventDefault();
        if (!openRef.current) {
          reset();
          setOpen(true);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (openRef.current) {
          setOpen(false);
        } else {
          reset();
          setOpen(true);
        }
      }
    };
    const onOpenEvent = (e: Event) => {
      reset((e as CustomEvent<OpenPaletteOptions>).detail);
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpenEvent);
    };
  }, [reset]);

  // Keep the highlighted row visible when arrowing past the fold.
  // scrollIntoView({block:"nearest"}) no-ops when already in view, so
  // mouse-hover highlight changes don't cause jumps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeIdx is the trigger; the ref is read imperatively
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Debounced async suggestions for prompt views that declare suggestAsync.
  useEffect(() => {
    if (atRoot || view?.kind !== "prompt" || !view.prompt.suggestAsync) return;
    const q = query.trim();
    if (!q) {
      setAsyncSuggestions([]);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      view.prompt.suggestAsync?.(q).then((items) => {
        if (!cancelled) setAsyncSuggestions(items);
      });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [atRoot, view, query]);

  // Open (ID lookups): synthesized from the query, shown at the top.
  const idSection = useMemo<PaletteSection | null>(() => {
    const sugs = parseIdInput(query);
    if (sugs.length === 0) return null;
    return {
      label: "Open",
      items: sugs.map((s, i) => ({
        key: `id-${i}-${s.target}`,
        label: s.label,
        icon: <Search size={14} aria-hidden />,
        href: s.kind === "file" ? undefined : s.target,
        onSelect: () => {
          if (s.kind === "file") fileOpenApi?.openPath(s.target);
          else router.push(s.target);
        },
        recent:
          s.kind === "file"
            ? {
                title: s.target.split("/").pop() ?? s.target,
                href: `/files?path=${encodeURIComponent(s.target)}`,
                kind: "file" as const,
              }
            : {
                title: s.label.replace(/^Open (workflow run |agent session )?/i, ""),
                href: s.target,
                kind: s.kind,
              },
      })),
    };
  }, [query, router, fileOpenApi]);

  // Recents (shown when the query is empty) — recently opened targets.
  const recentItems = useMemo<PaletteItem[]>(
    () =>
      recents
        .filter((r) => r.href !== pathname) // not "go where you already are"
        .map((r) => ({
          key: `recent-${r.href}`,
          label: r.title,
          description: r.href,
          icon: recentIcon(r),
          trailing: r.at ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(r.at)}</span>
          ) : undefined,
          onSelect: () => router.push(r.href),
          recent: r,
        })),
    [recents, router, pathname],
  );

  const recentSection = useMemo<PaletteSection>(
    () => ({ label: "Recent", order: -100, items: recentItems }),
    [recentItems],
  );

  // Compose root sections: Recents (empty query) or ID lookups (non-empty)
  // first, then every registered section sorted by `order`.
  const composed = useMemo<PaletteSection[]>(() => {
    const q = query.trim();
    const out: PaletteSection[] = [];
    if (q && idSection) out.push(idSection);
    if (!q && recentSection.items.length) out.push(recentSection);
    const rest = [...Object.values(sections)];
    rest.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    out.push(...rest);
    return out;
  }, [query, idSection, recentSection, sections]);

  // Filter root items by query, then RANK matches within each section by
  // match quality + priority. Sort is stable, so equal scores keep
  // registration order. Open + Recents are exempt (synthesized).
  const filtered = useMemo<PaletteSection[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return composed;
    const tokens = q.split(/\s+/).filter(Boolean);
    const score = makePaletteScorer(q, tokens);
    return composed
      .map((s) => {
        if (s === idSection || s === recentSection) return s;
        const items = s.items
          .filter((it) => {
            const hay = [it.label, it.description ?? "", it.subtitle ?? "", ...(it.keywords ?? [])]
              .join(" ")
              .toLowerCase();
            return matchesPaletteQuery(hay, tokens);
          })
          .map((it) => ({ it, s: score(it) }))
          .sort((a, b) => b.s - a.s)
          .map(({ it }) => it);
        return { ...s, items };
      })
      .filter((s) => s.items.length > 0);
  }, [composed, query, idSection, recentSection]);

  const displayed = useMemo(
    () =>
      query.trim()
        ? filtered
        : paletteHomeSections<PaletteItem, PaletteSection>(filtered, (section) => ({
            key: `browse-section-${section.label}`,
            label: `Browse all ${section.label.toLowerCase()}`,
            description: `${section.items.length.toLocaleString()} entries · Search above to find any of them`,
            pushItems: { title: section.label, items: section.items },
          })),
    [filtered, query],
  );

  // Flatten the CURRENT view for keyboard nav + index-aligned rendering.
  const flat = useMemo<{ item: PaletteItem; sectionLabel: string }[]>(() => {
    const list: { item: PaletteItem; sectionLabel: string }[] = [];
    if (atRoot) {
      for (const s of displayed)
        for (const it of s.items) list.push({ item: it, sectionLabel: s.label });
      return list;
    }
    if (view?.kind === "prompt") {
      const sync = view.prompt.suggest?.(query) ?? [];
      for (const it of [...sync, ...asyncSuggestions])
        list.push({ item: it, sectionLabel: "Suggestions" });
      return list;
    }
    if (view?.kind === "list") {
      const q = query.trim().toLowerCase();
      const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
      for (const it of view.items) {
        if (tokens.length) {
          const hay = [it.label, it.description ?? "", ...(it.keywords ?? [])]
            .join(" ")
            .toLowerCase();
          if (!matchesPaletteQuery(hay, tokens)) continue;
        }
        list.push({ item: it, sectionLabel: view.title });
      }
      return list;
    }
    return list;
  }, [atRoot, view, displayed, query, asyncSuggestions]);

  const submitPrompt = useCallback(() => {
    if (atRoot || view?.kind !== "prompt") return;
    const ok = view.prompt.canSubmit ? view.prompt.canSubmit(query) : query.trim().length > 0;
    if (!ok) return;
    view.prompt.onSubmit(query);
    setOpen(false);
  }, [atRoot, view, query]);

  const activate = useCallback(
    (idx: number, openInNewTab = false): void => {
      const target = flat[idx];
      if (!target) return;
      const it = target.item;
      if (it.prompt) {
        pushView({ kind: "prompt", prompt: it.prompt });
        return;
      }
      if (it.pushItems) {
        pushView({ kind: "list", title: it.pushItems.title, items: it.pushItems.items });
        return;
      }
      const href = itemHref(it);
      if (openInNewTab && href) {
        window.open(href, "_blank", "noopener,noreferrer");
        if (it.recent) recordRecent(it.recent);
        setOpen(false);
        return;
      }
      // Fire the action FIRST (router.push / overlay open / …) then close. If
      // we close first, the unmount path can swallow the router transition.
      it.onSelect?.();
      if (it.recent) recordRecent(it.recent);
      setOpen(false);
    },
    [flat, pushView],
  );

  const minIdx = !atRoot && view?.kind === "prompt" ? -1 : 0;

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, minIdx));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const openInNewTab = (e.metaKey || e.ctrlKey) && Boolean(itemHref(flat[activeIdx]?.item));
      if (!atRoot && view?.kind === "prompt") {
        if (activeIdx >= 0 && flat[activeIdx]) activate(activeIdx, openInNewTab);
        else submitPrompt();
      } else if (flat[activeIdx]) {
        activate(activeIdx, openInNewTab);
      }
    } else if (e.key === "Backspace") {
      // Backspace on an empty input pops the drill-down.
      if (!atRoot && query === "") {
        e.preventDefault();
        popView();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!atRoot) popView();
      else setOpen(false);
    }
  };

  // Focus the input on every open / view change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus follows open+stack transitions
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, stack]);

  if (!open) return null;

  const placeholder = atRoot
    ? "Search agents, routes, runs, or paste an id…"
    : view?.kind === "prompt"
      ? view.prompt.placeholder
      : `Filter ${view?.title ?? ""}…`;
  const renderTokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const activeHref = itemHref(flat[activeIdx]?.item);

  const canSubmitNow =
    !atRoot &&
    view?.kind === "prompt" &&
    (view.prompt.canSubmit ? view.prompt.canSubmit(query) : query.trim().length > 0);

  const emptyNode: ReactNode =
    !atRoot && view?.kind === "prompt" ? (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
        {view.prompt.hint ?? `Press Enter to ${view.prompt.submitLabel.toLowerCase()}.`}
      </p>
    ) : (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</p>
    );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close is a mouse convenience; Esc is wired on the input.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a click-to-close target only; the dialog below carries role + focus.
    <div
      className="fixed inset-0 z-60 flex items-start justify-center bg-black/60 sm:p-6 sm:pt-[14vh]"
      onClick={() => setOpen(false)}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop-close on inner clicks; not itself a control. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col overflow-hidden border-border bg-background sm:h-auto sm:max-h-[70vh] sm:max-w-lg sm:rounded-xl sm:border sm:shadow-lg"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          {atRoot ? (
            <Search size={16} className="shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <button
              type="button"
              onClick={popView}
              aria-label="Back"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft size={16} aria-hidden />
            </button>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(!atRoot && view?.kind === "prompt" ? -1 : 0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-base placeholder:text-muted-foreground focus:outline-none md:text-sm"
          />
          {!atRoot && view?.kind === "prompt" ? (
            <button
              type="button"
              onClick={submitPrompt}
              disabled={!canSubmitNow}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {view.prompt.submitLabel}
              <Kbd>⏎</Kbd>
            </button>
          ) : (
            <Kbd>esc</Kbd>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1 sm:max-h-80">
          {flat.length === 0
            ? emptyNode
            : flat.map(({ item, sectionLabel }, idx) => {
                const showHeader = idx === 0 || flat[idx - 1].sectionLabel !== sectionLabel;
                const isActive = idx === activeIdx;
                const labelMatch = renderTokens.length
                  ? paletteMatchIndices(item.label, renderTokens)
                  : null;
                const detail = item.description;
                const detailMatch =
                  renderTokens.length && detail ? paletteMatchIndices(detail, renderTokens) : null;
                const labelHighlight = fuzzyHighlightIndices(item.label, renderTokens, labelMatch);
                const detailHighlight = detail
                  ? fuzzyHighlightIndices(detail, renderTokens, detailMatch)
                  : null;
                return (
                  <Fragment key={item.key}>
                    {showHeader && sectionLabel && (
                      <div className="flex items-center justify-between px-3 pt-2 pb-1">
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                          {sectionLabel}
                        </span>
                        {sectionLabel === "Recent" && recentItems.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              clearRecents();
                              setRecents([]);
                            }}
                            className="text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      ref={isActive ? activeRowRef : undefined}
                      onClick={(event) => activate(idx, event.metaKey || event.ctrlKey)}
                      onAuxClick={(event) => {
                        if (event.button !== 1 || !itemHref(item)) return;
                        event.preventDefault();
                        activate(idx, true);
                      }}
                      onMouseEnter={() => setActiveIdx(idx)}
                      aria-keyshortcuts={itemHref(item) ? "Meta+Enter Control+Enter" : undefined}
                      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        isActive
                          ? "bg-muted/80 text-foreground"
                          : "text-foreground hover:bg-muted/60"
                      }`}
                    >
                      <span className="shrink-0 text-muted-foreground">
                        {item.icon ?? <ArrowRight size={14} aria-hidden />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          {/* flex-none + a cap: short labels never truncate in favor
                              of the (secondary) description; only very long labels
                              give way. */}
                          <span className="block max-w-[70%] flex-none truncate">
                            <HighlightedMatch text={item.label} indices={labelHighlight} />
                          </span>
                          {detail ? (
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                              <HighlightedMatch text={detail} indices={detailHighlight} />
                            </span>
                          ) : null}
                        </span>
                        {item.subtitle && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.subtitle}
                          </span>
                        )}
                      </span>
                      {item.trailing ??
                        (isActive && (
                          <ArrowRight
                            size={14}
                            className="shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                        ))}
                    </button>
                  </Fragment>
                );
              })}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑↓</Kbd> Navigate
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>⏎</Kbd> {!atRoot && view?.kind === "prompt" ? view.prompt.submitLabel : "Select"}
          </span>
          {activeHref && (
            <span className="hidden items-center gap-1 sm:inline-flex">
              <Kbd>⌘⏎</Kbd> New tab
            </span>
          )}
          {!atRoot && (
            <span className="inline-flex items-center gap-1">
              <Kbd>⌫</Kbd> Back
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1">
            <Kbd>esc</Kbd> {atRoot ? "Close" : "Back"}
          </span>
        </div>
      </div>
    </div>
  );
}
