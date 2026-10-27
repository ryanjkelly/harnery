/**
 * The one preload `next dev` may receive.
 *
 * `next dev` runs its HTTP server in a forked child and rebuilds that child's
 * Node options by parsing the parent's `--import` flags into a single value.
 * Two `--import` flags (or one in the arguments plus one in NODE_OPTIONS)
 * collapse into one space-joined module path, and the child exits with
 * ERR_MODULE_NOT_FOUND before the dashboard starts. Importing both hooks from
 * this file keeps the dev command to exactly one preload. ES module caching
 * loads each hook once even when `next start` also names them directly.
 */
import "./server-keepalive.mjs";
import "./server-performance.mjs";

// Next reads PORT itself. Shell parameter expansion in package scripts is
// interpreted literally by cmd.exe on native Windows.
process.env.PORT ??= process.env.HARNERY_WEB_PORT ?? "4276";
