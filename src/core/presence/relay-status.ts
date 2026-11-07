/**
 * Local diagnostic snapshot of the presence relay client (ADR 0016), for
 * `presence relay-status`. Reads only local state: config, the daemon's pid
 * file, the presence-relay log, the relay cache, locally fetched presence
 * refs, and the git publish state. No network calls.
 *
 * The room key never leaves this module: only an 8-character prefix of the
 * opaque room id is reported. Remote machines are summarized by name, agent
 * count and timestamps; task text and file lists are left out.
 */

import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { coordEnv } from "../../lib/env.ts";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { processAlive } from "../../lib/process-alive.ts";
import { presenceEnabled, presenceRelayUrl } from "../config.ts";
import { createStorageCatalog } from "../storage/catalog.ts";
import { type HarneryLogRecordV1, parseLogRecord } from "../storage/jsonl.ts";
import { readRecentActiveLogs } from "../storage/query.ts";
import { familyLogDirectory, readSegmentManifest } from "../storage/segments.ts";
import type { PresenceBlob } from "./blob.ts";
import {
  originUrl,
  PRESENCE_REF_PREFIX,
  readMachineRefs,
  rootCommitSha,
  sanitizeRefComponent,
} from "./git.ts";
import {
  readRelayLockState,
  readRelayPidRecord,
  readRoomSalt,
  relayInstanceLockEndpoint,
  relayLegacyLogPath,
} from "./relay-client.ts";
import { deriveRoomCredentials } from "./relay-protocol.ts";

/** Matches readRemoteMachines' window: older blobs render as offline. */
const REMOTE_STALE_SECS = 900;
/** Bounds on the newest-first log walk (uncompressed bytes, files). */
const HISTORY_MAX_BYTES = 4 * 1_024 * 1_024;
const HISTORY_MAX_FILES = 64;

export interface RelayLogEvent {
  at: string;
  event: string;
  phase: string;
  message: string | null;
  fields: Record<string, unknown>;
}

export interface RemoteSummary {
  machine: string;
  /** This machine's own entry (its git ref, or a cache file it wrote). */
  self: boolean;
  published_at: string | null;
  age_secs: number | null;
  stale: boolean;
  agents: number | null;
}

export interface RelayStatus {
  generated_at: string;
  machine: string;
  presence_enabled: boolean;
  relay: { configured: boolean; url: string | null };
  room: { id_prefix: string | null; salted: boolean; reason?: string };
  daemon: {
    pid_record: { pid: number; url: string; started_at: string } | null;
    pid_alive: boolean;
    running: boolean;
    url_matches_config: boolean | null;
    started_at: string | null;
    uptime_secs: number | null;
  };
  /**
   * The relay instance lock. `unavailable` means something other than this
   * project's relay daemon occupies the lock's endpoint, so no daemon will
   * connect until it goes away; git-ref presence continues meanwhile.
   */
  lock: {
    state: "held" | "unavailable" | "none";
    endpoint: "named_pipe" | "loopback_tcp";
    port?: number;
    reason?: string;
    at?: string;
  };
  log: {
    source: "shared" | "legacy";
    error?: string;
    /** A size or file cap stopped the walk before it had what it needed. */
    truncated: boolean;
    /** Whether `since_daemon_start` covers the daemon's whole life; null with no running daemon. */
    history_complete: boolean | null;
    oldest_record_at: string | null;
    files_read: number;
    last_connected: RelayLogEvent | null;
    last_disconnected: RelayLogEvent | null;
    last_idle_exit: RelayLogEvent | null;
    last_superseded: RelayLogEvent | null;
    last_error: RelayLogEvent | null;
    /** Counted from the running daemon's start; null without a pid record. */
    since_daemon_start: { connects: number; disconnects: number } | null;
  };
  relay_cache: RemoteSummary[];
  git_refs: RemoteSummary[];
  publish_state: {
    pushed_at: string | null;
    age_secs: number | null;
    agents: number | null;
  } | null;
}

