/**
 * Plain-words descriptions of a record's `work` (what a schedule runs) and a
 * Harnery job's `job` part, shared by `schedule show` and the dashboard so
 * both say the same thing. Pure: no file or process access.
 */

import type {
  ScheduleAgent,
  ScheduleCommand,
  ScheduleHarneryJob,
  ScheduleRecord,
  ScheduleWork,
} from "./types.ts";

/** One argv as a shell-like line; arguments with spaces or quotes are double-quoted. */
export function formatScheduleArgv(argv: readonly string[]): string {
  return argv
    .map((arg) => (arg === "" || /[\s"'\\$`]/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");
}

/** A command as one line: its argv quoted, or its stored line unchanged. */
export function formatScheduleCommand(command: ScheduleCommand): string {
  return command.argv !== null ? formatScheduleArgv(command.argv) : (command.line ?? "");
}

/** Programs that only start the one that matters (`bash x.sh`, `env A=1 node y.js`). */
const LAUNCHERS = new Set([
  "env",
  "nice",
  "ionice",
  "nohup",
  "timeout",
  "flock",
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "ruby",
  "perl",
  "npx",
  "bunx",
  "exec",
]);

function baseName(path: string): string {
  const trimmed = path.replace(/^["']|["']$/g, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * The program a command is really about: the first word that is not a
 * launcher, a flag, a number or a `NAME=value`, by its base name. `bash
 * /x/local-dev-heal.sh` gives `local-dev-heal.sh`; `sh -c "cd /a && ./go"`
 * gives `go`.
 */
export function scheduleCommandHeadline(command: ScheduleCommand): string {
  const text = command.argv !== null ? command.argv.join(" ") : (command.line ?? "");
  const words = text.split(/\s+|&&|\|\||;|\|/).filter((w) => w.trim().length > 0);
  let afterCd = false;
  for (const raw of words) {
    const word = raw.trim().replace(/^["'(]+|["')]+$/g, "");
    const skipDir = afterCd;
    afterCd = word === "cd";
    if (skipDir || afterCd || word.length === 0) continue;
    if (word.startsWith("-") || /^\d+$/.test(word)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    const name = baseName(word);
    if (LAUNCHERS.has(name) || /^python\d/.test(name)) continue;
    return name;
  }
  return command.name ?? "a command";
}

/** "codex agent (gpt-5, medium)"; adapter defaults are named as such. */
export function describeScheduleAgent(agent: ScheduleAgent): string {
  const parts = [agent.model ?? "default model", agent.effort ?? "default effort"];
  return `${agent.adapter} agent (${parts.join(", ")})`;
}

/** The prompt's first non-blank line, cut to `max` characters. */
export function schedulePromptHeadline(prompt: string, max = 80): string {
  const line = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "(empty prompt)";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * One line saying what a schedule runs, such as "Runs: local-dev-heal.sh",
 * "Runs 3 commands, then a codex agent (gpt-5, medium) judges the output" or
 * "Starts a codex agent (gpt-5, high): Check yesterday's failed runs".
 */
export function describeScheduleWork(work: ScheduleWork): string {
  const n = work.commands.length;
  const first = work.commands[0];
  const commands =
    n === 1 && first
      ? `Runs: ${scheduleCommandHeadline(first)}`
      : n > 1
        ? `Runs ${n} commands`
        : null;
  if (!work.agent) return commands ?? "Runs nothing: no commands and no agent";
  const agent = describeScheduleAgent(work.agent);
  return commands
    ? `${commands}, then a ${agent} judges the output`
    : `Starts a ${agent}: ${schedulePromptHeadline(work.agent.prompt)}`;
}

/**
 * Whether the job runs here, in plain words, from the enrollment state the
 * record carries. `record.account` is this machine.
 */
export function describeScheduleEnrollment(
  record: Pick<ScheduleRecord, "account" | "runs_on">,
  job: ScheduleHarneryJob,
): string {
  if (record.runs_on.host !== record.account) {
    return `For host ${record.runs_on.host}; it does not run on this machine (${record.account})`;
  }
  switch (job.enrollment.state) {
    case "enrolled":
      return "Enrolled on this machine and checkout";
    case "not-enrolled":
      return "Not enrolled; it will not run here until enrolled";
    case "changed":
      return "Changed since enrollment; stopped until enrolled again";
    case "wrong-machine":
      return "Enrolled for another machine; it will not run here";
    case "wrong-checkout":
      return "Enrolled for another checkout; it will not run from this one";
  }
}

/** "2m 5s", "41s", "1h 3m"; the run's length from its record. */
export function formatScheduleDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
