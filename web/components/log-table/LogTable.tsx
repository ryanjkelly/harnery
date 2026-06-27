"use client";

import {
  type ChangeEvent,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  ChevronRight,
  Copy,
  Download,
  Pause,
  Play,
  Regex,
  Search,
  X,
} from "lucide-react";

import { AgentChip } from "@/components/AgentChip";
import { ColorizedJson } from "@/components/log-table/ColorizedJson";
import { LogTimestamp } from "@/components/log-table/LogTimestamp";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { NO_DATA } from "@/lib/format/no-data";
import type { LogRowRenderer, LogRowVariant } from "@/lib/log-table/types";
import { useLiveSignal } from "@/lib/useLiveSignal";

const MAX_BUFFER = 5000;
const SEARCH_DEBOUNCE_MS = 120;

interface Props<E> {
  /** Server-rendered initial batch (already sorted in any order; the table
   * sorts client-side, descending by ts). */
  initialRows: E[];
  /** Per-event-shape getters + renderers. Identity is what makes
   * /live and /events share the same shell. */
  renderer: LogRowRenderer<E>;
  /** When set, the table opens an EventSource and consumes the same SSE
   * envelopes /api/live-events emits: `snapshot`, `event`, `ready`,
   * `heartbeat`. /events doesn't pass this (its rows are server-rendered). */
  sseUrl?: string;
  /** Comma-separated query params appended to `sseUrl`. */
  sseSearchParams?: Record<string, string | undefined>;
  /** Non-streaming GET that returns `{ rows }`, refetched in the polling
   * fallback when the live SSE stream can't be used (e.g. through harn tunnel). */
  snapshotUrl?: string;
  /** Agent dropdown options (bare names, sorted). */
  agentNames: string[];
  /** Optional initial agent filter from URL searchParams. */
  initialAgent?: string | null;
  /** Optional initial kind filter from URL searchParams. */
  initialKind?: string | null;
  /** Optional kinds to seed the chip row even if the current buffer has zero
   * occurrences (useful so /events shows the full kind catalog). */
  knownKinds?: string[];
  /** Label below `events`/`live`/etc. for the empty-state hint. */
  emptyStateHint?: string;
  /** Override max rows kept in memory. Default 5000. */
  maxBuffer?: number;
}

/**
 * A unit of rendering after run-folding: either a single standalone row, or a
 * group of ≥2 adjacent rows that shared a non-null `getGroupKey` (e.g. the
 * per-line `output` events of one command, folded into one expandable block).
 */
type RenderItem<E> =
  | { kind: "row"; row: E }
  | { kind: "group"; rows: E[]; groupKey: string };

/**
 * Generic full-width scrollable structured-event log.
 *
 * Shared shell between /events (canonical hook-event log from
 * `.harnery/events.ndjson`) and /live (session-tee stream from
 * `.harnery/session-events.ndjson`). The two pages plug in per-event-shape
 * renderers via the `renderer` prop. Everything else is identical across both
 * surfaces: toolbar, search (plain + regex), agent filter, kind chips,
 * auto-scroll, table-scoped scrolling with sticky header, row expansion with
 * colorized 2-space JSON, pause + drain, live indicator, and timezone
 * detection + per-row tooltip.
 *
 * Keyboard shortcuts:
 *   `/`     focus search input
 *   `Esc`   clear search / collapse expanded row / blur input
 *   `[`     toggle regex mode
 *   `p`     toggle pause (only when SSE source is connected)
 *
 * Sort: descending by `ts`, newest rows at top. Auto-scroll keeps the view
 * pinned to the top when new events arrive, but if the user scrolls down the
 * pinning pauses so they can read history without being yanked away.
 */
