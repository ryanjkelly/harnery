"use client";

/**
 * Plain text / log renderer: a thin wrapper over VirtualTextView (Phase 5).
 * Virtualized line list + a `/`-triggered in-file search. The base fallback for
 * any text-family file without a richer renderer (and what csv falls back to
 * when papaparse finds zero rows).
 */

import type { FileText } from "@/lib/file-viewer/types";
import VirtualTextView from "./VirtualTextView";
import { useWrapPref, WrapToggle } from "./WrapToggle";

export default function TextRenderer({
  file,
  wrap: wrapProp,
}: {
  file: FileText;
  /** Controlled soft-wrap for renderer fallbacks. When omitted, plain text
   * owns the shared preference and displays the Wrap control. */
  wrap?: boolean;
}) {
  const [ownWrap, toggleOwnWrap] = useWrapPref();
  const controlled = wrapProp !== undefined;
  const wrap = controlled ? wrapProp : ownWrap;
  const body = <VirtualTextView content={file.content} wrap={wrap} />;

  if (controlled) return body;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b border-border bg-card px-3 py-1.5">
        <WrapToggle wrap={wrap} onToggle={toggleOwnWrap} />
      </div>
      {body}
    </div>
  );
}
