/**
 * Child-process environment builder shared by every spawn adapter.
 *
 * Rules (the first is a hard-won Phase 1 spike finding):
 * 1. **Delete inherited adapter-session vars, never blank them.** A nested
 *    adapter CLI under a live session inherits vars that make it exit 1 with
 *    empty output; an empty-string var still reads as set. Scrub all three
 *    families (CLAUDE*, CODEX*, CURSOR*) regardless of which adapter spawns —
 *    a codex child launched from inside a Claude Code session must not inherit
 *    CLAUDE* either. Preserve explicit auth/config locators such as CODEX_HOME:
 *    changing the home silently changes which subscription account the child
 *    uses.
 * 2. **The scrub targets SESSION vars, not credentials or auth locators.** CURSOR_API_KEY
 *    matches the CURSOR* prefix but is an auth credential, so it is carved
 *    out and re-added — a key-only cursor host must keep working. CODEX_HOME
 *    is likewise preserved because codex reads its ChatGPT subscription login
 *    from `$CODEX_HOME/auth.json`. (The other two key vars,
 *    ANTHROPIC_API_KEY and OPENAI_API_KEY, don't collide with the scrub
 *    prefixes.)
 * 3. **subscriptionOnly deletes every API-key var** (see billing.ts) so the
 *    child can only authenticate via its stored subscription login — the
 *    guarantee behind `workflow run --subscription-only`.
 * 4. **Mark the child as a workflow child** (HARNERY_WORKFLOW_CHILD=1): the
 *    stop-hook rule exempts it from the human-facing end-of-turn ritual while
 *    hooks stay on, keeping heartbeat + event capture.
 * 5. **Stamp the run id** (HARNERY_WORKFLOW_RUN_ID) so the coord layer and
 *    web UI can associate child sessions with their workflow run.
 * 6. **Stamp the agent id** (HARNERY_WORKFLOW_AGENT_ID) so that association is
 *    per-agent rather than only per-run. The orchestrator cannot use the child's
 *    session id for this: the adapter mints that id and reports it back only in
 *    the result envelope, which is to say only once the work being watched is
 *    over. Passing in the id the orchestrator already owns is the only way to
 *    attribute in-flight activity to a particular agent.
 *
 * An `allowList` replaces all of the above with a closed environment: only the
 * named variables, the preserved adapter locators, and the values it sets.
 * API-key variables are never copied in that mode, and no workflow marker is
 * added. A caller with no `allowList` gets exactly the rules above.
 */

import { API_KEY_VARS } from "./billing.ts";

const SCRUB_PREFIXES = ["CLAUDE", "CODEX", "CURSOR"];
const PRESERVED_ADAPTER_VARS = new Set(["CODEX_HOME"]);

/** A closed child environment: nothing is inherited unless it is named here. */
export interface ChildEnvAllowList {
  /** Names of the variables taken out of `source` when present (never their values). */
  names: readonly string[];
  /** Values set after copying, such as a child marker. */
  set?: Readonly<Record<string, string>>;
  /** Where the named values come from. Defaults to `process.env`. */
  source?: Readonly<Record<string, string | undefined>>;
}

export interface ChildEnvOpts {
  /** Delete all API-key vars so children can only use stored logins. */
  subscriptionOnly?: boolean;
  /** Transcript agent id (`a1`, `a2`, …) this child is running. */
  agentId?: string;
  /** Build a closed environment instead of copying the parent's (see module note). */
  allowList?: ChildEnvAllowList;
}

/**
 * The closed environment: the allow-listed names plus the adapter locators that
 * name where a stored sign-in and config live (`CODEX_HOME`), never an API-key
 * variable, then the values in `set`.
 */
export function buildAllowListedChildEnv(allowList: ChildEnvAllowList): Record<string, string> {
  const source = allowList.source ?? process.env;
  const keyVars = new Set<string>(Object.values(API_KEY_VARS));
  const env: Record<string, string> = {};
  for (const name of [...allowList.names, ...PRESERVED_ADAPTER_VARS]) {
    if (keyVars.has(name)) continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [k, v] of Object.entries(allowList.set ?? {})) {
    if (!keyVars.has(k)) env[k] = v;
  }
  return env;
}

export function buildChildEnv(runId?: string, opts: ChildEnvOpts = {}): Record<string, string> {
  if (opts.allowList) return buildAllowListedChildEnv(opts.allowList);
  const env: Record<string, string> = {};
  const keyVars = new Set<string>(Object.values(API_KEY_VARS));
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (opts.subscriptionOnly && keyVars.has(k)) continue;
    if (
      SCRUB_PREFIXES.some((p) => k.startsWith(p)) &&
      !keyVars.has(k) &&
      !PRESERVED_ADAPTER_VARS.has(k)
    ) {
      continue;
    }
    env[k] = v;
  }
  env.HARNERY_WORKFLOW_CHILD = "1";
  if (runId) env.HARNERY_WORKFLOW_RUN_ID = runId;
  if (opts.agentId) env.HARNERY_WORKFLOW_AGENT_ID = opts.agentId;
  return env;
}
