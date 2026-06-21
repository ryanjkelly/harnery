"use client";

import { useEffect } from "react";

import { useAttentionSlot } from "@/components/AttentionProvider";
import type { AttentionRequest } from "@/lib/attention";

/**
 * Declarative "this state waits on the operator" marker. Server components
 * compute the request (or null) per render and mount this leaf; the root
 * AttentionProvider does the alerting. Renders nothing.
 *
 *   <Attention request={{ key: `att:${id}:r3:copy:agent-X`,
 *                         label: "Copy agent-X's prompt" }} />
 *
 * Pass `request={null}` (or unmount) when the state is no longer actionable;
 * channels stop immediately. The key is the dedup identity: once the operator
 * interacts, that key never re-alerts in this tab (see lib/attention.ts).
 */
export function Attention({ request }: { request: AttentionRequest | null }) {
  const set = useAttentionSlot();
  const key = request?.key ?? null;
  // Re-arm only on semantic key change. RSC refreshes pass a fresh object
  // for the same moment on every render, which must not restart the alert.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key IS request's identity
  useEffect(() => {
    set(request ?? null);
    return () => set(null);
  }, [key, set]);
  return null;
}