export async function relayStatus(
  coordRoot: string,
  opts: { now?: Date } = {},
): Promise<RelayStatus> {
  const now = opts.now ?? new Date();
  const machine = sanitizeRefComponent(resolveMachineLabel());
  const url = presenceRelayUrl(coordRoot);
  const rec = readRelayPidRecord(coordRoot);
  const recOk =
    rec !== null && Number.isSafeInteger(rec.pid) && rec.pid > 0 && typeof rec.url === "string";
  const alive = recOk ? processAlive(rec.pid) : false;
  const startedAt = recOk && typeof rec.started_at === "string" ? rec.started_at : null;
  const log = readRelayLog(coordRoot, alive ? startedAt : null);

  return {
    generated_at: now.toISOString(),
    machine,
    presence_enabled: presenceEnabled(coordRoot),
    relay: { configured: url !== null, url },
    room: await roomSummary(coordRoot),
    daemon: {
      pid_record: recOk ? { pid: rec.pid, url: rec.url, started_at: rec.started_at } : null,
      pid_alive: alive,
      running: alive,
      url_matches_config: recOk && url !== null ? rec.url === url : null,
      started_at: startedAt,
      uptime_secs: alive && startedAt ? ageSecs(startedAt, now) : null,
    },
    lock: lockSummary(coordRoot, alive),
    log,
    relay_cache: readRelayCache(coordRoot, now, machine),
    git_refs: readGitRefs(coordRoot, now, machine),
    publish_state: readPublishState(coordRoot, now),
  };
}

function lockSummary(coordRoot: string, daemonAlive: boolean): RelayStatus["lock"] {
  const endpoint = relayInstanceLockEndpoint(coordRoot);
  const base = {
    endpoint: endpoint.kind === "pipe" ? ("named_pipe" as const) : ("loopback_tcp" as const),
    ...(endpoint.kind === "tcp" ? { port: endpoint.port } : {}),
  };
  const failure = readRelayLockState(coordRoot);
  if (failure) {
    return {
      ...base,
      state: "unavailable",
      reason: failure.reason,
      at: failure.at,
      ...(failure.port !== undefined ? { port: failure.port } : {}),
    };
  }
  return { ...base, state: daemonAlive ? "held" : "none" };
}

async function roomSummary(coordRoot: string): Promise<RelayStatus["room"]> {
  const salt = readRoomSalt(coordRoot);
  const sha = rootCommitSha(coordRoot);
  const origin = originUrl(coordRoot);
  if (!sha || !origin) {
    return {
      id_prefix: null,
      salted: salt !== undefined,
      reason: !sha ? "repository has no commits" : "no origin remote",
    };
  }
  try {
    const creds = await deriveRoomCredentials({ rootCommitSha: sha, originUrl: origin, salt });
    return { id_prefix: creds.roomId.slice(0, 8), salted: salt !== undefined };
  } catch (e) {
    return {
      id_prefix: null,
      salted: salt !== undefined,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Classify a relay log record. Shared-log records carry `phase`; older
 * records and legacy text lines carry only a message, so its prefix decides. */
export function relayLogPhase(event: string, fields: Record<string, unknown>): string {
  if (typeof fields.phase === "string" && fields.phase) return fields.phase;
  const message = typeof fields.message === "string" ? fields.message : "";
  if (message.startsWith("connected")) return "connected";
  if (message.startsWith("disconnected")) return "disconnected";
  if (message.startsWith("connect failed")) return "connect_failed";
  if (message.startsWith("no live sessions")) return "idle_exit";
  if (message.startsWith("pid file superseded")) return "superseded";
  if (event === "relay.disconnected") return "disconnected";
  if (event.includes("error")) return "error";
  return "other";
}

type RelayLogSummary = Pick<
  RelayStatus["log"],
  | "last_connected"
  | "last_disconnected"
  | "last_idle_exit"
  | "last_superseded"
  | "last_error"
  | "since_daemon_start"
>;

export function summarizeRelayLog(
  events: readonly RelayLogEvent[],
  daemonStartedAt: string | null,
): RelayLogSummary {
  const last = (pred: (e: RelayLogEvent) => boolean): RelayLogEvent | null => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && pred(e)) return e;
    }
    return null;
  };
  const startMs = daemonStartedAt ? Date.parse(daemonStartedAt) : Number.NaN;
  let since: { connects: number; disconnects: number } | null = null;
  if (Number.isFinite(startMs)) {
    since = { connects: 0, disconnects: 0 };
    for (const e of events) {
      if (Date.parse(e.at) < startMs) continue;
      if (e.phase === "connected") since.connects++;
      else if (e.phase === "disconnected" || e.phase === "connect_failed") since.disconnects++;
    }
  }
  return {
    last_connected: last((e) => e.phase === "connected"),
    last_disconnected: last((e) => e.phase === "disconnected" || e.phase === "connect_failed"),
    last_idle_exit: last((e) => e.phase === "idle_exit"),
    last_superseded: last((e) => e.phase === "superseded"),
    last_error: last((e) => e.phase === "error"),
    since_daemon_start: since,
  };
}

