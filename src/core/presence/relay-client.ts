/**
 * Relay client transport for cross-machine presence (ADR 0016, phase 2c).
 *
 * The hooks are short-lived processes, so a live WebSocket needs a home: a
 * small per-repo-per-machine DAEMON that the hooks lazy-start
 * (`ensureRelayDaemon`) and that exits itself when the machine goes idle.
 * The daemon:
 *
 *   - derives the room credentials from the repo identity (root-commit SHA +
 *     origin URL + optional committed `.harnery/presence-salt`)
 *   - holds the socket open with auto-reconnect + jittered backoff
 *   - watches the active V3 ledger and publishes the encrypted presence blob on
 *     change (debounced), plus a 60s keepalive so peers' staleness math works
 *   - decrypts received peer frames and writes them to
 *     `.harnery/presence/remote/<machine>.json`, where `readRemoteMachines`
 *     merges them with the git-refs floor (freshest source per machine wins)
 *   - exits after ~5 minutes with no live local sessions (hooks restart it
 *     when sessions return), and exits if its pid file is superseded
 *
 * Everything fails silent; the git-refs transport is always the floor.
 * Requires a global WebSocket (Bun, Node >= 21, Workers) — on older Nodes the
 * daemon refuses to start and presence stays on git-refs.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { coordEnv } from "../../lib/env.ts";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { harnCliEntry } from "../cli-entry.ts";
import { presenceRelayUrl } from "../config.ts";
import { eventV3ActiveWatchPath } from "../events/v3/reader.ts";
import { closeProcessLoggers, legacyLogFields, processLogger } from "../storage/logger.ts";
import { RotatingTextSink } from "../storage/process-log.ts";
import { buildPresenceBlob, type PresenceBlob } from "./blob.ts";
import { originUrl, rootCommitSha, sanitizeRefComponent } from "./git.ts";
import {
  computeSenderId,
  decryptPayload,
  deriveRoomCredentials,
  encryptPayload,
  parseRelayFrame,
} from "./relay-protocol.ts";
import { initialReconnectState, planReconnect, type ReconnectState } from "./relay-reconnect.ts";

const KEEPALIVE_MS = 60_000;
const WATCH_DEBOUNCE_MS = 500;
const IDLE_EXIT_MS = 5 * 60_000;

function presenceDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "presence");
}

function remoteCacheDir(coordRoot: string): string {
  return join(presenceDir(coordRoot), "remote");
}

function pidFilePath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "relay-daemon.json");
}

export function relayLegacyLogPath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "relay-daemon.log");
}

export interface RelayPidRecord {
  pid: number;
  url: string;
  started_at: string;
}

export function readRelayPidRecord(coordRoot: string): RelayPidRecord | null {
  try {
    return JSON.parse(readFileSync(pidFilePath(coordRoot), "utf8")) as RelayPidRecord;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The committed rotatable room salt, when the repo minted one. */
