/**
 * Builds a record's `work` (what a schedule runs) from a reader's raw
 * commands and prompt. Every reader goes through here, so every command and
 * prompt passes the shared secret redactor before it enters a record and no
 * surface (JSON output, the dashboard, logs, notices) sees unmasked text.
 */

import { redactSecretArgv, redactSecretText } from "../../lib/redact-secrets.ts";
import type { ScheduleAgent, ScheduleCommand, ScheduleWork } from "./types.ts";

/** A command as a reader found it: an argument list or one line of text. */
export type ScheduleRawCommand = {
  name?: string | null;
  env?: readonly string[];
  finding_exit_codes?: readonly number[];
} & ({ argv: readonly string[]; line?: undefined } | { line: string; argv?: undefined });

export interface ScheduleRawWork {
  commands: readonly ScheduleRawCommand[];
  agent: ScheduleAgent | null;
}

/** The redacted `work` for a record. */
export function buildScheduleWork(raw: ScheduleRawWork): ScheduleWork {
  let redacted = false;
  const commands: ScheduleCommand[] = raw.commands.map((cmd) => {
    let argv: string[] | null = null;
    let line: string | null = null;
    if (cmd.argv !== undefined) {
      const r = redactSecretArgv(cmd.argv);
      argv = r.argv;
      redacted ||= r.redacted;
    } else {
      const r = redactSecretText(cmd.line);
      line = r.text;
      redacted ||= r.redacted;
    }
    return {
      name: cmd.name ?? null,
      argv,
      line,
      env: [...(cmd.env ?? [])],
      finding_exit_codes: [...(cmd.finding_exit_codes ?? [])],
    };
  });
  let agent: ScheduleAgent | null = null;
  if (raw.agent) {
    const r = redactSecretText(raw.agent.prompt);
    redacted ||= r.redacted;
    agent = { ...raw.agent, prompt: r.text };
  }
  return { commands, agent, redacted };
}
