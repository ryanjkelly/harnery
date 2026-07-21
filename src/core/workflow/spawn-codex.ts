/**
 * codex spawn adapter: runs one subagent as a headless `codex exec`
 * subprocess.
 *
 * Contract notes (LIVE-VERIFIED 2026-07-16 against codex-cli 0.144.5: flags
 * present, schema-gated triage + text stages round-trip via `--harness codex`):
 * - `codex exec "<prompt>"` is the non-interactive mode.
 * - The final assistant message is captured via `--output-last-message <file>`
 *   (a temp file), which is far more drift-tolerant than parsing the
 *   experimental `--json` JSONL event stream.
 * - `--skip-git-repo-check` keeps non-repo cwds working; `--sandbox
 *   workspace-write` matches workflow-stage expectations (children may edit).
 * - No per-run cost or session-id surface in this mode → both left undefined.
 * - No max-turns equivalent → `maxTurns` is accepted and ignored (documented
 *   in the CLI docs page).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../lib/exec.ts";
import { validateHarnessEffort } from "../harnesses/profiles.ts";
import type { HarnessInvocation, HarnessRawResult } from "../harnesses/types.ts";
import { buildChildEnv } from "./child-env.ts";
import { notFoundError } from "./harnesses.ts";
import type { Spawner, SpawnRequest, SpawnResult } from "./types.ts";

export function buildCodexInvocation(req: SpawnRequest, resultFile?: string): HarnessInvocation {
  validateHarnessEffort("codex", req.effort);
  if (!resultFile) throw new Error("codex adapter requires a final-message result file");
  const argv = [
    "codex",
    "exec",
    req.prompt,
    "--output-last-message",
    resultFile,
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
  ];
  if (req.model) argv.push("--model", req.model);
  if (req.effort) argv.push("-c", `model_reasoning_effort=${JSON.stringify(req.effort)}`);
  return { argv, resultFile };
}

export function normalizeCodexResult(raw: HarnessRawResult): SpawnResult {
  if (raw.exitCode === 127) {
    return { ok: false, text: "", durationMs: raw.durationMs, error: notFoundError("codex") };
  }
  if (raw.exitCode !== 0) {
    return {
      ok: false,
      text: "",
      durationMs: raw.durationMs,
      error: `codex exited ${raw.exitCode}: ${(raw.stderr || raw.stdout).slice(0, 500)}`,
    };
  }
  return {
    ok: true,
    text: (raw.resultFileText ?? raw.stdout).trim(),
    durationMs: raw.durationMs,
  };
}

export const codexSpawner: Spawner = async (req: SpawnRequest): Promise<SpawnResult> => {
  const t0 = Date.now();
  const outFile = join(
    tmpdir(),
    `harnery-codex-${process.pid}-${randomBytes(4).toString("hex")}.txt`,
  );

  try {
    let invocation: HarnessInvocation;
    try {
      invocation = buildCodexInvocation(req, outFile);
    } catch (error) {
      return { ok: false, text: "", durationMs: 0, error: (error as Error).message };
    }
    const r = await exec(invocation.argv, {
      cwd: req.cwd,
      env: buildChildEnv(req.runId, { subscriptionOnly: req.subscriptionOnly }),
      timeout: req.timeoutMs,
    });
    return normalizeCodexResult({
      ...r,
      durationMs: Date.now() - t0,
      resultFileText: existsSync(outFile) ? readFileSync(outFile, "utf8") : undefined,
    });
  } finally {
    rmSync(outFile, { force: true });
  }
};