/** One log file, in newest-first walk order. */
export interface HistorySource {
  /** Uncompressed size when known up front (sealed segments). */
  bytes?: number;
  read(maxBytes: number): { events: RelayLogEvent[]; bytes: number; truncated: boolean };
}

export interface RelayHistory {
  events: RelayLogEvent[];
  truncated: boolean;
  history_complete: boolean | null;
  oldest_record_at: string | null;
  files_read: number;
}

/**
 * Walk log files newest first until the history answers every question: the
 * walk has passed the daemon's start (so lifetime counts are whole) and found
 * each kind of lifecycle event, or it ran out of files. A size or file cap
 * ends it early and sets `truncated`. `history_complete` says whether the
 * counts since daemon start cover the daemon's whole life (null with no
 * running daemon); retention that pruned records after the start makes it
 * false even when the walk read every retained file.
 */
export function walkRelayHistory(
  sources: readonly HistorySource[],
  opts: { daemonStartedAt: string | null; pruned: boolean; maxBytes?: number; maxFiles?: number },
): RelayHistory {
  const maxBytes = opts.maxBytes ?? HISTORY_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? HISTORY_MAX_FILES;
  const startMs = opts.daemonStartedAt ? Date.parse(opts.daemonStartedAt) : Number.NaN;
  const chunks: RelayLogEvent[][] = [];
  let bytes = 0;
  let filesRead = 0;
  let truncated = false;
  let stoppedEarly = false;
  for (const source of sources) {
    if (filesRead >= maxFiles || (source.bytes !== undefined && bytes + source.bytes > maxBytes)) {
      truncated = true;
      break;
    }
    const r = source.read(maxBytes - bytes);
    bytes += r.bytes;
    filesRead++;
    chunks.unshift(r.events);
    if (r.truncated) {
      truncated = true;
      break;
    }
    const events = chunks.flat();
    const oldest = events[0];
    const passedStart =
      !Number.isFinite(startMs) || (oldest !== undefined && Date.parse(oldest.at) < startMs);
    const sum = summarizeRelayLog(events, null);
    if (
      passedStart &&
      sum.last_connected &&
      sum.last_disconnected &&
      sum.last_idle_exit &&
      sum.last_superseded &&
      sum.last_error
    ) {
      stoppedEarly = true;
      break;
    }
  }
  const events = chunks.flat();
  const oldestAt = events[0]?.at ?? null;
  const exhausted = !truncated && !stoppedEarly;
  let complete: boolean | null = null;
  if (Number.isFinite(startMs)) {
    const passedStart = oldestAt !== null && Date.parse(oldestAt) < startMs;
    complete = passedStart || (exhausted && !opts.pruned);
  }
  return {
    events,
    truncated,
    history_complete: complete,
    oldest_record_at: oldestAt,
    files_read: filesRead,
  };
}

