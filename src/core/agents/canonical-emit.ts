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
import { monorepoRoot } from "./coord-client.ts";

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

/**
 * Resolve the coord root for a canonical emit.
 *
 * Order: explicit `HARNERY_COORD_ROOT_OVERRIDE` → git-superproject-aware
 * `monorepoRoot()` (must actually carry `.harnery/`) → cwd walk (non-git
 * hosts). The git-aware step is load-bearing: a shell cd'd into a nested
 * directory that carries its own `.harnery/` (e.g. an embedded harnery
 * checkout) made the old cwd-walk resolve the NESTED root, from which
 * `<root>/harnery/bin/agent-coord` doesn't exist — so `agents status` /
 * `set-task` emits silently vanished and the Stop-hook's rule 1/3
 * (`state.status_checked` in-turn) blocked turns that had done the ritual.
 * Same bug class as the coordHelperOpts root-pin fix; this closes the
 * emitCanonical instance of it.
 */
export function resolveEmitRoot(start: string = process.cwd()): string | null {
  const override = process.env.HARNERY_COORD_ROOT_OVERRIDE;
  if (override) return override;
  // Memoized per start-dir: the session-tee middleware resolves once per
  // emitted event, and monorepoRoot() spawns git — cache so a streaming
  // command doesn't pay 1-3 subprocess spawns per output line.
  if (cachedRoot && cachedRoot.start === start) return cachedRoot.root;
  const gitRoot = monorepoRoot();
  const root =
    gitRoot && existsSync(join(gitRoot, ".harnery")) ? gitRoot : findRepoRoot(start);
  cachedRoot = { start, root };
  return root;
}

let cachedRoot: { start: string; root: string | null } | undefined;

export function emitCanonical(input: CanonicalEmitInput): void {
  const root = resolveEmitRoot();
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
 * `claude_code`) to the canonical kebab-case Harness type.
 */
export function normalizeHarness(platform: string | undefined): "claude-code" | "cursor" | "codex" {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return "claude-code";
}

function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".harnery"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
