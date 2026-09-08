/**
 * Raises the HTTP keep-alive window above the browser's socket-reuse window.
 *
 * Node closes an idle keep-alive socket after 5 seconds and advertises
 * `Keep-Alive: timeout=5`. Chrome keeps its own idle sockets far longer and
 * reuses them, so on any page with more same-host assets than the 6-connection
 * limit it will write a request into a socket this server has already dropped.
 * The request never reaches Node — nothing appears in the request log — and
 * Chrome reports `net::ERR_CONNECTION_RESET` about 30 seconds later. On the
 * character-pack review pages that meant 3 or 4 of 10 images failed per reload,
 * with a different subset each time.
 *
 * Preloaded via `--import` so it covers both `next dev` and `next start`
 * without replacing Next's server. The hook is on `Server.prototype.listen`
 * rather than `http.createServer`, because patching the latter is invisible to
 * a caller that uses the named ESM export (`import { createServer }`).
 * `headersTimeout` must stay above `keepAliveTimeout` or Node warns and clamps.
 */

import { Server } from "node:http";

const KEEP_ALIVE_MS = Number(process.env.HARNERY_WEB_KEEPALIVE_MS ?? 72_000);
const HEADERS_MS = KEEP_ALIVE_MS + 3_000;

const originalListen = Server.prototype.listen;

Server.prototype.listen = function listen(...args) {
  this.keepAliveTimeout = KEEP_ALIVE_MS;
  this.headersTimeout = HEADERS_MS;
  return originalListen.apply(this, args);
};
