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

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { coordFreshnessSeconds } from "../../config.ts";
import { type EventAdapterIdV3, eventAdapterIdV3FromPlatform } from "../../events/v3/adapter-id.ts";
import { withGenerationCustodyV3 } from "../../events/v3/generation-custody.ts";
import { liveInstanceIdV3 } from "../../events/v3/live-routing.ts";
import { writeProducerDiagnosticV3 } from "../../events/v3/producers/intake.ts";
import { recordLiveSweepObservationV3 } from "../live-lifecycle-v3.ts";
import {
  captureFileRevision,
  type DeleteFileResult,
  deleteFileIfUnchanged,
  type FileRecoveryResult,
  recoverInterruptedFileDeletions,
} from "./unchanged-file.ts";

/** platform → adapter, for the swept-event envelope (mirrors heartbeat-writer's adapterOf). */
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
  expectedGenerationId: `gen_${string}` | null,
  reason: "stale" | "unparseable" | "missing_ts",
  ageSecs?: number,
): boolean {
  try {
    recordLiveSweepObservationV3({
      coordRoot,
      owner: instanceId,
      nativeSessionId: sessionId,
      adapter,
      expectedGenerationId,
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

/** Any retained or unreadable owner row prevents dependent cache deletion. */
function retainsHeartbeat(
  coordRoot: string,
  activeDir: string,
  owner: string,
  uncertainOwners: Set<string>,
): boolean {
  if (uncertainOwners.has("*") || uncertainOwners.has(owner)) return true;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner)) return true;
  const heartbeat = join(activeDir, `${owner}.json`);
  try {
    lstatSync(heartbeat);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  try {
    if (!lstatSync(activeDir).isDirectory()) return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  // Callers hold this owner's custody. A sweeper that died after the initial
  // directory scan may have left its heartbeat hidden under a private pin.
  for (const recovery of recoverInterruptedFileDeletions(
    activeDir,
    (source) => source === heartbeat,
  )) {
    if (recovery.sourcePath && recovery.sourcePath !== heartbeat) continue;
    if (recovery.state !== "restored") {
      uncertainOwners.add(recovery.sourcePath ? owner : "*");
      recordCleanupFailure(coordRoot, recovery.sourcePath ?? activeDir, recovery);
    }
    return true;
  }
  return false;
}

function recordCleanupFailure(
  coordRoot: string,
  sourcePath: string,
  result: DeleteFileResult | FileRecoveryResult,
): void {
  if (
    result.state !== "error" &&
    result.state !== "recovery-required" &&
    result.state !== "retained"
  ) {
    return;
  }
  writeProducerDiagnosticV3(coordRoot, "heartbeat_sweep_unrecorded", {
    signal: "cache.cleanup",
    state: "cache_cleanup_pending",
    reason: `${result.state}:${result.error ?? "file_cleanup_pending"}; source=${sourcePath}; recovery=${result.recoveryPath ?? "unavailable"}`,
  });
}

function recordHeartbeatCleanupResult(
  coordRoot: string,
  sourcePath: string,
  owner: string,
  result: DeleteFileResult,
  uncertainOwners: Set<string>,
): void {
  if (result.state === "recovery-required" || result.state === "error") {
    uncertainOwners.add(owner);
  }
  recordCleanupFailure(coordRoot, sourcePath, result);
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
  const uncertainOwners = new Set<string>();
  const d = resolve(coordRoot, ".harnery", "active");
  for (const recovery of existsSync(d)
    ? recoverInterruptedFileDeletions(
        d,
        (source) => dirname(source) === d && /^[A-Za-z0-9_-]{1,128}\.json$/.test(basename(source)),
      )
    : []) {
    if (recovery.state !== "restored") {
      uncertainOwners.add(recovery.sourcePath ? basename(recovery.sourcePath, ".json") : "*");
      recordCleanupFailure(coordRoot, recovery.sourcePath ?? d, recovery);
    }
  }
  if (existsSync(d)) {
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      const path = join(d, f);
      const idFromFile = f.replace(/\.json$/, "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(idFromFile)) continue;
      try {
        withGenerationCustodyV3(coordRoot, [liveInstanceIdV3(idFromFile)], () => {
          const revision = captureFileRevision(path);
          if (!revision) return;
          const mtimeSecs = Number(revision.mtimeNs / 1_000_000_000n);
          let parsed: {
            instance_id?: string;
            last_heartbeat?: string;
            platform?: unknown;
            session_id?: string;
            v3_generation_id?: unknown;
          } | null = null;
          try {
            const value = JSON.parse(revision.bytes.toString("utf8"));
            if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
          } catch {
            parsed = null;
          }

          if (parsed === null) {
            // Unparseable: only reap if the file itself is mtime-old.
            if (mtimeSecs < cutoff) {
              const result = deleteFileIfUnchanged(path, revision, () =>
                emitSwept(
                  coordRoot,
                  idFromFile,
                  "claude-code",
                  idFromFile,
                  null,
                  "unparseable",
                  nowSec - mtimeSecs,
                ),
              );
              recordHeartbeatCleanupResult(coordRoot, path, idFromFile, result, uncertainOwners);
              if (result.state === "deleted") {
                heartbeatsRemoved.push(f);
              }
            }
            return;
          }

          // The filename selects the writer's custody scope. A conflicting content
          // identity cannot authorize an audit or deletion for a different owner.
          if (parsed.instance_id !== undefined && parsed.instance_id !== idFromFile) return;
          const instanceId = parsed.instance_id ?? idFromFile;
          const adapter = eventAdapterIdV3FromPlatform(parsed.platform, { context: "stale-sweep" });
          const sessionId = parsed.session_id ?? instanceId;
          const generationId =
            typeof parsed.v3_generation_id === "string" &&
            /^gen_[A-Za-z0-9._-]+$/.test(parsed.v3_generation_id)
              ? (parsed.v3_generation_id as `gen_${string}`)
              : null;
          const ts = parsed.last_heartbeat
            ? Math.floor(Date.parse(parsed.last_heartbeat) / 1000)
            : Number.NaN;

          if (!parsed.last_heartbeat || !Number.isFinite(ts)) {
            // No / NaN last_heartbeat: can't trust content; gate on mtime.
            if (mtimeSecs < cutoff) {
              const result = deleteFileIfUnchanged(path, revision, () =>
                emitSwept(
                  coordRoot,
                  instanceId,
                  adapter,
                  sessionId,
                  generationId,
                  "missing_ts",
                  nowSec - mtimeSecs,
                ),
              );
              recordHeartbeatCleanupResult(coordRoot, path, idFromFile, result, uncertainOwners);
              if (result.state === "deleted") {
                heartbeatsRemoved.push(f);
              }
            } else if (parsed.instance_id) {
              liveInstanceIds.add(parsed.instance_id);
            }
            return;
          }

          if (ts < cutoff) {
            // Legitimate stale prune (valid timestamp, past the freshness cutoff).
            const result = deleteFileIfUnchanged(path, revision, () =>
              emitSwept(
                coordRoot,
                instanceId,
                adapter,
                sessionId,
                generationId,
                "stale",
                nowSec - ts,
              ),
            );
            recordHeartbeatCleanupResult(coordRoot, path, idFromFile, result, uncertainOwners);
            if (result.state === "deleted") {
              heartbeatsRemoved.push(f);
            }
            return;
          }

          if (parsed.instance_id) liveInstanceIds.add(parsed.instance_id);
        });
      } catch {
        // Busy or unknown custody retains the cache and its dependent files.
        uncertainOwners.add(idFromFile);
      }
    }
  }

  // 2. Prune pid-map entries whose instance has no live heartbeat.
  const pidmapDir = resolve(coordRoot, ".harnery", "pid-map");
  for (const recovery of existsSync(pidmapDir)
    ? recoverInterruptedFileDeletions(
        pidmapDir,
        (source) => dirname(source) === pidmapDir && /^\d+$/.test(basename(source)),
      )
    : [])
    recordCleanupFailure(coordRoot, recovery.sourcePath ?? pidmapDir, recovery);
  if (existsSync(pidmapDir)) {
    for (const f of readdirSync(pidmapDir)) {
      if (f.startsWith(".harnery-delete-")) continue;
      const path = join(pidmapDir, f);
      try {
        const revision = captureFileRevision(path);
        if (!revision) continue;
        const row = revision.bytes.toString("utf8").trim();
        const ownerId = row.split("\t")[0]?.trim() ?? "";
        const prune = () => {
          if (
            !ownerId ||
            (!liveInstanceIds.has(ownerId) &&
              !retainsHeartbeat(coordRoot, d, ownerId, uncertainOwners))
          ) {
            const result = deleteFileIfUnchanged(
              path,
              revision,
              () => !ownerId || !retainsHeartbeat(coordRoot, d, ownerId, uncertainOwners),
            );
            recordCleanupFailure(coordRoot, path, result);
            if (result.state === "deleted") pidmapsRemoved += 1;
          }
        };
        if (/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) {
          withGenerationCustodyV3(coordRoot, [liveInstanceIdV3(ownerId)], prune);
        } else if (!ownerId) {
          prune();
        }
      } catch {
        /* swallow */
      }
    }
  }

  // 3. Prune prompt hashes for dead owners. Resource hashes retain their own
  // count so existing peer-hash telemetry keeps its original meaning.
  const agentsDir = resolve(coordRoot, ".harnery");
  for (const recovery of existsSync(agentsDir)
    ? recoverInterruptedFileDeletions(
        agentsDir,
        (source) =>
          dirname(source) === agentsDir &&
          /^\.last-(?:resource|peer)-hash\.[A-Za-z0-9_-]{1,128}$/.test(basename(source)),
      )
    : [])
    recordCleanupFailure(coordRoot, recovery.sourcePath ?? agentsDir, recovery);
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
      }
      if (!liveInstanceIds.has(owner) && /^[A-Za-z0-9_-]{1,128}$/.test(owner)) {
        try {
          withGenerationCustodyV3(coordRoot, [liveInstanceIdV3(owner)], () => {
            if (retainsHeartbeat(coordRoot, d, owner, uncertainOwners)) return;
            const path = join(agentsDir, f);
            const revision = captureFileRevision(path);
            if (!revision) return;
            const result = deleteFileIfUnchanged(
              path,
              revision,
              () => !retainsHeartbeat(coordRoot, d, owner, uncertainOwners),
            );
            recordCleanupFailure(coordRoot, path, result);
            if (result.state === "deleted") {
              if (resourceHash) resourceHashesRemoved += 1;
              else peerHashesRemoved += 1;
            }
          });
        } catch {
          /* swallow */
        }
      }
    }
  }

  return { heartbeatsRemoved, pidmapsRemoved, peerHashesRemoved, resourceHashesRemoved };
}
