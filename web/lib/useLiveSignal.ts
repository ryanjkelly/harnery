"use client";

import { useEffect, useRef, useState } from "react";

export type LiveStatus = "connecting" | "live" | "polling" | "reconnecting";

export interface LiveSignalOptions {
  /**
   * SSE endpoint to subscribe to. When it changes the hook re-subscribes;
   * consumers that vary the URL at runtime (e.g. an agent filter) should fold
   * that into this string so a change triggers a fresh connection.
   */
  streamUrl: string;
  /**
   * Map of SSE event-name → handler. Every delivered event also marks the
   * stream live and resets the watchdogs (receiving any byte proves the
   * transport flushes). Register every named event you care about, including
   * inert ones like `ready`/`heartbeat`, so heartbeats keep the activity
   * watchdog satisfied. Do NOT register `error`; the hook owns it. A `stale`
   * handler, if present, runs in addition to the hook's own reconnect.
   */
  events: Record<string, (ev: MessageEvent) => void>;
  /**
   * Called when, in polling-fallback mode, the version endpoint reports a
   * change. The consumer refetches/refreshes its own data here (router.refresh
   * for a server-rendered page, or a snapshot fetch for a streaming consumer).
   */
  onFallbackChange: () => void;
  /** Change-detection endpoint polled in fallback mode. */
  versionUrl?: string;
  /** No first event within this long after the stream opens → assume the
   * transport is buffering (the Cloudflare `harn tunnel` case) → poll. */
  watchdogMs?: number;
  /** No event for this long after going live → assume the connection silently
   * died → reconnect. Must exceed the server heartbeat interval. */
  staleMs?: number;
  /** Polling cadence in fallback mode. */
  pollMs?: number;
  /** Failed SSE (re)connects before abandoning the stream for polling. */
  maxRetries?: number;
  /** Skip the stream + polling entirely when false (e.g. a server-rendered
   * table with no SSE source). Defaults to true. */
  enabled?: boolean;
  /** Run onFallbackChange once on entering polling mode (before baselining).
   * For consumers with no server-rendered seed data (empty initial snapshot)
   * so the view populates on fallback instead of staying empty until the first
   * change. Consumers that SSR their data leave this false to stay flash-free.
   * Default false. */
  fetchOnFallbackStart?: boolean;
}

const DEFAULT_VERSION_URL = "/api/coord-version";
const DEFAULT_WATCHDOG_MS = 5_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;
const RECONNECT_DELAY_MS = 1_000;

/**
 * Shared live-update primitive for the Harnery viewer. Owns the SSE connection
 * lifecycle, a tristate-plus status, two watchdogs, a change-detection polling
 * fallback, exponential-backoff reconnect, and visibility handling, so every
 * live surface (dashboard refresher, image gallery, log tables) behaves
 * identically, in particular through `harn tunnel`.
 *
 * The tunnel problem this exists for: Cloudflare's trycloudflare quick tunnel
 * buffers `text/event-stream` bodies wholesale: the 200 + headers arrive
 * (EventSource fires `onopen`) but no event bytes ever flush, and `onerror`
 * never fires. So the stream looks "open" yet silent forever. The initial
 * watchdog catches that and falls back to polling a cheap version endpoint,
 * refreshing only when the coord state actually changes.
 *
 * Locally, where SSE flushes immediately, the first event marks the stream live
 * within ~1s, the watchdog is cleared, and the hook never polls, identical to
 * the original per-component SSE behavior.
 */
