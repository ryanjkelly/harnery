import { Fragment } from "react";

import { cn } from "@/lib/cn";

/** Render an exact identifier or path with safe line-break opportunities after
 * its natural separators. The copied text remains unchanged. */
export function BreakableMono({ text, className }: { text: string; className?: string }) {
  const segments = Array.from(text.matchAll(/[^/_.:-]+|[/_.:-]/g)).flatMap((match) => {
    const token = match[0];
    const offset = match.index;
    if (/^[a-f0-9]{12,}$/i.test(token)) {
      return Array.from(token.matchAll(/.{1,6}/g), (part) => ({
        text: part[0],
        offset: offset + part.index,
        breakAfter: true,
      }));
    }
    return [{ text: token, offset, breakAfter: /^[/_.:-]$/.test(token) }];
  });
  return (
    <samp className={cn("text-balance font-mono", className)}>
      {segments.map((segment) => (
        <Fragment key={`${segment.offset}-${segment.text}`}>
          <samp className="font-inherit">{segment.text}</samp>
          {segment.breakAfter && <wbr />}
        </Fragment>
      ))}
    </samp>
  );
}
