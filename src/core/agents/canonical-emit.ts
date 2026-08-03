/**
 * Emit canonical events by spawning `agent-coord emit-event`. Used by every
 * `agents …` / `journal` / `presence` write that has a canonical state event.
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

export interface CanonicalEmitInput {
  type: string;
  owner: string;
  session: string;
  adapter: "claude-code" | "cursor" | "codex";
  data: Record<string, unknown>;
  turnId?: string;
  parentSessionId?: string;
  parentTurnId?: string;
}

/**
 * Resolve the coord root for a canonical emit.
 *
 * Delegates to `resolveCoordRoot()`, the single resolution the hooks and the
 * CLI's reads also use. An emit resolved any other way is an emit the Stop hook
 * cannot see: the hook reads `state.status_checked` from the stream under ITS
 * root, so a divergent emit root blocks rule 1/3 on a turn that did run
 * `agents status`, and no sequence of CLI commands can satisfy it.
 */
export function resolveEmitRoot(start: string = process.cwd()): string | null {
  return resolveCoordRoot(start);
}

export function emitCanonical(input: CanonicalEmitInput): void {
  const root = resolveEmitRoot();
  if (!root) return;
  const binary = coordBinPath("agent-coord", root);
  if (!binary) return;
  try {
    const args = [
      "emit-event",
      "--type",
      input.type,
      "--owner",
      input.owner,
      "--session",
      input.session,
      "--adapter",
      input.adapter,
      "--data-json",
      JSON.stringify(input.data),
    ];
    if (input.turnId) args.push("--turn-id", input.turnId);
    if (input.parentSessionId) args.push("--parent-session-id", input.parentSessionId);
    if (input.parentTurnId) args.push("--parent-turn-id", input.parentTurnId);
    // Pin cwd + HARNERY_COORD_ROOT_OVERRIDE so the child writes to the SAME
    // stream we resolved, regardless of where the caller's shell is cd'd.
    const result = spawnSync(binary, args, {
      encoding: "utf8",
      stdio: "ignore",
      timeout: 3000,
      cwd: root,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    if (result.error || result.status !== 0) {
      const why = result.error ? result.error.message : `exit ${result.status}`;
      process.stderr.write(`emitCanonical: ${input.type} emit failed (${why})\n`); // lint-ok-emission: soft-fail diagnostic promised by the module doc; silent drops cost blocked turns
    }
  } catch {
    /* never break the caller */
  }
}

/**
 * Normalize the heartbeat's `platform` field (which uses snake_case
 * `claude_code`) to the canonical kebab-case Adapter type.
 */
export function normalizeAdapter(platform: string | undefined): "claude-code" | "cursor" | "codex" {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return "claude-code";
}
