"use client";

/**
 * Clickable file path, a base-bundle leaf. Renders the same `font-mono` span the
 * dashboard already shows for paths, but as a button that opens the file in the
 * shared viewer overlay. Kept tiny (no overlay/renderer imports) so it
 * doesn't pull the heavy chunks into the base bundle.
 *
 * Phase 1 wires this onto STRUCTURED event-log tool targets only (Read/Edit/
 * Write file_path, Grep/Glob path: typed JSON fields, zero regex risk). Prose
 * linkify (ping bodies, scratchpad, Bash command_head) is Phase 4.
 */

import { useFileViewer } from "./FileViewerProvider";

export function FilePath({
  path,
  display,
  className,
  title,
}: {
  /** Repo-relative or absolute path the viewer's resolveFile will accept. */
  path: string;
  /** Shown text (e.g. a shortened path); defaults to `path`. */
  display?: string;
  className?: string;
  title?: string;
}) {
  const { open } = useFileViewer();
  if (!path) return <span className={className}>{display ?? path}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        open(path);
      }}
      title={title ?? `Open ${path}`}
      className={`cursor-pointer rounded-sm text-left underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${className ?? ""}`}
    >
      {display ?? path}
    </button>
  );
}
