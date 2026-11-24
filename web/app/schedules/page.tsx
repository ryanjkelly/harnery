import { AgentChip } from "@/components/AgentChip";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { EmptyState } from "@/components/layout/EmptyState";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Section } from "@/components/layout/Section";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableHead, Td, Th, Tr } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import {
  COVERAGE_TONES,
  fileViewerHref,
  formatRunDuration,
  formatTrigger,
  LAST_RUN_TONES,
  RUN_RESULT_TONES,
  readScheduleHistory,
  readScheduleList,
  type ScheduleHistory,
  type ScheduleRecord,
  type ScheduleSourceCoverage,
  sortSchedules,
} from "@/lib/schedules";
import { TONE } from "@/lib/tone";

export const dynamic = "force-dynamic";

const RECENT_RUNS = 5;

export default async function SchedulesPage() {
  const { list, error } = await readScheduleList();
  const now = Date.now();
  const records = sortSchedules(list?.records ?? []);
  const jobs = records.filter((r) => r.source === "harnery");
  const histories = await Promise.all(
    jobs.map(async (job) => ({ job, ...(await readScheduleHistory(job.id, RECENT_RUNS)) })),
  );

  return (
    <PageShell width="wide">
      <PageHeader
        title="Schedules"
        description="Every scheduled job this machine knows about, from the agent apps, the machine's own timers and Harnery's scheduler, with how each source was read."
      />
      {error || !list ? (
        <Notice tone="danger" title="Could not read the schedules">
          {error}
        </Notice>
      ) : (
        <div className="space-y-6">
          <ScheduleTable records={records} />
          {jobs.length > 0 ? <RunsTable histories={histories} /> : null}
          <CoverageTable coverage={list.coverage} />
          <p className="text-xs text-muted-foreground">
            as of <FormattedDateTime iso={new Date(now).toISOString()} kind="timestamp" />
          </p>
        </div>
      )}
    </PageShell>
  );
}

function Trigger({ record }: { record: ScheduleRecord }) {
  const t = formatTrigger(record.trigger);
  return (
    <Tooltip content={<span className="font-mono">{t.raw || "(no source text)"}</span>}>
      <span className="cursor-help">
        {t.text}
        {t.at ? (
          <>
            {" "}
            <FormattedDateTime iso={t.at} />
          </>
        ) : null}
      </span>
    </Tooltip>
  );
}

