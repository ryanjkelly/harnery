"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { createLiveRefreshScheduler } from "@/lib/live-refresh-scheduler";
import { useLiveSignal } from "@/lib/useLiveSignal";

const RESOURCE_REFRESH_MS = 2_000;

export function ResourceLiveRefresher() {
  const router = useRouter();
  const scheduler = useMemo(
    () =>
      createLiveRefreshScheduler(() => router.refresh(), RESOURCE_REFRESH_MS, {
        now: () => Date.now(),
        setTimeout: (callback, ms) => window.setTimeout(callback, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
      }),
    [router],
  );
  useEffect(() => () => scheduler.cancel(), [scheduler]);
  const events = useMemo(
    () => ({
      hello: () => {},
      ping: () => {},
      refresh: () => scheduler.request(),
    }),
    [scheduler],
  );
  useLiveSignal({
    streamUrl: "/api/stream",
    events,
    onFallbackChange: () => scheduler.request(),
    pollMs: RESOURCE_REFRESH_MS,
  });
  return null;
}
