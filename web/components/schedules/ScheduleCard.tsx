import { ChevronRight, FileText } from "lucide-react";
import type * as React from "react";

import { AgentChip } from "@/components/AgentChip";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import {
  cleanTitle,
  describeScheduleAgent,
  describeScheduleEnrollment,
  describeScheduleJobWork,
  fileViewerHref,
  formatScheduleArgv,
  formatRunDuration,
  formatTrigger,
  LAST_RUN_LABELS,
  RUN_RESULT_LABELS,
  RUN_RESULT_TONES,
  type ScheduleHarneryJob,
  type ScheduleHistory,
  type ScheduleRecord,
  type ScheduleState,
  SOURCE_META,
  sourceLabel,
} from "@/lib/schedules";
import { TONE } from "@/lib/tone";
import { SourceIcon, StatusGlyph, TriggerGlyph } from "./icons";
import { RelativeTime } from "./RelativeTime";

export interface JobRuns {
  history?: ScheduleHistory;
  error?: string;
}

const STATE_BADGE: Partial<
  Record<ScheduleState, { label: string; tone: "danger" | "warn" | "neutral" }>
> = {
  failed: { label: "Failed", tone: "danger" },
  attention: { label: "Needs attention", tone: "warn" },
  paused: { label: "Paused", tone: "neutral" },
  finished: { label: "Finished", tone: "neutral" },
};

/** One schedule: what it is, what it does, when it runs, and how it last went. */
export function ScheduleCard({
  record,
  state,
  commonHost,
  runs,
}: {
  record: ScheduleRecord;
  state: ScheduleState;
  /** The host the page header names; the card repeats only a different one. */
  commonHost: string | null;
  runs?: JobRuns;
}) {
  const badge = STATE_BADGE[state];
  const inactive = state === "paused" || state === "finished";
  const label = sourceLabel(record);
  const otherHost = record.runs_on.host !== commonHost ? record.runs_on.host : null;
  const accent =
    state === "failed"
      ? cn("border-l-[3px]", TONE.danger.accentBorder)
      : state === "attention"
        ? cn("border-l-[3px]", TONE.warn.accentBorder)
        : null;
  const latest = runs?.history?.rows[0];

  return (
    <article className={cn("min-w-0 rounded-lg border bg-card px-3.5 py-3", accent)}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5">
          {record.source === "captured" ? (
            <Tooltip content={SOURCE_META.captured.hint}>
              <SourceIcon source={record.source} recordId={record.id} />
            </Tooltip>
          ) : (
            <SourceIcon source={record.source} recordId={record.id} />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <h3
            className={cn(
              "min-w-0 break-words text-sm font-medium leading-snug",
              inactive && "text-muted-foreground",
            )}
          >
            {cleanTitle(record)}
          </h3>
          <span className="text-xs text-muted-foreground">
            {label}
            {otherHost ? ` · ${otherHost}` : ""}
          </span>
        </div>
        {badge ? (
          <Badge tone={badge.tone} className="mt-0.5">
            {badge.label}
          </Badge>
        ) : null}
      </div>

      <div className="pl-6">
        {record.description ? (
          <p className="mt-1 text-sm leading-snug text-muted-foreground">{record.description}</p>
        ) : null}

        {record.job ? <JobSummary record={record} job={record.job} /> : null}

        <Timing record={record} inactive={inactive} />

        {runs ? <RecentRuns runs={runs} /> : null}

        {(state === "failed" || state === "attention") && latest?.report_path ? (
          <a
            href={fileViewerHref(latest.report_path)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2 hover:text-foreground"
          >
            <FileText aria-hidden className="size-3.5" />
            Latest report
          </a>
        ) : null}

        <Details record={record} label={label} />
      </div>
    </article>
  );
}

function Timing({ record, inactive }: { record: ScheduleRecord; inactive: boolean }) {
  const t = formatTrigger(record.trigger);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <Tooltip
        content={
          <span className="font-mono break-all">{t.raw || "The source gave no trigger text."}</span>
        }
      >
        <span className="inline-flex cursor-help items-center gap-1.5">
          <TriggerGlyph icon={t.icon} />
          <span>
            {t.text}
            {t.at ? (
              <>
                {" on "}
                <FormattedDateTime iso={t.at} />
              </>
            ) : null}
          </span>
        </span>
      </Tooltip>

      {record.next_run_at ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">Next</span>
          <Tooltip content={<FormattedDateTime iso={record.next_run_at} />}>
            <RelativeTime iso={record.next_run_at} className="cursor-help" />
          </Tooltip>
        </span>
      ) : inactive ? null : (
        <span className="text-muted-foreground">No next run</span>
      )}

      {record.last_run ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">Last</span>
          <Tooltip
            content={
              <span>
                {LAST_RUN_LABELS[record.last_run.status]}
                {record.last_run.at ? (
                  <>
                    {" · "}
                    <FormattedDateTime iso={record.last_run.at} />
                  </>
                ) : null}
              </span>
            }
          >
            <span className="inline-flex cursor-help items-center gap-1">
              <StatusGlyph status={record.last_run.status} />
              {record.last_run.at ? (
                <RelativeTime iso={record.last_run.at} />
              ) : (
                <span>{LAST_RUN_LABELS[record.last_run.status]}</span>
              )}
            </span>
          </Tooltip>
        </span>
      ) : (
        <span className="text-muted-foreground">Never run</span>
      )}
    </div>
  );
}

