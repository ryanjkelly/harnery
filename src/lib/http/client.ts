import type { Cookie, CookieJar } from "../cookies/index.ts";

/**
 * Simple cookie-aware HTTP client.
 *
 * Wraps the global `fetch` (Bun's native one) with two extras:
 *   - Attaches a `Cookie:` header from a CookieJar before the request.
 *   - Persists `Set-Cookie` responses back into the same jar.
 *
 * Used by the `fetch` command and other tooling that wants to share session
 * state with `browse`.
 */

export type FetchResponseType = "text" | "bytes";

export interface FetchOptions<TResponseType extends FetchResponseType = "text"> {
  /** HTTP method. Default GET. */
  method?: string;
  /** Request body. Strings/Buffers/Streams pass through to fetch directly. */
  body?: BodyInit | null;
  /** Extra headers (merged with auto-added Cookie). */
  headers?: Record<string, string>;
  /**
   * Optional CookieJar. When provided:
   *   - Matching cookies become a Cookie header.
   *   - Set-Cookie response headers are parsed and merged into the jar.
   * Pass `null` (or omit) to disable.
   */
  jar?: CookieJar | null;
  /** Optional override for redirect handling. Default `'follow'`. */
  redirect?: RequestRedirect;
  /** AbortSignal for timeout/cancel control. */
  signal?: AbortSignal;
  /**
   * Optional callback that returns extra headers to attach based on the
   * target URL. Consumers can inject extra HTTP headers per-URL via this
   * callback (e.g., a Cloudflare-bypass header for specific zones).
   * Caller-provided explicit headers always win; auto-attached values
   * only land when the key isn't already set.
   */
  extraHeaders?: (url: string) => Record<string, string>;
  /** Response body representation. Default `text`; use `bytes` for lossless file output. */
  responseType?: TResponseType;
}

type FetchBody<TResponseType extends FetchResponseType> = TResponseType extends "bytes"
  ? Uint8Array
  : string;

export interface FetchResult<TBody = string> {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: TBody;
  /** Number of cookies persisted back into the jar (0 if no jar passed). */
  cookiesSaved: number;
}

/**
 * Fetch a URL with optional cookie-jar attach + persist.
 *
 * Returns the response body as text by default (callers handle JSON parsing).
 * Pass `responseType: "bytes"` when the caller must preserve the body exactly.
 * Streams aren't supported; this is a CLI helper, not a streaming HTTP
 * client. Use Bun's `fetch` directly for streaming workloads.
 */
export async function fetchWithJar<TResponseType extends FetchResponseType = "text">(
  url: string,
  opts: FetchOptions<TResponseType> = {},
): Promise<FetchResult<FetchBody<TResponseType>>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };

  if (opts.jar) {
    const cookieHeader = opts.jar.header(url);
    if (cookieHeader && !headers.Cookie && !headers.cookie) {
      headers.Cookie = cookieHeader;
    }
  }

  // Caller-provided extraHeaders callback (e.g., for Cloudflare-bypass or
  // custom auth headers). Caller-supplied explicit headers always win.
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders(url))) {
      if (!(k in headers) && !(k.toLowerCase() in headers)) headers[k] = v;
    }
  }

  // Byte mode is a download boundary, so keep the HTTP representation bytes
  // aligned with the response headers. Bun otherwise decompresses the body
  // while retaining Content-Encoding and the encoded Content-Length.
  if (opts.responseType === "bytes" && !headers["Accept-Encoding"] && !headers["accept-encoding"]) {
    headers["Accept-Encoding"] = "identity";
  }
  const fetchInit: RequestInit & { decompress?: boolean } = {
    method: opts.method ?? "GET",
    body: opts.body,
    headers,
    redirect: opts.redirect ?? "follow",
    signal: opts.signal,
  };
  if (opts.responseType === "bytes") fetchInit.decompress = false;

  const response = await fetch(url, fetchInit);

  if (
    opts.responseType === "bytes" &&
    typeof Bun === "undefined" &&
    response.headers.has("content-encoding")
  ) {
    throw new Error(
      "cannot preserve a content-encoded response under the Node fallback; install Bun or request identity encoding",
    );
  }

  let cookiesSaved = 0;
  if (opts.jar) {
    const setCookieHeaders = collectSetCookie(response.headers);
    if (setCookieHeaders.length > 0) {
      const parsedHost = new URL(response.url).hostname;
      const cookies: Cookie[] = setCookieHeaders
        .map((sc) => parseSetCookie(sc, parsedHost))
        .filter((c): c is Cookie => c !== null);
      for (const cookie of cookies) {
        opts.jar.set(cookie);
      }
      cookiesSaved = cookies.length;
    }
  }

  const headerObj: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headerObj[key] = value;
  });

  const body =
    opts.responseType === "bytes"
      ? new Uint8Array(await response.arrayBuffer())
      : await response.text();

  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: headerObj,
    body: body as FetchBody<TResponseType>,
    cookiesSaved,
  };
}

// ---------------------------------------------------------------------------
// Set-Cookie parsing
// ---------------------------------------------------------------------------
//
// `fetch` joins multiple Set-Cookie headers with `, ` per the spec, but that
// collides with the comma-separated date format in `Expires=`. We use the
// dual-mode approach: prefer the `getSetCookie()` method when available
// (Node 20+, Bun 1.0+) and fall back to manual splitting otherwise.

function collectSetCookie(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? splitSetCookieHeader(raw) : [];
}

function splitSetCookieHeader(raw: string): string[] {
  // Splits on ", " that precedes a new cookie (heuristic: a token followed
  // by `=`), avoiding date-internal commas like `Expires=Wed, 21 Oct …`.
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "," && depth === 0) {
      const ahead = raw.slice(i + 1).trimStart();
      if (/^[A-Za-z0-9_!#$%&'*+\-.^`|~]+=/.test(ahead)) {
        parts.push(buf.trim());
        buf = "";
        continue;
      }
    }
    if (ch === "=") depth++;
    if (ch === ";") depth = 0;
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function parseSetCookie(raw: string, defaultDomain: string): Cookie | null {
  const parts = raw.split(";").map((p) => p.trim());
  if (parts.length === 0) return null;

  const first = parts[0];
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const cookie: Cookie = {
    name,
    value,
    domain: defaultDomain,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    session: true,
    size: name.length + value.length,
  };

  for (const attr of parts.slice(1)) {
    const lower = attr.toLowerCase();
    if (lower.startsWith("domain=")) {
      const d = attr.slice(7).trim();
      cookie.domain = d.startsWith(".") ? d : `.${d}`;
    } else if (lower.startsWith("path=")) {
      cookie.path = attr.slice(5).trim() || "/";
    } else if (lower.startsWith("expires=")) {
      const ts = Date.parse(attr.slice(8).trim());
      if (!Number.isNaN(ts)) {
        cookie.expires = Math.floor(ts / 1000);
        cookie.session = false;
      }
    } else if (lower.startsWith("max-age=")) {
      const seconds = Number.parseInt(attr.slice(8).trim(), 10);
      if (!Number.isNaN(seconds)) {
        cookie.expires = Math.floor(Date.now() / 1000) + seconds;
        cookie.session = false;
      }
    } else if (lower === "secure") {
      cookie.secure = true;
    } else if (lower === "httponly") {
      cookie.httpOnly = true;
    } else if (lower.startsWith("samesite=")) {
      const v = attr.slice(9).trim();
      cookie.sameSite = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
    }
  }

  return cookie;
}
