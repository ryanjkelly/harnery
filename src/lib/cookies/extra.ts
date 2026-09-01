import type { Cookie, CookieJar } from "./client.ts";

/**
 * Host callback that can mint or refresh cookies for one request URL.
 * Must stay synchronous: `fetch` and `browse` attach cookies before they
 * leave this process, the same constraint as `extraHeaders`.
 *
 * Return cookies to add; do not mutate the jar. The caller persists them
 * with `jar.set()` so `--no-cookies` (no jar) skips the callback entirely.
 */
export type ExtraCookies = (url: string, jar: CookieJar) => Cookie[];

/**
 * Run a host `extraCookies` callback and persist whatever it returns.
 * No-op when the callback is omitted. Order matters: this must run
 * before `jar.header()` or Playwright `addCookies`, because an already
 * populated `Cookie` header cannot pick up extra cookies later.
 */
export function applyExtraCookies(
  url: string,
  jar: CookieJar,
  extraCookies?: ExtraCookies,
): Cookie[] {
  if (!extraCookies) return [];
  const cookies = extraCookies(url, jar);
  for (const cookie of cookies) jar.set(cookie);
  return cookies;
}
