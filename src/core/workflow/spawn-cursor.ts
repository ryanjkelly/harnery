/**
 * cursor spawn adapter: runs one subagent as a headless `cursor-agent -p`
 * subprocess with `--output-format json`.
 *
 * Contract notes (per upstream docs; NOT yet verified against a live binary —
 * no cursor-agent install on the authoring machine; re-verify on first use):
 * - `cursor-agent -p "<prompt>" --output-format json` prints a single result
 *   envelope modeled on Claude Code's (`{type: "result", is_error, result,
 *   session_id, …}`).
 * - Envelope drift guard: when stdout doesn't parse as JSON but the process
 *   exited 0, the raw stdout is returned as the reply text.
 * - No per-run cost surface → undefined. No max-turns equivalent → `maxTurns`
 *   accepted and ignored (documented in the CLI docs page).
 */

import { exec } from "../../lib/exec.ts";
import { buildChildEnv } from "./child-env.ts";
import type { Spawner, SpawnRequest, SpawnResult } from "./types.ts";

interface CursorEnvelope {
  type?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

/** Exported for unit tests (no live binary to test against). */
export function parseCursorOutput(stdout: string): {
  text: string;
  sessionId?: string;
  isError: boolean;
} {
  try {
    const envelope = JSON.parse(stdout) as CursorEnvelope;
    return {
      text: String(envelope.result ?? ""),
      sessionId: envelope.session_id,
      isError: Boolean(envelope.is_error),
    };
  } catch {
    return { text: stdout, isError: false };
  }
}

export const cursorSpawner: Spawner = async (req: SpawnRequest): Promise<SpawnResult> => {
  const t0 = Date.now();

  const argv = ["cursor-agent", "-p", req.prompt, "--output-format", "json"];
  if (req.model) argv.push("--model", req.model);

  const r = await exec(argv, {
    cwd: req.cwd,
    env: buildChildEnv(req.runId, { subscriptionOnly: req.subscriptionOnly }),
    timeout: req.timeoutMs,
  });
  const durationMs = Date.now() - t0;

  if (r.exitCode === 127) {
    return { ok: false, text: "", durationMs, error: "cursor-agent CLI not found on PATH" };
  }
  if (r.exitCode !== 0) {
    return {
      ok: false,
      text: "",
      durationMs,
      error: `cursor-agent exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
    };
  }

  const parsed = parseCursorOutput(r.stdout);
  if (parsed.isError) {
    return {
      ok: false,
      text: parsed.text,
      sessionId: parsed.sessionId,
      durationMs,
      error: `cursor-agent reported is_error: ${parsed.text.slice(0, 300)}`,
    };
  }
  return { ok: true, text: parsed.text, sessionId: parsed.sessionId, durationMs };
};
