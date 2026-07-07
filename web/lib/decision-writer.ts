/**
 * Decision docket write-side. Shells `harnery/bin/harn decision review` so the
 * lifecycle + validation stay in the engine, mirroring council-writer's runHarn.
 * Review is the only write the web UI performs; everything else is agent-side.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { coordRoot } from "./coord-reader";

export interface HelperResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}

// slug-YYYY-MM-DD-hhhh
const DECISION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/;
export function safeDecisionId(id: string): boolean {
  return DECISION_ID_PATTERN.test(id);
}

export const REVIEW_VERDICTS = [
  "ratified",
  "overridden",
  "wrong-tier-high",
  "wrong-tier-low",
] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export function isVerdict(v: string): v is ReviewVerdict {
  return (REVIEW_VERDICTS as readonly string[]).includes(v);
}

async function runHarn(args: string[]): Promise<HelperResult> {
  const root = coordRoot();
  const harnBin = path.join(root, "harnery", "bin", "harn");
  return new Promise((resolve) => {
    const proc = spawn(harnBin, args, {
      cwd: root,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, exit_code: code });
    });
    proc.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: `${stderr}${err.message}`, exit_code: null });
    });
  });
}

export async function reviewDecision(
  id: string,
  verdict: ReviewVerdict,
  note?: string,
): Promise<HelperResult> {
  const args = ["decision", "review", id, "--verdict", verdict];
  if (note?.trim()) args.push("--note", note.trim());
  return runHarn(args);
}

/**
 * Archive a reviewed decision, recording where its output graduated. The
 * lifecycle-terminal exit for the review feed: once you've weighed in and the
 * output has a canonical home, the decision closes into the (still-searchable)
 * archive.
 */
export async function archiveDecision(id: string, graduatedTo?: string): Promise<HelperResult> {
  const args = ["decision", "archive", id];
  if (graduatedTo?.trim()) args.push("--graduated-to", graduatedTo.trim());
  return runHarn(args);
}

/**
 * Reopen an archived decision back to `reviewed` — the inverse of archive, for
 * fixing a fat-fingered graduation or a wrongly-archived decision.
 */
export async function reopenDecision(id: string): Promise<HelperResult> {
  return runHarn(["decision", "reopen", id]);
}
