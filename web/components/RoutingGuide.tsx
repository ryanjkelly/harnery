"use client";

import {
  ArrowRight,
  Check,
  CheckCheck,
  KeyRound,
  MousePointerClick,
  PenLine,
  UserCog,
} from "lucide-react";

import { AgentChip } from "@/components/AgentChip";
import { Attention } from "@/components/Attention";
import {
  AdvanceCouncilTrigger,
  CloseCouncilTrigger,
} from "@/components/CouncilActionTrigger";
import { useHostInfo } from "@/components/HostInfoProvider";
import { councilAttentionRequest } from "@/lib/council-attention";
import { harnessLabel } from "@/lib/harness";

/**
 * Presentational helpers that make the council routing flow self-explanatory and
 * draw the operator's eye to the one thing to do next. Pure (no client state):
 * they render off the same per-prompt state the RoutingPromptTabs use, plus
 * member-level round state and a live "working" signal from heartbeats.
 *
 * The model they explain: the steward drafts one prompt per member; the operator
 * copies the **active** prompt, pastes it into that agent's harness session, and
 * the agent runs `/council contribute`, which unlocks the next prompt. Queued
 * prompts are copy-disabled so routing can't happen out of order. The steward
 * routes prompts to OTHERS and contributes directly, so "all prompts contributed"
 * does NOT mean the round is done. The banner walks all three stages:
 *
 *   1. a prompt is active          → sky: copy it into that agent's session
 *   2. prompts in, members missing → sky: the unrouted member(s) (steward) still
 *      owe their own take. Surface the exact contribute command.
 *   3. every member contributed    → emerald: point at "Advance to round N+1"
 *   0. exit criterion met          → emerald: point at "Close the council". This
 *      beats every other stage. It covers both a collected final round (where
 *      stage 3 would otherwise mislead the operator into advancing) and an
 *      open round nobody has acted on (operator advanced past the finish
 *      line; closing from there is safe). Once a prompt or contribution
 *      lands in the open round, the operator has chosen to continue and
 *      stages 1–3 take back over.
 *
 * Colour system (shared with RoutingPromptTabs + the Key): sky = act now, neutral =
 * wait, emerald = done, emerald pulse = an agent is working live.
 */

