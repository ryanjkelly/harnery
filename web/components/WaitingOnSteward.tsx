"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { AgentChip } from "@/components/AgentChip";
import { Button } from "@/components/ui/button";
import { NO_DATA } from "@/lib/format/no-data";

/**
 * Empty-state banner for the Routing prompts card when the current round has
 * no drafted prompts yet. Surfaces a copyable one-liner that the operator
 * pastes into the steward's chat (or sends via `harn agents ping`).
 */
export function WaitingOnSteward({
  councilId,
  currentRound,
  steward,
}: {
  councilId: string;
  currentRound: number;
  steward: string;
}) {
  const kickoff = `Draft round ${currentRound} routing prompts for council \`${councilId}\`.`;
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(kickoff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* silent */
    }
  };

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-xs leading-relaxed space-y-2">
      <div>
        <strong className="text-amber-300">Waiting on steward.</strong> No
        prompts drafted yet for round {currentRound}.
      </div>
      <div className="text-muted-foreground">
        The steward (
        {steward ? (
          <AgentChip name={steward} className="font-mono text-foreground/80" />
        ) : (
          <span className="font-mono text-foreground/80">{NO_DATA}</span>
        )}
        ) drafts one prompt per member via{" "}
        <code className="font-mono text-[11px]">
          harn agents council prompt &lt;council-id&gt; &lt;member&gt; --message …
        </code>
        . They&apos;ll appear here as the steward writes them.
      </div>

      <div className="pt-2 border-t border-amber-500/20 space-y-1.5">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Operator next step
        </div>
        <div className="flex items-start gap-2">
          <code className="flex-1 font-mono text-[11px] leading-relaxed px-2 py-1.5 rounded bg-background border border-amber-500/20 select-all wrap-break-word">
            {kickoff}
          </code>
          <Button
            variant="default"
            size="sm"
            onClick={onCopy}
            tooltip={`Copy this one-liner, then paste it into the active chat with ${steward || "the steward"}.`}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
    </div>
  );
}
