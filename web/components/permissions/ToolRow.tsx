import { ChevronRight } from "lucide-react";
import type * as React from "react";
import type { ToolSummary } from "@/components/permissions/levels";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { TONE } from "@/lib/tone";

/**
 * One coding tool on the Permissions page: a summary line (name, level, one
 * sentence) that opens to its details and a one-line "how to change" note.
 * Rows stack inside one bordered list; amber rows carry an amber left rule.
 */
export function ToolRow({
  id,
  name,
  summary,
  change,
  defaultOpen = false,
  children,
}: {
  id: string;
  name: string;
  summary: ToolSummary;
  /** One sentence on how to change this tool's settings. */
  change?: React.ReactNode;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <details
      id={id}
      open={defaultOpen || undefined}
      className={cn(
        "group/tool scroll-mt-20 border-l-2",
        summary.tone === "warn" || summary.tone === "danger"
          ? TONE[summary.tone].accentBorder
          : "border-l-transparent",
      )}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-3 hover:bg-muted/40 sm:grid-cols-[auto_9rem_8.5rem_1fr] [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />
        <span className="font-medium">{name}</span>
        <span className="justify-self-end sm:justify-self-start">
          <Badge tone={summary.tone} title={summary.raw ? `Setting: ${summary.raw}` : undefined}>
            {summary.level}
          </Badge>
        </span>
        <span className="col-span-3 col-start-1 pl-7 text-sm text-muted-foreground sm:col-span-1 sm:col-start-auto sm:pl-0">
          {summary.sentence}
        </span>
      </summary>
      <div className="space-y-3 px-3 pb-4 text-sm sm:pl-10">
        {children}
        {change ? <p className="text-xs text-muted-foreground">{change}</p> : null}
      </div>
    </details>
  );
}