/** Always-visible "what do I do next" callout, shown above the prompts card. */
export function NextActionBanner({
  councilId,
  activeMember,
  activeMemberPlatform,
  activeMemberWorking,
  routedContributed,
  routedTotal,
  pendingUnrouted,
  workingUnrouted,
  steward,
  memberContributed,
  memberTotal,
  currentRound,
  nextRound,
  exitCriterionMet,
  consecutiveAllTrivialRounds,
  roundIdle,
}: {
  councilId: string;
  /** The member whose prompt is copy-able right now, or null when all routed. */
  activeMember: string | null;
  /** Coord-layer platform of the active member ("claude_code" | "codex" | "cursor"), when known. */
  activeMemberPlatform?: string | null;
  /** True when the active member's agent is heartbeating right now. */
  activeMemberWorking?: boolean;
  routedContributed: number;
  routedTotal: number;
  /** Members with NO routing prompt who haven't contributed (typically the steward). */
  pendingUnrouted: string[];
  /** Subset of pendingUnrouted heartbeating right now. */
  workingUnrouted?: string[];
  steward: string | null;
  memberContributed: number;
  memberTotal: number;
  currentRound: number;
  nextRound: number;
  /** Two consecutive all-Trivial collected rounds; deliberation converged. */
  exitCriterionMet?: boolean;
  consecutiveAllTrivialRounds?: number;
  /** Current round is open with zero prompts + zero contributions (page.tsx). */
  roundIdle?: boolean;
}) {
  const { binName } = useHostInfo();
  // Stage-0 gate, mirrored by CouncilActions' closeRecommended: criterion met
  // AND the operator hasn't acted on the current round (it's collected, or
  // open-but-untouched). Drafted prompts / landed contributions = continuing.
  const closeRecommended = Boolean(
    exitCriterionMet &&
      ((activeMember === null && pendingUnrouted.length === 0) || roundIdle),
  );

  // One attention request per banner state: the provider title-flashes /
  // chimes / edge-pulses until the operator interacts (lib/council-attention.ts
  // documents the per-stage + working-suppression rules).
  const attention = councilAttentionRequest({
    councilId,
    currentRound,
    nextRound,
    activeMember,
    activeMemberWorking: activeMemberWorking ?? false,
    pendingUnrouted,
    workingUnrouted: workingUnrouted ?? [],
    closeRecommended,
  });

  // Stage 0, exit criterion met: closing is the one move left. Must beat
  // stage 3, whose "Advance to round N+1" guidance is exactly how operators
  // end up with a stray open round past the finish line.
  if (closeRecommended) {
    return (
      <div className="rounded-lg border border-emerald-500/45 bg-emerald-500/[0.07] px-4 py-3.5 flex items-start gap-3">
        <Attention request={attention} />
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/40">
          <CheckCheck className="size-4 text-emerald-400" aria-hidden />
        </span>
        <p className="text-sm text-foreground/90 leading-relaxed self-center min-w-0 flex-1">
          <span className="font-semibold text-emerald-300">
            {`Exit criterion met: ${consecutiveAllTrivialRounds ?? 2} consecutive all-trivial rounds.`}
          </span>{" "}
          <span className="font-semibold">Next:</span>{" "}
          <CloseCouncilTrigger className="font-medium text-emerald-300 underline decoration-emerald-500/50 underline-offset-2 hover:text-emerald-200 cursor-pointer">
            Close the council
            <ArrowRight className="inline size-3.5 ml-0.5 -mt-0.5" aria-hidden />
          </CloseCouncilTrigger>
          {roundIdle
            ? `. It opens the confirmation right here. Round ${currentRound} is open but nothing is pending in it, so closing ends the empty round. To keep deliberating instead, have the steward draft round-${currentRound} prompts.`
            : `. It opens the confirmation right here. Deliberation is complete; the council stays inspectable read-only after close.`}
        </p>
        <span className="shrink-0 self-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs tabular-nums text-emerald-200/90">
          {roundIdle ? "ready to close" : `${memberContributed} of ${memberTotal} in`}
        </span>
      </div>
    );
  }

  // Stage 3, every member is in: the one move left is advancing the round.
  if (activeMember === null && pendingUnrouted.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-500/45 bg-emerald-500/[0.07] px-4 py-3.5 flex items-start gap-3">
        <Attention request={attention} />
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/40">
          <Check className="size-4 text-emerald-400" aria-hidden />
        </span>
        <p className="text-sm text-foreground/90 leading-relaxed self-center min-w-0 flex-1">
          <span className="font-semibold text-emerald-300">
            Round {currentRound} complete: all {memberTotal} members are in.
          </span>{" "}
          <span className="font-semibold">Next:</span>{" "}
          <AdvanceCouncilTrigger className="font-medium text-emerald-300 underline decoration-emerald-500/50 underline-offset-2 hover:text-emerald-200 cursor-pointer">
            Advance to round {nextRound}
            <ArrowRight className="inline size-3.5 ml-0.5 -mt-0.5" aria-hidden />
          </AdvanceCouncilTrigger>
          . It opens the confirmation right here; contributions unlock for
          everyone once the new round opens, and the steward synthesizes them
          into the plan.
        </p>
        <span className="shrink-0 self-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs tabular-nums text-emerald-200/90">
          {memberContributed} of {memberTotal} in
        </span>
      </div>
    );
  }

  // Stage 2, every drafted prompt is in, but unrouted members (the steward
  // doesn't route a prompt to themselves) still owe their own take.
  if (activeMember === null) {
    const single = pendingUnrouted.length === 1;
    return (
      <div className="rounded-lg border border-sky-500/45 bg-sky-500/[0.07] px-4 py-3.5 flex items-start gap-3">
        <Attention request={attention} />
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-sky-500/15 ring-1 ring-sky-500/40">
          <PenLine className="size-4 text-sky-400" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 self-center">
          <p className="text-sm text-foreground/90 leading-relaxed">
            <span className="font-semibold text-sky-300">
              All {routedTotal} routed prompts are in.
            </span>{" "}
            <span className="font-semibold">Still needed:</span> the round-
            {currentRound} take from{" "}
            {pendingUnrouted.map((name, i) => (
              <span key={name}>
                {i > 0 && ", "}
                <AgentChip name={name} className="font-mono text-foreground" />
                {steward !== null && name === steward && (
                  <span className="text-muted-foreground"> (steward)</span>
                )}
              </span>
            ))}
            {". "}
            The steward gets no routing prompt and contributes directly. Ask{" "}
            {single ? "them" : "each"} to run:
          </p>
          <p className="mt-1.5">
            {/* Template literal on purpose: JSX text segments with HTML
                entities directly after an expression lose their leading space
                under this Next/SWC version (the "round 2once" bug). */}
            <code
              data-attention-target
              className="font-mono text-xs rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-200/90 break-all"
            >
              {`${binName} agents council contribute ${councilId} --file <their-take>.md`}
            </code>
          </p>
          {(workingUnrouted ?? []).map((name) => (
            <p
              key={name}
              className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-300"
            >
              <span className="live-dot" aria-hidden />
              <AgentChip name={name} className="font-mono" /> is working now.
              Watch for the contribution to land.
            </p>
          ))}
        </div>
        <span className="shrink-0 self-center rounded-full bg-sky-500/10 px-2 py-0.5 text-xs tabular-nums text-sky-200/90">
          {memberContributed} of {memberTotal} in
        </span>
      </div>
    );
  }

  // Stage 1, a prompt is copy-able: routing is the operator's move.
  return (
    <div className="rounded-lg border border-sky-500/45 bg-sky-500/[0.07] px-4 py-3.5 flex items-start gap-3">
      <Attention request={attention} />
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-sky-500/15 ring-1 ring-sky-500/40">
        <MousePointerClick className="size-4 text-sky-400" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 self-center">
        <p className="text-sm text-foreground/90 leading-relaxed">
          <span className="font-semibold text-sky-300">Next:</span> copy{" "}
          <AgentChip name={activeMember} className="font-mono text-foreground" />
          &apos;s prompt below and paste it into their{" "}
          {activeMemberPlatform ? (
            <span className="font-medium text-foreground">
              {harnessLabel(activeMemberPlatform)}
            </span>
          ) : (
            "harness"
          )}{" "}
          session. They run{" "}
          <code className="font-mono">/council contribute</code> to submit, and
          the next prompt unlocks automatically.
        </p>
        {activeMemberWorking && (
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-emerald-300">
            <span className="live-dot" aria-hidden />
            <AgentChip name={activeMember} className="font-mono" /> is working now.
            Watch for the contribution to land.
          </p>
        )}
      </div>
      <span className="shrink-0 self-center rounded-full bg-sky-500/10 px-2 py-0.5 text-xs tabular-nums text-sky-200/90">
        {routedContributed} of {routedTotal} routed
      </span>
    </div>
  );
}

