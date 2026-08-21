"use client";

import { useEffect, useRef, useState } from "react";

import { createLiveSignalController, type LiveSignalStatus } from "./live-signal-controller";

export type LiveStatus = LiveSignalStatus;

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
    const controller = createLiveSignalController(
      {
        streamUrl,
        versionUrl,
        watchdogMs,
        staleMs,
        pollMs,
        maxRetries,
        enabled,
        fetchOnFallbackStart,
        eventNames: () => Object.keys(eventsRef.current),
        onEvent: (name, event) => eventsRef.current[name]?.(event as MessageEvent),
        onFallbackChange: () => onFallbackRef.current(),
        onStatus: setStatus,
      },
      {
        createSource: (url) => new EventSource(url),
        fetchVersion: async (url) => {
          try {
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) return undefined;
            const body = (await response.json()) as { v?: unknown };
            return typeof body.v === "string" ? body.v : undefined;
          } catch {
            return undefined;
          }
        },
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        setInterval: (callback, ms) => setInterval(callback, ms),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
        visibility: () => (document.visibilityState === "hidden" ? "hidden" : "visible"),
        onVisibilityChange: (callback) => {
          document.addEventListener("visibilitychange", callback);
          return () => document.removeEventListener("visibilitychange", callback);
        },
      },
    );
    controller.start();
    return () => controller.stop();
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
