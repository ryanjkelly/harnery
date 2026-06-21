/**
 * Stale-sweep: prune dead heartbeats + orphaned pid-map + .last-peer-hash
 * files.
 *
 * Fires at session.start to clean up crashed-peer detritus before the new
 * session's UX layer reads peer state.
 *
 * Freshness threshold defaults to 600s; configurable via
 * HARNERY_AGENT_COORD_FRESHNESS env var.
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { coordEnv } from "../../../lib/env.ts";
import { emit } from "../events/emit.ts";

const DEFAULT_FRESHNESS_SECS = 600;

/** platform → harness, for the swept-event envelope (mirrors heartbeat-writer's harnessOf). */
function harnessFromPlatform(platform: unknown): "claude-code" | "cursor" | "codex" {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return "claude-code";
}

/** Emit a best-effort health.heartbeat_swept event. Telemetry only, never throws. */
function emitSwept(
  coordRoot: string,
  instanceId: string,
  harness: "claude-code" | "cursor" | "codex",
  sessionId: string,
  reason: "stale" | "unparseable" | "missing_ts",
  ageSecs?: number,
): void {
  try {
    emit(coordRoot, {
      event_type: "health.heartbeat_swept",
      instance_id: instanceId,
      session_id: sessionId,
      harness,
      source: "agent-coord",
      data: { reason, ...(ageSecs !== undefined ? { age_secs: ageSecs } : {}) },
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    } as Parameters<typeof emit>[1]);
  } catch {
    /* telemetry only, never break the sweep */
  }
}

/** File mtime in epoch-seconds, or +Infinity if it can't be read (treat as fresh → don't reap). */
function mtimeSecs(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs / 1000);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function staleSweep(coordRoot: string): {
  heartbeatsRemoved: string[];
  pidmapsRemoved: number;
  peerHashesRemoved: number;
} {
  const heartbeatsRemoved: string[] = [];
  let pidmapsRemoved = 0;
  let peerHashesRemoved = 0;

  const freshness = Number.parseInt(
    coordEnv("AGENT_COORD_FRESHNESS") ?? String(DEFAULT_FRESHNESS_SECS),
    10,
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff =
    nowSec - (Number.isFinite(freshness) && freshness > 0 ? freshness : DEFAULT_FRESHNESS_SECS);

  // 1. Prune stale heartbeats from the canonical `.harnery/active/` dir.
  //
  // Two deletion regimes, deliberately asymmetric:
  //   • Valid JSON with an OLD last_heartbeat → the legitimate dead/idle-agent
  //     prune. Delete (this is the whole point of stale-sweep; idle agents get
  //     healed back on their next tool call).
  //   • Can't-trust-content (JSON.parse failed, or no/NaN last_heartbeat) →
  //     fall back to file MTIME as the liveness signal. Only delete if the file
  //     is also mtime-old. A fresh-mtime file failing to parse is almost always
  //     a transient (mid-write / partial read), and deleting it would nuke a
  //     LIVE agent's heartbeat, the worst possible outcome. So: never reap a
  //     fresh file on a content failure.
  // Every deletion now emits health.heartbeat_swept so the lifecycle is
  // auditable (sweeps used to be silent; see the swept-event schema doc).
  const liveInstanceIds = new Set<string>();
  const d = join(coordRoot, ".harnery", "active");
  if (existsSync(d)) {
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      const path = join(d, f);
      const idFromFile = f.replace(/\.json$/, "");
      let parsed: {
        instance_id?: string;
        last_heartbeat?: string;
        platform?: unknown;
        session_id?: string;
      } | null = null;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        parsed = null;
      }

      if (parsed === null) {
        // Unparseable: only reap if the file itself is mtime-old.
        if (mtimeSecs(path) < cutoff) {
          try {
            unlinkSync(path);
            heartbeatsRemoved.push(f);
            emitSwept(coordRoot, idFromFile, "claude-code", idFromFile, "unparseable");
          } catch {
            /* swallow */
          }
        }
        continue;
      }

      const instanceId = parsed.instance_id ?? idFromFile;
      const harness = harnessFromPlatform(parsed.platform);
      const sessionId = parsed.session_id ?? instanceId;
      const ts = parsed.last_heartbeat
        ? Math.floor(Date.parse(parsed.last_heartbeat) / 1000)
        : Number.NaN;

      if (!parsed.last_heartbeat || !Number.isFinite(ts)) {
        // No / NaN last_heartbeat: can't trust content; gate on mtime.
        if (mtimeSecs(path) < cutoff) {
          unlinkSync(path);
          heartbeatsRemoved.push(f);
          emitSwept(coordRoot, instanceId, harness, sessionId, "missing_ts");
        } else if (parsed.instance_id) {
          liveInstanceIds.add(parsed.instance_id);
        }
        continue;
      }

      if (ts < cutoff) {
        // Legitimate stale prune (valid timestamp, past the freshness cutoff).
        unlinkSync(path);
        heartbeatsRemoved.push(f);
        emitSwept(coordRoot, instanceId, harness, sessionId, "stale", nowSec - ts);
        continue;
      }

      if (parsed.instance_id) liveInstanceIds.add(parsed.instance_id);
    }
  }

  // 2. Prune pid-map entries whose instance has no live heartbeat.
  const pidmapDir = join(coordRoot, ".harnery", "pid-map");
  if (existsSync(pidmapDir)) {
    for (const f of readdirSync(pidmapDir)) {
      const path = join(pidmapDir, f);
      try {
        const row = readFileSync(path, "utf8").trim();
        const ownerId = row.split("\t")[0]?.trim() ?? "";
        if (!ownerId || !liveInstanceIds.has(ownerId)) {
          unlinkSync(path);
          pidmapsRemoved += 1;
        }
      } catch {
        /* swallow */
      }
    }
  }

  // 3. Prune .last-peer-hash files for dead owners.
  const agentsDir = join(coordRoot, ".harnery");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (!f.startsWith(".last-peer-hash.")) continue;
      const owner = f.slice(".last-peer-hash.".length);
      if (!liveInstanceIds.has(owner)) {
        try {
          unlinkSync(join(agentsDir, f));
          peerHashesRemoved += 1;
        } catch {
          /* swallow */
        }
      }
    }
  }

  return { heartbeatsRemoved, pidmapsRemoved, peerHashesRemoved };
}
