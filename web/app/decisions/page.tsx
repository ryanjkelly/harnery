import Link from "next/link";

import { AgentChip, AgentChipProvider } from "@/components/AgentChip";
import { Attention } from "@/components/Attention";
import { StakesPill, StatusPill, TierPill, VerdictPill } from "@/components/decision/DecisionPills";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { formatDuration } from "@/lib/changelog-parser";
import { hostInfo } from "@/lib/config";
import {
  coordRoot,
  type InstanceIdentity,
  readAgents,
  readInstanceIdentities,
} from "@/lib/coord-reader";
import { sortReviewFeed } from "@/lib/decision-attention";
import { type DecisionManifest, readDecisions } from "@/lib/decision-reader";

export const dynamic = "force-dynamic";

/** Normalize a stored agent name (heartbeat form "Quill") to the chip form "agent-Quill". */
function norm(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.startsWith("agent-") ? name : `agent-${name}`;
}

/** Resolve an actor field to a chip name. `claimed_by` stores an instance_id
 * (from `resolveOwner`), unlike `filed_by`/`resolved_by` which store the name;
 * map the id back through the identity index so the chip resolves + hovers. */
function actorName(
  value: string | null | undefined,
  identities: Record<string, InstanceIdentity>,
): string | null {
  if (!value) return null;
  const bare = value.startsWith("agent-") ? value.slice("agent-".length) : value;
  return norm(identities[bare]?.name ?? identities[value]?.name ?? value);
}

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
    const f = norm(d.filed_by);
    if (f) everyName.add(f);
    const r = norm(d.resolution?.resolved_by);
    if (r) everyName.add(r);
    if (d.claimed_by) {
      const name = actorName(d.claimed_by, identities);
      if (name) everyName.add(name);
      const bare = d.claimed_by.startsWith("agent-")
        ? d.claimed_by.slice("agent-".length)
        : d.claimed_by;
      claimers[d.decision_id] = {
        name,
        active: activeIds.has(bare) || activeIds.has(d.claimed_by),
      };
    }
  }
  const summaries = buildAgentSummaryMap(everyName);

  return (
    <AgentChipProvider summaries={summaries}>
      <NavBar scannedDir={coordRoot()} />
      <main className="w-full max-w-screen-2xl mx-auto px-6 pb-10">
        <nav className="mb-4 text-xs text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            ← Dashboard
          </Link>
        </nav>

        <header className="mb-6 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Decision docket</h1>
            <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
              Decisions an agent would otherwise route to a human. Tier 2 is waiting on you and
              nothing else will move it. Everything below it already proceeded on a default, so your
              review there is calibration, not approval.
            </p>
          </div>
          <div className="text-xs text-muted-foreground flex gap-3">
            <Count n={snap.waiting.length} label="waiting on you" />
            <Count n={reviewFeed.length} label="to review" />
            <Count n={snap.queue.length} label="in queue" />
            <Count n={snap.reviewed.length} label="reviewed" />
          </div>
        </header>

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
          <p className="text-sm text-muted-foreground italic">
            No decisions filed yet. An agent files one with{" "}
            <code className="font-mono text-xs">{`${binName} decision file "..."`}</code> (or the{" "}
            <code className="font-mono text-xs">decision</code> skill).
          </p>
        )}
      </main>
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

type Tone = "act" | "wait" | "done" | "muted";

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
  tone: Tone;
  decisions: DecisionManifest[];
  claimers: Record<string, ClaimerInfo>;
  emptyText?: string;
  /** Render how long each entry has been open. Only the waiting list uses it:
   * elsewhere age is trivia, but a decision blocking work reads very differently
   * at three hours than at three weeks, and a filing date does not say which. */
  showAge?: boolean;
}) {
  if (decisions.length === 0) {
    if (!emptyText) return null;
    return (
      <section className="mb-8">
        <SectionHeader title={title} hint={hint} count={0} />
        <p className="text-sm text-muted-foreground italic">{emptyText}</p>
      </section>
    );
  }
  return (
    <section className="mb-8">
      <SectionHeader title={title} hint={hint} count={decisions.length} />
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
    </section>
  );
}

function SectionHeader({ title, hint, count }: { title: string; hint: string; count: number }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
        {title} {count > 0 && <span className="text-foreground">({count})</span>}
      </h2>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

const TONE_RING: Record<Tone, string> = {
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
  tone: Tone;
  claimer?: ClaimerInfo;
  showAge?: boolean;
}) {
  const who = norm(d.filed_by);
  const age = showAge ? formatDuration(d.filed_at, new Date().toISOString()) : null;
  return (
    <Link
      href={`/decisions/${encodeURIComponent(d.decision_id)}`}
      className={`block rounded-lg border ${TONE_RING[tone]} bg-card p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
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
            <span className="text-muted-foreground/60">by</span>
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
                <span className="text-muted-foreground/60">·</span>
                {working ? (
                  <span className="live-dot" aria-hidden />
                ) : (
                  <span className="text-muted-foreground/60">claimed by</span>
                )}
                <AgentChip name={claimer.name} className="font-mono text-foreground/80" />
                {working && <span className="text-emerald-400/90">working</span>}
              </span>
            );
          })()}
        <span className="ml-auto inline-flex items-center gap-2">
          {age && (
            <span className="rounded px-1.5 py-0.5 font-medium text-amber-300/90 bg-amber-400/10">
              open {age}
            </span>
          )}
          <FormattedDateTime iso={d.filed_at} className="text-muted-foreground" />
        </span>
      </div>
    </Link>
  );
}
