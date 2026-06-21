/**
 * MetricBadge: small tinted chip for headline KPIs. Mirrors the upstream app.
 *
 *   <MetricBadge label="ROAS" value="4.43x" tone="good" />
 *
 * Tones map to semantic backgrounds: good=positive-soft, warn=cost-soft,
 * bad=negative-soft, neutral=muted, info=tone-acquisition.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type MetricTone = "good" | "warn" | "bad" | "neutral" | "info";

interface Props {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: MetricTone;
  className?: string;
}

export function MetricBadge({
  label,
  value,
  hint,
  tone = "neutral",
  className,
}: Props) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-md border px-3 py-2 min-w-32",
        TONE_BORDER[tone],
        TONE_BG[tone],
        className,
      )}
      title={hint}
    >
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "text-base font-semibold font-mono tabular-nums",
          TONE_TEXT[tone],
        )}
      >
        {value}
      </span>
      {hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

const TONE_BORDER: Record<MetricTone, string> = {
  good: "border-positive/30",
  warn: "border-cost/30",
  bad: "border-negative/30",
  neutral: "border-border",
  info: "border-tone-acquisition/30",
};

const TONE_BG: Record<MetricTone, string> = {
  good: "bg-positive-soft/40",
  warn: "bg-cost/10",
  bad: "bg-negative-soft/40",
  neutral: "bg-muted/40",
  info: "bg-tone-acquisition/10",
};

const TONE_TEXT: Record<MetricTone, string> = {
  good: "text-positive",
  warn: "text-cost",
  bad: "text-negative",
  neutral: "text-foreground",
  info: "text-tone-acquisition",
};
