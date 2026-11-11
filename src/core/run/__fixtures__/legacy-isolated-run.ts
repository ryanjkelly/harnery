import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A run recorded before ADR 0244 removed isolated workspaces and observer
 * admission. The JSON files keep the exact shape such a run wrote (an
 * isolated `workspace_binding` and `isolation: "worktree"` in `run.json`,
 * plus `execution` and `diagnostic_admission` evidence in `proof.json`), with
 * every path rebased onto `__ROOT__`.
 */
export const LEGACY_ISOLATED_RUN_ID = "wf-2026-11-10T01-51-30-282Z-b78d36";

const FIXTURE_DIR = join(import.meta.dir, "legacy-isolated-run");

export function writeLegacyIsolatedRun(coordRoot: string): string {
  const runDir = join(coordRoot, ".harnery", "workflows", LEGACY_ISOLATED_RUN_ID);
  mkdirSync(runDir, { recursive: true });
  // JSON-escape the root so a Windows path's backslashes stay valid JSON.
  const root = JSON.stringify(coordRoot).slice(1, -1);
  for (const file of ["run.json", "proof.json"]) {
    const body = readFileSync(join(FIXTURE_DIR, file), "utf8").replaceAll("__ROOT__", root);
    writeFileSync(join(runDir, file), body, "utf8");
  }
  writeFileSync(
    join(runDir, "transcript.jsonl"),
    `${JSON.stringify({ ts: "2026-11-10T01:51:30.300Z", event: "run.start", name: "legacy-isolated" })}\n` +
      `${JSON.stringify({ ts: "2026-11-10T01:51:30.400Z", event: "run.parked", approval_id: "apr-legacy" })}\n`,
    "utf8",
  );
  return LEGACY_ISOLATED_RUN_ID;
}
