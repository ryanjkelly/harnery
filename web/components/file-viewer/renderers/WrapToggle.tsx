"use client";

/**
 * Soft-wrap preference for the source views, plus the toolbar button that
 * flips it. Wrap is ON by default so a minified or long-line file is readable
 * without horizontal scrolling; the choice persists per browser in
 * localStorage. Read after mount (never during render) so the server and the
 * first client paint agree on the default.
 */

import { WrapText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "harnery:file-viewer:wrap";

/** Wrap preference: defaults to on, restored from localStorage after mount. */
export function useWrapPref(): [boolean, () => void] {
  const [wrap, setWrap] = useState(true);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "off") setWrap(false);
    } catch {
      // Private mode / blocked storage: keep the default.
    }
  }, []);

  const toggle = useCallback(() => {
    setWrap((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
      } catch {
        // Preference just won't survive the reload.
      }
      return next;
    });
  }, []);

  return [wrap, toggle];
}

/** Tailwind classes applied to the `<pre>` of a highlighted source block. */
export function wrapClass(wrap: boolean): string {
  return wrap ? "[&_pre]:whitespace-pre-wrap [&_pre]:break-words" : "[&_pre]:whitespace-pre";
}

export function WrapToggle({ wrap, onToggle }: { wrap: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={wrap}
      title={wrap ? "Turn off soft wrap" : "Turn on soft wrap"}
      className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition ${
        wrap
          ? "bg-muted/70 text-foreground"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      }`}
    >
      <WrapText className="size-3.5" />
      Wrap
    </button>
  );
}