export function readRoomSalt(coordRoot: string): string | undefined {
  try {
    const s = readFileSync(join(coordRoot, ".harnery", "presence-salt"), "utf8").trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

/**
 * Lazy-start the relay daemon for this repo if a relay is configured and no
 * live daemon already owns the pid file. Called from the hook path — must
 * return fast and never throw.
 */
export function ensureRelayDaemon(coordRoot: string): void {
  try {
    const url = presenceRelayUrl(coordRoot);
    if (!url) return;
    const rec = readRelayPidRecord(coordRoot);
    if (rec && rec.url === url && pidAlive(rec.pid)) return;

    // The runtime itself runs the CLI entry, so the daemon starts on Windows
    // too (see cli-entry.ts).
    const entry = harnCliEntry();
    if (!existsSync(entry)) return;

    mkdirSync(presenceDir(coordRoot), { recursive: true });
    const sharedLogs = coordEnv("SHARED_LOGS") !== "0";
    const log = sharedLogs ? undefined : openSync(relayLegacyLogPath(coordRoot), "a");
    const child = spawn(process.execPath, [entry, "presence", "relay-daemon"], {
      windowsHide: true,
      cwd: coordRoot,
      detached: true,
      stdio: log === undefined ? ["ignore", "ignore", "ignore"] : ["ignore", log, log],
      // Pin the daemon to this project: an inherited CLAUDE_PROJECT_DIR (or
      // similar) may name another one, whose config has no relay.
      env: {
        ...process.env,
        HARNERY_COORD_ROOT_OVERRIDE: coordRoot,
        HARNERY_OUTPUT_SESSION_TEE: "0",
      },
    });
    if (log !== undefined) closeSync(log);
    child.unref();
  } catch {
    /* best-effort */
  }
}

/** Foreground daemon loop (spawned detached by ensureRelayDaemon). */
export async function runRelayDaemon(coordRoot: string): Promise<number> {
  const url = presenceRelayUrl(coordRoot);
  if (!url) {
    const message = "relay-daemon: no relay configured (presence.relay)";
    console.error(message);
    if (coordEnv("SHARED_LOGS") !== "0") {
      appendPresenceRelayDiagnostic(coordRoot, "relay.configuration_error", { message });
    }
    await closeProcessLoggers();
    return 2;
  }
  if (typeof WebSocket === "undefined") {
    const message = "relay-daemon: no global WebSocket in this runtime (need Bun or Node >= 21)";
    console.error(message);
    if (coordEnv("SHARED_LOGS") !== "0") {
      appendPresenceRelayDiagnostic(coordRoot, "relay.runtime_error", { message });
    }
    await closeProcessLoggers();
    return 2;
  }
  const sha = rootCommitSha(coordRoot);
  const origin = originUrl(coordRoot);
  if (!sha || !origin) {
    const message = "relay-daemon: repo has no commits or no origin remote";
    console.error(message);
    if (coordEnv("SHARED_LOGS") !== "0") {
      appendPresenceRelayDiagnostic(coordRoot, "relay.repository_error", { message });
    }
    await closeProcessLoggers();
    return 2;
  }

  // Take (or take over) the pid file. A superseded daemon notices and exits.
  const myRecord: RelayPidRecord = {
    pid: process.pid,
    url,
    started_at: new Date().toISOString(),
  };
  atomicWriteJson(pidFilePath(coordRoot), myRecord);

  const creds = await deriveRoomCredentials({
    rootCommitSha: sha,
    originUrl: origin,
    salt: readRoomSalt(coordRoot),
  });
  const machine = sanitizeRefComponent(resolveMachineLabel());
  const senderId = await computeSenderId(creds, machine);
  const wsUrl = `${url.replace(/\/+$/, "")}/v1/room/${creds.roomId}`;

  let ws: WebSocket | null = null;
  let reconnect: ReconnectState = initialReconnectState();
  let lastBasisHash = "";
  let lastSentAt = 0;
  let idleSince: number | null = null;
  let shuttingDown = false;

  // `phase` gives `presence relay-status` a stable key; older records carry
  // only the message.
  const log = (
    msg: string,
    phase: string,
    event = "relay.lifecycle",
    extra: Record<string, unknown> = {},
  ) => {
    console.log(relayDaemonLogLine(new Date(), msg));
    if (coordEnv("SHARED_LOGS") !== "0") {
      appendPresenceRelayDiagnostic(coordRoot, event, { phase, message: msg, ...extra });
    }
  };

  const publishNow = async (force = false): Promise<void> => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const { blob, basisHash, json } = buildPresenceBlob(coordRoot);
      const keepaliveDue = Date.now() - lastSentAt >= KEEPALIVE_MS;
      if (!force && basisHash === lastBasisHash && !keepaliveDue) return;
      const enc = await encryptPayload(creds, json);
      ws.send(JSON.stringify({ t: "pub", sender: senderId, ...enc }));
      lastBasisHash = basisHash;
      lastSentAt = Date.now();
      idleSince = blob.agents.length === 0 ? (idleSince ?? Date.now()) : null;
    } catch {
      /* next trigger retries */
    }
  };

  const handleFrame = async (raw: string): Promise<void> => {
    const frame = parseRelayFrame(raw);
    if (frame?.t !== "pub") return;
    if (frame.sender === senderId) return; // our own warm-join echo
    const pt = await decryptPayload(creds, frame);
    if (!pt) return;
    let blob: PresenceBlob;
    try {
      blob = JSON.parse(pt) as PresenceBlob;
    } catch {
      return;
    }
    if (blob?.v !== 1 || typeof blob.machine !== "string") return;
    const m = sanitizeRefComponent(blob.machine);
    if (m === machine) return;
    try {
      atomicWriteJson(join(remoteCacheDir(coordRoot), `${m}.json`), blob);
    } catch {
      /* best-effort */
    }
  };

  const connect = (): void => {
    if (shuttingDown) return;
    // Per-socket facts for the disconnect record. An error is folded into
    // the close that follows it, so each socket writes at most one record and
    // the reconnect throttle covers errors too.
    let openedAt: number | null = null;
    let socketError: string | undefined;
    let ended = false;
    const scheduleReconnect = (code: number | null, reason: string, wasClean: boolean) => {
      if (ended) return;
      ended = true;
      if (shuttingDown) return;
      const plan = planReconnect(reconnect, {
        code,
        reason,
        wasClean,
        openedAt,
        closedAt: Date.now(),
        error: socketError,
      });
      reconnect = plan.next;
      if (plan.log) {
        const { phase, message, ...fields } = plan.log;
        log(String(message), String(phase), "relay.disconnected", fields);
      }
      setTimeout(connect, plan.delayMs);
    };
    try {
      const sock = new WebSocket(wsUrl);
      ws = sock;
      sock.onopen = () => {
        openedAt = Date.now();
        log(`connected room=${creds.roomId.slice(0, 8)}… as ${machine}`, "connected");
        void publishNow(true);
      };
      sock.onmessage = (ev) => {
        void handleFrame(String(ev.data));
      };
      sock.onclose = (ev) => {
        scheduleReconnect(ev.code, ev.reason ?? "", ev.wasClean);
      };
      sock.onerror = (ev) => {
        socketError ??= errorText(ev);
        try {
          sock.close();
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      socketError = e instanceof Error ? e.message : String(e);
      scheduleReconnect(null, "", false);
    }
  };

  connect();

  // Publish on canonical V3 ledger change (debounced).
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const activeLedger = eventV3ActiveWatchPath(coordRoot);
  try {
    watch(activeLedger, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void publishNow(), WATCH_DEBOUNCE_MS);
    });
  } catch {
    /* keepalive interval still covers publication */
  }

  // Keepalive + lifecycle checks.
  const interval = setInterval(() => {
    void publishNow();
    // Superseded by a newer daemon → exit quietly.
    const rec = readRelayPidRecord(coordRoot);
    if (!rec || rec.pid !== process.pid) {
      log("pid file superseded; exiting", "superseded");
      shuttingDown = true;
      clearInterval(interval);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      void closeProcessLoggers().finally(() => process.exit(0));
      return;
    }
    // Idle machine (no live sessions for a while) → exit; hooks restart us.
    if (idleSince && Date.now() - idleSince > IDLE_EXIT_MS) {
      log("no live sessions; idle exit", "idle_exit");
      shuttingDown = true;
      clearInterval(interval);
      try {
        rmSync(pidFilePath(coordRoot), { force: true });
        ws?.close();
      } catch {
        /* ignore */
      }
      void closeProcessLoggers().finally(() => process.exit(0));
    }
  }, KEEPALIVE_MS);

  // Never resolves in normal operation; exits happen above.
  return await new Promise<number>(() => {});
}

