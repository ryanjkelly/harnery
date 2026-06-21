"use client";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { ScratchCategory } from "@/lib/coord-writer";

import { CATEGORY_META } from "./categories";

/**
 * Radio-style picker for one of the 7 scratch categories. Each chip carries
 * its own tooltip ("what does <category> mean?"), so the operator never has
 * to guess the semantics. Selection is single-choice.
 */

const SELECTED_RING: Record<string, string> = {
  default: "ring-2 ring-primary/60",
  outline: "ring-2 ring-foreground/30",
  secondary: "ring-2 ring-secondary-foreground/40",
  muted: "ring-2 ring-foreground/30",
  info: "ring-2 ring-sky-500/50",
  success: "ring-2 ring-emerald-500/60",
  warning: "ring-2 ring-amber-500/60",
  destructive: "ring-2 ring-destructive/60",
  accent: "ring-2 ring-purple-500/60",
};

const BASE_CHIP: Record<string, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  outline: "border-border text-foreground bg-background",
  muted: "border-border/60 bg-muted text-muted-foreground",
  info: "border-sky-500/60 bg-sky-500/10 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  success:
    "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  warning:
    "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  destructive:
    "border-destructive/60 bg-destructive/10 text-destructive dark:bg-destructive/20",
  accent:
    "border-purple-500/60 bg-purple-500/10 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300",
};

export function CategoryPicker({
  value,
  onChange,
  disabled,
}: {
  value: ScratchCategory;
  onChange: (v: ScratchCategory) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Entry category"
      className="flex flex-wrap gap-1.5"
    >
      {CATEGORY_META.map((m) => {
        const selected = m.value === value;
        return (
          <Tooltip
            key={m.value}
            side="top"
            content={
              <div className="max-w-[18rem] space-y-1">
                <div className="font-semibold">{m.label}</div>
                <div className="text-muted-foreground">{m.short}</div>
                <div className="text-popover-foreground/85">{m.long}</div>
              </div>
            }
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(m.value)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium tracking-wider uppercase whitespace-nowrap transition-all cursor-pointer",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                BASE_CHIP[m.variant],
                selected && SELECTED_RING[m.variant],
                !selected && "opacity-70 hover:opacity-100",
              )}
            >
              {m.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
