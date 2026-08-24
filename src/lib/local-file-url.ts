/** Mnemonic dashboard port: 4276 spells HARN on a phone keypad. */
export const DEFAULT_WEB_PORT = 4276;

/** Cookie-isolated host for navigable repo files. */
export const FILES_ORIGIN_HOST = "harnery-files.localhost";

/** Encode each repo-path segment while preserving slash-based URL resolution. */
export function encodedRepoPath(relPath: string): string {
  return relPath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
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
  return `http://localhost:${port}/files?path=${encodeURIComponent(relPath)}`;
}