/** Best-effort text of a WebSocket error event (Bun and Node attach `message`). */
function errorText(ev: Event): string {
  const m = (ev as Event & { message?: unknown; error?: unknown }).message;
  if (typeof m === "string" && m) return m;
  const err = (ev as Event & { error?: unknown }).error;
  if (err instanceof Error && err.message) return err.message;
  return ev.type || "error";
}

export function appendPresenceRelayDiagnostic(
  coordRoot: string,
  event: string,
  fields: Record<string, unknown> = {},
): "shared" | "legacy" {
  if (coordEnv("SHARED_LOGS") !== "0") {
    try {
      const logger = processLogger(coordRoot, "presence-relay");
      if (event.includes("error")) logger.error(event, legacyLogFields(fields));
      else logger.info(event, legacyLogFields(fields));
      return "shared";
    } catch {
      // Bootstrap failures retain a bounded text file for process diagnostics.
    }
  }
  const sink = new RotatingTextSink({
    path: relayLegacyLogPath(coordRoot),
    max_bytes: 512 * 1_024,
  });
  sink.append(
    `${JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), event, ...fields })}\n`,
  );
  sink.close();
  return "legacy";
}

/** Daemon status for `presence peers`/doctor surfaces. */
export function relayDaemonStatus(coordRoot: string): {
  running: boolean;
  pid?: number;
  url?: string;
  started_at?: string;
} {
  const rec = readRelayPidRecord(coordRoot);
  if (rec && pidAlive(rec.pid)) {
    return { running: true, pid: rec.pid, url: rec.url, started_at: rec.started_at };
  }
  return { running: false };
}

/**
 * The daemon's stdout line. With shared logs off (`HARNERY_SHARED_LOGS=0`),
 * stdout is redirected to the legacy text log and this line is the only
 * record of the event, so `presence relay-status` parses this exact shape.
 */
export function relayDaemonLogLine(at: Date, message: string): string {
  return `[${at.toISOString()}] ${message}`;
}
