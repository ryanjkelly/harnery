/**
 * Warm-before-switch handover for a supervised `next start`.
 *
 * A supervisor that rebuilds the dashboard used to stop the serving process,
 * start the new bundle on the public port, and then warm it. Every open tab
 * lost its pooled sockets at the stop, and the port then answered slowly for
 * about a minute while routes loaded on first use.
 *
 * With this preload the supervisor starts the new process on an ephemeral port
 * (the ordinary `-p`), warms it there, and then asks it to take the public port
 * over. The request is a file: when `HARNERY_WEB_HANDOVER_FILE` appears, this
 * module opens a plain TCP listener on `HARNERY_WEB_PUBLIC_PORT` and hands
 * every accepted socket to the HTTP server Next created, so keep-alive,
 * upgrades and timeouts behave exactly as on the original listener. The bind
 * retries while the old process still holds the port, so the supervisor can
 * write the file first and drain the old listener second; the gap is one retry
 * interval. A file rather than a signal because `bun run` sits between the
 * supervisor and Node and does not forward SIGUSR2.
 *
 * HARNERY_WEB_DRAIN_FILE requests retirement of the current listener without
 * closing its accepted sockets. Their next response advertises Connection:
 * close. The supervisor keeps this process and its bundle until all sockets
 * close or its bounded drain deadline expires. Unsupervised starts are inert.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import { createServer, Server as NetServer } from "node:net";

const PUBLIC_PORT = Number(process.env.HARNERY_WEB_PUBLIC_PORT ?? 0);
const HANDOVER_FILE = process.env.HARNERY_WEB_HANDOVER_FILE ?? "";
const DRAIN_FILE = process.env.HARNERY_WEB_DRAIN_FILE ?? "";
const POLL_MS = 100;
const BIND_RETRY_MS = 50;
const BIND_LIMIT_MS = Number(process.env.HARNERY_WEB_HANDOVER_TIMEOUT_MS ?? 15_000);

if ((PUBLIC_PORT > 0 && HANDOVER_FILE) || DRAIN_FILE) {
  /** The HTTP server Next listens with; the front door feeds it sockets. */
  let target;
  let door;
  let draining = false;
  const sockets = new Set();
  const acknowledgeDrain = () => {
    if (draining && sockets.size === 0) writeFileSync(`${DRAIN_FILE}.drained`, String(process.pid));
  };
  const originalListen = Server.prototype.listen;
  Server.prototype.listen = function listen(...args) {
    if (!target) {
      target = this;
      this.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => { sockets.delete(socket); acknowledgeDrain(); });
      });
      this.prependListener("request", (_request, response) => {
        if (draining) response.setHeader("Connection", "close");
      });
    }
    return originalListen.apply(this, args);
  };

  let opened = false;
  const openFrontDoor = () => {
    if (opened || !target) return false;
    opened = true;
    const started = Date.now();
    door = createServer((socket) => target.emit("connection", socket));
    door.on("error", (error) => {
      if (error.code === "EADDRINUSE" && Date.now() - started < BIND_LIMIT_MS) {
        setTimeout(() => door.listen(PUBLIC_PORT), BIND_RETRY_MS).unref();
        return;
      }
      console.error(`[handover] could not take port ${PUBLIC_PORT}: ${error.message}`);
      door.close();
    });
    door.on("listening", () => {
      writeFileSync(`${HANDOVER_FILE}.ready`, String(process.pid));
      console.log(`[handover] serving public port ${PUBLIC_PORT}`);
    });
    door.listen(PUBLIC_PORT);
    return true;
  };

  const poll = setInterval(() => {
    if (DRAIN_FILE && existsSync(DRAIN_FILE) && target) {
      draining = true;
      // http.Server.close() also closes idle keep-alive sockets. Close only
      // the TCP listeners so pooled requests can still finish on this process.
      if (door?.listening) door.close();
      if (target.listening) NetServer.prototype.close.call(target);
      clearInterval(poll);
      unlinkSync(DRAIN_FILE);
      acknowledgeDrain();
      return;
    }
    if (!HANDOVER_FILE || !existsSync(HANDOVER_FILE)) return;
    if (!openFrontDoor()) return;
    if (!DRAIN_FILE) clearInterval(poll);
    try {
      unlinkSync(HANDOVER_FILE);
    } catch {
      // The supervisor may remove it too; either is fine.
    }
  }, POLL_MS);
  poll.unref();
}
