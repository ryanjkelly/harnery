// Path scope for the tunnel gate: the URL path prefixes a tunnel publishes.
//
// A tunnel forwards to a whole local app, but the person starting it usually
// means to share one surface of that app. The gate therefore refuses every
// request whose path is outside the scope the operator named at `tunnel up`,
// and an empty scope refuses everything. `/` is the explicit way to publish
// the whole upstream.

/** Env var that carries the scope from `tunnel up` to the detached gate. */
export const ALLOW_PATHS_ENV = "HARNERY_TUNNEL_ALLOW_PATHS";

/**
 * Normalize one `--allow-path` value to a canonical prefix: a leading slash,
 * no trailing slash (except `/` itself), no query or fragment, and no dot,
 * empty, or percent-encoded segment. Throws on anything the gate could not
 * match unambiguously, so a typo fails at `tunnel up` instead of publishing
 * more or less than intended.
 */
export function normalizeAllowPath(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith("/")) {
    throw new Error(`allow-path must start with "/": ${JSON.stringify(raw)}`);
  }
  if (/[?#%\\]/.test(value)) {
    throw new Error(
      `allow-path must be a plain path prefix without ?, #, %, or \\: ${JSON.stringify(raw)}`,
    );
  }
  if (value === "/") return "/";
  const trimmed = value.replace(/\/+$/, "");
  const segments = trimmed.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(
      `allow-path must not contain empty, "." or ".." segments: ${JSON.stringify(raw)}`,
    );
  }
  return trimmed;
}

/** Normalize and de-duplicate a list of `--allow-path` values. */
export function normalizeAllowPaths(raw: readonly string[]): string[] {
  return [...new Set(raw.map(normalizeAllowPath))];
}

/** Parse the gate's env value (comma-separated, already normalized by `up`). */
export function parseAllowPathsEnv(value: string | undefined): string[] {
  return normalizeAllowPaths(
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Encoded slash, backslash, dot, or percent. A request path carrying one of
// these can be decoded differently by the gate and the upstream router (for
// example `/share%2F..%2Fprivate`), so the gate refuses it outright rather than
// guess which reading the upstream will use.
const AMBIGUOUS_PATH = /%(2f|5c|2e|25)|\\/i;

/**
 * True when `pathname` (a WHATWG-parsed URL pathname, so `.` and `..` segments
 * are already resolved) falls inside one of the allowed prefixes. A prefix
 * matches itself and anything below it on a segment boundary: `/share` allows
 * `/share` and `/share/x`, never `/shared`.
 */
export function isPathAllowed(pathname: string, allowPaths: readonly string[]): boolean {
  if (allowPaths.length === 0) return false;
  if (!pathname.startsWith("/") || AMBIGUOUS_PATH.test(pathname)) return false;
  return allowPaths.some(
    (prefix) => prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