function ScheduleTable({ records }: { records: ScheduleRecord[] }) {
  return (
    <Section title="All schedules" count={records.length} className="mb-0">
      {records.length === 0 ? (
        <EmptyState>No schedules found. Check the coverage below for sources not read.</EmptyState>
      ) : (
        <Table>
          <TableHead>
            <tr>
              <Th>Source</Th>
              <Th>Schedule</Th>
              <Th>Trigger</Th>
              <Th>Next run</Th>
              <Th>Last run</Th>
              <Th>Enabled</Th>
              <Th>Runs on</Th>
              <Th>Created by</Th>
            </tr>
          </TableHead>
          <tbody>
            {records.map((r) => (
              <Tr key={JSON.stringify([r.source, r.account, r.id])}>
                <Td className="text-xs whitespace-nowrap">{r.source}</Td>
                <Td>
                  <div>{r.title || r.id}</div>
                  {r.title && r.title !== r.id ? (
                    <div className="font-mono text-xs break-all text-muted-foreground">{r.id}</div>
                  ) : null}
                </Td>
                <Td className="text-xs">
                  <Trigger record={r} />
                </Td>
                <Td className="text-xs whitespace-nowrap">
                  {r.next_run_at ? <FormattedDateTime iso={r.next_run_at} /> : "none"}
                </Td>
                <Td className="text-xs whitespace-nowrap">
                  {r.last_run ? (
                    <div className="flex items-center gap-1.5">
                      <StatusBadge state={r.last_run.status} tones={LAST_RUN_TONES} />
                      {r.last_run.at ? <FormattedDateTime iso={r.last_run.at} /> : null}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </Td>
                <Td className="text-xs">
                  {r.enabled === true ? (
                    "on"
                  ) : r.enabled === false ? (
                    <Badge tone="neutral">off</Badge>
                  ) : (
                    <span className="text-muted-foreground">unknown</span>
                  )}
                </Td>
                <Td className="text-xs">
                  <div>{r.runs_on.host}</div>
                  {r.runs_on.project ? (
                    <div className="text-muted-foreground break-all">{r.runs_on.project}</div>
                  ) : null}
                  {r.runs_on.thread ? (
                    <div className="font-mono text-muted-foreground break-all">
                      {r.runs_on.thread}
                    </div>
                  ) : null}
                </Td>
                <Td className="text-xs">
                  {r.created_by ? (
                    r.created_by.agent_name ? (
                      <AgentChip name={r.created_by.agent_name} />
                    ) : (
                      <span className="font-mono">{r.created_by.instance_id.slice(0, 8)}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">unknown</span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

function RunsTable({
  histories,
}: {
  histories: Array<{ job: ScheduleRecord; history?: ScheduleHistory; error?: string }>;
}) {
  return (
    <Section
      title="Harnery job runs"
      hint={`The last ${RECENT_RUNS} runs of each job, newest first.`}
      className="mb-0"
    >
      <Table>
        <TableHead>
          <tr>
            <Th>Job</Th>
            <Th>Result</Th>
            <Th>Started</Th>
            <Th>Kind</Th>
            <Th>Duration</Th>
            <Th>Report</Th>
          </tr>
        </TableHead>
        <tbody>
          {histories.map(({ job, history, error }) => {
            const rows = history?.rows ?? [];
            const name = (
              <Td rowSpan={Math.max(rows.length, 1)} className="text-xs">
                <div>{job.title || job.id}</div>
                <div className="font-mono text-muted-foreground">{job.id}</div>
              </Td>
            );
            if (error || rows.length === 0) {
              return (
                <Tr key={job.id}>
                  {name}
                  <Td colSpan={5} className={error ? `text-xs ${TONE.danger.text}` : "text-xs"}>
                    {error ? (
                      `Could not read this job's runs: ${error}`
                    ) : (
                      <span className="text-muted-foreground">No runs recorded yet.</span>
                    )}
                  </Td>
                </Tr>
              );
            }
            return rows.map((run, i) => (
              <Tr key={run.run_id} className={i > 0 ? "border-border/50" : undefined}>
                {i === 0 ? name : null}
                <Td className="text-xs">
                  <StatusBadge state={run.result} tones={RUN_RESULT_TONES} />
                </Td>
                <Td className="text-xs whitespace-nowrap">
                  <FormattedDateTime iso={run.started_at} />
                </Td>
                <Td className="text-xs text-muted-foreground">{run.kind}</Td>
                <Td className="text-xs whitespace-nowrap">
                  {formatRunDuration(run.duration_ms) || (
                    <span className="text-muted-foreground">running</span>
                  )}
                </Td>
                <Td className="text-xs">
                  {run.report_path ? (
                    <a className="underline" href={fileViewerHref(run.report_path)}>
                      report
                    </a>
                  ) : (
                    <span className="text-muted-foreground">none</span>
                  )}
                </Td>
              </Tr>
            ));
          })}
        </tbody>
      </Table>
    </Section>
  );
}

function CoverageTable({ coverage }: { coverage: ScheduleSourceCoverage[] }) {
  return (
    <Section
      title="Coverage"
      hint="How each source was read. A source not read in full may hold schedules this list is missing."
      className="mb-0"
    >
      <Table>
        <TableHead>
          <tr>
            <Th>Source</Th>
            <Th>Account</Th>
            <Th>State</Th>
            <Th>Detail</Th>
            <Th>Read at</Th>
          </tr>
        </TableHead>
        <tbody>
          {coverage.map((c) => (
            <Tr key={`${c.source}:${c.account}`}>
              <Td className="text-xs whitespace-nowrap">{c.source}</Td>
              <Td className="text-xs">{c.account}</Td>
              <Td>
                <StatusBadge
                  state={c.state}
                  tones={COVERAGE_TONES}
                  labels={{ disabled: "switched off" }}
                />
              </Td>
              <Td className="text-xs">
                {c.state === "disabled" ? (
                  <>
                    <span className="font-medium">This reader is switched off</span>, so its
                    schedules are not listed.
                    {c.detail ? <span className="text-muted-foreground"> {c.detail}</span> : null}
                  </>
                ) : (
                  (c.detail ??
                  (c.state === "current" ? (
                    <span className="text-muted-foreground">read in full</span>
                  ) : null))
                )}
              </Td>
              <Td className="text-xs whitespace-nowrap">
                <FormattedDateTime iso={c.read_at} kind="timestamp" />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Section>
  );
}
