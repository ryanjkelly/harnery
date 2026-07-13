"use client";

import { Radio, RefreshCw, WifiOff } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { useLiveSignal } from "@/lib/useLiveSignal";

/**
 * Routes whose page owns its own client-side live updates — a targeted
 * /api/events-stream subscription that folds new events into local state in
 * place (see ImageGallery's foldEvent). On those, a global router.refresh() is
 * both redundant (the page is already live) and destructive: /api/stream fires
 * a `refresh` on ANY .harnery change, so during active image production —
 * exactly when /images is being watched — it saturates at ~4/sec, and each
 * refresh re-runs the server render (tail-scanning a multi-MB events.ndjson,
 * rebuilding every summary) and re-reconciles the whole grid. That was the
 * cause of the ~2-3fps scroll on /images. We keep the live badge (the SSE
 * connection is cheap) and just skip the refresh call.
 */
const SELF_LIVE_ROUTES = ["/images"];

/**
 * Subscribes to /api/stream (SSE) and calls router.refresh() on each "refresh"
 * event so the dashboard re-renders against fresh disk state. Connection
 * lifecycle, the polling fallback (for tunnel-buffered SSE), and the status
 * badge state all live in the shared useLiveSignal hook; see that file for
 * why the fallback exists. Here we just map the signal to router.refresh() —
 * except on self-live routes (above), where the page updates itself.
 */
export function LiveRefresher() {
  const router = useRouter();
  const pathname = usePathname();
  const selfLive = SELF_LIVE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

  const events = useMemo(
    () => ({
      hello: () => {},
      ping: () => {},
      refresh: () => {
        if (!selfLive) router.refresh();
      },
    }),
    [router, selfLive],
  );

  const status = useLiveSignal({
    streamUrl: "/api/stream",
    events,
    onFallbackChange: () => {
      if (!selfLive) router.refresh();
    },
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
