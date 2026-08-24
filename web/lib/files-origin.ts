/**
 * Isolated files origin: `http://harnery-files.localhost:<port>/…`.
 *
 * Same allowlisted tree as `/api/file`, but a different host so HTML/JS can run
 * without becoming same-origin to the dashboard (`localhost`). Cookies are
 * host-scoped — `harnery-files.localhost` does not share the `localhost` jar.
 * `*.localhost` resolves to loopback (RFC 6761); no hosts-file edit.
 */

import {
  DEFAULT_WEB_PORT,
  encodedRepoPath,
  FILES_ORIGIN_HOST,
  localFilesOriginUrl,
} from "../../src/lib/local-file-url";

export { FILES_ORIGIN_HOST } from "../../src/lib/local-file-url";

/** Middleware → `/api/file` path carrier (rewritten search params are unreliable). */
export const FILES_ORIGIN_HEADER = "x-harnery-files-path";

/** True when the request Host is the files origin (port ignored). */
export function isFilesOriginHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0]?.toLowerCase() ?? "";
  return host === FILES_ORIGIN_HOST;
}

/** Current-origin path for an inert full-tab HTML document and its relative
 * assets. The path shape is load-bearing: browser URL resolution keeps every
 * relative request beside the source document. */
export function sandboxedRenderPath(relPath: string): string {
  return `/files/render/${encodedRepoPath(relPath)}`;
}

/**
 * Absolute URL for a repo-relative path on the files origin. Path segments are
 * encoded so relative asset URLs inside HTML resolve on the same host.
 */
export function filesOriginUrl(relPath: string): string {
  if (typeof window !== "undefined") {
    const port = window.location.port;
    return localFilesOriginUrl(relPath, port, window.location.protocol);
  }
  const port = process.env.HARNERY_WEB_PORT || DEFAULT_WEB_PORT;
  return localFilesOriginUrl(relPath, port);
}
