import type { AttentionRequest } from "@/lib/attention";

/**
 * Maps the council banner's stage machine (components/RoutingGuide.tsx) onto
 * an operator-attention request, null whenever the next move belongs to an
 * AGENT, not the human:
 *
 *   stage 1 (a prompt is copy-able)   → alert, UNLESS that member is already
 *                                       heartbeating (the operator pasted; the
 *                                       agent is on it, alerting now is the
 *                                       annoying post-paste alarm)
 *   stage 2 (unrouted members owe)    → alert for the idle ones; suppressed
 *                                       while they're all live-working
 *   stage 3 (round complete)          → alert: advancing is purely operator
 *   stage 4 (exit criterion met)      → alert: CLOSING is the move, beats
 *                                       stage 3 so a collected final round
 *                                       points at Close, not Advance, and
 *                                       beats stages 1–2 trivially because
 *                                       the caller only sets it while the
 *                                       round has no prompts/contributions
 *                                       (an operator who drafts prompts has
 *                                       chosen to keep deliberating)
 *
 * The working-suppression also gives auto-clear for free: paste a prompt →
 * the member starts heartbeating → the request goes null → channels stop.
 * Trade-off (accepted): a member who happens to be heartbeating on unrelated
 * work when their prompt unlocks suppresses that transition's alert; the
 * banner still shows the move, and the next transition re-alerts.
 *
 * Keys carry council + round + member so each actionable moment alerts once
 * per tab (sessionStorage ack dedup in lib/attention.ts). The close key is
 * round-scoped too: if the council deliberately continues and a LATER round
 * re-satisfies the criterion, that new moment alerts again.
 */
export function councilAttentionRequest({
  councilId,
  currentRound,
  nextRound,
  activeMember,
  activeMemberWorking,
  pendingUnrouted,
  workingUnrouted,
  closeRecommended = false,
}: {
  councilId: string;
  currentRound: number;
  nextRound: number;
  /** Member whose prompt is copy-able now, or null when all routed. */
  activeMember: string | null;
  activeMemberWorking: boolean;
  /** Members with no routing prompt who haven't contributed (the steward). */
  pendingUnrouted: string[];
  /** Subset of pendingUnrouted heartbeating right now. */
  workingUnrouted: string[];
  /**
   * Exit criterion met AND the operator hasn't chosen to continue (current
   * round is collected, or open with zero prompts + zero contributions).
   * Computed in app/councils/[id]/page.tsx; the same flag drives the
   * banner's stage-0 render and the Actions panel's Close highlight.
   */
  closeRecommended?: boolean;
}): AttentionRequest | null {
  // Stage 4, exit criterion met: closing the council is the operator's move.
  if (closeRecommended) {
    return {
      key: `att:council:${councilId}:r${currentRound}:close`,
      label: "Exit criterion met: close the council",
    };
  }

  // Stage 3, every member is in; advancing the round is the operator's move.
  if (activeMember === null && pendingUnrouted.length === 0) {
    return {
      key: `att:council:${councilId}:r${currentRound}:advance`,
      label: `Round ${currentRound} complete: advance to round ${nextRound}`,
    };
  }

  // Stage 2, routed prompts are all in; unrouted members (steward) still owe.
  if (activeMember === null) {
    const working = new Set(workingUnrouted);
    const idle = pendingUnrouted.filter((name) => !working.has(name));
    if (idle.length === 0) return null;
    return {
      key: `att:council:${councilId}:r${currentRound}:unrouted:${pendingUnrouted.join("+")}`,
      label: `Prompt ${idle.join(", ")} for their round-${currentRound} take`,
    };
  }

  // Stage 1, a prompt is copy-able. Quiet while that member is working.
  if (activeMemberWorking) return null;
  return {
    key: `att:council:${councilId}:r${currentRound}:copy:${activeMember}`,
    label: `Copy ${activeMember}'s round-${currentRound} prompt`,
  };
}

/**
 * Closed-council wrap-up counterpart (components/CouncilCompletionBanner.tsx):
 * after Close, two operator moves remain: route the close-out-handoff prompt
 * to the steward, then Archive. Both are real waits-on-the-human moments, so
 * they alert like the routing stages do:
 *
 *   step 1 (handoff pending) → alert: copy the kickoff prompt, suppressed
 *                              while the steward is heartbeating (they're
 *                              already writing it; same post-paste quiet rule
 *                              as routing stage 1)
 *   step 2 (handoff landed)  → alert: Archive is the final, purely-operator
 *                              click
 *
 * Archived councils are terminal (null). Keys are step-scoped so landing the
 * handoff re-alerts for the archive moment even after step 1 was acked.
 */
export function councilWrapupAttentionRequest({
  councilId,
  closed,
  handoffDone,
  stewardWorking,
}: {
  councilId: string;
  /** status === "closed" and not archived (the only wrap-up-actionable state). */
  closed: boolean;
  handoffDone: boolean;
  /** True while the steward's agent is heartbeating right now. */
  stewardWorking: boolean;
}): AttentionRequest | null {
  if (!closed) return null;
  if (!handoffDone) {
    if (stewardWorking) return null;
    return {
      key: `att:council:${councilId}:wrapup:handoff`,
      label: "Route the close-out handoff prompt to the steward",
    };
  }
  return {
    key: `att:council:${councilId}:wrapup:archive`,
    label: "Archive the council: final step",
  };
}

/**
 * Fresh-round empty state (components/WaitingOnSteward.tsx): the round is
 * open with ZERO prompts drafted, so NextActionBanner (and its attention
 * mount) doesn't render — but the state still waits on the HUMAN: copy the
 * steward kickoff one-liner into the steward's chat. Without this request the
 * post-advance moment was silent (operator feedback, 2026-07-06).
 *
 * Same live-working quiet rule as routing stage 1: while the steward's agent
 * is heartbeating they're likely already drafting prompts, so alerting would
 * be the annoying post-paste alarm. Key carries council + round so each new
 * round's kickoff moment alerts once.
 */
export function councilStewardKickoffAttentionRequest({
  councilId,
  currentRound,
  stewardWorking,
}: {
  councilId: string;
  currentRound: number;
  /** True while the steward's agent is heartbeating right now. */
  stewardWorking: boolean;
}): AttentionRequest | null {
  if (stewardWorking) return null;
  return {
    key: `att:council:${councilId}:r${currentRound}:steward-kickoff`,
    label: `Round ${currentRound} needs prompts: copy the steward kickoff`,
  };
}
