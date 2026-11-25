/**
 * Plain-words descriptions of a Harnery job's `job` record part, shared by
 * `schedule show` and the dashboard so both say the same thing. Pure: no
 * file or process access.
 */

import type { ScheduleHarneryAgent, ScheduleHarneryJob, ScheduleRecord } from "./types.ts";

/** One argv as a shell-like line; arguments with spaces or quotes are double-quoted. */
export function formatScheduleArgv(argv: readonly string[]): string {
  return argv
    .map((arg) => (arg === "" || /[\s"'\\$`]/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");
}

/** "codex agent (gpt-5, medium)"; adapter defaults are named as such. */
export function describeScheduleAgent(agent: ScheduleHarneryAgent): string {
  const parts = [agent.model ?? "default model", agent.effort ?? "default effort"];
  return `${agent.adapter} agent (${parts.join(", ")})`;
}

/**
 * One line saying what the job runs and whether it starts an agent, such as
 * "Runs a script: scripts/x.sh · no AI agent" or "Runs 3 commands, then a
 * codex agent (gpt-5, medium) judges the output".
 */
export function describeScheduleJobWork(job: ScheduleHarneryJob): string {
  const n = job.commands.length;
  const first = job.commands[0];
  const commands =
    n === 1 && first
      ? `Runs a script: ${first.argv[0] ?? first.name}`
      : n > 1
        ? `Runs ${n} commands`
        : null;
  if (!job.agent) {
    return commands ? `${commands} · no AI agent` : "Runs nothing: no commands and no agent";
  }
  const agent = describeScheduleAgent(job.agent);
  return commands
    ? `${commands}, then a ${agent} judges the output`
    : `Starts a ${agent} · no commands run first`;
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
