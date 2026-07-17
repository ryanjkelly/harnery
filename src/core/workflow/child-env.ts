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
 * 2. **Mark the child as a workflow child** (HARNERY_WORKFLOW_CHILD=1): the
 *    stop-hook rule exempts it from the human-facing end-of-turn ritual while
 *    hooks stay on, keeping heartbeat + event capture.
 * 3. **Stamp the run id** (HARNERY_WORKFLOW_RUN_ID) so the coord layer and
 *    web UI can associate child sessions with their workflow run.
 */

const SCRUB_PREFIXES = ["CLAUDE", "CODEX", "CURSOR"];

export function buildChildEnv(runId?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SCRUB_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  env.HARNERY_WORKFLOW_CHILD = "1";
  if (runId) env.HARNERY_WORKFLOW_RUN_ID = runId;
  return env;
}
