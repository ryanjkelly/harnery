/**
 * DeltaIndicator: small inline chip showing the change between two values.
 *
 * Renders an up/down/flat arrow + the formatted delta in semantic color.
 * Used per-row in compare grids and per-card on trailing-7d deltas. Mirrors
 * the upstream app's components/data-viz/delta-indicator.tsx.
 *
 *   <DeltaIndicator current={1200} previous={1000} format="currency" />
 *   <DeltaIndicator current={4.43} previous={3.1} format="roas" tone="auto" />
 */

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/cn";

export type DeltaFormat = "currency" | "percent" | "roas" | "number" | "decimal";
export type DeltaTone = "auto" | "neutral";
export type DeltaSize = "xs" | "sm";

interface Props {
  current: number;
  previous: number | null | undefined;
  format?: DeltaFormat;
  tone?: DeltaTone;
  size?: DeltaSize;
  showSign?: boolean;
  className?: string;
}

export function DeltaIndicator({
  current,
  previous,
  format = "currency",
  tone = "auto",
  size = "xs",
  showSign = true,
  className,
}: Props) {
  if (previous == null || !Number.isFinite(previous)) {
    return null;
  }
  const delta = current - previous;
  const direction: "up" | "down" | "flat" =
    Math.abs(delta) < epsilon(format)
      ? "flat"
      : delta > 0
        ? "up"
        : "down";

  const Icon =
    direction === "up"
      ? ArrowUpRight
      : direction === "down"
        ? ArrowDownRight
        : Minus;
  const colorClass =
    tone === "neutral"
      ? "text-muted-foreground"
      : direction === "up"
        ? "text-positive"
        : direction === "down"
          ? "text-negative"
          : "text-muted-foreground";

  const sizeClass = size === "xs" ? "text-[11px] gap-0.5" : "text-xs gap-1";
  const iconSize = size === "xs" ? 10 : 12;

  return (
    <span
      className={cn(
        "inline-flex items-center font-mono tabular-nums whitespace-nowrap",
        sizeClass,
        colorClass,
        className,
      )}
      title={`${formatDelta(delta, format, showSign)} vs prior`}
    >
      <Icon size={iconSize} strokeWidth={2.25} aria-hidden />
      <span>{formatDelta(delta, format, showSign)}</span>
    </span>
  );
}

/**
 * Pure-render variant for when the caller has already computed the delta and just
 * wants the visual treatment (trailing-7d baselines that compute their own
 * delta differently from `current - previous`).
 */
export function DeltaChip({
  delta,
  format = "currency",
  tone = "auto",
  size = "xs",
  className,
}: {
  delta: number;
  format?: DeltaFormat;
  tone?: DeltaTone;
  size?: DeltaSize;
  className?: string;
}) {
  const direction: "up" | "down" | "flat" =
    Math.abs(delta) < epsilon(format) ? "flat" : delta > 0 ? "up" : "down";
  const Icon =
    direction === "up"
      ? ArrowUpRight
      : direction === "down"
        ? ArrowDownRight
        : Minus;
  const colorClass =
    tone === "neutral"
      ? "text-muted-foreground"
      : direction === "up"
        ? "text-positive"
        : direction === "down"
          ? "text-negative"
          : "text-muted-foreground";
  const sizeClass = size === "xs" ? "text-[11px] gap-0.5" : "text-xs gap-1";
  const iconSize = size === "xs" ? 10 : 12;
  return (
    <span
      className={cn(
        "inline-flex items-center font-mono tabular-nums whitespace-nowrap",
        sizeClass,
        colorClass,
        className,
      )}
    >
      <Icon size={iconSize} strokeWidth={2.25} aria-hidden />
      <span>{formatDelta(delta, format, true)}</span>
    </span>
  );
}

function formatDelta(value: number, format: DeltaFormat, showSign: boolean): string {
  const sign = showSign && value > 0 ? "+" : "";
  if (format === "currency") {
    return `${sign}${value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })}`;
  }
  if (format === "percent") {
    return `${sign}${value.toFixed(1)}%`;
  }
  if (format === "roas") {
    return `${sign}${value.toFixed(2)}x`;
  }
  if (format === "decimal") {
    return `${sign}${value.toFixed(2)}`;
  }
  return `${sign}${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function epsilon(format: DeltaFormat): number {
  if (format === "roas" || format === "decimal") return 0.01;
  if (format === "percent") return 0.05;
  return 0.5;
}
