import { EmptyState } from "@/components/layout/EmptyState";
import { Notice } from "@/components/layout/Notice";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Section } from "@/components/layout/Section";
import { CoverageNotice, CoverageStrip } from "@/components/schedules/CoverageStrip";
import { type JobRuns, ScheduleCard } from "@/components/schedules/ScheduleCard";
import { cn } from "@/lib/cn";
import {
  commonHost,
  groupSchedules,
  readScheduleHistory,
  readScheduleList,
  type ScheduleRecord,
  scheduleState,
} from "@/lib/schedules";
import { TONE } from "@/lib/tone";

export const dynamic = "force-dynamic";

const RECENT_RUNS = 5;

export default async function SchedulesPage() {
  const { list, error } = await readScheduleList();
  const now = Date.now();
  const records = list?.records ?? [];
  const groups = groupSchedules(records, now);
  const host = commonHost(records);
  const runsById = new Map<string, JobRuns>(
    await Promise.all(
      records
        .filter((r) => r.source === "harnery")
        .map(async (r) => [r.id, await readScheduleHistory(r.id, RECENT_RUNS)] as const),
    ),
  );

  const card = (r: ScheduleRecord) => (
    <ScheduleCard
      key={JSON.stringify([r.source, r.account, r.id])}
      record={r}
      state={scheduleState(r, now)}
      commonHost={host}
      runs={r.source === "harnery" ? runsById.get(r.id) : undefined}
    />
  );
  const grid = (rs: ScheduleRecord[]) => (
    <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">{rs.map(card)}</div>
  );

  return (
    <PageShell width="wide">
      <PageHeader
        title="Schedules"
        description="Everything set to run on its own: automations in the agent apps, this machine's timers and Harnery's jobs."
        meta={
          list ? (
            <p className="text-xs text-muted-foreground">
              {`${groups.active.length} active · `}
              <span
                className={cn(groups.attention.length > 0 && TONE.warn.text, "font-medium")}
              >{`${groups.attention.length} ${groups.attention.length === 1 ? "needs" : "need"} attention`}</span>
              {` · ${groups.inactive.length} paused or finished`}
              {host ? ` · on ${host}` : ""}
            </p>
          ) : null
        }
      />
      {error || !list ? (
        <Notice tone="danger" title="Could not read the schedules">
          {error}
        </Notice>
      ) : (
        <div className="flex flex-col gap-6">
          <CoverageNotice coverage={list.coverage} />
          {records.length === 0 ? (
            <EmptyState>No schedules found. The sources below show what was read.</EmptyState>
          ) : null}
          {groups.attention.length > 0 ? (
            <Section
              title="Needs attention"
              count={groups.attention.length}
              hint="The last run failed or reported something a person should look at."
              className="mb-0"
            >
              {grid(groups.attention)}
            </Section>
          ) : null}
          {groups.active.length > 0 ? (
            <Section
              title="Active"
              count={groups.active.length}
              hint="Soonest next run first."
              className="mb-0"
            >
              {grid(groups.active)}
            </Section>
          ) : null}
          {groups.inactive.length > 0 ? (
            <Section
              title="Paused or finished"
              count={groups.inactive.length}
              hint="Switched off, or a one-off run that has already happened."
              className="mb-0"
            >
              {grid(groups.inactive)}
            </Section>
          ) : null}
          <CoverageStrip coverage={list.coverage} asOf={new Date(now).toISOString()} />
        </div>
      )}
    </PageShell>
  );
}
