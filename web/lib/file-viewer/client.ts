/**
 * Tiny fetch client for the file-viewer API. Lives in the first lazy chunk
 * (only the overlay imports it), not the base bundle. Returns a discriminated
 * result so renderers branch on `ok` instead of throwing across the network
 * boundary.
 */

import type { FileError, FileMeta, FileText } from "./types";

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

/** Raw-bytes URL for a path, used by <img>/<audio>/<video>/<iframe> src and
 * the open-in-new-tab / download header actions. */
export function rawUrl(path: string, opts: { download?: string } = {}): string {
  let url = `/api/file?${qs(path)}`;
  if (opts.download !== undefined) url += `&download=${encodeURIComponent(opts.download)}`;
  return url;
}
