import Link from "next/link";

import { AgentChip, AgentChipProvider } from "@/components/AgentChip";
import { Attention } from "@/components/Attention";
import { StakesPill, StatusPill, TierPill, VerdictPill } from "@/components/decision/DecisionPills";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Section as LayoutSection } from "@/components/layout/Section";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { formatDuration } from "@/lib/format/duration";
import { hostInfo } from "@/lib/config";
import { readAgents, readInstanceIdentities } from "@/lib/coord-reader";
import { actorName, chipName } from "@/lib/decision-actors";
import { sortReviewFeed } from "@/lib/decision-attention";
import { type DecisionManifest, readDecisions } from "@/lib/decision-reader";
import { bareName } from "@/lib/identities";
import { TONE } from "@/lib/tone";

export const dynamic = "force-dynamic";

/** Per-decision claimer, resolved to a name + whether that agent is live now. */
export interface ClaimerInfo {
  name: string | null;
  active: boolean;
}

export default function DecisionsPage() {
  const snap = readDecisions();
  const { binName } = hostInfo();
  const reviewFeed = sortReviewFeed(snap.review);

  const identities = readInstanceIdentities();
  const activeIds = new Set(readAgents().active.map((a) => a.instance_id));

  const everyName = new Set<string>();
  const claimers: Record<string, ClaimerInfo> = {};
  for (const d of [
    ...snap.waiting,
    ...snap.queue,
    ...reviewFeed,
    ...snap.reviewed,
    ...snap.closed,
  ]) {
    const f = chipName(d.filed_by);
    if (f) everyName.add(f);
    const r = chipName(d.resolution?.resolved_by);
    if (r) everyName.add(r);
    if (d.claimed_by) {
      const name = actorName(d.claimed_by, identities);
      if (name) everyName.add(name);
      const bare = bareName(d.claimed_by);
      claimers[d.decision_id] = {
        name,
        active: activeIds.has(bare) || activeIds.has(d.claimed_by),
      };
    }
  }
  const summaries = buildAgentSummaryMap(everyName);

  return (
    <AgentChipProvider summaries={summaries}>
      <PageShell width="wide">
        <PageHeader
          title="Decision docket"
          description="Decisions an agent would otherwise route to a human. Tier 2 is waiting on you and nothing else will move it. Everything below it already proceeded on a default, so your review there is calibration, not approval."
          actions={
            <>
              <Count n={snap.waiting.length} label="waiting on you" />
              <Count n={reviewFeed.length} label="to review" />
              <Count n={snap.queue.length} label="in queue" />
              <Count n={snap.reviewed.length} label="reviewed" />
            </>
          }
        />

        {/* Waiting outranks review for the alert: review is sampling the human
            can batch, whereas a tier-2 decision has work parked behind it. */}
        {snap.waiting.length > 0 ? (
          <Attention
            request={{
              key: `decisions-waiting-${snap.waiting.length}`,
              label: `${snap.waiting.length} decision(s) waiting on you`,
            }}
          />
        ) : (
          reviewFeed.length > 0 && (
            <Attention
              request={{
                key: `decisions-review-${reviewFeed.length}`,
                label: `${reviewFeed.length} decision(s) to review`,
              }}
            />
          )
        )}

        <Section
          title="Waiting on you"
          hint="Tier 2: an agent judged this yours to call and stopped. Highest stakes first, then longest open."
          tone="act"
          decisions={snap.waiting}
          claimers={claimers}
          emptyText="Nothing is blocked on a ruling."
          showAge
        />
        <Section
          title="To review"
          hint="Resolved and already enacted. Ratify, override, or flag the tier."
          tone="act"
          decisions={reviewFeed}
          claimers={claimers}
          emptyText="Nothing awaiting review."
        />
        <Section
          title="Queue"
          hint="Tier 0/1, filed or in deliberation. Work already proceeded on a default."
          tone="wait"
          decisions={snap.queue}
          claimers={claimers}
          emptyText="Empty queue."
        />
        <Section
          title="Reviewed"
          hint="You've weighed in. Kept for precedent."
          tone="done"
          decisions={snap.reviewed}
          claimers={claimers}
        />
        <Section
          title="Closed"
          hint="Archived, superseded, or wontfix."
          tone="muted"
          decisions={snap.closed}
          claimers={claimers}
        />

        {snap.meta.count === 0 && (
          <EmptyState>
            No decisions filed yet. An agent files one with{" "}
            <code className="font-mono text-xs">{`${binName} decision file "..."`}</code> (or the{" "}
            <code className="font-mono text-xs">decision</code> skill).
          </EmptyState>
        )}
      </PageShell>
    </AgentChipProvider>
  );
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <span>
      <strong className="text-foreground">{n}</strong> {label}
    </span>
  );
}

