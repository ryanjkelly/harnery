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
 *   - watches `.harnery/active/` and publishes the encrypted presence blob on
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
import { resolveMachineLabel } from "../../lib/machine.ts";
import { presenceRelayUrl } from "../config.ts";
import { buildPresenceBlob, type PresenceBlob } from "./blob.ts";
import { originUrl, rootCommitSha, sanitizeRefComponent } from "./git.ts";
import {
  computeSenderId,
  decryptPayload,
  deriveRoomCredentials,
  encryptPayload,
  parseRelayFrame,
} from "./relay-protocol.ts";

const KEEPALIVE_MS = 60_000;
const WATCH_DEBOUNCE_MS = 500;
const IDLE_EXIT_MS = 5 * 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

function presenceDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "presence");
}

function remoteCacheDir(coordRoot: string): string {
  return join(presenceDir(coordRoot), "remote");
}

function pidFilePath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "relay-daemon.json");
}

function logFilePath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "relay-daemon.log");
}

interface PidRecord {
  pid: number;
  url: string;
  started_at: string;
}

function readPidRecord(coordRoot: string): PidRecord | null {
  try {
    return JSON.parse(readFileSync(pidFilePath(coordRoot), "utf8")) as PidRecord;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The committed rotatable room salt, when the repo minted one. */
function readRoomSalt(coordRoot: string): string | undefined {
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
    const rec = readPidRecord(coordRoot);
    if (rec && rec.url === url && pidAlive(rec.pid)) return;

    // Resolve the harn bin at the package root (works from src/ under Bun and
    // dist/ under Node — both sit two levels below the root).
    const harnBin = new URL("../../../bin/harn", import.meta.url).pathname;
    if (!existsSync(harnBin)) return;

    mkdirSync(presenceDir(coordRoot), { recursive: true });
    const log = openSync(logFilePath(coordRoot), "a");
    const child = spawn(harnBin, ["presence", "relay-daemon"], {
      cwd: coordRoot,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, HARNERY_OUTPUT_SESSION_TEE: "0" },
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

/** Foreground daemon loop (spawned detached by ensureRelayDaemon). */
export async function runRelayDaemon(coordRoot: string): Promise<number> {
  const url = presenceRelayUrl(coordRoot);
  if (!url) {
    console.error("relay-daemon: no relay configured (presence.relay)");
    return 2;
  }
  if (typeof WebSocket === "undefined") {
    console.error("relay-daemon: no global WebSocket in this runtime (need Bun or Node >= 21)");
    return 2;
  }
  const sha = rootCommitSha(coordRoot);
  const origin = originUrl(coordRoot);
  if (!sha || !origin) {
    console.error("relay-daemon: repo has no commits or no origin remote");
    return 2;
  }

  // Take (or take over) the pid file. A superseded daemon notices and exits.
  const myRecord: PidRecord = {
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
  let backoff = BACKOFF_MIN_MS;
  let lastBasisHash = "";
  let lastSentAt = 0;
  let idleSince: number | null = null;
  let shuttingDown = false;

  const log = (msg: string) => {
    console.log(`[${new Date().toISOString()}] ${msg}`);
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
    try {
      const sock = new WebSocket(wsUrl);
      ws = sock;
      sock.onopen = () => {
        backoff = BACKOFF_MIN_MS;
        log(`connected room=${creds.roomId.slice(0, 8)}… as ${machine}`);
        void publishNow(true);
      };
      sock.onmessage = (ev) => {
        void handleFrame(String(ev.data));
      };
      const scheduleReconnect = () => {
        if (shuttingDown) return;
        const jitter = Math.random() * backoff * 0.3;
        const delay = Math.min(BACKOFF_MAX_MS, backoff) + jitter;
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        setTimeout(connect, delay);
      };
      sock.onclose = scheduleReconnect;
      sock.onerror = () => {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
      };
    } catch {
      setTimeout(connect, backoff);
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    }
  };

  connect();

  // Publish on heartbeat change (debounced).
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const activeDir = join(coordRoot, ".harnery", "active");
  mkdirSync(activeDir, { recursive: true });
  try {
    watch(activeDir, () => {
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
    const rec = readPidRecord(coordRoot);
    if (!rec || rec.pid !== process.pid) {
      log("pid file superseded; exiting");
      shuttingDown = true;
      clearInterval(interval);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    }
    // Idle machine (no live sessions for a while) → exit; hooks restart us.
    if (idleSince && Date.now() - idleSince > IDLE_EXIT_MS) {
      log("no live sessions; idle exit");
      shuttingDown = true;
      clearInterval(interval);
      try {
        rmSync(pidFilePath(coordRoot), { force: true });
        ws?.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    }
  }, KEEPALIVE_MS);

  // Never resolves in normal operation; exits happen above.
  return await new Promise<number>(() => {});
}

/** Daemon status for `presence peers`/doctor surfaces. */
export function relayDaemonStatus(coordRoot: string): {
  running: boolean;
  pid?: number;
  url?: string;
  started_at?: string;
} {
  const rec = readPidRecord(coordRoot);
  if (rec && pidAlive(rec.pid)) {
    return { running: true, pid: rec.pid, url: rec.url, started_at: rec.started_at };
  }
  return { running: false };
}