function RecentRuns({ runs }: { runs: JobRuns }) {
  if (runs.error) {
    return (
      <p className={cn("mt-2 text-xs", TONE.danger.text)}>
        {`Could not read this job's runs: ${runs.error}`}
      </p>
    );
  }
  const rows = runs.history?.rows ?? [];
  if (rows.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">No runs recorded yet.</p>;
  }
  // The CLI lists newest first; the dots read left to right, oldest to newest.
  const ordered = [...rows].reverse();
  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        {`Last ${rows.length} ${rows.length === 1 ? "run" : "runs"}, oldest first`}
      </span>
      <span className="flex items-center">
        {ordered.map((run) => {
          const tone = RUN_RESULT_TONES[run.result];
          const word = RUN_RESULT_LABELS[run.result];
          const duration = formatRunDuration(run.duration_ms);
          const dot = <span className={cn("size-2.5 rounded-full", TONE[tone].dot)} />;
          const tip = (
            <span className="block space-y-0.5">
              <span className={cn("block font-medium", TONE[tone].text)}>{word}</span>
              <span className="block">
                <FormattedDateTime iso={run.started_at} />
              </span>
              <span className="block text-muted-foreground">
                {`${run.kind} run · ${duration || "still running"}`}
              </span>
              {run.report_path ? null : (
                <span className="block text-muted-foreground">No report written</span>
              )}
            </span>
          );
          const box =
            "inline-flex size-5 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
          return (
            <Tooltip key={run.run_id} content={tip}>
              {run.report_path ? (
                <a
                  href={fileViewerHref(run.report_path)}
                  aria-label={`${word} run report`}
                  className={cn(box, "hover:bg-muted")}
                >
                  {dot}
                </a>
              ) : (
                <span role="img" aria-label={`${word} run`} className={box}>
                  {dot}
                </span>
              )}
            </Tooltip>
          );
        })}
      </span>
    </div>
  );
}

function Details({ record, label }: { record: ScheduleRecord; label: string }) {
  const t = formatTrigger(record.trigger);
  const mono = (text: string) => <span className="font-mono break-all">{text}</span>;
  return (
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer list-none items-center gap-0.5 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
        Details
      </summary>
      <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <Row term="Source">{`${label}. ${SOURCE_META[record.source].hint}`}</Row>
        <Row term="Native id">{mono(record.id)}</Row>
        <Row term="Account">{record.account}</Row>
        <Row term="Host">{record.runs_on.host}</Row>
        {record.runs_on.project ? <Row term="Project">{mono(record.runs_on.project)}</Row> : null}
        {record.runs_on.thread ? <Row term="Thread">{mono(record.runs_on.thread)}</Row> : null}
        <Row term="Trigger">
          <span className="block">
            {t.text}
            {t.at ? (
              <>
                {" on "}
                <FormattedDateTime iso={t.at} />
              </>
            ) : null}
          </span>
          {t.raw ? (
            <span className="block font-mono break-all text-muted-foreground">{t.raw}</span>
          ) : (
            <span className="block text-muted-foreground">No raw trigger text from the source</span>
          )}
        </Row>
        {record.created_by ? (
          <Row term="Created by">
            {record.created_by.agent_name ? (
              <AgentChip name={record.created_by.agent_name} />
            ) : (
              mono(record.created_by.instance_id.slice(0, 8))
            )}
          </Row>
        ) : null}
        {record.job ? <JobRows record={record} job={record.job} /> : null}
      </dl>
      {record.job ? <WhatItRuns job={record.job} /> : null}
    </details>
  );
}

/** One line on what a Harnery job runs, and a warning when it will not run here. */
function JobSummary({ record, job }: { record: ScheduleRecord; job: ScheduleHarneryJob }) {
  const runsHere = record.runs_on.host === record.account && job.enrollment.state === "enrolled";
  return (
    <div className="mt-1 space-y-0.5 text-xs">
      <p className="break-words">{describeScheduleJobWork(job)}</p>
      {runsHere ? null : (
        <p className={TONE.warn.text}>{describeScheduleEnrollment(record, job)}</p>
      )}
    </div>
  );
}

