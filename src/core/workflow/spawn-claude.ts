/**
 * claude-code spawn adapter: runs one subagent as a headless `claude -p`
 * subprocess with `--output-format json` and unwraps the result envelope.
 *
 * Two hard-won rules from the Phase 1 spike, both load-bearing:
 *
 * 1. **Scrub inherited `CLAUDE*` env vars — delete, don't blank.** A workflow
 *    launched from inside a Claude Code session inherits session env that makes
 *    the nested CLI exit 1 with empty output. Setting a var to "" still reads
 *    as set; only deletion works.
 * 2. **Mark the child as a workflow child instead of disabling hooks.** With
 *    the host repo's hooks active, the coordination Stop hook blocks a headless
 *    child for skipping the end-of-turn ritual (observed: num_turns burned on
 *    re-prompts → error_max_turns). `--settings '{"disableAllHooks":true}'`
 *    fixes that but also kills the coord capture that makes workflow children
 *    visible to peers — the point of running them under harnery. So the child
 *    gets HARNERY_WORKFLOW_CHILD=1 and the stop-hook rule exempts it
 *    (stop-hook.ts), keeping heartbeats + events on.
 */

import { exec } from "../../lib/exec.ts";
import { buildChildEnv } from "./child-env.ts";
import { notFoundError } from "./harnesses.ts";
import type { Spawner, SpawnRequest, SpawnResult } from "./types.ts";

interface ClaudeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  errors?: string[];
}

export const claudeCodeSpawner: Spawner = async (req: SpawnRequest): Promise<SpawnResult> => {
  const t0 = Date.now();

  const argv = [
    "claude",
    "-p",
    req.prompt,
    "--output-format",
    "json",
    "--max-turns",
    String(req.maxTurns),
  ];
  if (req.model) argv.push("--model", req.model);

  const r = await exec(argv, {
    cwd: req.cwd,
    env: buildChildEnv(req.runId, { subscriptionOnly: req.subscriptionOnly }),
    timeout: req.timeoutMs,
  });
  const durationMs = Date.now() - t0;

  if (r.exitCode === 127) {
    return { ok: false, text: "", durationMs, error: notFoundError("claude-code") };
  }
  if (r.exitCode !== 0) {
    return {
      ok: false,
      text: "",
      durationMs,
      error: `claude exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
    };
  }

  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(r.stdout) as ClaudeEnvelope;
  } catch {
    return {
      ok: false,
      text: "",
      durationMs,
      error: `result envelope was not JSON: ${r.stdout.slice(0, 300)}`,
    };
  }

  if (envelope.is_error) {
    return {
      ok: false,
      text: String(envelope.result ?? ""),
      sessionId: envelope.session_id,
      costUsd: envelope.total_cost_usd,
      durationMs,
      error: `harness error (${envelope.subtype ?? "unknown"}): ${(envelope.errors ?? []).join("; ") || "see envelope"}`,
    };
  }

  return {
    ok: true,
    text: String(envelope.result ?? ""),
    sessionId: envelope.session_id,
    costUsd: envelope.total_cost_usd,
    durationMs,
  };
};
