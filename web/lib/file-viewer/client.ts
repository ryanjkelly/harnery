/**
 * Tiny fetch client for the file-viewer API. Lives in the first lazy chunk
 * (only the overlay imports it), not the base bundle. Returns a discriminated
 * result so renderers branch on `ok` instead of throwing across the network
 * boundary.
 */

import type { DirListing, DirUsage, FileError, FileMeta, FileText, SearchResult } from "./types";

export interface FetchOk<T> {
  ok: true;
  data: T;
}
export interface FetchErr {
  ok: false;
  status: number;
  /** Resolver reject code (`denied` / `not_found` / `ambiguous_path` / …) or a
   * transport sentinel (`transport` / `bad_json`). */
  code: string;
  detail: string | null;
}
export type FetchResult<T> = FetchOk<T> | FetchErr;

function qs(path: string): string {
  return `path=${encodeURIComponent(path)}`;
}

async function getJson<T>(url: string): Promise<FetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    return { ok: false, status: 0, code: "transport", detail: (err as Error).message };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) return { ok: false, status: res.status, code: "transport", detail: null };
    return { ok: false, status: res.status, code: "bad_json", detail: "response was not JSON" };
  }
  if (!res.ok) {
    const e = body as FileError;
    return {
      ok: false,
      status: res.status,
      code: typeof e?.error === "string" ? e.error : "transport",
      detail: typeof e?.detail === "string" ? e.detail : null,
    };
  }
  return { ok: true, data: body as T };
}

export function fetchMeta(path: string): Promise<FetchResult<FileMeta>> {
  return getJson<FileMeta>(`/api/file/meta?${qs(path)}`);
}

export function fetchText(path: string): Promise<FetchResult<FileText>> {
  return getJson<FileText>(`/api/file/text?${qs(path)}`);
}

/** List one directory's immediate children (repo-relative; "" = repo root). */
export function fetchList(dir: string): Promise<FetchResult<DirListing>> {
  return getJson<DirListing>(`/api/file/list?dir=${encodeURIComponent(dir)}`);
}

/** Recursive disk usage + file/folder counts for a directory (+ per-immediate-
 * child breakdown). */
export function fetchUsage(dir: string): Promise<FetchResult<DirUsage>> {
  return getJson<DirUsage>(`/api/file/usage?dir=${encodeURIComponent(dir)}`);
}

/** Fuzzy file-name search across the repo (cached, deny-aware index). */
export function fetchSearch(query: string, limit?: number): Promise<FetchResult<SearchResult>> {
  const lim = limit ? `&limit=${limit}` : "";
  return getJson<SearchResult>(`/api/file/search?q=${encodeURIComponent(query)}${lim}`);
}

/** Raw-bytes URL for a path, used by <img>/<audio>/<video>/<iframe> src and
 * the open-in-new-tab / download header actions. */
export function rawUrl(path: string, opts: { download?: string } = {}): string {
  let url = `/api/file?${qs(path)}`;
  if (opts.download !== undefined) url += `&download=${encodeURIComponent(opts.download)}`;
  return url;
}

const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/** Resolve a Markdown image destination beside its source document, then
 * route the resulting repository path through the sandboxed raw-file API.
 *
 * Browsers resolve a relative `src` against `/files?path=...`, which loses the
 * source document's directory and turns `images/frame.png` into the unrelated
 * dashboard URL `/images/frame.png`. Keep remote/data/blob/protocol-relative
 * destinations unchanged; react-markdown's normal URL sanitizer remains the
 * protocol authority. Local traversal may move upward inside the repository,
 * but never above its root. */
export function markdownImageUrl(documentPath: string, source: string): string {
  const value = source.trim();
  if (
    value === "" ||
    value.startsWith("#") ||
    value.startsWith("?") ||
    value.startsWith("//") ||
    URL_SCHEME.test(value) ||
    value.includes("\\")
  ) {
    return source;
  }

  const hashAt = value.indexOf("#");
  const beforeHash = hashAt === -1 ? value : value.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : value.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const encodedPath = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const sourceQuery = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);

  let localPath: string;
  try {
    localPath = decodeURIComponent(encodedPath);
  } catch {
    return source;
  }
  if (localPath === "" || localPath.includes("\0")) return source;

  const resolved = localPath.startsWith("/")
    ? []
    : documentPath.split("/").slice(0, -1).filter(Boolean);
  for (const segment of localPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return source;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  if (resolved.length === 0) return source;

  const queryCarrier = sourceQuery === "" ? "" : `&sourceQuery=${encodeURIComponent(sourceQuery)}`;
  return `${rawUrl(resolved.join("/"))}${queryCarrier}${fragment}`;
}

/** Browser-rendered HTML on the current dashboard origin. The path-shaped URL
 * preserves the document directory so relative images, styles, fonts, and
 * media resolve through the same sandboxed render tree. */
/**
 * Open on the isolated files origin (`harnery-files.localhost`) so HTML/JS run
 * in a real browser document without sharing the dashboard cookie jar.
 * Same allowlisted tree; relative asset URLs resolve on that host.
 */
export {
  filesOriginUrl as renderUrl,
  sandboxedRenderPath as sandboxedRenderUrl,
} from "../files-origin";

/** Dashboard chrome viewer (`/files/view`) with Source | Preview. Prefer
 * `renderUrl` for a real browser tab of just the HTML page. */
export function viewUrl(path: string, opts: { mode?: "source" | "preview" } = {}): string {
  let url = `/files/view?${qs(path)}`;
  if (opts.mode) url += `&mode=${opts.mode}`;
  return url;
}

/** True when a path should offer the HTML render open-in-tab (.html / .htm). */
export function isHtmlPreviewPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}
