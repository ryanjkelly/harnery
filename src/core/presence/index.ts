/**
 * Cross-machine presence (ADR 0016), phase 1: the git-refs transport.
 *
 * publishPresence(): serialize this machine's live sessions into a presence
 * blob and force-push it to `refs/harnery/presence/<machine>` on origin —
 * change-batched (only when the blob materially changed) with a keepalive
 * (~5 min) so peers can distinguish "no change" from "machine gone".
 *
 * fetchPresence(): throttled fetch of every peer machine's presence ref.
 *
 * readRemoteMachines(): parse the locally-known refs into render-ready rows
 * (self machine excluded, stale blobs dropped).
 *
 * All entry points are fail-silent and gated on `presenceEnabled()` — presence
 * must never break a hook, a render, or a repo with no origin.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { coordEnv } from "../../lib/env.ts";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { presenceEnabled } from "../config.ts";
import { buildPresenceBlob, type PresenceAgent, type PresenceBlob } from "./blob.ts";
import {
  fetchPresenceRefs,
  hasOrigin,
  pushPresenceRef,
  readPresenceRefs,
  sanitizeRefComponent,
  writePresenceCommit,
} from "./git.ts";

export type { PresenceAgent, PresenceBlob } from "./blob.ts";
export { buildPresenceBlob } from "./blob.ts";
export { PRESENCE_REF_PREFIX, parseForEachRefOutput, sanitizeRefComponent } from "./git.ts";

/** Re-push at least this often while sessions are live, so peers can treat a
 * blob older than ~3x this as "machine offline" rather than "no change". */
const KEEPALIVE_SECS = 300;
/** Never push more often than this, however chatty the triggers. */
const MIN_PUSH_INTERVAL_SECS = 15;
/** Default fetch throttle (hook cadence fires far more often than this). */
const FETCH_INTERVAL_SECS = 60;
/** A blob whose published_at is older than this is rendered as gone. */
const REMOTE_STALE_SECS = 900;

export type PublishResult =
  | { status: "published"; machine: string; agents: number; sha: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

export type FetchResult =
  | { status: "fetched" }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string };

interface PublishState {
  basis_hash?: string;
  pushed_at?: string;
  agents?: number;
}

function presenceDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "presence");
}

function statePath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "publish-state.json");
}

function fetchStampPath(coordRoot: string): string {
  return join(presenceDir(coordRoot), "fetch-stamp");
}

function readState(coordRoot: string): PublishState {
  try {
    return JSON.parse(readFileSync(statePath(coordRoot), "utf8")) as PublishState;
  } catch {
    return {};
  }
}

function writeState(coordRoot: string, state: PublishState): void {
  try {
    const p = statePath(coordRoot);
    mkdirSync(presenceDir(coordRoot), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, p);
  } catch {
    /* best-effort */
  }
}

/**
 * Publish this machine's presence blob to origin if it changed (or the
 * keepalive elapsed). `sync: true` pushes in-process and reports errors (CLI
 * path); default spawns the push detached (hook path).
 */
