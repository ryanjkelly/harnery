/**
 * Cross-site request forgery guard for the dashboard's state-changing API.
 *
 * Every POST/PUT/PATCH/DELETE under `/api/*` passes through `checkWriteOrigin`
 * in `middleware.ts`. A browser marks where a request came from: Sec-Fetch-Site
 * says `same-origin` for the dashboard's own `fetch("/api/...")`, and Origin
 * names the page's scheme and host. A page on another site, another local
 * port, or the `*.localhost` files origin (which serves untrusted documents)
 * gets a different value and is refused.
 *
 * Through a tunnel the browser's Origin is the public name while Host may be
 * rewritten to `localhost`; the tunnel gate copies the original Host into
 * X-Forwarded-Host (overwriting any client value), and Next fills it from Host
 * when absent. A browser page cannot set X-Forwarded-Host on a cross-site
 * request without a CORS preflight the dashboard never grants, so Origin may
 * match either header.
 *
 * Requests that carry neither header (the CLI, curl, tests) are not browser
 * cross-site requests and pass. Locality is a separate, stricter check
 * (`checkLocalWrite` in permissions.ts) for writes that must come from this
 * computer only.
 *
 * Pure header logic: safe to import from the edge middleware bundle.
 */

/** A header reader: `Headers`, or Next's `ReadonlyHeaders`. */
export interface WriteHeaderSource {
  get(name: string): string | null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a method can change state and therefore needs the origin check. */
export function isStateChangingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

const REFUSED = "Not changed: the request did not come from the dashboard page.";

function hosts(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function checkWriteOrigin(
  h: WriteHeaderSource,
): { ok: true } | { ok: false; message: string } {
  const site = h.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return { ok: false, message: REFUSED };
  }
  const origin = h.get("origin");
  if (origin === null) return { ok: true };
  let originHost: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    originHost = url.host.toLowerCase();
  } catch {
    // Includes the literal `null` Origin of sandboxed frames and file pages.
    return { ok: false, message: REFUSED };
  }
  const allowed = [...hosts(h.get("host")), ...hosts(h.get("x-forwarded-host"))];
  return allowed.includes(originHost) ? { ok: true } : { ok: false, message: REFUSED };
}
