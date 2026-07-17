/**
 * Child-process environment builder shared by every spawn adapter.
 *
 * Rules (the first is a hard-won Phase 1 spike finding):
 * 1. **Delete inherited harness-session vars, never blank them.** A nested
 *    harness CLI under a live session inherits vars that make it exit 1 with
 *    empty output; an empty-string var still reads as set. Scrub all three
 *    families (CLAUDE*, CODEX*, CURSOR*) regardless of which adapter spawns —
 *    a codex child launched from inside a Claude Code session must not
 *    inherit CLAUDE* either.
 * 2. **The scrub targets SESSION vars, not credentials.** CURSOR_API_KEY
 *    matches the CURSOR* prefix but is an auth credential, so it is carved
 *    out and re-added — a key-only cursor host must keep working. (The other
 *    two key vars, ANTHROPIC_API_KEY and OPENAI_API_KEY, don't collide with
 *    the scrub prefixes.)
 * 3. **subscriptionOnly deletes every API-key var** (see billing.ts) so the
 *    child can only authenticate via its stored subscription login — the
 *    guarantee behind `workflow run --subscription-only`.
 * 4. **Mark the child as a workflow child** (HARNERY_WORKFLOW_CHILD=1): the
 *    stop-hook rule exempts it from the human-facing end-of-turn ritual while
 *    hooks stay on, keeping heartbeat + event capture.
 * 5. **Stamp the run id** (HARNERY_WORKFLOW_RUN_ID) so the coord layer and
 *    web UI can associate child sessions with their workflow run.
 */

import { API_KEY_VARS } from "./billing.ts";

const SCRUB_PREFIXES = ["CLAUDE", "CODEX", "CURSOR"];

export interface ChildEnvOpts {
  /** Delete all API-key vars so children can only use stored logins. */
  subscriptionOnly?: boolean;
}

export function buildChildEnv(runId?: string, opts: ChildEnvOpts = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const keyVars = new Set<string>(Object.values(API_KEY_VARS));
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (opts.subscriptionOnly && keyVars.has(k)) continue;
    if (SCRUB_PREFIXES.some((p) => k.startsWith(p)) && !keyVars.has(k)) continue;
    env[k] = v;
  }
  env.HARNERY_WORKFLOW_CHILD = "1";
  if (runId) env.HARNERY_WORKFLOW_RUN_ID = runId;
  return env;
}
