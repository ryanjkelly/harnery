import Link from "next/link";

import { Attention } from "@/components/Attention";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { coordRoot } from "@/lib/coord-reader";
import { sortReviewFeed } from "@/lib/decision-attention";
import { type DecisionManifest, readDecisions } from "@/lib/decision-reader";

export const dynamic = "force-dynamic";

export default function DecisionsPage() {
  const snap = readDecisions();
  const reviewFeed = sortReviewFeed(snap.review);

  return (
    <>
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
              Decisions an agent would otherwise route to a human. Tier 0/1 already proceeded on a
              default; your review is calibration, not approval. Skim the highest-stakes first.
            </p>
          </div>
          <div className="text-xs text-muted-foreground flex gap-3">
            <Count n={reviewFeed.length} label="to review" />
            <Count n={snap.queue.length} label="in queue" />
            <Count n={snap.reviewed.length} label="reviewed" />
          </div>
        </header>

        {reviewFeed.length > 0 && (
          <Attention
            request={{
              key: `decisions-review-${reviewFeed.length}`,
              label: `${reviewFeed.length} decision(s) to review`,
            }}
          />
        )}

        <Section
          title="To review"
          hint="Resolved and already enacted. Ratify, override, or flag the tier."
          tone="act"
          decisions={reviewFeed}
          emptyText="Nothing awaiting review."
        />
        <Section
          title="Queue"
          hint="Filed or in deliberation. Not yet resolved."
          tone="wait"
          decisions={snap.queue}
          emptyText="Empty queue."
        />
        <Section
          title="Reviewed"
          hint="You've weighed in. Kept for precedent."
          tone="done"
          decisions={snap.reviewed}
        />
        <Section
          title="Closed"
          hint="Archived, superseded, or wontfix."
          tone="muted"
          decisions={snap.closed}
        />

        {snap.meta.count === 0 && (
          <p className="text-sm text-muted-foreground italic">
            No decisions filed yet. An agent files one with{" "}
            <code className="font-mono text-xs">bp decision file &quot;...&quot;</code> (or the{" "}
            <code className="font-mono text-xs">/decide</code> skill).
          </p>
        )}
      </main>
    </>
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
  emptyText,
}: {
  title: string;
  hint: string;
  tone: Tone;
  decisions: DecisionManifest[];
  emptyText?: string;
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {decisions.map((d) => (
          <DecisionCard key={d.decision_id} d={d} tone={tone} />
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
  done: "border-emerald-500/30 hover:border-emerald-400/60",
  muted: "border-border/60 opacity-80 hover:opacity-100",
};

function DecisionCard({ d, tone }: { d: DecisionManifest; tone: Tone }) {
  return (
    <Link
      href={`/decisions/${encodeURIComponent(d.decision_id)}`}
      className={`block rounded-lg border ${TONE_RING[tone]} bg-card p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium leading-snug">{d.question}</p>
        <TierPill tier={d.tier} />
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
        <StatusPill status={d.status} />
        <StakesPill stakes={d.stakes} />
        {d.review && <span className="font-mono">verdict: {d.review.verdict}</span>}
        {d.filed_by && <span className="font-mono">{d.filed_by}</span>}
        <FormattedDateTime iso={d.filed_at} className="ml-auto" />
      </div>
    </Link>
  );
}

function TierPill({ tier }: { tier: number }) {
  const label = tier === 2 ? "T2 · your call" : tier === 1 ? "T1 · review" : "T0 · auto";
  const cls =
    tier === 2
      ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
      : tier === 1
        ? "bg-muted/60 text-foreground/80 border-border"
        : "bg-muted/30 text-muted-foreground border-border/60";
  return (
    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function StakesPill({ stakes }: { stakes: string }) {
  const cls =
    stakes === "high"
      ? "text-red-300 border-red-500/30"
      : stakes === "medium"
        ? "text-amber-300 border-amber-500/30"
        : "text-muted-foreground border-border/60";
  return <span className={`rounded-full border px-1.5 py-0.5 ${cls}`}>{stakes}</span>;
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className="rounded-full border border-border/60 px-1.5 py-0.5 font-mono">{status}</span>
  );
}
