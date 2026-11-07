import type * as React from "react";

import { cn } from "@/lib/cn";
import { TONE, type Tone } from "@/lib/tone";

/**
 * A banner or callout inside a page: a read error, a warning about stale
 * data, a hint about what to do next. Colour comes from the shared tone
 * grammar, so a `danger` notice and a `danger` badge always match.
 *
 *   <Notice tone="danger" title="Could not read the server registry">{error}</Notice>
 */
export function Notice({
  tone = "neutral",
  title,
  icon,
  actions,
  className,
  children,
}: {
  tone?: Tone;
  title?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
        TONE[tone].surface,
        className,
      )}
    >
      {icon ? (
        <span className={cn("mt-0.5 shrink-0 [&>svg]:size-4", TONE[tone].text)}>{icon}</span>
      ) : null}
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium text-foreground">{title}</div> : null}
        {children ? (
          <div className={cn("text-muted-foreground", title ? "mt-0.5" : undefined)}>
            {children}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
