import type * as React from "react";

import { cn } from "@/lib/cn";

/**
 * What a list or section shows when it has nothing in it. Say what is
 * missing and, when there is one, how to create the first item.
 *
 *   <EmptyState>No durable work yet. Create one with <code>harn work create</code>.</EmptyState>
 */
export function EmptyState({
  icon,
  action,
  className,
  children,
}: {
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {icon ? (
          <span className="shrink-0 text-muted-foreground/60 [&>svg]:size-4">{icon}</span>
        ) : null}
        <div>{children}</div>
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
