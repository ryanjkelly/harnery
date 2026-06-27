/**
 * Shared client types for the universal file viewer. Mirror the JSON the
 * /api/file/meta + /api/file/text routes return (lib/file-routes.ts). Kept in
 * the base bundle; they're tiny and the provider + FilePath reference them.
 */

/** Categories the renderer registry dispatches on. Mirror lib/files.ts FileCategory. */
export type FileCategory =
  | "markdown"
  | "code"
  | "json"
  | "yaml"
  | "html"
  | "csv"
  | "image"
  | "svg"
  | "pdf"
  | "audio"
  | "video"
  | "archive"
  | "text"
  | "binary";

/** The /api/file/meta JSON shape. */
export interface FileMeta {
  relPath: string;
  size: number;
  mtime: string;
  mime: string;
  category: FileCategory;
  inlineable: boolean;
  lineCount?: number;
  truncated?: boolean;
}

/** The /api/file/text JSON shape. */
export interface FileText {
  relPath: string;
  size: number;
  mtime: string;
  mime: string;
  category: FileCategory;
  content: string;
  lines: number;
  truncated: boolean;
}

/** The error envelope every route returns on a non-2xx (lib/file-routes.ts). */
export interface FileError {
  error: string;
  detail: string | null;
}

/** One entry in a directory listing from /api/file/list. */
export interface DirEntry {
  /** Bare entry name (last path segment). */
  name: string;
  /** Canonical repo-relative path, openable via the viewer / `?file=`. */
  relPath: string;
  kind: "dir" | "file";
}

/** The /api/file/list JSON shape (lib/file-tree.ts). */
export interface DirListing {
  /** Canonical repo-relative path of the listed directory ("" = repo root). */
  dir: string;
  entries: DirEntry[];
}

/** Options for `useFileViewer().open()`. A `sequence` of repo-relative paths
 * enables ←/→ navigation (e.g. /images keeps prev/next); `index` is the
 * starting position within it. */
export interface OpenOptions {
  sequence?: string[];
  index?: number;
}

/** Viewer overlay state while open. null = closed. */
export interface FileViewerState {
  path: string;
  sequence: string[];
  index: number;
}
