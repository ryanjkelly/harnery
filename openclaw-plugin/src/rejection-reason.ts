// Kept free of ledger imports: the gateway thread loads it too.

const MAX_REASON_LENGTH = 120;
const PATH_MARKER = "<path>";
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** Characters that can open a token; a path token starts after the last one. */
const TOKEN_BOUNDARY = /[\s'"`([{<=,]/;

/**
 * A short reason for a rejected message that never carries any part of a
 * filesystem path or event content.
 *
 * The error's `code` is used when it is a plain identifier. Otherwise the
 * first line of the message is kept only up to the first path-like token
 * (any token containing `/` or `\`), which becomes `<path>`; everything after
 * it is dropped, because a path may contain spaces and its end cannot be
 * known. The result is at most 120 characters.
 */
export function rejectionReason(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && SAFE_CODE.test(code)) return code;
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const line = (raw.split(/\r?\n/, 1)[0] ?? "").trim();
  const separator = line.search(/[\\/]/);
  if (separator < 0) {
    return line.length > 0 ? line.slice(0, MAX_REASON_LENGTH) : "unknown";
  }
  let start = separator;
  while (start > 0 && !TOKEN_BOUNDARY.test(line[start - 1] ?? "")) start -= 1;
  const prefix = line.slice(0, start).slice(0, MAX_REASON_LENGTH - PATH_MARKER.length);
  return `${prefix}${PATH_MARKER}`;
}
