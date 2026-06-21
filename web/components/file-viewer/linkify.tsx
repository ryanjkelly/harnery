"use client";

/**
 * Conservative prose path-linkifier. Splits free text and wraps
 * path-shaped tokens in <FilePath>, leaving everything else as plain text.
 *
 * "Conservative" + "highest false-positive risk, ships last" (the plan): the
 * client can't know the repo's top-level children (that's host state, and
 * hardcoding `/home/<user>/...` would break portability), so this only requires a
 * token to LOOK like a path: at least one `/` and a trailing `.ext`. The real
 * arbiter is the server's resolveFile: a false positive (a URL path, a glob, a
 * regex) resolves to the graceful Unresolvable / Not-found state, never a leak.
 * URLs are still skipped up front (the scheme `//` + `:` fail the lookbehind)
 * so links don't turn into a pile of broken file buttons.
 */

import type { ReactNode } from "react";
import { FilePath } from "./FilePath";

// A path-shaped run: optional leading `/` or `./`/`../`, then one-or-more
// `segment/`, then a filename with an extension. Lookbehind rejects starts that
// sit inside a URL (`://`, `/`) or mid-token (`\w`, `.`).
const PATH_RE = /(?<![\w:/.])((?:\.\.?\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,12})/g;

function shorten(p: string): string {
  // Display: trim a leading repo-root-ish absolute prefix to the tail few
  // segments so long absolute paths don't blow out the line. resolveFile still
  // gets the full token.
  if (p.length <= 72) return p;
  const segs = p.split("/").filter(Boolean);
  return `…/${segs.slice(-3).join("/")}`;
}

/**
 * Turn `text` into React nodes with path tokens linkified. Pure-ish: returns a
 * node array suitable for inlining inside a <pre>/<span>. `className` is applied
 * to each <FilePath>.
 */
export function linkifyPaths(text: string, className?: string): ReactNode[] {
  if (!text || !text.includes("/")) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // Fresh lastIndex each call (module-level regex with /g).
  PATH_RE.lastIndex = 0;
  let key = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec loop
  while ((m = PATH_RE.exec(text)) !== null) {
    const token = m[1]!;
    const start = m.index + (m[0].length - token.length);
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <FilePath
        key={`p${key++}`}
        path={token}
        display={shorten(token)}
        className={className ?? "text-sky-700 dark:text-sky-400"}
      />,
    );
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  // Mixed array of plain strings + keyed <FilePath> elements: valid React
  // children (primitives need no key; the FilePaths carry their own).
  return out.length ? out : [text];
}
