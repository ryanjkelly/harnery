export {
  type Cookie,
  CookieJar,
  type CookieJarOptions,
  type CookieStore,
  CookieStoreParseError,
  cookieSendsToHost,
  domainMatches,
  type InfoResult,
  isExpired,
  isLoopbackHost,
  matchingCookies,
  mergeCookies,
  type OriginEntry,
  pathMatches,
  violatesCookiePrefix,
} from "./client.js";
export { applyExtraCookies, type ExtraCookies } from "./extra.js";
