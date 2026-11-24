"use client";

import { useEffect, useState } from "react";

import { relativeLabel } from "./relative-label";

/**
 * "in 4 min" / "3 min ago", refreshed every minute so an open tab stays
 * true. The server renders its own reading; the client re-reads on mount, and
 * `suppressHydrationWarning` covers the rare minute that ticks over between.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className={className} suppressHydrationWarning>
      {relativeLabel(iso, now)}
    </span>
  );
}