export function publishPresence(
  coordRoot: string,
  opts: { force?: boolean; sync?: boolean } = {},
): PublishResult {
  try {
    if (!presenceEnabled(coordRoot)) return { status: "skipped", reason: "disabled" };
    if (!hasOrigin(coordRoot)) return { status: "skipped", reason: "no origin remote" };

    const { blob, basisHash, json } = buildPresenceBlob(coordRoot);
    const state = readState(coordRoot);
    const pushedAtMs = Date.parse(state.pushed_at ?? "");
    const sincePush = Number.isFinite(pushedAtMs)
      ? (Date.now() - pushedAtMs) / 1000
      : Number.POSITIVE_INFINITY;

    if (!opts.force) {
      // Nothing live and the last publish already said so → stay quiet.
      if (blob.agents.length === 0 && (state.agents ?? 0) === 0) {
        return { status: "skipped", reason: "no live sessions" };
      }
      const unchanged = state.basis_hash === basisHash;
      if (unchanged && sincePush < KEEPALIVE_SECS) {
        return { status: "skipped", reason: "unchanged (within keepalive)" };
      }
      if (!unchanged && sincePush < MIN_PUSH_INTERVAL_SECS) {
        return { status: "skipped", reason: "min push interval" };
      }
    }

    const sha = writePresenceCommit(coordRoot, json);
    if (!sha) return { status: "error", error: "commit-tree failed" };

    const push = pushPresenceRef(coordRoot, blob.machine, sha, { sync: opts.sync });
    if (!push.ok) return { status: "error", error: push.error ?? "push failed" };

    // Optimistic on the detached path: a failed background push self-heals at
    // the next keepalive re-push.
    writeState(coordRoot, {
      basis_hash: basisHash,
      pushed_at: new Date().toISOString(),
      agents: blob.agents.length,
    });
    return { status: "published", machine: blob.machine, agents: blob.agents.length, sha };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Throttled fetch of peer presence refs from origin. */
export function fetchPresence(
  coordRoot: string,
  opts: { force?: boolean; sync?: boolean } = {},
): FetchResult {
  try {
    if (!presenceEnabled(coordRoot)) return { status: "skipped", reason: "disabled" };
    if (!hasOrigin(coordRoot)) return { status: "skipped", reason: "no origin remote" };

    const stamp = fetchStampPath(coordRoot);
    if (!opts.force) {
      const interval = Number.parseInt(
        coordEnv("PRESENCE_FETCH_INTERVAL") ?? String(FETCH_INTERVAL_SECS),
        10,
      );
      try {
        const age = (Date.now() - statSync(stamp).mtimeMs) / 1000;
        if (age < interval) return { status: "skipped", reason: "within fetch interval" };
      } catch {
        /* no stamp yet → fetch */
      }
    }

    // Touch the stamp BEFORE spawning so concurrent hooks don't stampede.
    try {
      mkdirSync(presenceDir(coordRoot), { recursive: true });
      if (existsSync(stamp)) {
        const now = new Date();
        utimesSync(stamp, now, now);
      } else {
        writeFileSync(stamp, "", "utf8");
      }
    } catch {
      /* best-effort */
    }

    const r = fetchPresenceRefs(coordRoot, { sync: opts.sync });
    if (!r.ok) return { status: "error", error: r.error ?? "fetch failed" };
    return { status: "fetched" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

export interface RemoteMachine {
  machine: string;
  published_at: string;
  age_secs: number;
  agents: PresenceAgent[];
}

/**
 * Render-ready view of every OTHER machine's presence, from the locally-known
 * refs (run fetchPresence to refresh them). Self machine excluded; blobs older
 * than the stale window or with zero agents dropped.
 */
export function readRemoteMachines(
  coordRoot: string,
  opts: { includeSelf?: boolean; includeStale?: boolean } = {},
): RemoteMachine[] {
  try {
    if (!presenceEnabled(coordRoot)) return [];
    const selfMachine = sanitizeRefComponent(resolveMachineLabel());
    const out: RemoteMachine[] = [];
    for (const { machine, message } of readPresenceRefs(coordRoot)) {
      if (!opts.includeSelf && machine === selfMachine) continue;
      let blob: PresenceBlob;
      try {
        blob = JSON.parse(message) as PresenceBlob;
      } catch {
        continue;
      }
      if (blob?.v !== 1 || !Array.isArray(blob.agents)) continue;
      const publishedMs = Date.parse(blob.published_at ?? "");
      if (!Number.isFinite(publishedMs)) continue;
      const ageSecs = Math.max(0, Math.floor((Date.now() - publishedMs) / 1000));
      if (!opts.includeStale && ageSecs > REMOTE_STALE_SECS) continue;
      if (blob.agents.length === 0) continue;
      out.push({
        machine,
        published_at: blob.published_at,
        age_secs: ageSecs,
        agents: blob.agents,
      });
    }
    out.sort((a, b) => a.machine.localeCompare(b.machine));
    return out;
  } catch {
    return [];
  }
}
