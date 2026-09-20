/**
 * opencode spawn adapter: runs one subagent as a headless `opencode run`
 * subprocess with `--format json`.
 *
 * Contract notes (verified 2026-09-20 against opencode v2.0.11: a
 * `--format json` run streams NDJSON parts and a `PONG` probe round-trips):
 * - `opencode run --format json --model <provider/model#variant> "<prompt>"`
 *   prints one JSON object per line (NDJSON). Each line carries `sessionID`;
 *   the assistant answer is the concatenation of `type:"text"` parts.
 * - `--title` names the session; the final text is assembled from the stream
 *   rather than a single result envelope (there is no `type:"result"` line).
 * - `run` connects to the shared background service by default; a workflow
 *   child inherits whatever service is discovered, matching interactive runs.
 * - No per-run cost surface in the stream (cost lives in `session export`) →
 *   left undefined. No max-turns equivalent → `maxTurns` accepted and ignored.
 * - OpenCode selects reasoning through the model id variant, so there is no
 *   effort flag; `effortValues` is empty and a supplied effort is rejected.
 */

import { exec } from "../../lib/exec.ts";
import { builtinAdapterProfile, validateAdapterEffort } from "../adapters/profiles.ts";
import type { AdapterInvocation, AdapterRawResult } from "../adapters/types.ts";
import { notFoundError } from "./adapters.ts";
import { buildChildEnv } from "./child-env.ts";
import { resolveSandboxProjection } from "./sandbox-projection.ts";
import { isUpstreamFailureText, vendorFailureText } from "./spawn-failure.ts";
import type { Spawner, SpawnRequest, SpawnResult } from "./types.ts";

interface OpenCodeStreamPart {
  type?: string;
  sessionID?: string;
  part?: { type?: string; text?: string };
}

/**
 * Parse the NDJSON `opencode run --format json` stream into the final answer
 * text and the session id. Exported for unit tests (no live binary needed).
 *
 * Tolerant by contract: non-JSON lines (a stray log line) are skipped, and the
 * text is the ordered concatenation of every `text` part so a multi-part answer
 * is preserved.
 */
export function parseOpenCodeStream(stdout: string): {
  text: string;
  sessionId?: string;
} {
  let sessionId: string | undefined;
  const chunks: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: OpenCodeStreamPart;
    try {
      parsed = JSON.parse(trimmed) as OpenCodeStreamPart;
    } catch {
      continue;
    }
    if (!sessionId && typeof parsed.sessionID === "string" && parsed.sessionID.length > 0) {
      sessionId = parsed.sessionID;
    }
    if (parsed.type === "text" && typeof parsed.part?.text === "string") {
      chunks.push(parsed.part.text);
    }
  }
  return { text: chunks.join("").trim(), sessionId };
}

export function buildOpenCodeInvocation(req: SpawnRequest): AdapterInvocation {
  validateAdapterEffort("opencode", req.effort);
  if (req.filesystemPolicy) {
    // Declared unrepresentable: refuse rather than drop it silently (ADR 0039).
    resolveSandboxProjection(
      "opencode",
      builtinAdapterProfile("opencode")?.sandboxProjection,
      req.filesystemPolicy,
    );
  }
  // `--auto` auto-approves permissions that are not explicitly denied, which a
  // headless workflow child needs because it has no interactive approval
  // channel; it does not map host policy into child tools (unsupported).
  const argv = ["opencode", "run", "--format", "json", "--auto"];
  if (req.model) argv.push("--model", req.model);
  argv.push(req.prompt);
  return { argv };
}

export function normalizeOpenCodeResult(raw: AdapterRawResult): SpawnResult {
  if (raw.timedOut) {
    return {
      ok: false,
      text: "",
      durationMs: raw.durationMs,
      error: `opencode timed out after ${raw.durationMs}ms and was killed`,
    };
  }
  // Structural environment signal: the binary was never there (spawned directly,
  // so a missing binary surfaces as ENOENT). Uncharged and not retried.
  if (raw.spawnErrno === "ENOENT") {
    return {
      ok: false,
      text: "",
      durationMs: raw.durationMs,
      error: notFoundError("opencode"),
      class: "environment",
    };
  }
  if (raw.exitCode === 127) {
    // A bare 127 with no errno is a shell/vendor 127, indistinguishable from a
    // legitimate one — charged as work rather than classed environment.
    return { ok: false, text: "", durationMs: raw.durationMs, error: notFoundError("opencode") };
  }
  if (raw.exitCode !== 0) {
    const failureText = vendorFailureText(raw);
    return {
      ok: false,
      text: "",
      durationMs: raw.durationMs,
      error: `opencode exited ${raw.exitCode}: ${failureText}`,
      ...(isUpstreamFailureText(failureText) ? { class: "upstream" as const } : {}),
    };
  }

  const parsed = parseOpenCodeStream(raw.stdout);
  return {
    ok: true,
    text: parsed.text,
    sessionId: parsed.sessionId,
    durationMs: raw.durationMs,
  };
}

export const openCodeSpawner: Spawner = async (req: SpawnRequest): Promise<SpawnResult> => {
  const t0 = Date.now();
  let invocation: AdapterInvocation;
  try {
    invocation = buildOpenCodeInvocation(req);
  } catch (error) {
    return { ok: false, text: "", durationMs: 0, error: (error as Error).message };
  }

  const r = await exec(invocation.argv, {
    cwd: req.cwd,
    env: buildChildEnv(req.runId, {
      subscriptionOnly: req.subscriptionOnly,
      agentId: req.agentId,
    }),
    timeout: req.timeoutMs,
  });
  return normalizeOpenCodeResult({ ...r, durationMs: Date.now() - t0 });
};
