"use client";

import { BellRing } from "lucide-react";

import { useAttentionState } from "@/components/AttentionProvider";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * NavBar control that re-fires the most recent attention alert, for "I heard
 * the chime but clicked it away before reading" moments. The provider keeps
 * the last alert in state + sessionStorage (reload-safe) and falls back to the
 * page's current actionable request, so the bell works even when the moment
 * was acked before this tab ever alerted; replay forces every channel past
 * the acked-dedup and engaged suppression.
 *
 * `data-attention-replay` exempts the click from the provider's
 * ack-on-interaction listener. Otherwise pressing the bell would instantly
 * silence the alert it just fired.
 */
export function AttentionReplayBell() {
  const { replayTarget, isAlerting, replay } = useAttentionState();
  const disabled = !replayTarget || isAlerting;
  return (
    <Tooltip
      content={
        replayTarget
          ? isAlerting
            ? "An alert is already showing; interact anywhere to dismiss it."
            : `Replay the last alert: ${replayTarget.label}`
          : "No attention alerts yet this session."
      }
    >
      <button
        type="button"
        data-attention-replay
        onClick={replay}
        disabled={disabled}
        className="text-muted-foreground hover:text-foreground rounded p-1 hover:bg-muted/60 disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label="Replay the last attention alert"
      >
        <BellRing className="size-5" strokeWidth={1.5} aria-hidden />
      </button>
    </Tooltip>
  );
}