export function useLiveSignal(opts: LiveSignalOptions): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");

  // Latest closures live in refs so re-renders that hand us fresh callbacks
  // don't tear down and re-subscribe the stream.
  const eventsRef = useRef(opts.events);
  eventsRef.current = opts.events;
  const onFallbackRef = useRef(opts.onFallbackChange);
  onFallbackRef.current = opts.onFallbackChange;

  const streamUrl = opts.streamUrl;
  const versionUrl = opts.versionUrl ?? DEFAULT_VERSION_URL;
  const watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const enabled = opts.enabled ?? true;
  const fetchOnFallbackStart = opts.fetchOnFallbackStart ?? false;

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let initialWatchdog: ReturnType<typeof setTimeout> | null = null;
    let activityTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let lastVersion: string | null = null;
    let retries = 0;

    const clearTimer = (t: ReturnType<typeof setTimeout> | null): null => {
      if (t) clearTimeout(t);
      return null;
    };
    function stopPolling(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
    function closeStream(): void {
      reconnectTimer = clearTimer(reconnectTimer);
      initialWatchdog = clearTimer(initialWatchdog);
      activityTimer = clearTimer(activityTimer);
      es?.close();
      es = null;
    }
    function teardown(): void {
      closeStream();
      stopPolling();
    }

    // ── polling fallback ──────────────────────────────────────────────────
    async function pollOnce(): Promise<void> {
      try {
        const res = await fetch(versionUrl, { cache: "no-store" });
        if (cancelled || !res.ok) return;
        const { v } = (await res.json()) as { v: string };
        if (cancelled) return;
        if (lastVersion === null) {
          // First tick after fallback: current data is already on screen, so
          // just record the baseline; don't refresh (no flicker when idle).
          lastVersion = v;
          return;
        }
        if (v !== lastVersion) {
          lastVersion = v;
          onFallbackRef.current();
        }
      } catch {
        // transient: try again next tick
      }
    }
    function startPolling(): void {
      if (cancelled || pollTimer) return;
      closeStream();
      setStatus("polling");
      lastVersion = null;
      // Consumers with no SSR seed (empty initial snapshot, e.g. /live) populate
      // now; consumers that already rendered their data skip this and stay
      // flash-free until something actually changes.
      if (fetchOnFallbackStart) onFallbackRef.current();
      void pollOnce(); // establish baseline now (no refresh)
      pollTimer = setInterval(() => void pollOnce(), pollMs);
    }

    // ── stream lifecycle ──────────────────────────────────────────────────
    function bumpActivity(): void {
      activityTimer = clearTimer(activityTimer);
      activityTimer = setTimeout(() => {
        // Live, then went silent past the heartbeat interval → the connection
        // died without an error event. Reconnect; if the fresh stream is also
        // silent the initial watchdog will fall us back to polling.
        scheduleReconnect();
      }, staleMs);
    }
    function markLive(): void {
      retries = 0;
      initialWatchdog = clearTimer(initialWatchdog);
      stopPolling();
      setStatus("live");
      bumpActivity();
    }
    function scheduleReconnect(): void {
      closeStream();
      if (cancelled) return;
      setStatus((prev) => (prev === "live" ? "reconnecting" : prev));
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    }
    function connect(): void {
      if (!enabled || !streamUrl) return;
      if (cancelled || es || pollTimer) return;
      // Don't hold a socket while the tab is backgrounded. Next dev is HTTP/1.1
      // (≤6 connections per host) and every viewer tab holds one of these, so
      // background tabs would starve the foreground tab's loads. Reconnect on
      // return.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        setStatus("connecting");
        return;
      }
      const source = new EventSource(streamUrl);
      es = source;

      // Arm the initial watchdog only once the connection is established
      // (headers received). Through the tunnel `onopen` fires but no data
      // follows → watchdog → poll. Locally a cold dev-compile delays `onopen`,
      // so gating on it avoids a false fallback while the route compiles.
      source.onopen = () => {
        initialWatchdog = clearTimer(initialWatchdog);
        initialWatchdog = setTimeout(startPolling, watchdogMs);
      };

      // Attach a listener per registered event name; dispatch to the latest
      // handler via the ref so we never hold a stale closure.
      for (const name of Object.keys(eventsRef.current)) {
        source.addEventListener(name, (ev) => {
          markLive();
          eventsRef.current[name]?.(ev as MessageEvent);
        });
      }
      // The hook owns server-initiated reconnects so consumers don't each
      // reimplement it. (A consumer-supplied `stale` handler still runs, above.)
      source.addEventListener("stale", () => scheduleReconnect());

      source.onerror = () => {
        // Browsers fire onerror on transport drop. (A tunnel-buffered stream
        // never does; the initial watchdog covers that.)
        setStatus((prev) => (prev === "live" ? "reconnecting" : prev));
        closeStream();
        if (cancelled) return;
        retries += 1;
        if (retries >= maxRetries) {
          startPolling(); // give up on SSE
          return;
        }
        reconnectTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retries));
      };
    }

    function onVisibility(): void {
      if (document.visibilityState === "hidden") {
        teardown();
        setStatus("connecting");
      } else {
        // Re-probe SSE from scratch on return (network path may have changed).
        retries = 0;
        teardown();
        setStatus("connecting");
        connect();
      }
    }

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      teardown();
    };
  }, [
    streamUrl,
    versionUrl,
    watchdogMs,
    staleMs,
    pollMs,
    maxRetries,
    enabled,
    fetchOnFallbackStart,
  ]);

  return status;
}
