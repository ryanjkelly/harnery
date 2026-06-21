"use client";

import { Radio, RefreshCw, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { useLiveSignal } from "@/lib/useLiveSignal";

/**
 * Subscribes to /api/stream (SSE) and calls router.refresh() on each "refresh"
 * event so the dashboard re-renders against fresh disk state. Connection
 * lifecycle, the polling fallback (for tunnel-buffered SSE), and the status
 * badge state all live in the shared useLiveSignal hook; see that file for
 * why the fallback exists. Here we just map the signal to router.refresh().
 */
export function LiveRefresher() {
  const router = useRouter();

  const events = useMemo(
    () => ({
      hello: () => {},
      ping: () => {},
      refresh: () => router.refresh(),
    }),
    [router],
  );

  const status = useLiveSignal({
    streamUrl: "/api/stream",
    events,
    onFallbackChange: () => router.refresh(),
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
    ? "Live updates connected. UI auto-refreshes on .harnery/ changes."
    : isPolling
      ? "Live stream unavailable through this connection (proxy buffering the event stream); refreshing on change every few seconds instead."
      : isReconnecting
        ? "Connection lost; retrying with exponential backoff. Manual refresh works in the meantime."
        : "Connecting to the live-update stream…";

  return (
    <Tooltip content={tip}>
      <span
        className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider cursor-help ${colorCls}`}
      >
        {icon}
        <span>{isLive ? "live" : isPolling ? "polling" : isReconnecting ? "reconnecting" : "connecting"}</span>
      </span>
    </Tooltip>
  );
}
