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
  const doors = new Set();
  let draining = false;
  let bindingFailed = false;
  const sockets = new Set();
  const acknowledgeDrain = () => {
    if (draining && sockets.size === 0) writeFileSync(`${DRAIN_FILE}.drained`, String(process.pid));
  };
  const originalListen = Server.prototype.listen;
  // A single IPv6 dual-stack socket accepts IPv4 locally, but some host port
  // forwarders expose only the socket's declared family. Bind both explicitly.
  const listenDoor = (options, onReady, onFailure) => {
    const started = Date.now();
    const door = createServer((socket) => target.emit("connection", socket));
    doors.add(door);
    const bind = () => { if (!draining && !bindingFailed) door.listen(options); };
    door.on("error", (error) => {
      if (draining || bindingFailed) return;
      if (error.code === "EADDRINUSE" && Date.now() - started < BIND_LIMIT_MS) {
        setTimeout(bind, BIND_RETRY_MS).unref();
        return;
      }
      // IPv4-only hosts still work; an occupied IPv6 port is not optional.
      if (options.ipv6Only && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) {
        doors.delete(door);
        onReady();
        return;
      }
      bindingFailed = true;
      onFailure(error);
    });
    door.once("listening", () => {
      if (draining || bindingFailed) door.close();
      else onReady();
    });
    bind();
  };
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
      const options = typeof args[0] === "object" && args[0] !== null ? args[0] : null;
      const port = options ? options.port : args[0];
      const host = options ? options.host : typeof args[1] === "string" ? args[1] : undefined;
      if (host === undefined && (typeof port === "number" || /^\d+$/.test(port))) {
        // Preserve explicit host and Unix-socket binds. Only split the default
        // wildcard TCP bind used by a supervised Next start.
        if (options) args[0] = { ...options, host: "0.0.0.0" };
        else if (typeof args[1] === "function") args.splice(1, 0, "0.0.0.0");
        else args[1] = "0.0.0.0";
        this.once("listening", () => {
          listenDoor(
            { port: this.address().port, host: "::", ipv6Only: true },
            () => {},
            (error) => this.emit("error", error),
          );
        });
      }
    }
    return originalListen.apply(this, args);
  };

  let opened = false;
  const openFrontDoor = () => {
    if (opened || !target) return false;
    opened = true;
    let pending = 2;
    let failed = false;
    const onFailure = (error) => {
      failed = true;
      console.error(`[handover] could not take port ${PUBLIC_PORT}: ${error.message}`);
      for (const door of doors) if (door.listening) door.close();
    };
    const onReady = () => {
      if (--pending !== 0 || failed || draining) return;
      writeFileSync(`${HANDOVER_FILE}.ready`, String(process.pid));
      console.log(`[handover] serving public port ${PUBLIC_PORT}`);
    };
    listenDoor({ port: PUBLIC_PORT, host: "0.0.0.0" }, onReady, onFailure);
    listenDoor({ port: PUBLIC_PORT, host: "::", ipv6Only: true }, onReady, onFailure);
    return true;
  };

  const poll = setInterval(() => {
    if (DRAIN_FILE && existsSync(DRAIN_FILE) && target) {
      draining = true;
      // http.Server.close() also closes idle keep-alive sockets. Close only
      // the TCP listeners so pooled requests can still finish on this process.
      for (const door of doors) if (door.listening) door.close();
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
