import type * as React from "react";

import { cn } from "@/lib/cn";
import { TONE, type Tone } from "@/lib/tone";

/**
 * Small uppercase label used above a group of fields or a list
 * ("Recent runs", "Claims"). Use instead of re-typing the class string.
 */
export function Eyebrow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A titled block of a page: heading, optional count and hint, right-aligned
 * actions, then the content. `tone` adds a coloured left rule using the shared
 * state grammar (for example `act` for "Waiting on you").
 */
export function Section({
  title,
  hint,
  count,
  actions,
  tone,
  id,
  className,
  children,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
  tone?: Tone;
  id?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn("mb-8", tone && cn("border-l-2 pl-3", TONE[tone].accentBorder), className)}
    >
      <SectionHeader title={title} hint={hint} count={count} actions={actions} />
      {children}
    </section>
  );
}

export function SectionHeader({
  title,
  hint,
  count,
  actions,
  className,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1", className)}>
      <div className="min-w-0">
        <h2 className="flex items-baseline gap-2 text-sm font-semibold tracking-tight">
          {title}
          {count !== undefined ? (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
          ) : null}
        </h2>
        {hint ? <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
