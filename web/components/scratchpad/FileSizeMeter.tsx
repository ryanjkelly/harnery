"use client";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

/**
 * Compact horizontal meter showing scratchpad bytes used vs the 50KB cap.
 * Mirrors the canonical thresholds from `harnery/src/core/scratch/index.ts`:
 *
 *   WARN at 40KB (80%):  emerald → amber
 *   HARD CAP at 50KB:    amber  → red (scratch lib starts pruning oldest)
 *
 * The cap is enforced server-side; this meter is purely informational, so
 * the operator can see how close they are without reading the source.
 */
const MAX_BYTES = 50 * 1024;
const WARN_BYTES = 40 * 1024;

export function FileSizeMeter({
  bytes,
  className,
}: {
  bytes: number;
  className?: string;
}) {
  const pct = Math.min(100, (bytes / MAX_BYTES) * 100);
  const state = bytes >= MAX_BYTES ? "over" : bytes >= WARN_BYTES ? "warn" : "ok";
  const trackColor =
    state === "over"
      ? "bg-destructive"
      : state === "warn"
        ? "bg-amber-500"
        : "bg-emerald-500";
  const labelColor =
    state === "over"
      ? "text-destructive"
      : state === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";

  return (
    <Tooltip
      side="bottom"
      content={
        <div className="space-y-1">
          <div>
            <span className="font-semibold">{formatBytes(bytes)}</span> used
            of {formatBytes(MAX_BYTES)} cap
          </div>
          <div className="text-muted-foreground">
            Warning above {formatBytes(WARN_BYTES)} (80%). The scratch
            library prunes oldest entries when the file crosses the cap.
          </div>
        </div>
      }
    >
      <span
        className={cn(
          "inline-flex items-center gap-2 cursor-help",
          className,
        )}
      >
        <span
          className="relative h-1.5 w-24 rounded-full bg-muted overflow-hidden shrink-0"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={MAX_BYTES}
          aria-valuenow={bytes}
        >
          <span
            className={cn("absolute inset-y-0 left-0 transition-all", trackColor)}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className={cn("text-[11px] tabular-nums", labelColor)}>
          {formatBytes(bytes)}
        </span>
      </span>
    </Tooltip>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
}
