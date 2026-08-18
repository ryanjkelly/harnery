/**
 * Emit canonical V2 observations by spawning `agent-coord emit-event`. Used by
 * coordination commands whose durable state change also has a V2 audit event.
 *
 * Soft-fails: never throws into the caller. A failed emit logs to stderr
 * (visible to operators in their terminal) but never breaks the CLI flow.
 *
 * Synchronous spawn: the projector runs before the CLI returns. ~20ms
 * latency budget per call.
 */

import { spawnSync } from "node:child_process";
import { coordBinPath } from "./coord-bin.ts";
import { resolveCoordRoot } from "./coord-client.ts";

import type { LiveCoordinationObservationV2 } from "../events/v2/live-observation.ts";

export type EventV2EmitObservation =
  | LiveCoordinationObservationV2
  | {
      event_type: "coord.lifecycle_changed";
      new_state: "active" | "blocked" | "done";
      reason?: string;
      suggested_session_name?: string;
    };

export interface EventV2EmitInput {
  owner: string;
  session: string;
  adapter: "claude-code" | "cursor" | "codex";
  observation: EventV2EmitObservation;
}

/**
 * Resolve the coord root for a canonical emit.
 *
 * Delegates to `resolveCoordRoot()`, the single resolution the hooks and the
 * CLI's reads also use. An observation resolved any other way can disappear
 * from the live V2 generation even though the command itself succeeded.
 */
export function resolveEmitRoot(start: string = process.cwd()): string | null {
  return resolveCoordRoot(start);
}

export function emitEventV2(input: EventV2EmitInput): boolean {
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
      timeout: 3000,
      cwd: root,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    if (result.error || result.status !== 0) {
      const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
      const why = result.error
        ? result.error.message
        : `exit ${result.status}${detail ? `: ${detail}` : ""}`;
      process.stderr.write(`emitEventV2: ${input.observation.event_type} emit failed (${why})\n`); // lint-ok-emission: soft-fail diagnostic promised by the module doc; silent drops cost blocked turns
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
export function normalizeAdapter(platform: string | undefined): "claude-code" | "cursor" | "codex" {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return "claude-code";
}
