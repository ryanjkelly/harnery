/**
 * Stale-sweep: prune dead heartbeats + orphaned pid-map + prompt hash
 * files.
 *
 * Runs after session.started to clean up crashed-peer detritus before the new
 * session's UX layer reads peer state.
 *
 * Freshness threshold defaults to 600s; configurable via the
 * HARNERY_AGENT_COORD_FRESHNESS env var or `.harnery/config.jsonc`
 * `coord.freshness_seconds` (see `coordFreshnessSeconds`).
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { coordFreshnessSeconds } from "../../config.ts";
import type { EventAdapterIdV3 } from "../../events/v3/adapter-id.ts";
import { writeProducerDiagnosticV3 } from "../../events/v3/producers/intake.ts";
import { recordLiveSweepObservationV3 } from "../live-lifecycle-v3.ts";

/** platform → adapter, for the swept-event envelope (mirrors heartbeat-writer's adapterOf). */
function adapterFromPlatform(platform: unknown): EventAdapterIdV3 {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  if (platform === "openclaw") return "openclaw";
  return "claude-code";
}

/**
 * Record the sweep before deleting disposable cache state.
 *
 * A joinable generation owns the canonical provisional observation. Once that
 * generation is terminal or unavailable, it must not be reopened merely to
 * authorize cache housekeeping. Preserve the failed observation in the V3
 * diagnostics spool instead. If neither durable record can be written, fail
 * closed and keep the file.
 */
function emitSwept(
  coordRoot: string,
  instanceId: string,
  adapter: EventAdapterIdV3,
  sessionId: string,
  reason: "stale" | "unparseable" | "missing_ts",
  ageSecs?: number,
): boolean {
  try {
    recordLiveSweepObservationV3({
      coordRoot,
      owner: instanceId,
      nativeSessionId: sessionId,
      adapter,
      observation:
        reason === "stale"
          ? "stale_heartbeat"
          : reason === "unparseable"
            ? "unparseable_heartbeat"
            : "missing_timestamp",
      ageMs: Math.max(0, (ageSecs ?? 0) * 1_000),
    });
    return true;
  } catch (error) {
    return Boolean(
      writeProducerDiagnosticV3(coordRoot, "heartbeat_sweep_unrecorded", {
        adapter,
        instance_id: instanceId,
        signal: "lifecycle.sweep_observed",
        reason: error instanceof Error ? error.message : String(error),
        state: "cache_cleanup_pending",
        observation: reason,
        age_ms: Math.max(0, (ageSecs ?? 0) * 1_000),
      }),
    );
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
  resourceHashesRemoved: number;
} {
  const heartbeatsRemoved: string[] = [];
  let pidmapsRemoved = 0;
  let peerHashesRemoved = 0;
  let resourceHashesRemoved = 0;

  const freshness = coordFreshnessSeconds(coordRoot);
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - freshness;

  // 1. Prune stale rows from the disposable V3 coordination cache.
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
  // Every deletion leaves durable audit evidence. A joinable generation gets
  // lifecycle.sweep_observed; a terminal or unavailable generation gets a
  // heartbeat_sweep_unrecorded producer diagnostic without being resurrected.
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
            const ageSecs = nowSec - mtimeSecs(path);
            if (
              !emitSwept(coordRoot, idFromFile, "claude-code", idFromFile, "unparseable", ageSecs)
            ) {
              continue;
            }
            unlinkSync(path);
            heartbeatsRemoved.push(f);
          } catch {
            /* swallow */
          }
        }
        continue;
      }

      const instanceId = parsed.instance_id ?? idFromFile;
      const adapter = adapterFromPlatform(parsed.platform);
      const sessionId = parsed.session_id ?? instanceId;
      const ts = parsed.last_heartbeat
        ? Math.floor(Date.parse(parsed.last_heartbeat) / 1000)
        : Number.NaN;

      if (!parsed.last_heartbeat || !Number.isFinite(ts)) {
        // No / NaN last_heartbeat: can't trust content; gate on mtime.
        if (mtimeSecs(path) < cutoff) {
          if (
            !emitSwept(
              coordRoot,
              instanceId,
              adapter,
              sessionId,
              "missing_ts",
              nowSec - mtimeSecs(path),
            )
          ) {
            continue;
          }
          unlinkSync(path);
          heartbeatsRemoved.push(f);
        } else if (parsed.instance_id) {
          liveInstanceIds.add(parsed.instance_id);
        }
        continue;
      }

      if (ts < cutoff) {
        // Legitimate stale prune (valid timestamp, past the freshness cutoff).
        if (!emitSwept(coordRoot, instanceId, adapter, sessionId, "stale", nowSec - ts)) {
          continue;
        }
        unlinkSync(path);
        heartbeatsRemoved.push(f);
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

  // 3. Prune prompt hashes for dead owners. Resource hashes retain their own
  // count so existing peer-hash telemetry keeps its original meaning.
  const agentsDir = join(coordRoot, ".harnery");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      const resourceHash = f.startsWith(".last-resource-hash.");
      const prefix = resourceHash ? ".last-resource-hash." : ".last-peer-hash.";
      if (!f.startsWith(prefix)) continue;
      const owner = f.slice(prefix.length);
      if (resourceHash) {
        // Ignore atomic-write temporary files and preserve hashes when a
        // retained heartbeat's liveness could not be determined safely.
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner)) continue;
        if (existsSync(join(d, `${owner}.json`))) continue;
      }
      if (!liveInstanceIds.has(owner)) {
        try {
          unlinkSync(join(agentsDir, f));
          if (resourceHash) resourceHashesRemoved += 1;
          else peerHashesRemoved += 1;
        } catch {
          /* swallow */
        }
      }
    }
  }

  return { heartbeatsRemoved, pidmapsRemoved, peerHashesRemoved, resourceHashesRemoved };
}
