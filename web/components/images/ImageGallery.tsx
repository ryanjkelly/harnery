"use client";

import { Check, Copy, Download, ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentChip, AgentChipProvider } from "@/components/AgentChip";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { FilePath } from "@/components/file-viewer/FilePath";
import type { AgentSummary } from "@/lib/agent-summary";
import type { EventRow } from "@/lib/coord-reader";
import type { ImageCapture, ImageCaptureData } from "@/lib/images";
import { type LiveStatus, useLiveSignal } from "@/lib/useLiveSignal";

interface Props {
  initial: ImageCapture[];
  /** instance_id → display name, for resolving live-appended events. */
  instanceToName: Record<string, string>;
  /** Server-built hover-card summaries (bare-name keyed). The gallery owns the
   * provider so it can synthesize fallback cards for agents that first appear
   * via the live stream. */
  summaries: Record<string, AgentSummary>;
}

type RoleFilter = "all" | "viewed" | "produced";
type WindowFilter = "all" | "60s" | "5m" | "1h" | "24h";

const WINDOW_MS: Record<WindowFilter, number> = {
  all: Number.POSITIVE_INFINITY,
  "60s": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
};

const WINDOW_LABEL: Record<WindowFilter, string> = {
  all: "Any time",
  "60s": "Last 60s",
  "5m": "Last 5m",
  "1h": "Last hour",
  "24h": "Last 24h",
};

/**
 * /images client shell: a live, filterable thumbnail grid of every image
 * agents have viewed or produced. Seeds from the server snapshot, folds in live
 * `image.captured` events from `/api/events-stream?type=image.captured`, groups
 * by content hash (one card per distinct image, with a touch timeline). Filter
 * by fuzzy intent/path search, agent, role, and time window; arrow-key navigate
 * the lightbox; download with the real filename or pop the raw image out.
 */