type CardTone = "act" | "wait" | "done" | "muted";

function Section({
  title,
  hint,
  tone,
  decisions,
  claimers,
  emptyText,
  showAge,
}: {
  title: string;
  hint: string;
  tone: CardTone;
  decisions: DecisionManifest[];
  claimers: Record<string, ClaimerInfo>;
  emptyText?: string;
  /** Render how long each entry has been open. Only the waiting list uses it:
   * elsewhere age is trivia, but a decision blocking work reads very differently
   * at three hours than at three weeks, and a filing date does not say which. */
  showAge?: boolean;
}) {
  // Only the sections that ask something of the operator carry the accent rule.
  const sectionTone = tone === "act" ? "act" : undefined;
  if (decisions.length === 0) {
    if (!emptyText) return null;
    return (
      <LayoutSection title={title} hint={hint} tone={sectionTone}>
        <EmptyState>{emptyText}</EmptyState>
      </LayoutSection>
    );
  }
  return (
    <LayoutSection title={title} hint={hint} count={decisions.length} tone={sectionTone}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        {decisions.map((d) => (
          <DecisionCard
            key={d.decision_id}
            d={d}
            tone={tone}
            claimer={claimers[d.decision_id]}
            showAge={showAge}
          />
        ))}
      </div>
    </LayoutSection>
  );
}

const TONE_RING: Record<CardTone, string> = {
  act: "border-sky-500/40 hover:border-sky-400/70",
  wait: "border-border hover:border-foreground/30",
  done: "border-emerald-500/25 hover:border-emerald-400/50",
  muted: "border-border/60 opacity-80 hover:opacity-100",
};

function DecisionCard({
  d,
  tone,
  claimer,
  showAge,
}: {
  d: DecisionManifest;
  tone: CardTone;
  claimer?: ClaimerInfo;
  showAge?: boolean;
}) {
  const who = chipName(d.filed_by);
  const age = showAge ? formatDuration(d.filed_at, new Date().toISOString()) : null;
  return (
    <Link
      href={`/decisions/${encodeURIComponent(d.decision_id)}`}
      className={`block rounded-lg border ${TONE_RING[tone]} bg-card p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
    >
      <div className="flex items-start justify-between gap-3">
        {/* min-w-0 lets the question shrink + wrap; the pill (shrink-0) stays put. */}
        <p className="min-w-0 text-sm font-medium leading-snug">{d.question}</p>
        <TierPill tier={d.tier} />
      </div>
      {/* Meta row: colour-graded pills carry the state; the divider + right-aligned
          timestamp give it hierarchy instead of a flat gray run. */}
      <div className="mt-2.5 flex items-center gap-2 flex-wrap text-[11px]">
        <StatusPill status={d.status} />
        <StakesPill stakes={d.stakes} />
        {d.review && <VerdictPill verdict={d.review.verdict} />}
        {who && (
          <span className="text-muted-foreground inline-flex items-center gap-1">
            <span className="text-subtle-foreground">by</span>
            <AgentChip name={who} className="font-mono text-foreground/80" />
          </span>
        )}
        {claimer?.name &&
          (() => {
            // "working" only while actively deliberating; a resolved decision
            // keeps claimed_by but the live session isn't working it anymore.
            const working = claimer.active && d.status === "deliberating";
            return (
              <span className="text-muted-foreground inline-flex items-center gap-1">
                <span className="text-subtle-foreground">·</span>
                {working ? (
                  <span className="live-dot" aria-hidden />
                ) : (
                  <span className="text-subtle-foreground">claimed by</span>
                )}
                <AgentChip name={claimer.name} className="font-mono text-foreground/80" />
                {working && <span className={TONE.done.text}>working</span>}
              </span>
            );
          })()}
        <span className="ml-auto inline-flex items-center gap-2">
          {age && (
            <span className={`rounded border px-1.5 py-0.5 font-medium ${TONE.warn.pill}`}>
              open {age}
            </span>
          )}
          <FormattedDateTime iso={d.filed_at} className="text-muted-foreground" />
        </span>
      </div>
    </Link>
  );
}
