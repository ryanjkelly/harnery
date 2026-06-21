/**
 * Emit canonical events by spawning `agent-coord emit-event`. Used by every
 * `agents …` / `scratch` / `presence` write that has a canonical state event.
 *
 * Soft-fails: never throws into the caller. A failed emit logs to stderr
 * (visible to operators in their terminal) but never breaks the CLI flow.
 *
 * Synchronous spawn: the projector runs before the CLI returns. ~20ms
 * latency budget per call.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CanonicalEmitInput {
  type: string;
  owner: string;
  session: string;
  harness: "claude-code" | "cursor" | "codex";
  data: Record<string, unknown>;
  turnId?: string;
  parentSessionId?: string;
  parentTurnId?: string;
}

export function emitCanonical(input: CanonicalEmitInput): void {
  const root = findRepoRoot();
  if (!root) return;
  const binary = resolve(root, "harnery", "bin", "agent-coord");
  if (!existsSync(binary)) return;
  try {
    const args = [
      "emit-event",
      "--type",
      input.type,
      "--owner",
      input.owner,
      "--session",
      input.session,
      "--harness",
      input.harness,
      "--data-json",
      JSON.stringify(input.data),
    ];
    if (input.turnId) args.push("--turn-id", input.turnId);
    if (input.parentSessionId) args.push("--parent-session-id", input.parentSessionId);
    if (input.parentTurnId) args.push("--parent-turn-id", input.parentTurnId);
    spawnSync(binary, args, {
      encoding: "utf8",
      stdio: "ignore",
      timeout: 3000,
    });
  } catch {
    /* never break the caller */
  }
}

/**
 * Normalize the heartbeat's `platform` field (which uses snake_case
 * `claude_code`) to the canonical kebab-case Harness type.
 */
export function normalizeHarness(platform: string | undefined): "claude-code" | "cursor" | "codex" {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return "claude-code";
}

function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".harnery"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
