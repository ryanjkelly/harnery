/**
 * The canonical supervisor reconcile pass.
 *
 * Two things have to happen together, in this order:
 *
 *   1. `staleSweep` prunes the disposable coordination cache under
 *      `.harnery/active` (plus orphaned pid-map and `.last-peer-hash` files)
 *      and leaves a durable lifecycle observation for every deletion.
 *   2. `reconcileSessionFinalizationV3` turns those observations, along with
 *      archive/idle/run/host signals, into session finalization requests.
 *
 * Running the sweep first is what makes a single pass self-contained: the
 * `lifecycle.sweep_observed` rows it writes are visible to the finalizer in
 * the same pass, so a stale session is both reaped and finalized without
 * waiting for a later invocation.
 *
 * ADR 0077 already specified that `agents reconcile` and session start
 * discover stale-sweep in the same pass. Both entry points had drifted to
 * calling only the finalizer, so the sweep never ran outside its own
 * subcommand. This module is the single composition both now share; adding a
 * caller means calling this, not re-composing the two halves.
 */

import {
  type ReconcileSessionFinalizationOptionsV3,
  type ReconcileSessionFinalizationResultV3,
  reconcileSessionFinalizationV3,
} from "./session-finalizer-v3.ts";
import { staleSweep } from "./state/stale-sweep.ts";

export interface ReconcileCoordinationResultV3 extends ReconcileSessionFinalizationResultV3 {
  /** Heartbeat cache files deleted from `.harnery/active` by the sweep. */
  swept_heartbeats: number;
  /** Orphaned `.harnery/pid-map` entries deleted by the sweep. */
  swept_pidmaps: number;
  /** Dead-owner `.last-peer-hash.*` files deleted by the sweep. */
  swept_peer_hashes: number;
}

/**
 * Sweep the disposable coordination cache, then reconcile session
 * finalization, and report both sets of counts.
 *
 * The sweep owns its own safety contract (configured coordination freshness
 * for valid rows, an additional stale-mtime gate for malformed or missing
 * timestamps, and a durable audit record before any deletion, failing closed
 * when neither can be written). Nothing here loosens it, and a sweep failure
 * never blocks finalization: the cache is a projection that heals on the
 * owning agent's next tool call, while the V3 ledger is authoritative.
 */
export function reconcileCoordinationV3(
  coordRoot: string,
  options: ReconcileSessionFinalizationOptionsV3 = {},
): ReconcileCoordinationResultV3 {
  let sweptHeartbeats = 0;
  let sweptPidmaps = 0;
  let sweptPeerHashes = 0;
  const sweepDiagnostics: string[] = [];
  try {
    const sweep = staleSweep(coordRoot);
    sweptHeartbeats = sweep.heartbeatsRemoved.length;
    sweptPidmaps = sweep.pidmapsRemoved;
    sweptPeerHashes = sweep.peerHashesRemoved;
  } catch (error) {
    sweepDiagnostics.push(
      `stale_sweep_failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = reconcileSessionFinalizationV3(coordRoot, options);
  return {
    ...result,
    diagnostics: [...sweepDiagnostics, ...result.diagnostics],
    swept_heartbeats: sweptHeartbeats,
    swept_pidmaps: sweptPidmaps,
    swept_peer_hashes: sweptPeerHashes,
  };
}