function readRelayLog(coordRoot: string, daemonStartedAt: string | null): RelayStatus["log"] {
  const shared = coordEnv("SHARED_LOGS") !== "0";
  let history: RelayHistory = {
    events: [],
    truncated: false,
    history_complete: daemonStartedAt ? false : null,
    oldest_record_at: null,
    files_read: 0,
  };
  let error: string | undefined;
  try {
    const { sources, pruned } = shared
      ? sharedLogSources(coordRoot)
      : legacyLogSources(relayLegacyLogPath(coordRoot));
    history = walkRelayHistory(sources, { daemonStartedAt, pruned });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    source: shared ? "shared" : "legacy",
    ...(error ? { error } : {}),
    truncated: history.truncated,
    history_complete: history.history_complete,
    oldest_record_at: history.oldest_record_at,
    files_read: history.files_read,
    ...summarizeRelayLog(history.events, daemonStartedAt),
  };
}

/** The shared family's active file, then its sealed segments, newest first. */
function sharedLogSources(coordRoot: string): { sources: HistorySource[]; pruned: boolean } {
  const catalog = createStorageCatalog({ coord_root: coordRoot, project_root: coordRoot });
  const family = catalog.families.find((f) => f.id === "presence-relay-log");
  if (!family) return { sources: [], pruned: false };
  const directory = familyLogDirectory(family);
  const manifest = readSegmentManifest(directory, family);
  const sources: HistorySource[] = [
    {
      read(maxBytes) {
        const tail = readRecentActiveLogs(family, {
          max_records: Number.MAX_SAFE_INTEGER,
          max_bytes: Math.max(1, maxBytes),
        });
        return {
          events: recordEvents(tail.records),
          bytes: tail.bytes_examined,
          truncated: tail.truncated,
        };
      },
    },
  ];
  for (const segment of [...manifest.segments].reverse()) {
    sources.push({
      bytes: segment.bytes,
      read(maxBytes) {
        const path = join(directory, segment.file);
        if (!lstatSync(path).isFile()) {
          throw new Error(`log segment is not a regular file: ${segment.file}`);
        }
        let text: string;
        try {
          text = gunzipSync(readFileSync(path), { maxOutputLength: maxBytes }).toString("utf8");
        } catch (e) {
          if (e instanceof RangeError) return { events: [], bytes: maxBytes, truncated: true };
          throw e;
        }
        const records: HarneryLogRecordV1[] = [];
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            records.push(parseLogRecord(line));
          } catch {
            /* skip a damaged record */
          }
        }
        return { events: recordEvents(records), bytes: Buffer.byteLength(text), truncated: false };
      },
    });
  }
  return { sources, pruned: (manifest.pruned_through_sequence ?? 0) > 0 };
}

function recordEvents(records: readonly HarneryLogRecordV1[]): RelayLogEvent[] {
  return records
    .filter((r) => r.kind === "record")
    .map((r) => toEvent(r.emitted_at, r.event, r.fields as Record<string, unknown>));
}

/**
 * The legacy text log and its rotated backups, newest first. With shared logs
 * off, the daemon's stdout is redirected here, so most lines are its
 * `[ISO time] message` console lines (relayDaemonLogLine); the occasional JSON
 * line comes from appendPresenceRelayDiagnostic's fallback.
 */
function legacyLogSources(path: string): { sources: HistorySource[]; pruned: boolean } {
  const paths = [path, ...[1, 2, 3].map((i) => `${path}.${i}`)].filter((p) => existsSync(p));
  return {
    // The last backup existing means rotation may already have dropped older text.
    pruned: existsSync(`${path}.3`),
    sources: paths.map((p) => ({
      read(maxBytes) {
        const { text, bytes, truncated } = readTail(p, maxBytes);
        return { events: parseLegacyLog(text), bytes, truncated };
      },
    })),
  };
}

function readTail(
  path: string,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error("legacy relay log is not a regular file");
  const length = Math.min(st.size, Math.max(0, maxBytes));
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = length > 0 ? readSync(fd, buf, 0, length, st.size - length) : 0;
    let text = buf.subarray(0, read).toString("utf8");
    const truncated = st.size > length;
    // A tail that starts mid-line drops the partial first line.
    if (truncated) text = text.slice(text.indexOf("\n") + 1);
    return { text, bytes: read, truncated };
  } finally {
    closeSync(fd);
  }
}