export function ImageGallery({ initial, instanceToName, summaries: initialSummaries }: Props) {
  const mapRef = useRef<Map<string, ImageCapture>>(new Map(initial.map((img) => [img.hash, img])));
  const [images, setImages] = useState<ImageCapture[]>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  // Lightbox size preference, persisted so it sticks across opens + reloads.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    try {
      setMaximized(localStorage.getItem("harnery.images.maximized") === "1");
    } catch {
      /* ignore */
    }
  }, []);
  const toggleMaximized = useCallback(() => {
    setMaximized((m) => {
      const next = !m;
      try {
        localStorage.setItem("harnery.images.maximized", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Hover-card summaries: seeded from the server, then extended client-side for
  // any agent that first shows up via the live stream (synthesized stale card
  // so a live-appended name never renders as plain text). flush() re-publishes.
  const summariesRef = useRef<Record<string, AgentSummary>>({ ...initialSummaries });
  const [summaries, setSummaries] = useState<Record<string, AgentSummary>>(summariesRef.current);

  // Filters
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [role, setRole] = useState<RoleFilter>("all");
  const [win, setWin] = useState<WindowFilter>("all");

  const flush = useCallback(() => {
    const arr = [...mapRef.current.values()];
    arr.sort((a, b) => (a.latest_ts < b.latest_ts ? 1 : -1));
    setImages(arr);
    setSummaries({ ...summariesRef.current });
  }, []);

  const foldEvent = useCallback(
    (row: EventRow): boolean => {
      if (row.event_type !== "image.captured") return false;
      const d = row.data as ImageCaptureData | undefined;
      if (!d?.hash) return false;
      const ts = row.ts ?? "";
      const instanceId = row.instance_id ?? "";
      const name = instanceToName[instanceId];
      const agentName = name
        ? name.startsWith("agent-")
          ? name
          : `agent-${name}`
        : `agent-${instanceId.slice(0, 8)}`;
      const touch = {
        instance_id: instanceId,
        agent: agentName,
        role: d.role,
        ts,
        source_path: d.source_path,
        tool_name: d.tool_name,
        intent: d.intent,
        command_head: d.command_head,
      };
      // Synthesize a fallback hover card for an agent we haven't seen a summary
      // for yet (first appearance via the live stream). Server-provided cards
      // already cover agents present at load; this keeps live arrivals from
      // rendering as plain text.
      const bare = agentName.replace(/^agent-/, "").toLowerCase();
      if (bare && !summariesRef.current[bare]) {
        summariesRef.current[bare] = {
          name: agentName.replace(/^agent-/, ""),
          agent_id: "",
          state: "stale",
          last_seen: ts || null,
          created_at: "",
          aliases: [],
          instance_id: instanceId || undefined,
          platform: row.harness ?? null,
        };
      }
      const existing = mapRef.current.get(d.hash);
      if (existing) {
        if (existing.touches.some((t) => t.instance_id === instanceId && t.ts === ts)) {
          return false; // idempotent: already have this touch
        }
        existing.touches.unshift(touch);
        existing.touches.sort((a, b) => (a.ts < b.ts ? 1 : -1));
        existing.touch_count++;
        if (ts > existing.latest_ts) existing.latest_ts = ts;
        if (ts < existing.first_ts) existing.first_ts = ts;
        if (!existing.agents.includes(agentName)) existing.agents.push(agentName);
        if (!existing.roles.includes(d.role)) existing.roles.push(d.role);
      } else {
        mapRef.current.set(d.hash, {
          hash: d.hash,
          ext: d.ext,
          bytes: d.bytes,
          latest_ts: ts,
          first_ts: ts,
          touch_count: 1,
          agents: [agentName],
          roles: [d.role],
          touches: [touch],
          blob_exists: true,
        });
      }
      return true;
    },
    [instanceToName],
  );

  // Live updates via the shared signal: fold image.captured events while SSE
  // flows, fall back to change-detection polling (refetch the snapshot) when it
  // doesn't (e.g. through harn tunnel; see useLiveSignal). The hook owns the
  // connection lifecycle, watchdogs, reconnect, and visibility handling.
  const events = useMemo(
    () => ({
      ready: () => {},
      heartbeat: () => {},
      snapshot: (msg: MessageEvent) => {
        try {
          const data = JSON.parse(msg.data) as { events: EventRow[] };
          let changed = false;
          for (const ev of data.events) changed = foldEvent(ev) || changed;
          if (changed) flush();
        } catch {
          /* ignore */
        }
      },
      event: (msg: MessageEvent) => {
        try {
          const ev = JSON.parse(msg.data) as EventRow;
          if (foldEvent(ev)) flush();
        } catch {
          /* ignore */
        }
      },
    }),
    [foldEvent, flush],
  );
  const refetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/events?type=image.captured&limit=300", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { rows: EventRow[] };
      let changed = false;
      for (const ev of data.rows) changed = foldEvent(ev) || changed;
      if (changed) flush();
    } catch {
      /* ignore */
    }
  }, [foldEvent, flush]);
  const status = useLiveSignal({
    streamUrl: "/api/events-stream?type=image.captured",
    events,
    onFallbackChange: refetchSnapshot,
    fetchOnFallbackStart: initial.length === 0,
  });

  // Distinct agents for the dropdown.
  const allAgents = useMemo(() => {
    const s = new Set<string>();
    for (const img of images) for (const a of img.agents) s.add(a);
    return [...s].sort();
  }, [images]);

  // Apply filters. Time window recomputes per render against now; fine at this
  // scale and keeps "Last 60s" honest as time passes.
  const filtered = useMemo(() => {
    const now = Date.now();
    const q = query.trim().toLowerCase();
    return images.filter((img) => {
      if (role !== "all" && !img.roles.includes(role)) return false;
      if (agent !== "all" && !img.agents.includes(agent)) return false;
      if (win !== "all") {
        const age = now - new Date(img.latest_ts).getTime();
        if (!(age <= WINDOW_MS[win])) return false;
      }
      if (q) {
        const hay = `${img.touches
          .map((t) => `${t.intent ?? ""} ${t.command_head ?? ""} ${t.source_path}`)
          .join(" ")} ${img.hash}`.toLowerCase();
        if (!matchesQuery(q, hay)) return false;
      }
      return true;
    });
  }, [images, query, agent, role, win]);

  // Stable per-render open handler so memoized ThumbCards don't re-render on
  // every live SSE fold / keystroke (a fresh inline closure would defeat memo).
  const openImage = useCallback((hash: string) => setSelected(hash), []);

  const selectedIndex = selected ? filtered.findIndex((i) => i.hash === selected) : -1;
  const selectedImg = selectedIndex >= 0 ? filtered[selectedIndex] : null;

  const filtersActive = query !== "" || agent !== "all" || role !== "all" || win !== "all";
  const clearFilters = () => {
    setQuery("");
    setAgent("all");
    setRole("all");
    setWin("all");
  };

  return (
    <AgentChipProvider summaries={summaries}>
      <FilterBar
        query={query}
        setQuery={setQuery}
        agent={agent}
        setAgent={setAgent}
        agents={allAgents}
        role={role}
        setRole={setRole}
        win={win}
        setWin={setWin}
        shown={filtered.length}
        total={images.length}
        filtersActive={filtersActive}
        onClear={clearFilters}
        status={status}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        {images.length === 0 ? (
          <EmptyState>
            No images captured yet. Read an image file, or run something that produces one (e.g.{" "}
            <code className="font-mono">harn browse &lt;url&gt;</code> or{" "}
            <code className="font-mono">harn image generate …</code>) and it&apos;ll appear here live.
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState>
            No images match these filters.{" "}
            <button
              type="button"
              onClick={clearFilters}
              className="underline hover:text-foreground"
            >
              Clear filters
            </button>
            .
          </EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 pb-6">
            {filtered.map((img) => (
              <ThumbCard key={img.hash} img={img} onOpen={openImage} />
            ))}
          </div>
        )}
      </div>

      {selectedImg && (
        <DetailOverlay
          img={selectedImg}
          index={selectedIndex}
          total={filtered.length}
          maximized={maximized}
          onToggleMaximized={toggleMaximized}
          onClose={() => setSelected(null)}
          onPrev={() => {
            if (selectedIndex > 0) setSelected(filtered[selectedIndex - 1]!.hash);
          }}
          onNext={() => {
            if (selectedIndex < filtered.length - 1) setSelected(filtered[selectedIndex + 1]!.hash);
          }}
        />
      )}
    </AgentChipProvider>
  );
}

/* ── filter bar ──────────────────────────────────────────────────────────── */

function FilterBar(props: {
  query: string;
  setQuery: (v: string) => void;
  agent: string;
  setAgent: (v: string) => void;
  agents: string[];
  role: RoleFilter;
  setRole: (v: RoleFilter) => void;
  win: WindowFilter;
  setWin: (v: WindowFilter) => void;
  shown: number;
  total: number;
  filtersActive: boolean;
  onClear: () => void;
  status: LiveStatus;
}) {
  const selectCls =
    "rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
  return (
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
      <input
        type="search"
        value={props.query}
        onChange={(e) => props.setQuery(e.target.value)}
        placeholder="Search intent, command, or path…"
        className={`${selectCls} w-64 max-w-full`}
      />
      <select
        className={selectCls}
        value={props.agent}
        onChange={(e) => props.setAgent(e.target.value)}
      >
        <option value="all">All agents</option>
        {props.agents.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <select
        className={selectCls}
        value={props.role}
        onChange={(e) => props.setRole(e.target.value as RoleFilter)}
      >
        <option value="all">All roles</option>
        <option value="viewed">Viewed</option>
        <option value="produced">Produced</option>
      </select>
      <select
        className={selectCls}
        value={props.win}
        onChange={(e) => props.setWin(e.target.value as WindowFilter)}
      >
        {(Object.keys(WINDOW_LABEL) as WindowFilter[]).map((w) => (
          <option key={w} value={w}>
            {WINDOW_LABEL[w]}
          </option>
        ))}
      </select>
      {props.filtersActive && (
        <button
          type="button"
          onClick={props.onClear}
          className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
        >
          Clear
        </button>
      )}
      <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {props.shown === props.total
            ? `${props.total} image${props.total === 1 ? "" : "s"}`
            : `${props.shown} of ${props.total}`}
        </span>
        {(() => {
          const s = props.status;
          const cls =
            s === "live"
              ? "text-emerald-400"
              : s === "polling"
                ? "text-sky-400"
                : s === "reconnecting"
                  ? "text-amber-500/80"
                  : "text-muted-foreground";
          const dot =
            s === "live"
              ? "bg-emerald-400"
              : s === "polling"
                ? "bg-sky-400"
                : s === "reconnecting"
                  ? "bg-amber-500/80"
                  : "bg-muted-foreground";
          const title =
            s === "live"
              ? "live stream connected"
              : s === "polling"
                ? "live stream unavailable through this connection; polling for changes"
                : s === "reconnecting"
                  ? "reconnecting…"
                  : "connecting…";
          return (
            <span className={`inline-flex items-center gap-1 ${cls}`} title={title}>
              <span className={`size-1.5 rounded-full ${dot}`} />
              {s}
            </span>
          );
        })()}
      </div>
    </div>
  );
}

/* ── thumbnail ───────────────────────────────────────────────────────────── */

const ROLE_BADGE: Record<"viewed" | "produced", string> = {
  // Opaque-enough fill + ring so chips stay readable over busy thumbnails.
  // Deliberately NO backdrop-blur: these badges are always visible on every
  // card, and backdrop-filter re-samples the blur every scroll frame — the
  // dominant cause of the choppy scroll on this grid.
  produced: "bg-emerald-600/85 text-emerald-50 ring-1 ring-emerald-300/40 shadow-sm",
  viewed: "bg-sky-600/85 text-sky-50 ring-1 ring-sky-300/40 shadow-sm",
};

function RoleBadge({ role }: { role: "viewed" | "produced" }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${ROLE_BADGE[role]}`}>
      {role}
    </span>
  );
}

// Memoized: ImageCapture objects keep a stable reference across live folds
// (flush() mutates in place and re-emits the same Map values), so reference
// equality lets an unchanged card skip re-render on every SSE event / keystroke.
const ThumbCard = memo(function ThumbCard({
  img,
  onOpen,
}: {
  img: ImageCapture;
  onOpen: (hash: string) => void;
}) {
  const more = img.agents.length > 1 ? `+${img.agents.length - 1}` : "";
  const filename = filenameFor(img);
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition hover:border-ring/50">
      <button
        type="button"
        onClick={() => onOpen(img.hash)}
        className="relative aspect-4/3 w-full overflow-hidden bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label={`Open ${filename}`}
      >
        {img.blob_exists ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            // ?w=360 serves a small cached WebP (2× the ~180px cell for
            // retina), not the multi-MB full-res blob — decoding 300 full-page
            // screenshots into these cells is what hung scroll. The lightbox
            // below intentionally keeps the full-res src.
            src={`/api/image/${img.hash}?w=360`}
            alt={filename}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[11px] text-muted-foreground">
            expired
          </div>
        )}
        <div className="absolute left-1 top-1 flex gap-1">
          {img.roles.map((r) => (
            <RoleBadge key={r} role={r} />
          ))}
        </div>
        {img.touch_count > 1 && (
          <span className="absolute bottom-1 right-1 rounded bg-background/90 px-1 py-0.5 text-[10px] text-muted-foreground">
            ×{img.touch_count}
          </span>
        )}
      </button>

      {/* Hover actions: pop out / download. Outside the open-button so they
          don't trigger the lightbox. */}
      {img.blob_exists && (
        <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition group-hover:opacity-100">
          <IconLink
            href={`/api/image/${img.hash}`}
            target="_blank"
            title="Open image in new tab"
            label={`Open ${filename} in new tab`}
          >
            <ExternalLink className="size-3.5" />
          </IconLink>
          <IconLink
            href={`/api/image/${img.hash}?download=${encodeURIComponent(filename)}`}
            download={filename}
            title="Download"
            label={`Download ${filename}`}
          >
            <Download className="size-3.5" />
          </IconLink>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <span className="flex min-w-0 items-center gap-1 text-[11px]">
          <AgentChip name={img.agents[0] ?? "unknown"} className="truncate font-mono text-[11px]" />
          {more && <span className="shrink-0 text-muted-foreground">{more}</span>}
        </span>
        <FormattedDateTime
          iso={img.latest_ts}
          kind="timestamp"
          className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
        />
      </div>
    </div>
  );
});

/* ── lightbox ────────────────────────────────────────────────────────────── */

function DetailOverlay({
  img,
  index,
  total,
  maximized,
  onToggleMaximized,
  onClose,
  onPrev,
  onNext,
}: {
  img: ImageCapture;
  index: number;
  total: number;
  maximized: boolean;
  onToggleMaximized: () => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onPrev();
      else if (e.key === "ArrowRight") onNext();
      else if (e.key === "f" || e.key === "F") onToggleMaximized();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, onToggleMaximized]);

  // Touch swipe on the image surface: horizontal flicks navigate prev/next;
  // vertical flicks drive the size ladder: up maximizes, down restores, and a
  // second down (when already restored) closes. Single-finger only, so it never
  // fights a pinch-zoom; a distance threshold keeps a tap or tiny scroll from
  // registering as a swipe.
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const SWIPE_THRESHOLD = 45;
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      touchRef.current = null;
      return;
    }
    const t = e.touches[0]!;
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (Math.max(adx, ady) < SWIPE_THRESHOLD) return; // tap / too small
    if (adx > ady) {
      if (dx < 0) onNext();
      else onPrev();
    } else if (dy < 0) {
      if (!maximized) onToggleMaximized(); // swipe up → maximize
    } else if (maximized) {
      onToggleMaximized(); // swipe down → restore
    } else {
      onClose(); // swipe down again (already restored) → close
    }
  };

  const filename = filenameFor(img);
  const hasPrev = index > 0;
  const hasNext = index < total - 1;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close is a mouse convenience; keyboard close is Escape (wired above).
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 ${maximized ? "p-2" : "p-6"}`}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop-close from firing on inner clicks; not itself an interactive control. */}
      <div
        className={`flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl ${
          maximized ? "h-[96vh] w-[97vw] max-w-none" : "max-h-[90vh] w-full max-w-4xl"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <span className="truncate font-mono text-sm text-foreground" title={filename}>
            {filename}
          </span>
          <CopyButton value={img.touches[0]?.source_path ?? filename} title="Copy source path" />
          <span className="ml-1 hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span>{(img.bytes / 1024).toFixed(0)} KB</span>
            <span>·</span>
            <span>{img.ext}</span>
            <span>·</span>
            <code className="font-mono">{img.hash.slice(0, 12)}</code>
          </span>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {index + 1} / {total}
          </span>
          {img.blob_exists && (
            <>
              <IconLink
                href={`/api/image/${img.hash}`}
                target="_blank"
                title="Open in new tab"
                label="Open image in new tab"
                bordered
              >
                <ExternalLink className="size-4" />
              </IconLink>
              <IconLink
                href={`/api/image/${img.hash}?download=${encodeURIComponent(filename)}`}
                download={filename}
                title="Download"
                label={`Download ${filename}`}
                bordered
              >
                <Download className="size-4" />
              </IconLink>
            </>
          )}
          <button
            type="button"
            onClick={onToggleMaximized}
            className="rounded border border-border p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            aria-label={maximized ? "Restore default size" : "Maximize"}
            title={maximized ? "Restore default size (f)" : "Maximize (f)"}
          >
            {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div
          data-viewer-surface
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          className={`relative flex items-center justify-center overflow-auto bg-muted/30 p-4 ${
            maximized ? "min-h-0 flex-1" : ""
          }`}
        >
          {hasPrev && <NavArrow dir="prev" onClick={onPrev} />}
          {img.blob_exists ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/image/${img.hash}`}
              alt={filename}
              className={`w-auto object-contain ${maximized ? "max-h-full max-w-full" : "max-h-[60vh]"}`}
            />
          ) : (
            <div className="py-16 text-sm text-muted-foreground">
              blob expired, pruned by the retention janitor
            </div>
          )}
          {hasNext && <NavArrow dir="next" onClick={onNext} />}
        </div>

        <div
          className={`overflow-auto border-t border-border px-4 py-3 ${
            maximized ? "max-h-[26vh] shrink-0" : "max-h-[28vh]"
          }`}
        >
          <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            {img.touch_count} touch{img.touch_count === 1 ? "" : "es"}
          </p>
          <ul className="flex flex-col gap-2">
            {img.touches.map((t, i) => (
              <li
                key={`${t.instance_id}-${t.ts}-${i}`}
                className="flex flex-col gap-0.5 rounded border border-border/60 bg-background/40 px-2 py-1.5 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <AgentChip name={t.agent} className="font-mono text-foreground" />
                  <RoleBadge role={t.role} />
                  <span className="text-muted-foreground">{t.tool_name}</span>
                  <FormattedDateTime
                    iso={t.ts}
                    className="ml-auto tabular-nums text-[10px] text-muted-foreground"
                  />
                </div>
                {(t.intent || t.command_head) && (
                  <p className="text-[11px] text-muted-foreground">{t.intent ?? t.command_head}</p>
                )}
                {/* image-touch source_path → clickable so you
                    can open the live file the snapshot came from. */}
                <FilePath
                  path={t.source_path}
                  className="truncate font-mono text-[10px] text-muted-foreground/80"
                />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function NavArrow({ dir, onClick }: { dir: "prev" | "next"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === "prev" ? "Previous image" : "Next image"}
      className={`absolute top-1/2 -translate-y-1/2 ${dir === "prev" ? "left-2" : "right-2"} flex size-9 items-center justify-center rounded-full bg-background/70 text-foreground backdrop-blur-md transition hover:bg-background`}
    >
      {dir === "prev" ? "‹" : "›"}
    </button>
  );
}

/* ── small shared pieces ─────────────────────────────────────────────────── */

function IconLink({
  href,
  children,
  title,
  label,
  target,
  download,
  bordered,
}: {
  href: string;
  children: React.ReactNode;
  title: string;
  label: string;
  target?: string;
  download?: string;
  bordered?: boolean;
}) {
  return (
    <a
      href={href}
      title={title}
      aria-label={label}
      target={target}
      rel={target === "_blank" ? "noopener noreferrer" : undefined}
      download={download}
      onClick={(e) => e.stopPropagation()}
      className={
        bordered
          ? "inline-flex items-center justify-center rounded border border-border p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          : "inline-flex items-center justify-center rounded bg-background/80 p-1 text-foreground backdrop-blur-md hover:bg-background"
      }
    >
      {children}
    </a>
  );
}

function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* silent */
        }
      }}
      className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <p className="max-w-md text-center">{children}</p>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * Term-scoped substring match: split the query on whitespace and require every
 * term to appear as a substring (case-insensitive; both args are pre-lowered).
 * Predictable for filename-shaped queries — "dt3.png" matches only cards whose
 * path/intent literally contains that run — while staying loose across words:
 * "browse home" still matches "harn browse home".
 *
 * Replaces a subsequence matcher that matched a dotted token like "dt3.png"
 * against nearly every card, because its characters scatter trivially across
 * the long concatenated intent/command/path/hash haystack.
 */
function matchesQuery(query: string, haystack: string): boolean {
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.every((t) => haystack.includes(t));
}

function filenameFor(img: ImageCapture): string {
  const src = img.touches[0]?.source_path ?? "";
  const base = src.split("/").pop() ?? "";
  return base || `${img.hash.slice(0, 12)}.${img.ext}`;
}
