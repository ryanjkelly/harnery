"use client";

import { useState } from "react";
import { CheckCircle2, Copy, FileText, PartyPopper } from "lucide-react";


import { AgentChip } from "@/components/AgentChip";
import { Attention } from "@/components/Attention";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { councilWrapupAttentionRequest } from "@/lib/council-attention";
import { formatRelativeAgo } from "@/lib/format/datetime";
import { NO_DATA } from "@/lib/format/no-data";

/**
 * Full-width terminal-state banner shown above the main content when a
 * council reaches its terminal stages. Renders nothing for active councils.
 *
 * Three flavors:
 *  - archived → deep-emerald "Council complete"
 *  - closed (handoff written) → emerald "Council closed; archive to wrap up"
 *  - closed (handoff pending) → emerald with a copyable steward kickoff prompt
 *
 * The closed flavors mount an operator-attention request (step 1: route the
 * handoff prompt, quiet while the steward is working; step 2: archive). The
 * wrap-up steps are waits-on-the-human exactly like the routing stages.
 */
export function CouncilCompletionBanner({
  status,
  archived,
  closedAt,
  archivedAt,
  councilId,
  steward,
  consecutiveAllTrivialRounds,
  totalRounds,
  closeHandoffPath,
}: {
  status: "active" | "closed" | "archived";
  archived: boolean;
  closedAt?: string | null;
  archivedAt?: string | null;
  councilId: string;
  steward: string;
  consecutiveAllTrivialRounds: number;
  totalRounds: number;
  closeHandoffPath: string | null;
  /** True while the steward's agent is heartbeating (quiets the step-1 alert). */
}) {
  if (status === "active" && !archived) return null;

  if (archived) {
    return (
      <div className="mb-6 rounded-md border-2 border-emerald-500/50 bg-emerald-500/10 px-4 py-3.5">
        <div className="flex items-start gap-3">
          <PartyPopper className="size-5 shrink-0 text-emerald-300 mt-0.5" aria-hidden />
          <div className="space-y-1.5 flex-1">
            <h3 className="text-base font-semibold text-emerald-300">Council complete</h3>
            <p className="text-xs leading-relaxed text-foreground/80">
              Ran for{" "}
              <strong className="text-white">
                {totalRounds} round{totalRounds === 1 ? "" : "s"}
              </strong>
              {consecutiveAllTrivialRounds > 0 && (
                <>
                  , exited on{" "}
                  <strong className="text-white">
                    {consecutiveAllTrivialRounds} consecutive all-Trivial
                  </strong>
                </>
              )}
              . Closed <FormattedTs iso={closedAt} />, archived{" "}
              <FormattedTs iso={archivedAt} />{" "}
              {archivedAt && <span className="text-muted">({relativeAgo(archivedAt)})</span>}.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ClosedHandoffState
      closedAt={closedAt}
      councilId={councilId}
      steward={steward}
      consecutiveAllTrivialRounds={consecutiveAllTrivialRounds}
      totalRounds={totalRounds}
      closeHandoffPath={closeHandoffPath}
    />
  );
}

function ClosedHandoffState({
  closedAt,
  councilId,
  steward,
  consecutiveAllTrivialRounds,
  totalRounds,
  closeHandoffPath,
}: {
  closedAt?: string | null;
  councilId: string;
  steward: string;
  consecutiveAllTrivialRounds: number;
  totalRounds: number;
  closeHandoffPath: string | null;
}) {
  const handoffDone = closeHandoffPath !== null;
  const handoffBasename = closeHandoffPath
    ? closeHandoffPath.split("/").pop() ?? closeHandoffPath
    : null;
  const attention = councilWrapupAttentionRequest({
    councilId,
    closed: true,
    handoffDone,
  });

  return (
    <div className="mb-6 rounded-md border-2 border-emerald-500/40 bg-emerald-500/8 px-4 py-3.5 space-y-3">
      <Attention request={attention} />
      <div className="flex items-start gap-3">
        <CheckCircle2 className="size-5 shrink-0 text-emerald-300 mt-0.5" aria-hidden />
        <div className="space-y-1.5 flex-1">
          <h3 className="text-base font-semibold text-emerald-300">
            Council closed successfully
          </h3>
          <p className="text-xs leading-relaxed text-foreground/80">
            Ran for{" "}
            <strong className="text-white">
              {totalRounds} round{totalRounds === 1 ? "" : "s"}
            </strong>
            {consecutiveAllTrivialRounds > 0 && (
              <>
                , exited on{" "}
                <strong className="text-white">
                  {consecutiveAllTrivialRounds} consecutive all-Trivial
                </strong>
              </>
            )}
            . Closed <FormattedTs iso={closedAt} />{" "}
            {closedAt && <span className="text-muted">({relativeAgo(closedAt)})</span>}.
          </p>
        </div>
      </div>

      <div className="rounded border border-emerald-500/30 bg-background px-3 py-2.5 space-y-3">
        <div className="text-[10px] uppercase tracking-wide text-muted">
          Wrap-up: 2 steps to 100% complete
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs font-medium text-white">
              <span className="text-muted tabular-nums mr-1">1.</span>
              Steward close-out handoff
            </div>
            <span
              className={
                handoffDone
                  ? "inline-flex items-center rounded border border-emerald-500/50 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300"
                  : "inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300"
              }
            >
              {handoffDone ? "Done" : "Pending"}
            </span>
          </div>
          {handoffDone ? (
            <p className="text-xs text-muted leading-relaxed">
              Handoff doc landed:{" "}
              <span className="font-mono text-[11px] text-emerald-300 inline-flex items-center gap-1">
                <FileText className="size-3 shrink-0" aria-hidden />
                {handoffBasename}
              </span>
              {" "}
              <span className="text-muted">({closeHandoffPath})</span>
              .
            </p>
          ) : (
            <HandoffPendingSection councilId={councilId} steward={steward} />
          )}
        </div>

        <div className="space-y-1.5 border-t border-emerald-500/20 pt-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs font-medium text-white">
              <span className="text-muted tabular-nums mr-1">2.</span>
              Archive
            </div>
            <span className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
              Pending
            </span>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            {handoffDone ? (
              <>
                Click <strong className="text-white">Archive</strong> in the Actions card to
                move the council to{" "}
                <code className="font-mono text-[11px]">.harnery/councils/archive/</code>{" "}
                and mark it 100% complete.
              </>
            ) : (
              <>
                After step 1, click <strong className="text-white">Archive</strong> in the
                Actions card.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

function HandoffPendingSection({
  councilId,
  steward,
}: {
  councilId: string;
  steward: string;
}) {
  const kickoff = `Write the close-out handoff for council \`${councilId}\`.`;
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(kickoff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <>
      <p className="text-xs text-muted leading-relaxed">
        The steward (
        {steward ? (
          <AgentChip name={steward} className="font-mono text-white" />
        ) : (
          <span className="font-mono text-white">{NO_DATA}</span>
        )}
        ) writes the close-out handoff (a brief in{" "}
        <code className="font-mono text-[11px]">docs/handoffs/YYYY-MM/</code>) summarizing
        the final plan + any open loops. After it lands, archive the council to mark it
        100% complete.
      </p>
      <div className="flex items-start gap-2">
        <code className="flex-1 font-mono text-[11px] leading-relaxed px-2 py-1.5 rounded bg-background border border-emerald-500/20 select-all wrap-break-word">
          {kickoff}
        </code>
        <button
          type="button"
          onClick={onCopy}
          data-attention-target
          className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-emerald-50"
        >
          <Copy className="size-3" aria-hidden />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </>
  );
}

function FormattedTs({ iso }: { iso?: string | null }) {
  if (!iso) return <span>{NO_DATA}</span>;
  return (
    <FormattedDateTime iso={iso} className="font-mono text-[11px]" />
  );
}

function relativeAgo(iso: string): string {
  return formatRelativeAgo(iso) || NO_DATA;
}
