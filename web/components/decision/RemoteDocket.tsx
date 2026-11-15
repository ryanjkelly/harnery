import Link from "next/link";
import type { ReactNode } from "react";

import { AgentChip, AgentChipProvider } from "@/components/AgentChip";
import { StakesPill, StatusPill, TierPill } from "@/components/decision/DecisionPills";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { EmptyState } from "@/components/layout/EmptyState";
import { Notice } from "@/components/layout/Notice";
import { Section } from "@/components/layout/Section";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { chipName } from "@/lib/decision-actors";
import type { DecisionStakes, DecisionStatus, DecisionTier } from "@/lib/decision-reader";
import { formatDuration } from "@/lib/format/duration";
import {
  type RemoteApprovalRow,
  type RemoteDecisionRow,
  type RemoteDocketSnapshot,
  type RemoteSource,
  reachCommand,
  remoteDecisionHref,
} from "@/lib/remote-docket-reader";

/**
 * Other machines' shared docket entries (ADR 0255), rendered read-only.
 *
 * Nothing here mounts `Attention`: a decision waiting on a human elsewhere is
 * not something the person at this dashboard can act on, so it must never
 * flash this machine's tab. Remote agent names render through an empty
 * `AgentChipProvider`, so a local agent that happens to share a name never
 * lends its hover card (and its end-session control) to a remote one.
 */

const TIERS = new Set<number>([0, 1, 2]);
const STAKES = new Set<string>(["small", "medium", "high"]);
const STATUSES = new Set<string>([
  "filed",
  "triaged",
  "deliberating",
  "resolved",
  "enacted",
  "reviewed",
  "archived",
  "superseded",
  "wontfix",
]);

/** Tier pill, or a plain badge when a newer publisher sent a tier this build does not know. */
export function RemoteTier({ tier }: { tier: number }) {
  return TIERS.has(tier) ? (
    <TierPill tier={tier as DecisionTier} />
  ) : (
    <Badge tone="neutral">{`T${tier}`}</Badge>
  );
}

export function RemoteStakes({ stakes }: { stakes: string }) {
  return STAKES.has(stakes) ? (
    <StakesPill stakes={stakes as DecisionStakes} />
  ) : (
    <Badge tone="neutral">{stakes}</Badge>
  );
}

export function RemoteStatus({ status }: { status: string }) {
  return STATUSES.has(status) ? (
    <StatusPill status={status as DecisionStatus} />
  ) : (
    <Badge tone="neutral">{status}</Badge>
  );
}

/** Source-machine label; amber and explained when that machine stopped publishing. */
export function MachineBadge({ source, now }: { source: RemoteSource; now: string }) {
  const age = formatDuration(source.publishedAt, now);
  return source.stale ? (
    <Badge
      tone="warn"
      title={`${source.label} last published its docket ${age} ago and has not refreshed it since. This copy may be out of date.`}
    >
      {`${source.label} · stale`}
    </Badge>
  ) : (
    <Badge tone="accent" title={`Shared copy from ${source.label}, published ${age} ago.`}>
      {source.label}
    </Badge>
  );
}

/** How to reach whoever owns a remote item. */
export function ReachLine({ binName, source }: { binName: string; source: RemoteSource }) {
  const cmd = reachCommand(binName, source);
  return cmd ? (
    <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
      {cmd}
    </code>
  ) : (
    <span className="text-xs text-muted-foreground">
      {`No agent is known on ${source.label}; ask its owner directly.`}
    </span>
  );
}

function RemoteDecisionCard({ row, now }: { row: RemoteDecisionRow; now: string }) {
  const d = row.decision;
  const who = chipName(d.filed_by);
  return (
    <Link
      href={remoteDecisionHref(row)}
      className="block rounded-lg border border-dashed border-border bg-card p-4 transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-medium leading-snug">{d.question}</p>
        <RemoteTier tier={d.tier} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px]">
        <MachineBadge source={row.source} now={now} />
        <RemoteStatus status={d.status} />
        <RemoteStakes stakes={d.stakes} />
        {who && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span className="text-subtle-foreground">by</span>
            <AgentChip name={who} className="font-mono text-foreground/80" />
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-2 text-muted-foreground">
          <Tooltip content={<FormattedDateTime iso={d.filed_at} />}>
            <span>{`${d.waiting ? "open" : "filed"} ${formatDuration(d.filed_at, now)}`}</span>
          </Tooltip>
        </span>
      </div>
    </Link>
  );
}

