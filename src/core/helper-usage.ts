/**
 * Machine-wide record of helper agents: what each asked for, what it was sent
 * with, and, where the adapter reports it, which model answered. One JSON line
 * per helper turn or `run` worker, in one file per UTC day under
 * `~/.cache/harnery/helpers/` (honors `XDG_CACHE_HOME`).
 *
 * It is deliberately not a coordination event: a helper limit covers every
 * project on the machine, and a project's event ledger covers one.
 *
 * This module imports only Node built-ins, so an adapter plugin can bundle it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HelperUsageLine {
  /** ISO time the line was written. */
  ts: string;
  /** Adapter id, such as `claude-code`. */
  tool: string;
  /** A helper the adapter started itself, or a worker `run` started. */
  kind: "helper" | "run-worker";
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  /** What the request stated before the limit was applied. */
  asked_model?: string;
  asked_effort?: string;
  /** What was sent after the limit was applied. */
  sent_model?: string;
  sent_effort?: string;
  /** The model that answered, when the adapter reports it. */
  answered_model?: string;
  input_tokens?: number;
  output_tokens?: number;
  /** True when the limit changed this helper's model or effort. */
  lowered: boolean;
}

export interface HelperUsageSummary {
  since: string;
  /** Helpers and run workers recorded since `since`. */
  helpers: number;
  lowered: number;
  /** Count per model family or id: the answering model when known, otherwise
   * the model it was sent with, otherwise `unknown`. */
  by_model: Record<string, number>;
}

/** `~/.cache/harnery/helpers`. */
export function helperUsageDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg?.trim() ? xdg : join(homedir(), ".cache");
  return join(base, "harnery", "helpers");
}

/** `usage-YYYY-MM-DD.jsonl` for the UTC day of `ts`. */
export function helperUsageFile(ts: string, dir = helperUsageDir()): string {
  return join(dir, `usage-${ts.slice(0, 10)}.jsonl`);
}

/** Append one line. Never throws: a usage record must not break a helper. */
export function appendHelperUsage(line: HelperUsageLine, dir = helperUsageDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(helperUsageFile(line.ts, dir), `${JSON.stringify(line)}\n`);
  } catch {
    // Best effort by design.
  }
}

/** How long daily files are kept before a read removes them. */
export const HELPER_USAGE_RETENTION_DAYS = 7;

/**
 * Totals since a time, across every project on this machine. Also removes daily
 * files older than `HELPER_USAGE_RETENTION_DAYS`.
 */
export function summarizeHelperUsage(
  _since: Date,
  _options: { dir?: string; now?: Date; tool?: string } = {},
): HelperUsageSummary {
  throw new Error("summarizeHelperUsage: not implemented yet");
}
