/**
 * `schedule list` and `schedule show <id>`: every schedule from every source
 * in one list (ADR 0271), always with each source's coverage so a source that
 * could not be read is never mistaken for one with no schedules.
 */

import type { Command } from "commander";
import { defaultEmit, type EmitContext } from "../../commander.ts";
import { resolveCoordRoot } from "../../core/agents/coord-client.ts";
import { resolveBinName, resolveTimeZone } from "../../core/config.ts";
import {
  describeScheduleAgent,
  describeScheduleEnrollment,
  describeScheduleWork,
  formatScheduleCommand,
  formatScheduleDuration,
} from "../../core/schedule/describe-work.ts";
import {
  type ReadAllSchedulesOptions,
  readAllSchedules,
  type ScheduleList,
} from "../../core/schedule/registry.ts";
import {
  SCHEDULE_SOURCES,
  type ScheduleHarneryJob,
  type ScheduleRecord,
  type ScheduleSource,
  type ScheduleSourceCoverage,
  type ScheduleTrigger,
  type ScheduleWork,
} from "../../core/schedule/types.ts";
import { table } from "../../lib/format.ts";

/** Test seams: everything `readAllSchedules` takes, plus the coordination root. */
export type ScheduleListDeps = Partial<ReadAllSchedulesOptions>;

function isSource(value: string): value is ScheduleSource {
  return (SCHEDULE_SOURCES as readonly string[]).includes(value);
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function formatWhen(iso: string | null, zone: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
    timeZone: zone,
  });
}

function formatTrigger(trigger: ScheduleTrigger, zone: string): string {
  switch (trigger.kind) {
    case "once":
      return `once ${formatWhen(trigger.at, zone)}`;
    case "interval": {
      const minutes = trigger.everyMs / 60_000;
      return Number.isInteger(minutes) ? `every ${minutes}m` : `every ${trigger.everyMs}ms`;
    }
    case "cron":
      return trigger.zone ? `cron ${trigger.expr} (${trigger.zone})` : `cron ${trigger.expr}`;
    case "rrule":
      return `rrule ${trigger.rule}`;
    case "event":
      return `on ${trigger.description}`;
  }
}

function formatLastRun(record: ScheduleRecord, zone: string): string {
  if (!record.last_run) return "-";
  return record.last_run.at
    ? `${formatWhen(record.last_run.at, zone)} ${record.last_run.status}`
    : record.last_run.status;
}

function formatEnabled(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}

function formatCreatedBy(record: ScheduleRecord): string {
  const by = record.created_by;
  if (!by) return "-";
  return by.agent_name ?? by.instance_id;
}

/** The `schedule show` lines for what a schedule runs: commands, then the agent and prompt. */
function workLines(work: ScheduleWork): string[] {
  const lines = [`runs:        ${describeScheduleWork(work)}`];
  work.commands.forEach((cmd, i) => {
    const extra = [
      cmd.env.length > 0 ? `env names ${cmd.env.join(", ")}` : null,
      cmd.finding_exit_codes.length > 0
        ? `finding exit codes ${cmd.finding_exit_codes.join(", ")}`
        : null,
    ].filter(Boolean);
    const label = cmd.name ? `${cmd.name}: ` : "";
    lines.push(
      `  ${i + 1}. ${label}${formatScheduleCommand(cmd)}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}`,
    );
  });
  if (work.agent) {
    lines.push(`agent:       ${describeScheduleAgent(work.agent)}`, "prompt:");
    for (const line of work.agent.prompt.split("\n")) lines.push(`  ${line}`);
  } else {
    lines.push("agent:       none (commands only, no model tokens)");
  }
  if (work.redacted)
    lines.push("redacted:    yes; values that look like secrets are shown as ‹redacted›");
  return lines;
}

/** The `schedule show` lines for a Harnery job: enrollment, limits, newest run. */
function harneryJobLines(record: ScheduleRecord, job: ScheduleHarneryJob, zone: string): string[] {
  const lines: string[] = [];
  const e = job.enrollment;
  lines.push(
    `enrollment:  ${describeScheduleEnrollment(record, job)} [${e.state}${e.enrolled_at ? `, enrolled ${formatWhen(e.enrolled_at, zone)}` : ""}]`,
    `owner:       ${job.owner ?? "-"}`,
    `timeout:     ${job.timeout_minutes} min`,
    `daily limit: ${job.max_launches_per_day} launches`,
    `time zone:   ${job.zone}`,
  );
  const run = job.latest_run;
  if (run) {
    const codes = run.commands.map((c) => `${c.name}=${c.exit_code ?? "none"}`).join(", ");
    lines.push(
      `newest run:  ${run.result}, ${run.kind}, started ${formatWhen(run.started_at, zone)}, took ${formatScheduleDuration(run.duration_ms)}`,
    );
    if (codes) lines.push(`exit codes:  ${codes}`);
    if (run.agent)
      lines.push(
        `run agent:   ${run.agent.adapter} ${run.agent.ok ? "ok" : "failed"}, status ${run.agent.status_line}`,
      );
    lines.push(`last report: ${run.report_path ?? "-"}`);
  } else {
    lines.push("newest run:  -");
  }
  return lines;
}

function coverageText(coverage: readonly ScheduleSourceCoverage[]): string {
  const rows = coverage.map((row) => ({
    source: row.source,
    state: row.state,
    account: row.account,
    detail: row.detail ?? "",
  }));
  return `Coverage\n${table(rows, { maxColWidth: 100 })}\n`;
}

function coordRootFor(deps: ScheduleListDeps, emit: EmitContext): string | null {
  const coordRoot = deps.coordRoot ?? resolveCoordRoot();
  if (!coordRoot) {
    emit.error({ code: "no_coord_root", message: "no .harnery/ coordination root found" });
    emit.setExitCode(1);
    return null;
  }
  return coordRoot;
}