/** Details rows for a Harnery job: enrollment, owner, limits and the newest run. */
function JobRows({ record, job }: { record: ScheduleRecord; job: ScheduleHarneryJob }) {
  const run = job.latest_run;
  return (
    <>
      <Row term="Enrollment">
        <span className="block">{describeScheduleEnrollment(record, job)}</span>
        {job.enrollment.detail || job.enrollment.enrolled_at ? (
          <span className="block text-muted-foreground">
            {job.enrollment.detail ?? null}
            {job.enrollment.detail && job.enrollment.enrolled_at ? " · " : null}
            {job.enrollment.enrolled_at ? (
              <>
                {"enrolled "}
                <FormattedDateTime iso={job.enrollment.enrolled_at} />
              </>
            ) : null}
          </span>
        ) : null}
      </Row>
      <Row term="Owner">
        {job.owner ? (
          <AgentChip name={job.owner} />
        ) : (
          <span className="text-muted-foreground">
            None; nobody is pinged when a run needs attention
          </span>
        )}
      </Row>
      <Row term="Timeout">{`${job.timeout_minutes} min per run`}</Row>
      <Row term="Daily launch limit">{`${job.max_launches_per_day} per day`}</Row>
      <Row term="Time zone">{job.zone}</Row>
      <Row term="Last run">
        {run ? (
          <>
            <span className={cn("block", TONE[RUN_RESULT_TONES[run.result]].text)}>
              {`${RUN_RESULT_LABELS[run.result]} · ${run.kind} run · ${formatRunDuration(run.duration_ms) || "0s"}`}
            </span>
            <span className="block text-muted-foreground">
              {"Started "}
              <FormattedDateTime iso={run.started_at} />
              {" · finished "}
              <FormattedDateTime iso={run.finished_at} />
            </span>
            {run.commands.length > 0 ? (
              <span className="block font-mono break-all text-muted-foreground">
                {run.commands
                  .map((c) => `${c.name}: exit ${c.exit_code ?? "none"} (${c.state})`)
                  .join(" · ")}
              </span>
            ) : null}
            {run.agent ? (
              <span className="block text-muted-foreground">
                {`${run.agent.adapter} agent ${run.agent.ok ? "finished" : "failed"}, status ${run.agent.status_line}`}
              </span>
            ) : null}
            {run.report_path ? (
              <a
                href={fileViewerHref(run.report_path)}
                className="block font-mono break-all underline underline-offset-2 hover:text-foreground"
              >
                {run.report_path}
              </a>
            ) : (
              <span className="block text-muted-foreground">No report written</span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">Has not run on this checkout</span>
        )}
      </Row>
    </>
  );
}

/** The commands a Harnery job runs, in order, and the agent that judges them. */
function WhatItRuns({ job }: { job: ScheduleHarneryJob }) {
  return (
    <section className="mt-2.5 border-t pt-2 text-xs">
      <h4 className="font-medium">What it runs</h4>
      {job.commands.length > 0 ? (
        <ol className="mt-1 space-y-1.5">
          {job.commands.map((cmd, i) => (
            <li key={cmd.name} className="min-w-0">
              <span className="text-muted-foreground">{`${i + 1}. ${cmd.name}`}</span>
              <code className="mt-0.5 block rounded bg-muted px-2 py-1 font-mono break-all">
                {formatScheduleArgv(cmd.argv)}
              </code>
              {cmd.env.length > 0 || cmd.finding_exit_codes.length > 0 ? (
                <span className="mt-0.5 block text-muted-foreground">
                  {[
                    cmd.env.length > 0 ? `Passes ${cmd.env.join(", ")} (names only)` : null,
                    cmd.finding_exit_codes.length > 0
                      ? `Exit ${cmd.finding_exit_codes.join(", ")} means it found something`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-1 text-muted-foreground">No commands; the agent starts directly.</p>
      )}
      {job.agent ? (
        <div className="mt-2">
          <p>{`Then a ${describeScheduleAgent(job.agent)} reads the output and judges it.`}</p>
          <details className="group/prompt mt-1">
            <summary className="inline-flex cursor-pointer list-none items-center gap-0.5 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="size-3.5 transition-transform group-open/prompt:rotate-90"
              />
              Agent prompt
            </summary>
            <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono">
              {job.agent.prompt}
            </pre>
          </details>
        </div>
      ) : (
        <p className="mt-2 text-muted-foreground">
          No AI agent: it runs these commands only and spends no model tokens.
        </p>
      )}
    </section>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
