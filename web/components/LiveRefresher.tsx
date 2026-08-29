"use client";

import { Radio, RefreshCw, WifiOff } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { createLiveRefreshScheduler, liveRefreshIntervalMs } from "@/lib/live-refresh-scheduler";
import { useLiveSignal } from "@/lib/useLiveSignal";

/**
 * Subscribes to /api/stream (SSE) and calls router.refresh() on each "refresh"
 * event so the dashboard re-renders against fresh disk state. Connection
 * lifecycle, the polling fallback (for tunnel-buffered SSE), and the status
 * badge state all live in the shared useLiveSignal hook.
 *
 * The event ledger changes several times per tool call. A direct
 * router.refresh() for each change repeatedly rebuilds the complete V3
 * projection, blocks the event loop, and eventually pushes Next over its memory
 * restart threshold. The scheduler keeps the first server render authoritative
 * while coalescing subsequent changes into a bounded refresh cadence. Routes
 * with their own client-side live stream retain the badge but skip the global
 * server refresh entirely.
 */
export function LiveRefresher() {
  const router = useRouter();
  const pathname = usePathname();
  const refreshIntervalMs = liveRefreshIntervalMs(pathname);
  const scheduler = useMemo(
    () =>
      refreshIntervalMs === null
        ? null
        : createLiveRefreshScheduler(() => router.refresh(), refreshIntervalMs, {
            now: () => Date.now(),
            setTimeout: (callback, ms) => window.setTimeout(callback, ms),
            clearTimeout: (handle) => window.clearTimeout(handle as number),
          }),
    [refreshIntervalMs, router],
  );

  useEffect(() => () => scheduler?.cancel(), [scheduler]);

  const events = useMemo(
    () => ({
      hello: () => {},
      ping: () => {},
      refresh: () => scheduler?.request(),
    }),
    [scheduler],
  );

  const status = useLiveSignal({
    streamUrl: "/api/stream",
    events,
    onFallbackChange: () => scheduler?.request(),
  });

  const isLive = status === "live";
  const isPolling = status === "polling";
  const isReconnecting = status === "reconnecting";

  const colorCls = isLive
    ? "text-emerald-400"
    : isPolling
      ? "text-sky-400"
      : isReconnecting
        ? "text-amber-400"
        : "text-muted-foreground";

  const icon = isLive ? (
    <Radio className="size-3" />
  ) : isPolling ? (
    <RefreshCw className="size-3" />
  ) : isReconnecting ? (
    <WifiOff className="size-3" />
  ) : (
    <Radio className="size-3 opacity-50" />
  );

  const tip = isLive
    ? refreshIntervalMs === null
      ? "Live updates connected. This page folds updates into the current view."
      : "Live updates connected. Coordination changes are coalesced to keep the dashboard responsive."
    : isPolling
      ? "Live stream unavailable through this connection (proxy buffering the event stream); checking for changes by polling instead."
      : isReconnecting
        ? "Connection lost; retrying with exponential backoff. Manual refresh works in the meantime."
        : "Connecting to the live-update stream…";

  return (
    <Tooltip content={tip}>
      <span
        className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider cursor-help ${colorCls}`}
      >
        {icon}
        {/* The initial "connecting" moment is routine (server-rendered content
            is already on screen), so it stays icon-only instead of shouting a
            state label that reads like an error. */}
        {(isLive || isPolling || isReconnecting) && (
          <span>{isLive ? "live" : isPolling ? "polling" : "reconnecting"}</span>
        )}
      </span>
    </Tooltip>
  );
}
