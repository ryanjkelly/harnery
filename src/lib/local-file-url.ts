/** Mnemonic dashboard port: 4276 spells HARN on a phone keypad. */
export const DEFAULT_WEB_PORT = 4276;

/** Cookie-isolated host for navigable repo files. */
export const FILES_ORIGIN_HOST = "harnery-files.localhost";

/**
 * Percent-encode one URL component so the finished URL is safe as a bare
 * Markdown destination.
 *
 * encodeURIComponent leaves parentheses raw, and a raw ")" ends a `[text](url)`
 * destination early. The alternative is the angle-bracket destination form,
 * which is valid CommonMark but is not implemented by every renderer, and one
 * that skips it can style the text as a link while dropping the href, leaving
 * something that looks clickable and does nothing. These URLs are written into
 * Markdown for humans to click, so encode the parentheses instead.
 */
export function encodeLinkSafeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[()]/g, (char) => (char === "(" ? "%28" : "%29"));
}

/** Encode each repo-path segment while preserving slash-based URL resolution. */
export function encodedRepoPath(relPath: string): string {
  return relPath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeLinkSafeComponent(segment))
    .join("/");
}

export function localFilesOriginUrl(
  relPath: string,
  port: number | string = DEFAULT_WEB_PORT,
  protocol = "http:",
): string {
  const portPart = String(port) === "" ? "" : `:${port}`;
  return `${protocol}//${FILES_ORIGIN_HOST}${portPart}/${encodedRepoPath(relPath)}`;
}

export function localFileViewerUrl(
  relPath: string,
  port: number | string = DEFAULT_WEB_PORT,
): string {
  return `http://localhost:${port}/files?path=${encodeLinkSafeComponent(relPath)}`;
}
