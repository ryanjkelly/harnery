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
  /** Byte size for files (absent for directories — see DirUsage for those). */
  size?: number;
}

/** The /api/file/list JSON shape (lib/file-tree.ts). */
export interface DirListing {
  /** Canonical repo-relative path of the listed directory ("" = repo root). */
  dir: string;
  entries: DirEntry[];
}

/** Recursive byte + count totals for a directory subtree. */
export interface DirUsageStats {
  /** Total files under the directory (recursive, excluding hidden/denied). */
  fileCount: number;
  /** Total subdirectories under the directory (recursive). */
  dirCount: number;
  /** Total bytes of all included files (recursive). */
  totalBytes: number;
  /** Set when a safety cap was hit walking this subtree — totals are a floor,
   * not exact (absent/false otherwise). */
  partial?: boolean;
}

/** The /api/file/usage JSON shape (lib/file-tree.ts). `children` maps each
 * immediate child DIRECTORY name to its own recursive totals, so a tree level
 * can size every row's bar from one call. `partial` = a safety cap was hit and
 * the totals are a floor, not exact. */
export interface DirUsage {
  /** Canonical repo-relative path of the directory ("" = repo root). */
  dir: string;
  self: DirUsageStats;
  children: Record<string, DirUsageStats>;
  partial: boolean;
}

/** One fuzzy file-search hit from /api/file/search. */
export interface SearchMatch {
  relPath: string;
}

/** The /api/file/search JSON shape (lib/file-tree.ts). */
export interface SearchResult {
  query: string;
  matches: SearchMatch[];
  /** Total matches before the `limit` slice. */
  total: number;
  /** True if the index or the match set was capped. */
  truncated: boolean;
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