/** Inline explainer + a clearly-delimited "Key" box for the panel badges. */
export function RoutingLegend() {
  return (
    <div className="mb-4">
      <p className="text-xs text-muted-foreground leading-relaxed mb-2.5">
        Copy each prompt and paste it into that agent&apos;s session,{" "}
        <strong className="text-foreground/80">in order</strong>. The receiving
        agent runs <code className="font-mono">/council contribute</code> to
        submit, then the next prompt below becomes copy-able.
      </p>
      <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          <KeyRound className="size-3" aria-hidden />
          Key
        </div>
        <ul className="flex flex-col gap-1.5 text-xs">
          <KeyRow
            swatch={<span className="size-2.5 rounded-full bg-sky-400" />}
            term="active"
            termCls="text-sky-300"
            meaning="copy this one now; it's your move"
          />
          <KeyRow
            swatch={
              <span className="size-2.5 rounded-full border border-muted-foreground/60" />
            }
            term="queued"
            termCls="text-muted-foreground"
            meaning="waiting its turn; Copy is disabled until the one above contributes"
          />
          <KeyRow
            swatch={<Check className="size-3 text-emerald-400" />}
            term="contributed"
            termCls="text-emerald-300"
            meaning="that agent has submitted"
          />
          <KeyRow
            swatch={<span className="live-dot" />}
            term="working"
            termCls="text-emerald-300"
            meaning="that agent is heartbeating live right now (off-screen progress)"
          />
          <KeyRow
            swatch={<UserCog className="size-3 text-muted-foreground" />}
            term="steward"
            termCls="text-muted-foreground"
            meaning="routes the prompts and contributes directly; no prompt to copy, but still counts toward the round"
          />
        </ul>
      </div>
    </div>
  );
}

function KeyRow({
  swatch,
  term,
  termCls,
  meaning,
}: {
  swatch: React.ReactNode;
  term: string;
  termCls: string;
  meaning: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <span className="grid w-4 shrink-0 place-items-center">{swatch}</span>
      <span className={`font-mono shrink-0 ${termCls}`}>{term}</span>
      <span className="text-muted-foreground/70">: {meaning}</span>
    </li>
  );
}
