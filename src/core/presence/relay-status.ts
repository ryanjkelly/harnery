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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { coordEnv } from "../../lib/env.ts";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { presenceEnabled, presenceRelayUrl } from "../config.ts";
import { createStorageCatalog } from "../storage/catalog.ts";
import { readRecentActiveLogs } from "../storage/query.ts";
import type { PresenceBlob } from "./blob.ts";
import {
  originUrl,
  PRESENCE_REF_PREFIX,
  readMachineRefs,
  rootCommitSha,
  sanitizeRefComponent,
} from "./git.ts";
import { pidAlive, readRelayPidRecord, readRoomSalt, relayLegacyLogPath } from "./relay-client.ts";
import { deriveRoomCredentials } from "./relay-protocol.ts";

/** Matches readRemoteMachines' window: older blobs render as offline. */
const REMOTE_STALE_SECS = 900;
const LOG_TAIL_BYTES = 256 * 1_024;
const LOG_TAIL_RECORDS = 1_000;

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
  log: {
    source: "shared" | "legacy";
    error?: string;
    truncated: boolean;
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
  const alive = recOk ? pidAlive(rec.pid) : false;
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
    log,
    relay_cache: readRelayCache(coordRoot, now, machine),
    git_refs: readGitRefs(coordRoot, now, machine),
    publish_state: readPublishState(coordRoot, now),
  };
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

/** Classify a relay log record. New records carry `phase`; older ones only
 * a lifecycle message, so the message prefix is the fallback. */
export function relayLogPhase(event: string, fields: Record<string, unknown>): string {
  if (typeof fields.phase === "string" && fields.phase) return fields.phase;
  if (event === "relay.disconnected") return "disconnected";
  if (event.includes("error")) return "error";
  const message = typeof fields.message === "string" ? fields.message : "";
  if (message.startsWith("connected")) return "connected";
  if (message.startsWith("no live sessions")) return "idle_exit";
  if (message.startsWith("pid file superseded")) return "superseded";
  return "other";
}

export function summarizeRelayLog(
  events: readonly RelayLogEvent[],
  daemonStartedAt: string | null,
): Omit<RelayStatus["log"], "source" | "error" | "truncated"> {
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

function readRelayLog(coordRoot: string, daemonStartedAt: string | null): RelayStatus["log"] {
  const shared = coordEnv("SHARED_LOGS") !== "0";
  let events: RelayLogEvent[] = [];
  let truncated = false;
  let error: string | undefined;
  try {
    if (shared) {
      const catalog = createStorageCatalog({ coord_root: coordRoot, project_root: coordRoot });
      const family = catalog.families.find((f) => f.id === "presence-relay-log");
      if (family) {
        const tail = readRecentActiveLogs(family, {
          max_records: LOG_TAIL_RECORDS,
          max_bytes: LOG_TAIL_BYTES,
        });
        truncated = tail.truncated;
        events = tail.records
          .filter((r) => r.kind === "record")
          .map((r) => toEvent(r.emitted_at, r.event, r.fields as Record<string, unknown>));
      }
    } else {
      events = readLegacyLog(relayLegacyLogPath(coordRoot));
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    source: shared ? "shared" : "legacy",
    ...(error ? { error } : {}),
    truncated,
    ...summarizeRelayLog(events, daemonStartedAt),
  };
}

function readLegacyLog(path: string): RelayLogEvent[] {
  if (!existsSync(path)) return [];
  const out: RelayLogEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
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
