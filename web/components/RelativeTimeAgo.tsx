"use client";

import { useEffect, useState } from "react";

import { formatRelativeAgo } from "@/lib/format/datetime";

/**
 * Live-updating "1d 5h ago" label. Renders nothing on the server and the
 * first client paint (the endpoint is "now," which differs between SSR and
 * client mount), then swaps in the computed string in `useEffect`. Refreshes
 * once per minute so a long-lived dashboard tab doesn't read "2m ago" three
 * hours later.
 *
 * Use it alongside `<FormattedDateTime>` for the canonical pattern:
 *
 *   <FormattedDateTime iso={ts} /> · <RelativeTimeAgo iso={ts} />
 *
 * Producing: `Sun, May 24, 7:52 PM CDT · 1d 5h ago`.
 */
export function RelativeTimeAgo({
  iso,
  className,
}: {
  iso: string | Date | null | undefined;
  className?: string;
}) {
  const [label, setLabel] = useState<string>("");
  useEffect(() => {
    if (!iso) return;
    const compute = () => setLabel(formatRelativeAgo(iso));
    compute();
    const id = window.setInterval(compute, 60_000);
    return () => window.clearInterval(id);
  }, [iso]);
  if (!label) return null;
  return <span className={className}>{label}</span>;
}
