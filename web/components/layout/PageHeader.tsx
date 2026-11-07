import Link from "next/link";
import type * as React from "react";

import { cn } from "@/lib/cn";

/**
 * The title block at the top of a page: an optional back link, the page
 * title, a one- or two-sentence description, and right-aligned actions or
 * counters.
 *
 *   <PageHeader
 *     back={{ href: "/work", label: "All work" }}
 *     title="Work"
 *     description="Durable objectives that survive across workflow attempts."
 *     actions={<Button>New</Button>}
 *   />
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Buttons, counters or links aligned to the right of the title. */
  actions?: React.ReactNode;
  /** A link back to the parent list, shown above the title. */
  back?: { href: string; label: React.ReactNode };
  /** A row under the title for badges and identifiers. */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn("mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3", className)}
    >
      <div className="min-w-0 flex-1">
        {back ? (
          <Link
            href={back.href}
            prefetch={false}
            className="mb-1 inline-block text-xs text-muted-foreground hover:text-foreground"
          >
            ← {back.label}
          </Link>
        ) : null}
        <h1 className="break-words text-xl font-semibold tracking-tight">{title}</h1>
        {meta ? <div className="mt-1.5 flex flex-wrap items-center gap-2">{meta}</div> : null}
        {description ? (
          <div className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
