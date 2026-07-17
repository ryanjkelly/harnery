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
import { buildChildEnv } from "./child-env.ts";
import { notFoundError } from "./harnesses.ts";
import type { Spawner, SpawnRequest, SpawnResult } from "./types.ts";

export const codexSpawner: Spawner = async (req: SpawnRequest): Promise<SpawnResult> => {
  const t0 = Date.now();
  const outFile = join(
    tmpdir(),
    `harnery-codex-${process.pid}-${randomBytes(4).toString("hex")}.txt`,
  );

  const argv = [
    "codex",
    "exec",
    req.prompt,
    "--output-last-message",
    outFile,
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
  ];
  if (req.model) argv.push("--model", req.model);

  try {
    const r = await exec(argv, {
      cwd: req.cwd,
      env: buildChildEnv(req.runId, { subscriptionOnly: req.subscriptionOnly }),
      timeout: req.timeoutMs,
    });
    const durationMs = Date.now() - t0;

    if (r.exitCode === 127) {
      return { ok: false, text: "", durationMs, error: notFoundError("codex") };
    }
    if (r.exitCode !== 0) {
      return {
        ok: false,
        text: "",
        durationMs,
        error: `codex exited ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
      };
    }

    if (!existsSync(outFile)) {
      // Exit 0 but no last-message file: fall back to stdout (contract drift guard).
      return { ok: true, text: r.stdout, durationMs };
    }
    return { ok: true, text: readFileSync(outFile, "utf8").trim(), durationMs };
  } finally {
    rmSync(outFile, { force: true });
  }
};