const LEGACY_LINE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] (.+)$/;

/** Parse legacy text log content: daemon console lines and JSON fallback lines. */
export function parseLegacyLog(text: string): RelayLogEvent[] {
  const out: RelayLogEvent[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const m = LEGACY_LINE.exec(line);
    if (m?.[1] && m[2]) {
      const at = m[1];
      const message = m[2];
      if (!Number.isFinite(Date.parse(at))) continue;
      const phase = relayLogPhase("relay.lifecycle", { message });
      const isDrop = phase === "disconnected" || phase === "connect_failed";
      const fields: Record<string, unknown> = { message };
      if (isDrop) {
        const code = /\bcode=(\d+)/.exec(message)?.[1];
        const clean = /\bclean=(true|false)/.exec(message)?.[1];
        fields.code = code ? Number(code) : null;
        if (clean) fields.clean = clean === "true";
      }
      out.push(toEvent(at, isDrop ? "relay.disconnected" : "relay.lifecycle", fields));
      continue;
    }
    if (!line.startsWith("{")) continue;
    try {
      const {
        ts,
        event,
        schema_version: _v,
        ...fields
      } = JSON.parse(line) as Record<string, unknown>;
      if (typeof ts === "string" && typeof event === "string") out.push(toEvent(ts, event, fields));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function toEvent(at: string, event: string, fields: Record<string, unknown>): RelayLogEvent {
  const { phase: _p, message, ...rest } = fields;
  return {
    at,
    event,
    phase: relayLogPhase(event, fields),
    message: typeof message === "string" ? message : null,
    fields: rest,
  };
}

function readRelayCache(coordRoot: string, now: Date, self: string): RemoteSummary[] {
  const dir = join(coordRoot, ".harnery", "presence", "remote");
  if (!existsSync(dir)) return [];
  const out: RemoteSummary[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  for (const f of files) {
    let blob: Partial<PresenceBlob> | null = null;
    try {
      blob = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<PresenceBlob>;
    } catch {
      /* summarize the file name alone */
    }
    out.push(summarize(f.replace(/\.json$/, ""), blob, now, self));
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine));
}

function readGitRefs(coordRoot: string, now: Date, self: string): RemoteSummary[] {
  const out: RemoteSummary[] = [];
  for (const { machine, message } of readMachineRefs(coordRoot, PRESENCE_REF_PREFIX)) {
    let blob: Partial<PresenceBlob> | null = null;
    try {
      blob = JSON.parse(message) as Partial<PresenceBlob>;
    } catch {
      /* summarize the ref name alone */
    }
    out.push(summarize(machine, blob, now, self));
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine));
}

function summarize(
  machine: string,
  blob: Partial<PresenceBlob> | null,
  now: Date,
  self: string,
): RemoteSummary {
  const publishedAt = typeof blob?.published_at === "string" ? blob.published_at : null;
  const age = publishedAt ? ageSecs(publishedAt, now) : null;
  return {
    machine,
    self: machine === self,
    published_at: publishedAt,
    age_secs: age,
    stale: age === null || age > REMOTE_STALE_SECS,
    agents: Array.isArray(blob?.agents) ? blob.agents.length : null,
  };
}

function readPublishState(coordRoot: string, now: Date): RelayStatus["publish_state"] {
  const path = join(coordRoot, ".harnery", "presence", "publish-state.json");
  try {
    if (!statSync(path).isFile()) return null;
    const s = JSON.parse(readFileSync(path, "utf8")) as { pushed_at?: unknown; agents?: unknown };
    const pushedAt = typeof s.pushed_at === "string" ? s.pushed_at : null;
    return {
      pushed_at: pushedAt,
      age_secs: pushedAt ? ageSecs(pushedAt, now) : null,
      agents: typeof s.agents === "number" ? s.agents : null,
    };
  } catch {
    return null;
  }
}

function ageSecs(iso: string, now: Date): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / 1000));
}
