import type { ReactNode } from "react";

import { Tooltip } from "@/components/ui/tooltip";
import type {
  DecisionStakes,
  DecisionStatus,
  DecisionTier,
  ReviewVerdict,
} from "@/lib/decision-reader";
import { TONE } from "@/lib/tone";

/**
 * Shared, colour-graded, tooltip-carrying pills for the decision docket.
 * Colours come from the shared tone map (lib/tone.ts): act = sky,
 * done = emerald, warn = amber, danger = red, neutral = wait or inert. Every pill is a hover-tooltip so the
 * shorthand (tier number, verdict slug) explains itself.
 */

function Pill({ children, cls, tip }: { children: ReactNode; cls: string; tip: string }) {
  return (
    // `triggerClassName="shrink-0"`: the Tooltip's wrapper span is the actual
    // flex item in a pill row, so the pill must be marked non-shrinking THERE —
    // shrink-0 on the inner span below is invisible to the parent flex. Without
    // it a long sibling (a decision question) pushes the pill past the card edge.
    <Tooltip content={tip} triggerClassName="shrink-0">
      <span
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
      >
        {children}
      </span>
    </Tooltip>
  );
}

// ── Tier ──────────────────────────────────────────────────────────────────

const TIER_LABEL: Record<DecisionTier, string> = {
  0: "T0 · auto",
  1: "T1 · review",
  2: "T2 · your call",
};
const TIER_CLS: Record<DecisionTier, string> = {
  0: "bg-muted/30 text-muted-foreground border-border/60",
  1: "bg-muted/60 text-foreground/80 border-border",
  2: TONE.act.pill,
};
const TIER_TIP: Record<DecisionTier, string> = {
  0: "Tier 0: the agent decides, no human involvement. You never see it live.",
  1: "Tier 1: the agent decided and already proceeded; your review is calibration, not approval.",
  2: "Tier 2: your call — but decided from a deliberated brief, not a cold question.",
};

export function TierPill({ tier }: { tier: DecisionTier }) {
  return (
    <Pill cls={`shrink-0 ${TIER_CLS[tier]}`} tip={TIER_TIP[tier]}>
      {TIER_LABEL[tier]}
    </Pill>
  );
}

// ── Status ────────────────────────────────────────────────────────────────

const STATUS_CLS: Record<DecisionStatus, string> = {
  filed: "bg-muted/60 text-foreground/70 border-border",
  triaged: "bg-muted/60 text-foreground/70 border-border",
  deliberating: TONE.act.pill,
  resolved: TONE.act.pill,
  enacted: TONE.act.pill,
  reviewed: TONE.done.pill,
  archived: "bg-muted/30 text-muted-foreground border-border/60",
  superseded: "bg-muted/30 text-muted-foreground border-border/60",
  wontfix: "bg-muted/30 text-muted-foreground border-border/60",
};
const STATUS_TIP: Record<DecisionStatus, string> = {
  filed: "Filed. Awaiting triage or a deliberator.",
  triaged: "Triaged. Tier + stakes assigned; not yet deliberated.",
  deliberating: "Being deliberated (claimed by an agent).",
  resolved: "Resolved with cited evidence. Awaiting your review.",
  enacted: "Enacted. The work proceeded; awaiting your review.",
  reviewed: "Reviewed. You have weighed in; kept for precedent.",
  archived: "Archived. Its output graduated to a canonical home.",
  superseded: "Superseded by a newer decision.",
  wontfix: "Closed without action.",
};

export function StatusPill({ status }: { status: DecisionStatus }) {
  return (
    <Pill cls={`font-mono ${STATUS_CLS[status]}`} tip={STATUS_TIP[status]}>
      {status}
    </Pill>
  );
}

// ── Stakes ────────────────────────────────────────────────────────────────

const STAKES_CLS: Record<DecisionStakes, string> = {
  high: TONE.danger.pill,
  medium: TONE.warn.pill,
  small: "bg-muted/40 text-muted-foreground border-border/60",
};
const STAKES_DOT: Record<DecisionStakes, string> = {
  high: TONE.danger.dot,
  medium: TONE.warn.dot,
  small: "bg-muted-foreground/50",
};

export function StakesPill({ stakes }: { stakes: DecisionStakes }) {
  return (
    <Pill
      cls={STAKES_CLS[stakes]}
      tip="Stakes: reversal cost × blast radius. Higher stakes push a decision toward tier 2."
    >
      <span className={`size-1.5 rounded-full ${STAKES_DOT[stakes]}`} />
      {stakes}
    </Pill>
  );
}

// ── Verdict ───────────────────────────────────────────────────────────────

const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  ratified: "ratified",
  overridden: "overridden",
  "wrong-tier-high": "wanted sooner",
  "wrong-tier-low": "didn't need me",
};
const VERDICT_CLS: Record<ReviewVerdict, string> = {
  ratified: TONE.done.pill,
  overridden: TONE.danger.pill,
  "wrong-tier-high": TONE.warn.pill,
  "wrong-tier-low": TONE.warn.pill,
};
const VERDICT_TIP: Record<ReviewVerdict, string> = {
  ratified: "You agreed with the call. No action.",
  overridden: "You disagreed. In the full flow this spawns an unwind or redo.",
  "wrong-tier-high": "You should have seen this before it was enacted — retrains triage upward.",
  "wrong-tier-low": "You did not need to see this — triage was too eager; retrains it downward.",
};

export function VerdictPill({ verdict }: { verdict: ReviewVerdict }) {
  return (
    <Pill cls={VERDICT_CLS[verdict]} tip={VERDICT_TIP[verdict]}>
      {VERDICT_LABEL[verdict]}
    </Pill>
  );
}
