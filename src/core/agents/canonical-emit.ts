/**
 * Emit canonical V3 observations by spawning `agent-coord emit-event`. Used by
 * coordination commands whose durable state change also has a V3 audit event.
 *
 * Soft-fails: never throws into the caller. A failed emit logs to stderr
 * (visible to operators in their terminal) but never breaks the CLI flow.
 *
 * Synchronous spawn: the projector runs before the CLI returns. The child has
 * a 15-second safety budget; loaded-host checks normally finish in a few
 * seconds and record the observation before the parent command exits.
 */

import { spawnSync } from "node:child_process";
import type { EventAdapterIdV3 } from "../events/v3/adapter-id.ts";
import type { LiveCoordinationObservationV3 } from "../events/v3/live-observation.ts";
import { coordBinPath } from "./coord-bin.ts";
import { resolveCoordRoot } from "./coord-client.ts";
import type { Heartbeat } from "./state/heartbeat-reader.ts";

export type EventV3EmitObservation =
  | LiveCoordinationObservationV3
  | {
      event_type: "coord.lifecycle_changed";
      new_state: "active" | "blocked" | "done";
      reason?: string;
      suggested_session_name?: string;
    };

export interface EventV3EmitInput {
  owner: string;
  session: string;
  adapter: EventAdapterIdV3;
  observation: EventV3EmitObservation;
}

/**
 * Resolve the coord root for a canonical emit.
 *
 * Delegates to `resolveCoordRoot()`, the single resolution the hooks and the
 * CLI's reads also use. An observation resolved any other way can disappear
 * from the live V3 generation even though the command itself succeeded.
 */
export function resolveEmitRoot(start: string = process.cwd()): string | null {
  return resolveCoordRoot(start);
}

export function emitEventV3(input: EventV3EmitInput): boolean {
  const root = resolveEmitRoot();
  if (!root) return false;
  const binary = coordBinPath("agent-coord", root);
  if (!binary) return false;
  try {
    const args = [
      "emit-event",
      "--type",
      input.observation.event_type,
      "--owner",
      input.owner,
      "--session",
      input.session,
      "--adapter",
      input.adapter,
      "--data-stdin",
    ];
    // Pin cwd + HARNERY_COORD_ROOT_OVERRIDE so the child writes to the SAME
    // stream we resolved, regardless of where the caller's shell is cd'd.
    const result = spawnSync(binary, args, {
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
      input: JSON.stringify(input.observation),
      // Budget the append generously. Under multi-agent contention a single
      // `agent-coord emit-event` has been measured at 3.4-4.1s on a loaded
      // host, so a 3s cap timed out every emit and blocked end-of-turn checks
      // -- exactly the failure this module's doc warns about.
      timeout: 15000,
      cwd: root,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    if (result.error || result.status !== 0) {
      const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
      const why = result.error
        ? result.error.message
        : `exit ${result.status}${detail ? `: ${detail}` : ""}`;
      process.stderr.write(`emitEventV3: ${input.observation.event_type} emit failed (${why})\n`); // lint-ok-emission: soft-fail diagnostic promised by the module doc; silent drops cost blocked turns
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize the heartbeat's `platform` field to the canonical Adapter type.
 */
export function normalizeAdapter(platform: string | undefined): EventAdapterIdV3 {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  if (platform === "openclaw") return "openclaw";
  return "claude-code";
}

/** Producer joins use the private native session ID, never its V3 fingerprint. */
export function nativeSessionIdentity(
  row: Pick<Heartbeat, "native_session_id" | "session_id"> | null | undefined,
  fallback: string,
): string {
  if (row?.native_session_id) return row.native_session_id;
  // A projection-only row carries the privacy-safe canonical session
  // fingerprint, not the adapter's native session ID needed to join the hook
  // producer. Until a disposable cache exists, the resolved owner is the only
  // native identity available to command surfaces.
  if (row?.session_id && !/^sid_[a-f0-9]{64}$/.test(row.session_id)) return row.session_id;
  return fallback;
}
