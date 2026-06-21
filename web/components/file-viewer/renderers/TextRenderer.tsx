"use client";

/**
 * Plain text / log renderer: a thin wrapper over VirtualTextView (Phase 5).
 * Virtualized line list + a `/`-triggered in-file search. The base fallback for
 * any text-family file without a richer renderer (and what csv falls back to
 * when papaparse finds zero rows).
 */

import type { FileText } from "@/lib/file-viewer/types";
import VirtualTextView from "./VirtualTextView";

export default function TextRenderer({ file }: { file: FileText }) {
  return <VirtualTextView content={file.content} />;
}