function RemoteApprovalItem({
  row,
  binName,
  now,
}: {
  row: RemoteApprovalRow;
  binName: string;
  now: string;
}) {
  const a = row.approval;
  return (
    <li className="rounded-lg border border-dashed border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <MachineBadge source={row.source} now={now} />
        <Badge tone="neutral">{a.status}</Badge>
        {a.phase && <Badge tone="neutral">{a.phase}</Badge>}
        <span className="min-w-0 text-sm font-medium text-foreground">{a.action}</span>
        <span className="ml-auto text-muted-foreground">
          <Tooltip content={<FormattedDateTime iso={a.requested_at} />}>
            <span>{`waiting ${formatDuration(a.requested_at, now)}`}</span>
          </Tooltip>
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <Row label="Approval" value={<span className="font-mono">{a.id}</span>} />
        <Row label="Run" value={<span className="font-mono break-all">{a.run_id}</span>} />
        {a.addressed_to && <Row label="Addressed to" value={a.addressed_to} />}
        {a.reason && <Row label="Reason" value={a.reason} />}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        {`Only ${row.source.label} can approve or deny this. To reach it:`}
      </p>
      <div className="mt-1">
        <ReachLine binName={binName} source={row.source} />
      </div>
    </li>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{value}</dd>
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Notices for the degraded states that still let some rows render. */
function DegradedNotices({ snap, now }: { snap: RemoteDocketSnapshot; now: string }) {
  const stale = snap.machines.filter((m) => m.stale);
  const truncated = snap.machines.filter((m) => m.truncated > 0);
  return (
    <>
      {snap.malformed.length > 0 && (
        <Notice
          tone="warn"
          title={`${plural(snap.malformed.length, "shared docket")} could not be read`}
        >
          {`Skipped ${snap.malformed.join(", ")}: the published copy is malformed or from an unsupported version. Everything else below is unaffected.`}
        </Notice>
      )}
      {stale.length > 0 && (
        <Notice tone="warn" title="Some machines stopped refreshing their docket">
          {stale
            .map((m) => `${m.label} (last published ${formatDuration(m.publishedAt, now)} ago)`)
            .join(", ")}
          {". Their entries may already be settled there."}
        </Notice>
      )}
      {truncated.length > 0 && (
        <Notice tone="neutral" title="Some dockets were trimmed to fit">
          {truncated.map((m) => `${m.label} left out ${plural(m.truncated, "item")}`).join(", ")}
          {". The filing machine has the full list."}
        </Notice>
      )}
    </>
  );
}

/**
 * The "Other machines" block on the decisions page. Always renders something
 * (an empty or degraded state when there is nothing to show), so the reader
 * can tell "nothing shared" from "sharing not set up".
 */
export function RemoteDecisionsSection({
  snap,
  binName,
  now,
}: {
  snap: RemoteDocketSnapshot;
  binName: string;
  now: string;
}) {
  const hint =
    "Shared, read-only copies of other machines' dockets. Only the machine that filed an entry can resolve, claim, or review it.";
  const total = snap.waiting.length + snap.recent.length + snap.approvals.length;
  return (
    <Section title="Other machines" hint={hint} count={total}>
      <div className="space-y-3">
        <RemoteStateNotice snap={snap} binName={binName} />
        <DegradedNotices snap={snap} now={now} />
        {snap.machines.length > 0 && total === 0 && (
          <EmptyState>
            {`${plural(snap.machines.length, "machine")} shared a docket, with nothing waiting and nothing changed recently.`}
          </EmptyState>
        )}
        <AgentChipProvider summaries={{}}>
          {snap.waiting.length > 0 && (
            <RemoteGroup
              title="Waiting on a human there"
              hint="Tier 2 on another machine. It does not alert here because it can only be ruled on there."
            >
              <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
                {snap.waiting.map((row) => (
                  <RemoteDecisionCard
                    key={`${row.source.ref}/${row.decision.decision_id}`}
                    row={row}
                    now={now}
                  />
                ))}
              </div>
            </RemoteGroup>
          )}
          {snap.approvals.length > 0 && (
            <RemoteApprovalsList rows={snap.approvals} binName={binName} now={now} />
          )}
          {snap.recent.length > 0 && (
            <RemoteGroup
              title="Recently changed there"
              hint="Filed or updated in the last two weeks."
            >
              <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
                {snap.recent.map((row) => (
                  <RemoteDecisionCard
                    key={`${row.source.ref}/${row.decision.decision_id}`}
                    row={row}
                    now={now}
                  />
                ))}
              </div>
            </RemoteGroup>
          )}
        </AgentChipProvider>
      </div>
    </Section>
  );
}

/** Pending run approvals from other machines, for any page that lists approvals. */
export function RemoteApprovalsList({
  rows,
  binName,
  now,
  title = "Run approvals pending there",
}: {
  rows: RemoteApprovalRow[];
  binName: string;
  now: string;
  title?: string;
}) {
  return (
    <RemoteGroup
      title={title}
      hint="Parked workflow runs on another machine. Approve or deny them on that machine."
    >
      <ul className="space-y-2">
        {rows.map((row) => (
          <RemoteApprovalItem
            key={`${row.source.ref}/${row.approval.id}`}
            row={row}
            binName={binName}
            now={now}
          />
        ))}
      </ul>
    </RemoteGroup>
  );
}

function RemoteGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="pt-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mb-2 text-xs text-muted-foreground">{hint}</p>
      {children}
    </div>
  );
}

/** The empty states that explain why nothing from other machines appears. */
export function RemoteStateNotice({
  snap,
  binName,
}: {
  snap: RemoteDocketSnapshot;
  binName: string;
}) {
  if (snap.error) {
    return (
      <Notice tone="warn" title="Could not read other machines' dockets">
        {`${snap.error}. This machine's own docket above is unaffected.`}
      </Notice>
    );
  }
  if (!snap.presence) {
    return (
      <EmptyState>
        {`Presence is off, so no other machine's docket can reach this one. Turn on presence and set decision.share in the project config to share dockets across machines.`}
      </EmptyState>
    );
  }
  if (snap.machines.length === 0) {
    return (
      <EmptyState>
        {snap.sharing
          ? `No other machine has shared its docket yet. Copies arrive with presence fetches, which ${binName} runs during agent turns.`
          : `No other machine has shared its docket, and this machine does not share its own (decision.share is off in the project config).`}
      </EmptyState>
    );
  }
  if (!snap.sharing) {
    return (
      <Notice tone="neutral">
        {`This machine reads other machines' dockets but does not share its own (decision.share is off).`}
      </Notice>
    );
  }
  return null;
}
