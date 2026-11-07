import type * as React from "react";

import { NavBar } from "@/components/NavBar";
import { cn } from "@/lib/cn";
import { coordRoot } from "@/lib/coord-reader";

/**
 * Page widths. Pick by content, not by taste. Every width starts at the nav
 * bar's left edge, so page titles line up across the dashboard; the narrower
 * widths only cap line length.
 *
 * - `prose`   forms and single-column reading (≈768px)
 * - `narrow`  a detail page built from one column of cards (≈896px)
 * - `wide`    the default: lists, tables, boards, dashboards and mixed detail
 *             pages (≈1536px, so content lines up with the nav bar's left edge)
 * - `fill`    full-width, full-height tools that manage their own scrolling
 *             (log tables, file browsers); the main element becomes a flex column
 */
export type PageWidth = "prose" | "narrow" | "wide" | "fill";

const WIDTH_CLS: Record<PageWidth, string> = {
  prose: "w-full max-w-screen-md px-4 pb-10 sm:px-6",
  narrow: "w-full max-w-4xl px-4 pb-10 sm:px-6",
  wide: "w-full max-w-screen-2xl px-4 pb-10 sm:px-6",
  fill: "flex min-h-0 w-full flex-1 flex-col px-4 pb-6 sm:px-6",
};

/** Class string for a page's `<main>`, for the rare page that renders its own shell. */
export function pageMainClass(width: PageWidth = "wide", className?: string): string {
  return cn(WIDTH_CLS[width], className);
}

/**
 * The frame every dashboard page shares: the top navigation bar and a `<main>`
 * of a standard width and gutter. Server component; the nav bar is the only
 * client piece.
 *
 *   <PageShell>
 *     <PageHeader title="Servers" description="…" />
 *     …
 *   </PageShell>
 */
export function PageShell({
  width = "wide",
  compactNav,
  id,
  className,
  children,
}: {
  width?: PageWidth;
  /** Anchor id for the `<main>` element. */
  id?: string;
  /** Slim nav bar with no bottom margin; defaults to on for `fill` pages. */
  compactNav?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <NavBar scannedDir={coordRoot()} compact={compactNav ?? width === "fill"} />
      <main id={id} className={pageMainClass(width, className)}>
        {children}
      </main>
    </>
  );
}