export function LogTable<E>({
  initialRows,
  renderer,
  sseUrl,
  sseSearchParams,
  snapshotUrl,
  agentNames,
  initialAgent,
  initialKind,
  knownKinds,
  emptyStateHint,
  maxBuffer = MAX_BUFFER,
}: Props<E>) {
  const [rows, setRows] = useState<E[]>(initialRows);
  const [search, setSearch] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  const [regexMode, setRegexMode] = useState<boolean>(false);
  const [agentFilter, setAgentFilter] = useState<string | null>(
    initialAgent ?? null,
  );
  const [kindFilter, setKindFilter] = useState<string | null>(
    initialKind ?? null,
  );
  const [paused, setPaused] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState<string>("UTC");

  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pausedBufferRef = useRef<E[]>([]);
  const pausedRef = useRef(paused);
  const autoScrollRef = useRef(autoScroll);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  /* ───── timezone detection (UTC fallback on SSR) ──────────────────── */

  useEffect(() => {
    try {
      const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (userTz) setTimeZone(userTz);
    } catch {
      // keep UTC fallback
    }
  }, []);

  /* ───── search debounce ───────────────────────────────────────────── */

  useEffect(() => {
    const id = window.setTimeout(
      () => setDebouncedSearch(search),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [search]);

  /* ───── live updates via the shared signal ────────────────────────── */
  // Stream appends while SSE flows; fall back to change-detection polling
  // (refetch the snapshot) when it doesn't, e.g. through harn tunnel, which
  // buffers SSE wholesale. The hook owns the connection lifecycle, both
  // watchdogs, reconnect, and visibility handling. See useLiveSignal.
  const streamUrl = useMemo(() => {
    if (!sseUrl) return "";
    const params = new URLSearchParams();
    if (sseSearchParams) {
      for (const [k, v] of Object.entries(sseSearchParams)) {
        if (v !== undefined && v !== "") params.set(k, v);
      }
    }
    if (agentFilter) params.set("agent", agentFilter);
    const qs = params.toString();
    return qs ? `${sseUrl}?${qs}` : sseUrl;
  }, [sseUrl, agentFilter, JSON.stringify(sseSearchParams ?? {})]);

  const events = useMemo(
    () => ({
      ready: () => {},
      heartbeat: () => {},
      snapshot: (msg: MessageEvent) => {
        try {
          const data = JSON.parse(msg.data) as { events: E[] };
          setRows(data.events);
        } catch {
          /* malformed */
        }
      },
      event: (msg: MessageEvent) => {
        try {
          const ev = JSON.parse(msg.data) as E;
          if (pausedRef.current) {
            pausedBufferRef.current.push(ev);
            return;
          }
          setRows((prev) => appendCapped(prev, ev, maxBuffer));
        } catch {
          /* malformed */
        }
      },
    }),
    [maxBuffer],
  );

  // Polling fallback: replace the buffer with a fresh snapshot when the version
  // endpoint changes. Skips while paused (don't clobber a frozen view) and when
  // there's no snapshot source (server-rendered-only tables).
  const refetchSnapshot = useCallback(async () => {
    if (!snapshotUrl || pausedRef.current) return;
    try {
      const res = await fetch(snapshotUrl, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { rows: E[] };
      setRows(data.rows);
    } catch {
      /* transient */
    }
  }, [snapshotUrl]);

  const status = useLiveSignal({
    streamUrl,
    enabled: !!sseUrl,
    events,
    onFallbackChange: refetchSnapshot,
    // No SSR rows (e.g. /live seeds from the SSE snapshot) → populate on
    // fallback instead of showing an empty table through the tunnel.
    fetchOnFallbackStart: initialRows.length === 0 && !!snapshotUrl,
  });

  /* ───── drain paused buffer on unpause ────────────────────────────── */

  useEffect(() => {
    if (paused) return;
    if (pausedBufferRef.current.length === 0) return;
    const drained = pausedBufferRef.current;
    pausedBufferRef.current = [];
    setRows((prev) => {
      let next = prev;
      for (const ev of drained) {
        next = appendCapped(next, ev, maxBuffer);
      }
      return next;
    });
  }, [paused, maxBuffer]);

  /* ───── sort + filter pipeline ────────────────────────────────────── */

  const compiledRegex = useMemo(() => {
    if (!regexMode || !debouncedSearch) return null;
    try {
      return { re: new RegExp(debouncedSearch, "i"), error: null as null };
    } catch (err) {
      return { re: null, error: (err as Error).message };
    }
  }, [regexMode, debouncedSearch]);

  const { sortedRows, kindCounts } = useMemo(() => {
    const sorted = [...rows].sort((a, b) =>
      renderer.getTs(b).localeCompare(renderer.getTs(a)),
    );
    const counts = new Map<string, number>();
    for (const r of sorted) {
      const k = renderer.getKind(r);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return { sortedRows: sorted, kindCounts: counts };
  }, [rows, renderer]);

  const filteredRows = useMemo(() => {
    const q = debouncedSearch.trim();
    const re = compiledRegex?.re ?? null;
    const matches = (text: string): boolean => {
      if (!q) return true;
      if (re) return re.test(text);
      return text.toLowerCase().includes(q.toLowerCase());
    };
    return sortedRows.filter((r) => {
      if (agentFilter && renderer.getAgentName(r) !== agentFilter) return false;
      if (kindFilter && renderer.getKind(r) !== kindFilter) return false;
      if (!matches(renderer.getSearchableText(r))) return false;
      return true;
    });
  }, [
    sortedRows,
    agentFilter,
    kindFilter,
    debouncedSearch,
    compiledRegex,
    renderer,
  ]);

  /* ───── fold contiguous same-group runs into block items ──────────── */

  // When the renderer supplies `getGroupKey`, collapse maximal *adjacent*
  // runs sharing a non-null key into a single group item. A run of length 1
  // stays a plain row (collapsing one line buys nothing). Order is preserved,
  // so this is a linear scan over the already-sorted+filtered list. When no
  // `getGroupKey` is provided (e.g. /events), every row is a singleton item
  // and the table behaves exactly as before.
  const renderItems = useMemo<RenderItem<E>[]>(() => {
    const getGroupKey = renderer.getGroupKey;
    if (!getGroupKey) {
      return filteredRows.map((row) => ({ kind: "row" as const, row }));
    }
    const items: RenderItem<E>[] = [];
    let run: E[] = [];
    let runKey: string | null = null;
    const flushRun = () => {
      if (run.length === 0) return;
      if (run.length === 1) {
        items.push({ kind: "row", row: run[0] });
      } else {
        items.push({
          kind: "group",
          rows: run,
          // biome-ignore lint/style/noNonNullAssertion: runKey is non-null whenever run is populated
          groupKey: runKey!,
        });
      }
      run = [];
      runKey = null;
    };
    for (const row of filteredRows) {
      const key = getGroupKey(row);
      if (key === null) {
        flushRun();
        items.push({ kind: "row", row });
        continue;
      }
      if (key === runKey) {
        run.push(row);
      } else {
        flushRun();
        run = [row];
        runKey = key;
      }
    }
    flushRun();
    return items;
  }, [filteredRows, renderer]);

  /* ───── stable per-row keys via identity ──────────────────────────── */

  // React-key strategy: identity, not content. Each event object that enters
  // the buffer is minted a unique counter id, cached in a WeakMap keyed by
  // the event reference. Content-derived keys collide in practice (e.g. two
  // `output` events at the same ms with the same first-N chars of `line`)
  // and trigger React's "Encountered two children with the same key" error;
  // identity keys never collide and stay stable across renders. The WeakMap
  // also auto-cleans when older event objects become unreachable after the
  // buffer rolls past `maxBuffer`.
  const keyMapRef = useRef<WeakMap<object, string>>(new WeakMap());
  const keyCounterRef = useRef(0);
  const getRowKey = useCallback((row: E): string => {
    const obj = row as unknown as object;
    let key = keyMapRef.current.get(obj);
    if (!key) {
      keyCounterRef.current += 1;
      key = `r${keyCounterRef.current}`;
      keyMapRef.current.set(obj, key);
    }
    return key;
  }, []);

  // Stable, identity-preserving toggle: a single callback shared by every row
  // (the row passes its own key back) instead of a fresh inline arrow per row
  // per render. Without this, the `onToggle` prop changes every render and the
  // `memo`-wrapped rows below can never skip a re-render. Functional updater so
  // it never closes over `expandedId`.
  const handleToggle = useCallback((key: string) => {
    setExpandedId((cur) => (cur === key ? null : key));
  }, []);

  /* ───── auto-scroll to top + flash newest row on append ───────────── */

  const lastRowsLength = useRef(rows.length);
  const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const grew = rows.length > lastRowsLength.current;
    const delta = rows.length - lastRowsLength.current;
    lastRowsLength.current = rows.length;
    if (!grew) return;
    // Flash the N newest rows with a brief background pulse so the operator
    // sees what just landed even when they're reading mid-buffer.
    const newest = rows.slice(rows.length - delta).map((r) => getRowKey(r));
    setFlashIds(new Set(newest));
    const id = window.setTimeout(() => setFlashIds(new Set()), 1500);
    if (autoScrollRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: 0, behavior: "smooth" });
    }
    return () => window.clearTimeout(id);
  }, [rows, getRowKey]);

  function onScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    // Near-top means we should keep auto-scrolling. Threshold 80px so the
    // operator can wiggle the scrollbar a hair without pausing.
    const nearTop = el.scrollTop < 80;
    if (!nearTop && autoScrollRef.current) setAutoScroll(false);
    if (nearTop && !autoScrollRef.current) setAutoScroll(true);
  }

  /* ───── keyboard shortcuts ────────────────────────────────────────── */

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const inField =
        tag === "input" || tag === "textarea" || tag === "select";
      if (e.key === "/" && !inField) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === "Escape") {
        if (document.activeElement === searchInputRef.current) {
          if (search) {
            setSearch("");
          } else {
            (document.activeElement as HTMLElement).blur();
          }
        } else if (expandedId) {
          setExpandedId(null);
        }
        return;
      }
      if (e.key === "[" && !inField) {
        e.preventDefault();
        setRegexMode((r) => !r);
        return;
      }
      if (e.key === "p" && !inField && sseUrl) {
        e.preventDefault();
        setPaused((p) => !p);
        return;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [search, expandedId, sseUrl]);

  /* ───── handlers ──────────────────────────────────────────────────── */

  const onSearchChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value),
    [],
  );
  const onSearchKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        if (search) {
          setSearch("");
        } else {
          (e.target as HTMLInputElement).blur();
        }
      }
    },
    [search],
  );

  const visibleKinds = useMemo(() => {
    const keys = new Set<string>(kindCounts.keys());
    if (knownKinds) for (const k of knownKinds) keys.add(k);
    return Array.from(keys).sort((a, b) => {
      const aN = kindCounts.get(a) ?? 0;
      const bN = kindCounts.get(b) ?? 0;
      return bN - aN || a.localeCompare(b);
    });
  }, [kindCounts, knownKinds]);

  const liveLabel = (() => {
    if (!sseUrl) return null;
    if (status === "live") {
      return (
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
          live
        </span>
      );
    }
    if (status === "polling") {
      return (
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full bg-sky-500" />
          polling
        </span>
      );
    }
    if (status === "connecting") {
      return (
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full bg-amber-500" />
          connecting
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1">
        <span className="size-2 rounded-full bg-muted-foreground" />
        reconnecting
      </span>
    );
  })();

  const searchError = regexMode && debouncedSearch && !compiledRegex?.re;

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      {/* ───── toolbar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap text-xs shrink-0">
        {/* search */}
        <div
          className={cn(
            "relative inline-flex items-center rounded-md border bg-background min-h-9",
            searchError
              ? "border-rose-500/60"
              : "border-border/60 focus-within:border-foreground/40",
          )}
        >
          <Search className="size-3.5 text-muted-foreground/70 ml-2" />
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={onSearchChange}
            onKeyDown={onSearchKey}
            placeholder={regexMode ? "regex /pattern/i" : "search… (press /)"}
            className="bg-transparent border-0 outline-none px-2 py-1.5 text-foreground placeholder:text-muted-foreground/60 w-64 font-mono"
            spellCheck={false}
            autoComplete="off"
          />
          {search && (
            <Tooltip content="Clear search">
              <button
                type="button"
                onClick={() => setSearch("")}
                className="px-1.5 mr-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            </Tooltip>
          )}
          <Tooltip
            content={
              regexMode
                ? "Regex mode, case-insensitive. Click to switch back to substring search. ([)"
                : "Substring search. Click to switch to regex (case-insensitive). ([)"
            }
          >
            <button
              type="button"
              onClick={() => setRegexMode((r) => !r)}
              className={cn(
                "px-1.5 mr-1 border-l border-border/60 min-h-9 inline-flex items-center",
                regexMode
                  ? "text-accent-foreground bg-purple-500/10"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={regexMode}
              aria-label="Toggle regex mode"
            >
              <Regex className="size-3.5" />
            </button>
          </Tooltip>
        </div>

        {/* agent filter */}
        <span className="text-muted-foreground">agent:</span>
        <select
          value={agentFilter ?? ""}
          onChange={(e) => setAgentFilter(e.target.value || null)}
          className="rounded border border-border/60 bg-background px-2 py-1 text-foreground min-h-9 font-mono"
        >
          <option value="">all</option>
          {agentNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>

        {/* pause (live only) */}
        {sseUrl && (
          <Tooltip
            content={
              paused
                ? `Resume. ${pausedBufferRef.current.length} queued. (p)`
                : "Pause new-event ingestion. (p)"
            }
          >
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className={cn(
                "rounded border px-2.5 py-1 inline-flex items-center gap-1.5 min-h-9",
                paused
                  ? "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-border/60 bg-background text-foreground hover:bg-muted/40",
              )}
              aria-pressed={paused}
            >
              {paused ? (
                <>
                  <Play className="size-3" />
                  paused
                  {pausedBufferRef.current.length > 0 && (
                    <span className="tabular-nums">
                      ({pausedBufferRef.current.length})
                    </span>
                  )}
                </>
              ) : (
                <>
                  <Pause className="size-3" />
                  pause
                </>
              )}
            </button>
          </Tooltip>
        )}

        {/* auto-scroll */}
        <Tooltip
          content={
            autoScroll
              ? "Auto-scroll to top is ON. New events pin the view to the top."
              : "Auto-scroll OFF. Scroll back to the top to re-enable, or click here."
          }
        >
          <button
            type="button"
            onClick={() => {
              setAutoScroll((a) => {
                if (!a) {
                  scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                }
                return !a;
              });
            }}
            className={cn(
              "rounded border px-2.5 py-1 min-h-9 text-xs",
              autoScroll
                ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-border/60 bg-background text-foreground hover:bg-muted/40",
            )}
            aria-pressed={autoScroll}
          >
            auto-scroll {autoScroll ? "on" : "off"}
          </button>
        </Tooltip>

        {/* clear (live only; server-rendered events have no client buffer) */}
        {sseUrl && (
          <Tooltip content="Clear local buffer. Doesn't touch the file.">
            <button
              type="button"
              onClick={() => setRows([])}
              className="rounded border border-border/60 bg-background px-2.5 py-1 min-h-9 text-foreground hover:bg-muted/40 text-xs"
            >
              clear
            </button>
          </Tooltip>
        )}

        <Tooltip
          content={`Download ${filteredRows.length} visible row(s) as NDJSON. Skips client-side filters that have hidden rows.`}
        >
          <button
            type="button"
            onClick={() => downloadJsonl(filteredRows, renderer)}
            disabled={filteredRows.length === 0}
            className="rounded border border-border/60 bg-background px-2.5 py-1 min-h-9 text-foreground hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed text-xs inline-flex items-center gap-1.5"
          >
            <Download className="size-3" />
            export
          </button>
        </Tooltip>

        <div className="ml-auto flex items-center gap-3 text-muted-foreground tabular-nums">
          {liveLabel}
          <span title="Visible / total events in buffer">
            {filteredRows.length.toLocaleString()} /{" "}
            {sortedRows.length.toLocaleString()}
          </span>
          <Tooltip
            content="Times shown in your browser's detected timezone via Intl.DateTimeFormat. SSR falls back to UTC until hydration."
          >
            <Badge
              variant="muted"
              className="normal-case tracking-normal cursor-help"
            >
              {timeZone}
            </Badge>
          </Tooltip>
        </div>
      </div>

      {/* ───── kind filter chips ────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1 text-xs shrink-0">
        <KindChip active={!kindFilter} onClick={() => setKindFilter(null)}>
          all
          <span className="text-muted-foreground tabular-nums ml-1">
            {sortedRows.length}
          </span>
        </KindChip>
        {visibleKinds.slice(0, 24).map((k) => (
          <KindChip
            key={k}
            active={kindFilter === k}
            variant={kindToVariant(k, renderer, sortedRows)}
            onClick={() => setKindFilter(kindFilter === k ? null : k)}
          >
            <span className="font-mono">{k}</span>
            <span className="text-muted-foreground tabular-nums ml-1">
              {kindCounts.get(k) ?? 0}
            </span>
          </KindChip>
        ))}
      </div>

      {/* ───── table ────────────────────────────────────────────────── */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="rounded-md border border-border/60 bg-background/40 overflow-y-auto overflow-x-auto flex-1 min-h-0"
      >
        <table className="w-full text-xs border-separate border-spacing-0">
          <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium py-2 px-3 border-b border-border/60 w-[14ch]">
                time
              </th>
              <th className="text-left font-medium py-2 px-3 border-b border-border/60 w-[18ch]">
                event
              </th>
              <th className="text-left font-medium py-2 px-3 border-b border-border/60 w-[14ch]">
                agent
              </th>
              <th className="text-left font-medium py-2 px-3 border-b border-border/60">
                summary
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-12 text-center text-muted-foreground italic"
                >
                  {sortedRows.length === 0
                    ? (emptyStateHint ??
                      "No events yet. The buffer is empty.")
                    : "No events match the current filter. Clear the search/agent/kind selectors above."}
                </td>
              </tr>
            ) : (
              renderItems.map((item) => {
                if (item.kind === "group") {
                  // The group's identity (for key/expand/flash) is its first
                  // row, stable across renders via the same WeakMap.
                  const groupKey = getRowKey(item.rows[0]);
                  const isExpanded = expandedId === groupKey;
                  const isFlashing = item.rows.some((r) =>
                    flashIds.has(getRowKey(r)),
                  );
                  return (
                    <LogRowGroup
                      key={groupKey}
                      rowKey={groupKey}
                      rows={item.rows}
                      renderer={renderer}
                      expanded={isExpanded}
                      onToggle={handleToggle}
                      timeZone={timeZone}
                      flashing={isFlashing}
                    />
                  );
                }
                const rowKey = getRowKey(item.row);
                const isExpanded = expandedId === rowKey;
                const isFlashing = flashIds.has(rowKey);
                return (
                  <LogRow
                    key={rowKey}
                    rowKey={rowKey}
                    row={item.row}
                    renderer={renderer}
                    expanded={isExpanded}
                    onToggle={handleToggle}
                    timeZone={timeZone}
                    flashing={isFlashing}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
        {!autoScroll && (
          <button
            type="button"
            onClick={() => {
              scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
              setAutoScroll(true);
            }}
            className="absolute bottom-4 right-4 inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-background/95 shadow-lg px-3 py-2 text-xs text-foreground hover:bg-muted/40 backdrop-blur"
            aria-label="Jump to top + resume auto-scroll"
          >
            <ArrowUp className="size-3.5" />
            jump to top
          </button>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

interface LogRowProps<E> {
  /** Stable identity key (from the parent WeakMap); passed back to `onToggle`. */
  rowKey: string;
  row: E;
  renderer: LogRowRenderer<E>;
  expanded: boolean;
  onToggle: (key: string) => void;
  timeZone: string;
  flashing: boolean;
}

function LogRowInner<E>({
  rowKey,
  row,
  renderer,
  expanded,
  onToggle,
  timeZone,
  flashing,
}: LogRowProps<E>) {
  const ts = renderer.getTs(row);
  const kind = renderer.getKind(row);
  const variant = renderer.getKindVariant(row);
  const agentName = renderer.getAgentName(row);
  const agentInstanceId = renderer.getAgentInstanceId(row);

  const rowBaseCls =
    "group transition-colors odd:bg-muted/30 hover:bg-muted/60 cursor-pointer align-top";

  return (
    <>
      <tr
        className={cn(
          rowBaseCls,
          expanded && "bg-muted/70 hover:bg-muted/70",
          // Highlighted row stays for ~1.5s after append, then the parent
          // drops `flashing`; the existing `transition-colors` on the row
          // fades it back to baseline, providing the "what just landed"
          // visual cue without needing a custom keyframe.
          flashing &&
            "bg-sky-500/20 hover:bg-sky-500/20 odd:bg-sky-500/20",
        )}
        onClick={() => onToggle(rowKey)}
        aria-expanded={expanded}
      >
        <td className="py-1.5 px-3 font-mono text-muted-foreground whitespace-nowrap">
          <LogTimestamp iso={ts} timeZone={timeZone} />
        </td>
        <td className="py-1.5 px-3">
          <Badge
            variant={variant}
            className="font-mono normal-case tracking-normal"
          >
            {kind}
          </Badge>
        </td>
        <td
          className="py-1.5 px-3 font-mono"
          onClick={(e) => e.stopPropagation()}
        >
          {agentName ? (
            <AgentChip name={agentName} className="font-mono" prefix="" />
          ) : agentInstanceId ? (
            <span
              className="text-muted-foreground/70"
              title={agentInstanceId}
            >
              {agentInstanceId.slice(0, 8)}
            </span>
          ) : (
            <span className="text-muted-foreground/40">{NO_DATA}</span>
          )}
        </td>
        <td className="py-1.5 px-3 text-muted-foreground whitespace-pre-wrap wrap-break-word">
          {renderer.renderSummary(row)}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/20 border-b border-border/40">
          <td colSpan={4} className="px-3 py-3">
            <ExpandedRow row={row} renderer={renderer} />
          </td>
        </tr>
      )}
    </>
  );
}

// Memoized so a parent re-render (a keystroke in search, a streamed append, a
// filter toggle) only re-renders the rows whose props actually changed, not all
// N rows. Props are all primitives or stable refs (`row` identity is preserved
// across appends; `renderer` + `onToggle` are stable), so the default shallow
// comparison is correct. The cast restores the generic call signature `memo`
// erases. This is what turns an O(all rows) re-render into O(changed rows).
const LogRow = memo(LogRowInner) as typeof LogRowInner;

/* ────────────────────────────────────────────────────────────────────── */

interface LogRowGroupProps<E> {
  /** Stable identity key (the first row's key); passed back to `onToggle`. */
  rowKey: string;
  /** Run of ≥2 adjacent same-group rows, in display order (newest first). */
  rows: E[];
  renderer: LogRowRenderer<E>;
  expanded: boolean;
  onToggle: (key: string) => void;
  timeZone: string;
  flashing: boolean;
}

/**
 * A folded run of output lines rendered as one disclosure row.
 *
 * Collapsed: kind badge + "N lines" + the first emitted line as a preview.
 * Expanded: the same header row followed by a single monospace block with
 * every line (rendered via the renderer's `renderSummary`, so stderr keeps
 * its amber color). Clicking the header toggles; clicking the agent chip is
 * stopped from toggling so it stays a usable link.
 *
 * Rows arrive newest-first (the table sorts descending by ts). Output reads
 * naturally top-to-bottom in chronological order, so the block reverses the
 * run back to emission order and the time column shows the first emitted
 * line's timestamp (the run's start).
 */
function LogRowGroupInner<E>({
  rowKey,
  rows,
  renderer,
  expanded,
  onToggle,
  timeZone,
  flashing,
}: LogRowGroupProps<E>) {
  // Emission order = oldest→newest. `rows` is newest-first, so reverse it.
  const chrono = useMemo(() => [...rows].reverse(), [rows]);
  const first = chrono[0];
  const startTs = renderer.getTs(first);
  const variant = renderer.getKindVariant(first);
  const kind = renderer.getKind(first);
  const agentName = renderer.getAgentName(first);
  const agentInstanceId = renderer.getAgentInstanceId(first);
  const count = rows.length;

  const rowBaseCls =
    "group transition-colors odd:bg-muted/30 hover:bg-muted/60 cursor-pointer align-top";

  return (
    <>
      <tr
        className={cn(
          rowBaseCls,
          expanded && "bg-muted/70 hover:bg-muted/70",
          flashing && "bg-sky-500/20 hover:bg-sky-500/20 odd:bg-sky-500/20",
        )}
        onClick={() => onToggle(rowKey)}
        aria-expanded={expanded}
      >
        <td className="py-1.5 px-3 font-mono text-muted-foreground whitespace-nowrap">
          <LogTimestamp iso={startTs} timeZone={timeZone} />
        </td>
        <td className="py-1.5 px-3">
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight
              className={cn(
                "size-3 text-muted-foreground transition-transform shrink-0",
                expanded && "rotate-90",
              )}
            />
            <Badge
              variant={variant}
              className="font-mono normal-case tracking-normal"
            >
              {kind}
            </Badge>
            <span className="text-muted-foreground/70 tabular-nums text-[11px]">
              {count} lines
            </span>
          </span>
        </td>
        <td
          className="py-1.5 px-3 font-mono"
          onClick={(e) => e.stopPropagation()}
        >
          {agentName ? (
            <AgentChip name={agentName} className="font-mono" prefix="" />
          ) : agentInstanceId ? (
            <span className="text-muted-foreground/70" title={agentInstanceId}>
              {agentInstanceId.slice(0, 8)}
            </span>
          ) : (
            <span className="text-muted-foreground/40">{NO_DATA}</span>
          )}
        </td>
        <td className="py-1.5 px-3 text-muted-foreground">
          {expanded ? (
            <span className="text-muted-foreground/50 italic text-[11px]">
              {count} lines, click to collapse
            </span>
          ) : (
            <span className="inline-flex items-baseline gap-2 min-w-0">
              <span className="truncate block max-w-full opacity-90">
                {renderer.renderSummary(first)}
              </span>
              <span className="text-muted-foreground/40 shrink-0 text-[11px]">
                +{count - 1} more
              </span>
            </span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/20 border-b border-border/40">
          <td colSpan={4} className="px-3 py-2">
            <div className="rounded border border-border/40 bg-background/60 font-mono text-xs">
              {chrono.map((r, i) => (
                <div
                  // Index key is safe here: the block re-renders wholesale and
                  // line order within one command's output is stable.
                  key={i}
                  className="flex gap-2 px-3 py-0.5 border-l-2 border-border/40 hover:bg-muted/30 whitespace-pre-wrap wrap-break-word"
                >
                  <span className="text-muted-foreground/30 select-none tabular-nums shrink-0 w-[3ch] text-right">
                    {i + 1}
                  </span>
                  <span className="min-w-0">{renderer.renderSummary(r)}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// Memoized for the same reason as LogRow (see above): skip re-rendering folded
// groups whose props are unchanged on an unrelated parent re-render.
const LogRowGroup = memo(LogRowGroupInner) as typeof LogRowGroupInner;

function ExpandedRow<E>({
  row,
  renderer,
}: {
  row: E;
  renderer: LogRowRenderer<E>;
}) {
  const raw = renderer.getRaw(row);
  const json = useMemo(() => JSON.stringify(raw, null, 2), [raw]);
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard rejected; best effort
    }
  }, [json]);

  return (
    <div className="rounded border border-border/40 bg-background/60 p-3">
      <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
        <span>raw event</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded border border-border/60 bg-background px-2 py-1 text-foreground hover:bg-muted/40"
        >
          <Copy className="size-3" />
          {copied ? "copied" : "copy JSON"}
        </button>
      </div>
      <ColorizedJson value={raw} />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

function KindChip({
  active,
  variant,
  onClick,
  children,
}: {
  active: boolean;
  variant?: LogRowVariant;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const dot = variant ? VARIANT_DOT[variant] : "bg-muted-foreground/30";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors",
        active
          ? "bg-foreground/10 ring-1 ring-foreground/30 text-foreground"
          : "bg-muted/40 hover:bg-muted/70 text-foreground/80",
      )}
    >
      <span className={cn("size-1.5 rounded-full shrink-0", dot)} />
      {children}
    </button>
  );
}

const VARIANT_DOT: Record<LogRowVariant, string> = {
  info: "bg-sky-500",
  success: "bg-emerald-500",
  destructive: "bg-rose-500",
  accent: "bg-purple-500",
  warning: "bg-amber-500",
  secondary: "bg-secondary-foreground/50",
  muted: "bg-muted-foreground/30",
};

/* ────────────────────────────────────────────────────────────────────── */

function kindToVariant<E>(
  k: string,
  renderer: LogRowRenderer<E>,
  rows: E[],
): LogRowVariant {
  // Probe the first row of this kind to learn its variant.
  for (const r of rows) {
    if (renderer.getKind(r) === k) return renderer.getKindVariant(r);
  }
  return "muted";
}

/**
 * Trigger a browser download of `rows` as NDJSON (one event per line).
 * Uses the renderer's `getRaw` so the exported shape matches what's in the
 * source ndjson file (with `tool_input` parsed back to an object for
 * readability, same as the expand-row view).
 */
function downloadJsonl<E>(rows: E[], renderer: LogRowRenderer<E>): void {
  if (rows.length === 0) return;
  const body = rows.map((r) => JSON.stringify(renderer.getRaw(r))).join("\n");
  const blob = new Blob([body], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  a.download = `harnery-log-${ts}.ndjson`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the click handler can read it; ~1s is plenty.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function appendCapped<E>(prev: E[], ev: E, cap: number): E[] {
  const next = [...prev, ev];
  if (next.length > cap) return next.slice(next.length - cap);
  return next;
}