async function readList(coordRoot: string, deps: ScheduleListDeps): Promise<ScheduleList> {
  return readAllSchedules({ ...deps, coordRoot });
}

/** Split `source:id` when the prefix names a source; otherwise the whole text is the id. */
export function parseScheduleRef(ref: string): { source?: ScheduleSource; id: string } {
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const prefix = ref.slice(0, colon);
    if (isSource(prefix)) return { source: prefix, id: ref.slice(colon + 1) };
  }
  return { id: ref };
}

/** Attach `list` and `show` to the `schedule` command. */
export function registerScheduleListCommands(
  schedule: Command,
  emit: EmitContext = defaultEmit,
  deps: ScheduleListDeps = {},
): void {
  schedule
    .command("list")
    .description("List schedules from every source, with each source's coverage.")
    .option(
      "--source <name>",
      `Only records from this source (repeatable): ${SCHEDULE_SOURCES.join(", ")}`,
      collect,
    )
    .option("--json", "Emit records and coverage as JSON")
    .action(async (opts: { source?: string[]; json?: boolean }) => {
      const coordRoot = coordRootFor(deps, emit);
      if (!coordRoot) return;
      const wanted = opts.source ?? [];
      const unknown = wanted.filter((s) => !isSource(s));
      if (unknown.length > 0) {
        emit.error({
          code: "bad_schedule_source",
          message: `unknown source ${unknown.map((s) => JSON.stringify(s)).join(", ")}`,
          hint: `Sources: ${SCHEDULE_SOURCES.join(", ")}`,
        });
        emit.setExitCode(1);
        return;
      }
      const list = await readList(coordRoot, deps);
      const records =
        wanted.length === 0
          ? list.records
          : list.records.filter((r) => (wanted as string[]).includes(r.source));
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data({ records, coverage: list.coverage });
        return;
      }
      const zone = resolveTimeZone(coordRoot);
      const lines: string[] = [];
      if (records.length === 0) {
        lines.push("No schedules found in the sources that could be read.\n");
      } else {
        const rows = records.map((r) => ({
          source: r.source,
          title: r.title || r.id,
          trigger: formatTrigger(r.trigger, zone),
          "next run": formatWhen(r.next_run_at, zone),
          "last run": formatLastRun(r, zone),
          enabled: formatEnabled(r.enabled),
          "created by": formatCreatedBy(r),
        }));
        lines.push(`${table(rows)}\n`);
      }
      lines.push(`\n${coverageText(list.coverage)}`);
      lines.push(
        `\nOne schedule in full: ${resolveBinName(coordRoot)} schedule show <source:id>\n`,
      );
      emit.text(lines.join(""));
    });

  schedule
    .command("show <id>")
    .description("Show one schedule in full; use source:id when an id is in more than one source.")
    .option("--json", "Emit the record as JSON")
    .action(async (ref: string, opts: { json?: boolean }) => {
      const coordRoot = coordRootFor(deps, emit);
      if (!coordRoot) return;
      const bin = resolveBinName(coordRoot);
      const { source, id } = parseScheduleRef(ref);
      const list = await readList(coordRoot, deps);
      const matches = list.records.filter(
        (r) => r.id === id && (source === undefined || r.source === source),
      );
      if (matches.length === 0) {
        const unread = list.coverage.filter((c) => c.state !== "current");
        emit.error({
          code: "schedule_not_found",
          message: `no schedule with id ${JSON.stringify(ref)}`,
          hint:
            unread.length > 0
              ? `Not every source was read: ${unread.map((c) => `${c.source} ${c.state}`).join(", ")}. See ${bin} schedule list.`
              : `See ${bin} schedule list.`,
        });
        emit.setExitCode(1);
        return;
      }
      if (matches.length > 1) {
        emit.error({
          code: "schedule_ambiguous",
          message: `${matches.length} schedules have id ${JSON.stringify(id)}: ${matches.map((r) => `${r.source}:${r.id}`).join(", ")}`,
          hint: `Name one as ${bin} schedule show <source:id>.`,
        });
        emit.setExitCode(1);
        return;
      }
      const record = matches[0] as ScheduleRecord;
      const coverage = list.coverage.find((c) => c.source === record.source) ?? null;
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data({ record, coverage });
        return;
      }
      const zone = resolveTimeZone(coordRoot);
      const by = record.created_by;
      const lines = [
        `source:      ${record.source}`,
        `account:     ${record.account}`,
        `id:          ${record.id}`,
        `title:       ${record.title || "-"}`,
        `trigger:     ${formatTrigger(record.trigger, zone)}`,
        `raw trigger: ${record.trigger.raw || "-"}`,
        `runs on:     ${record.runs_on.host}${record.runs_on.project ? `, project ${record.runs_on.project}` : ""}${record.runs_on.thread ? `, thread ${record.runs_on.thread}` : ""}`,
        `enabled:     ${formatEnabled(record.enabled)}`,
        `next run:    ${formatWhen(record.next_run_at, zone)}`,
        `last run:    ${formatLastRun(record, zone)}`,
        `created by:  ${by ? `${by.agent_name ?? by.instance_id}${by.task ? ` (${by.task})` : ""}, seen ${formatWhen(by.observed_at, zone)}` : "-"}`,
      ];
      if (record.work) lines.push(...workLines(record.work));
      else lines.push("runs:        - (the source does not say)");
      if (record.job) lines.push(...harneryJobLines(record, record.job, zone));
      if (coverage) {
        lines.push(
          `coverage:    ${coverage.state}${coverage.detail ? ` (${coverage.detail})` : ""}`,
        );
      }
      emit.text(`${lines.join("\n")}\n`);
    });
}
