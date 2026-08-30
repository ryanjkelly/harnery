"use client";

import { Bug, CircleAlert, Pause, Play, Radio, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogFlowSnapshot } from "@/lib/log-flow-reader";
import { useLiveSignal } from "@/lib/useLiveSignal";
import type { HarneryLogLevel } from "../../../src/core/storage/contract";
import type { HarneryLogRecordV1 } from "../../../src/core/storage/jsonl";

const WINDOW_MS = 120_000;
const MAX_MARKERS_PER_LANE = 12;
const LEVELS: readonly HarneryLogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const HUES = [196, 264, 154, 42, 328, 14, 182, 232, 286, 102, 350, 58, 216];

export function LogFlow({ initialSnapshot }: { initialSnapshot: LogFlowSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [paused, setPaused] = useState(false);
  const initialClock = Date.parse(initialSnapshot.capturedAt);
  const [frozenAt, setFrozenAt] = useState(initialClock);
  const [now, setNow] = useState(initialClock);
  const [minimumLevel, setMinimumLevel] = useState<HarneryLogLevel>("trace");
  const [selected, setSelected] = useState<HarneryLogRecordV1 | null>(null);
  const [query, setQuery] = useState("");
  const known = useRef(new Set(recordKeys(initialSnapshot)));
  const [arrivals, setArrivals] = useState(0);

  const refresh = useCallback(async () => {
    if (paused || document.visibilityState !== "visible") return;
    try {
      const response = await fetch("/api/log-flow", { cache: "no-store" });
      if (!response.ok) return;
      const nextSnapshot = (await response.json()) as LogFlowSnapshot;
      const keys = recordKeys(nextSnapshot);
      const next = keys.filter((key) => !known.current.has(key));
      for (const key of keys) known.current.add(key);
      setSnapshot(nextSnapshot);
      if (next.length > 0) setArrivals(next.length);
    } catch {
      // Keep the last good frame. The shared live signal can recover.
    }
  }, [paused]);
  const liveEvents = useMemo(
    () => ({
      hello: () => void refresh(),
      ping: () => {},
      refresh: () => void refresh(),
    }),
    [refresh],
  );
  useLiveSignal({
    streamUrl: "/api/stream",
    versionUrl: "/api/log-flow/version",
    events: liveEvents,
    onFallbackChange: () => void refresh(),
    pollMs: 2_000,
    enabled: !paused,
    fetchOnFallbackStart: true,
  });

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [paused]);

  useEffect(() => {
    if (!arrivals) return;
    const timer = window.setTimeout(() => setArrivals(0), 1_800);
    return () => window.clearTimeout(timer);
  }, [arrivals]);

  const visible = useMemo(() => {
    const threshold = LEVELS.indexOf(minimumLevel);
    const needle = query.trim().toLowerCase();
    const clock = paused ? frozenAt : now;
    return snapshot.lanes.map((lane, index) => {
      const records = lane.records.filter((record) => {
        if (LEVELS.indexOf(record.level) < threshold) return false;
        if (clock - Date.parse(record.emitted_at) > WINDOW_MS) return false;
        if (!needle) return true;
        return `${record.event} ${record.component_id} ${record.family_id}`
          .toLowerCase()
          .includes(needle);
      });
      return {
        ...lane,
        hue: HUES[index % HUES.length]!,
        recordCount: records.length,
        records: compactMarkers(records),
      };
    });
  }, [snapshot, minimumLevel, query, paused, frozenAt, now]);

  const togglePause = () => {
    if (!paused) setFrozenAt(Date.now());
    else setNow(Date.now());
    setPaused((value) => !value);
  };

  return (
    <section aria-label="Live structured log flow" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/80 p-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-log-flow-action="pause"
            onClick={togglePause}
            className="log-flow-control"
          >
            {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            {paused ? "Resume" : "Pause"}
          </button>
          <label className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter event names"
              aria-label="Filter event names"
              className="h-8 w-48 rounded-md border border-input bg-background pl-8 pr-3 text-xs outline-none focus:ring-2 focus:ring-ring/40"
            />
          </label>
          <fieldset className="flex items-center rounded-md border border-border/70 p-0.5">
            <legend className="sr-only">Minimum severity</legend>
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                data-log-level={level}
                aria-pressed={minimumLevel === level}
                onClick={() => setMinimumLevel(level)}
                className={`rounded px-2 py-1 text-[10px] font-semibold uppercase transition ${minimumLevel === level ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              >
                {level}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {arrivals > 0 ? (
            <span aria-live="polite" className="font-medium text-emerald-500">
              +{arrivals} new
            </span>
          ) : null}
          <span className="flex items-center gap-1">
            <Radio className="size-3" aria-hidden /> 2 minute window
          </span>
          {paused ? <span className="font-semibold text-amber-500">FROZEN</span> : null}
        </div>
      </div>

      <div className={`log-flow-stage ${paused ? "is-paused" : ""}`}>
        <div className="log-flow-grid" aria-hidden />
        <div className="log-flow-ingest" aria-hidden>
          <span />
        </div>
        <div className="relative z-10 space-y-2 p-3 sm:p-5">
          {visible.map((lane) => (
            <div
              key={lane.familyId}
              className="log-flow-lane"
              style={{ "--lane-hue": lane.hue } as React.CSSProperties}
            >
              <div className="log-flow-label">
                <span className="log-flow-family-dot" />
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] font-semibold">
                    {shortFamily(lane.familyId)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                    {lane.storageClass === "debug-log" ? (
                      <Bug className="size-2.5" aria-hidden />
                    ) : null}
                    {lane.recordCount} visible
                    {lane.recordCount > lane.records.length
                      ? ` · ${lane.records.length} points`
                      : null}
                  </div>
                </div>
              </div>
              <div className="log-flow-track">
                <span className="log-flow-beam" aria-hidden />
                {lane.error ? (
                  <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-[10px] text-amber-500">
                    <span className="relative z-10 inline-flex max-w-[92%] items-center gap-1.5 rounded-full bg-background/90 px-2 py-0.5 text-center backdrop-blur-sm">
                      <CircleAlert className="size-3 shrink-0" aria-hidden /> lane unavailable:{" "}
                      {lane.error}
                    </span>
                  </div>
                ) : lane.records.length === 0 ? (
                  <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
                    <span className="relative z-10 rounded-full bg-background/90 px-2 py-0.5 backdrop-blur-sm">
                      quiet
                    </span>
                  </div>
                ) : (
                  lane.records.map((record) => (
                    <EventMarker
                      key={recordKey(record)}
                      record={record}
                      now={paused ? frozenAt : now}
                      paused={paused}
                      onSelect={() => setSelected(record)}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-3">
          {LEVELS.map((level) => (
            <span key={level} className="flex items-center gap-1">
              <span className={`log-flow-key log-flow-${level}`} />
              {level}
            </span>
          ))}
        </div>
        <span>Click an event to inspect its bounded context and fields.</span>
      </div>

      {selected ? (
        <article
          className="rounded-xl border border-border/70 bg-card p-4 shadow-sm"
          aria-label="Selected log event"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`log-flow-level-badge log-flow-${selected.level}`}>
                  {selected.level}
                </span>
                <h2 className="font-mono text-sm font-semibold">{selected.event}</h2>
              </div>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {selected.emitted_at} · {selected.family_id} · {selected.component_id}
              </p>
            </div>
            <button type="button" onClick={() => setSelected(null)} className="log-flow-control">
              <RotateCcw aria-hidden /> Clear
            </button>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <Detail title="Context" value={selected.context} />
            <Detail title="Fields" value={selected.fields} />
          </div>
          {selected.error ? (
            <div className="mt-3">
              <Detail title="Error" value={selected.error} />
            </div>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}

function EventMarker({
  record,
  now,
  paused,
  onSelect,
}: {
  record: HarneryLogRecordV1;
  now: number;
  paused: boolean;
  onSelect: () => void;
}) {
  const age = Math.max(0, now - Date.parse(record.emitted_at));
  const left = Math.max(0, Math.min(100, 100 - (age / WINDOW_MS) * 100));
  const fresh = age < 4_000;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${record.level} ${record.event} at ${record.emitted_at}`}
      data-log-event={record.event}
      className={`log-flow-event log-flow-${record.level} ${fresh ? "is-new" : ""}`}
      style={
        {
          left: `${left}%`,
          "--flow-duration": `${WINDOW_MS}ms`,
          "--flow-delay": `${-age}ms`,
          animationPlayState: paused ? "paused" : "running",
        } as React.CSSProperties
      }
    >
      <span className="log-flow-event-glyph" aria-hidden />
    </button>
  );
}

export function compactMarkers(records: readonly HarneryLogRecordV1[]): HarneryLogRecordV1[] {
  const minimumGapMs = WINDOW_MS / (MAX_MARKERS_PER_LANE - 1);
  const newestFirst = [...records].sort(
    (left, right) => Date.parse(right.emitted_at) - Date.parse(left.emitted_at),
  );
  const selected: HarneryLogRecordV1[] = [];
  for (const record of newestFirst) {
    const emittedAt = Date.parse(record.emitted_at);
    if (
      selected.every(
        (candidate) => Math.abs(Date.parse(candidate.emitted_at) - emittedAt) >= minimumGapMs,
      )
    ) {
      selected.push(record);
    }
  }
  return selected.sort((left, right) => Date.parse(left.emitted_at) - Date.parse(right.emitted_at));
}

function Detail({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-muted/25 p-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </h3>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function recordKey(record: HarneryLogRecordV1): string {
  return `${record.family_id}:${record.writer_id}:${record.writer_seq}`;
}
function recordKeys(snapshot: LogFlowSnapshot): string[] {
  return snapshot.lanes.flatMap((lane) => lane.records.map(recordKey));
}
function shortFamily(id: string): string {
  return id.replace(/-(?:operational-|debug-)?log$/, "");
}
