/**
 * Sparkbar: thin horizontal data bar showing magnitude relative to peers
 * in the same series. Used inline in compare grids: each column's row gets
 * a 2px baseline bar whose width = value / max. Mirrors the upstream app.
 *
 *   <Sparkbar value={4225} max={9283} tone="acquisition" />
 *
 * Renders as an absolutely-positioned 2px-tall bar at the bottom edge of
 * the cell. The cell must be `position: relative` and have a small bottom
 * padding so the bar has a baseline to sit on.
 */

import { cn } from "@/lib/cn";

export type SparkbarTone =
  | "acquisition"
  | "back-end"
  | "ecomm"
  | "total"
  | "neutral"
  | "positive"
  | "negative";

interface Props {
  value: number;
  max: number;
  tone?: SparkbarTone;
  className?: string;
}

export function Sparkbar({ value, max, tone = "neutral", className }: Props) {
  if (max <= 0 || !Number.isFinite(value) || value <= 0) return null;
  const pct = Math.max(0.02, Math.min(1, value / max));
  const bgClass = TONE_BG[tone];
  return (
    <span
      className={cn(
        "pointer-events-none absolute left-0 bottom-px h-0.5 rounded-r-[2px] opacity-80",
        bgClass,
        className,
      )}
      style={{ width: `${(pct * 100).toFixed(2)}%` }}
      aria-hidden
    />
  );
}

const TONE_BG: Record<SparkbarTone, string> = {
  acquisition: "bg-tone-acquisition",
  "back-end": "bg-tone-back-end",
  ecomm: "bg-tone-ecomm",
  total: "bg-tone-total",
  neutral: "bg-muted-foreground",
  positive: "bg-positive",
  negative: "bg-negative",
};
