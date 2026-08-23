/**
 * Isolated files origin: `http://harnery-files.localhost:<port>/…`.
 *
 * Same allowlisted tree as `/api/file`, but a different host so HTML/JS can run
 * without becoming same-origin to the dashboard (`localhost`). Cookies are
 * host-scoped — `harnery-files.localhost` does not share the `localhost` jar.
 * `*.localhost` resolves to loopback (RFC 6761); no hosts-file edit.
 */

export const FILES_ORIGIN_HOST = "harnery-files.localhost";

/** Middleware → `/api/file` path carrier (rewritten search params are unreliable). */
export const FILES_ORIGIN_HEADER = "x-harnery-files-path";

/** True when the request Host is the files origin (port ignored). */
export function isFilesOriginHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0]?.toLowerCase() ?? "";
  return host === FILES_ORIGIN_HOST;
}

function encodedRepoPath(relPath: string): string {
  return relPath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
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
  const encoded = encodedRepoPath(relPath);
  if (typeof window !== "undefined") {
    const port = window.location.port;
    const portPart = port ? `:${port}` : "";
    return `${window.location.protocol}//${FILES_ORIGIN_HOST}${portPart}/${encoded}`;
  }
  const port = process.env.HARNERY_WEB_PORT || "9000";
  return `http://${FILES_ORIGIN_HOST}:${port}/${encoded}`;
}
