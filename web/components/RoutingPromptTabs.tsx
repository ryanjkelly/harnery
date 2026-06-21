"use client";

import { Fragment, useState } from "react";
import { Check, ChevronRight, Copy, MousePointerClick, UserCog } from "lucide-react";

import { AgentChip } from "@/components/AgentChip";
import { useAttentionState } from "@/components/AttentionProvider";
import { useHostInfo } from "@/components/HostInfoProvider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { formatRelativeAgo } from "@/lib/format/datetime";
import { harnessLabel } from "@/lib/harness";
import type { CouncilPromptState } from "@/lib/coord-reader";

/** Live heartbeat signal for the member a prompt routes to. */
export interface MemberActivity {
  lastTool: string | null;
  lastSeen: string;
}

export interface RoutingPrompt {
  member: string;
  body: string;
  bytes: number;
  state: CouncilPromptState;
  order: number;
  activity?: MemberActivity | null;
  /** Coord-layer platform of the member's session ("claude_code" | "codex" | "cursor"), when known. */
  platform?: string | null;
  /** The model the member's session last used (e.g. "gpt-5.5"), when known. */
  model?: string | null;
}

/** The steward's seat in the strip: a member with NO routing prompt. */
export interface StewardSeat {
  name: string;
  contributed: boolean;
  platform?: string | null;
  model?: string | null;
  activity?: MemberActivity | null;
}

/**
 * The round's members as a strip in routing order, + a single detail pane.
 *
 * The strip shows EVERY member of the round: the routed prompts left-to-right
 * in the order the operator pastes them (chevrons make the queue explicit; no
 * "1/3"-style ordinals, which read as progress fractions and disagree with the
 * member-level "N of M in" counts), then the steward as a distinct dashed seat.
 * The steward routes prompts to others and contributes directly, so they have
 * no prompt to copy but their round state matters just as much. With the
 * steward seated, the strip's checkmarks always agree with the banner's
 * member count.
 *
 * Selection auto-follows the action: the active (copy-now) prompt while
 * routing, then the steward's seat when prompts are all in but the steward's
 * own take is missing. Click any chip to pin it. The sequential Copy guard is
 * preserved: any prompt is readable, but only the active one is copy-able.
 */
export function RoutingPromptTabs({
  prompts,
  steward,
  councilId,
  currentRound,
}: {
  prompts: RoutingPrompt[];
  steward?: StewardSeat | null;
  councilId?: string;
  currentRound?: number;
}) {
  const bare = (n: string) =>
    (n.startsWith("agent-") ? n.slice("agent-".length) : n).toLowerCase();
  // A steward who ALSO has a routed prompt (the CLI allows it) keeps their
  // prompt tab; don't seat them twice.
  const showSteward = Boolean(
    steward && !prompts.some((p) => bare(p.member) === bare(steward.name)),
  );

  const activeIndex = prompts.findIndex((p) => p.state === "active");
  // While the page-level attention alert is live (operator hasn't interacted
  // yet), spotlight the actionable chip + Copy button with a breathing ring.
  const { isAlerting } = useAttentionState();
  // null = "follow the action"; a number or "steward" = operator pinned it.
  const [pinned, setPinned] = useState<number | "steward" | null>(null);
  const autoSelection: number | "steward" =
    activeIndex >= 0
      ? activeIndex
      : showSteward && steward && !steward.contributed
        ? "steward"
        : 0;
  const selection = pinned ?? autoSelection;
  const selected =
    selection === "steward" ? null : (prompts[selection] ?? prompts[0]);

  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!selected || selected.state !== "active") return;
    try {
      await navigator.clipboard.writeText(selected.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* silent */
    }
  };

  if (prompts.length === 0) return null;

  return (
    <div>
      {/* Member strip in routing order. Chevrons carry the "paste in this
          sequence" semantic; the steward's seat closes the member count. */}
      <div
        role="tablist"
        aria-label="Round members in routing order"
        className="flex flex-wrap items-center gap-1 border-b border-border/60"
      >
        {prompts.map((p, i) => (
          <Fragment key={p.member}>
            {i > 0 && <SequenceArrow />}
            <PromptTab
              prompt={p}
              selected={selection === i}
              alerting={isAlerting}
              onSelect={() => setPinned(i)}
            />
          </Fragment>
        ))}
        {showSteward && steward && (
          <>
            <SequenceArrow />
            <StewardTab
              seat={steward}
              selected={selection === "steward"}
              onSelect={() => setPinned("steward")}
            />
          </>
        )}
      </div>

      {/* Detail pane: the selected member's prompt, or the steward explainer. */}
      {selection === "steward" && steward ? (
        <StewardDetail
          seat={steward}
          councilId={councilId}
          currentRound={currentRound}
        />
      ) : selected ? (
        <div role="tabpanel" className="pt-3">
          <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <AgentChip
                name={selected.member}
                className="text-xs font-mono font-semibold text-foreground"
              />
              <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                {selected.bytes.toLocaleString()} bytes
              </span>
              <HarnessBadge platform={selected.platform} model={selected.model} />
              <StateBadge state={selected.state} />
              {selected.activity && selected.state !== "contributed" && (
                <Tooltip
                  content={`${selected.member}'s agent is heartbeating right now: live off-screen progress; watch for the contribution to land.`}
                >
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300 cursor-help">
                    <span className="live-dot" aria-hidden />
                    working
                    {selected.activity.lastTool ? `: ${selected.activity.lastTool}` : ""}
                    <span className="text-emerald-300/60 tabular-nums">
                      · {formatRelativeAgo(selected.activity.lastSeen)}
                    </span>
                  </span>
                </Tooltip>
              )}
            </div>
            <Button
              variant={selected.state === "active" ? "default" : "outline"}
              size="sm"
              className={
                isAlerting && selected.state === "active"
                  ? "attention-ring"
                  : undefined
              }
              onClick={onCopy}
              disabled={selected.state !== "active"}
              tooltip={
                selected.state === "active"
                  ? "Copy this prompt, then paste it into the receiving agent's harness."
                  : selected.state === "contributed"
                    ? `${selected.member} already contributed; prompt no longer actionable.`
                    : "Queued. Wait for the active prompt to be contributed before routing this one."
              }
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>

          {selected.state === "active" && (
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-sky-300">
              <MousePointerClick className="size-3.5 shrink-0" aria-hidden />
              Next up: copy this into{" "}
              <AgentChip name={selected.member} className="font-mono" />
              &apos;s session; they run{" "}
              <code className="font-mono">/council contribute</code> to submit.
            </p>
          )}

          <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed px-3 py-2 rounded border border-border/60 bg-background/60 max-h-100 overflow-y-auto">
            {selected.body}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/** Muted chevron between strip chips: the visual "then" of the routing queue. */
function SequenceArrow() {
  return (
    <ChevronRight
      className="size-3 shrink-0 text-muted-foreground/40"
      aria-hidden
    />
  );
}

/** One compact prompt chip: state-at-a-glance, no body. */
function PromptTab({
  prompt,
  selected,
  alerting = false,
  onSelect,
}: {
  prompt: RoutingPrompt;
  selected: boolean;
  /** Page-level attention alert is live; spotlight the active chip. */
  alerting?: boolean;
  onSelect: () => void;
}) {
  const { state, member, activity } = prompt;
  const nameCls =
    state === "active"
      ? "font-semibold text-sky-300"
      : state === "contributed"
        ? "text-emerald-300/70 line-through"
        : "text-muted-foreground";
  const stateHint =
    state === "active"
      ? "Active. Copy this prompt now; it's your move."
      : state === "contributed"
        ? "Contributed. This member's take is in."
        : "Queued. Copy unlocks once the prompt before it is contributed.";
  return (
    <Tooltip
      content={
        <div className="space-y-1">
          <p className="font-mono text-foreground">{member}</p>
          <p>{stateHint}</p>
          {activity && state !== "contributed" && (
            <p className="text-emerald-300">
              Heartbeating live right now (off-screen progress).
            </p>
          )}
        </div>
      }
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={onSelect}
        className={`-mb-px flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs font-mono transition-colors ${
          selected
            ? "border-foreground/70 bg-card text-foreground"
            : "border-transparent text-muted-foreground hover:bg-muted/40"
        }${alerting && state === "active" ? " attention-ring" : ""}`}
      >
        <StateDot state={state} />
        <span className={nameCls}>{member}</span>
        {/* Live pulse rides on the chip so off-screen progress is visible even
            when this chip isn't selected, which is the point of the at-a-glance strip. */}
        {activity && state !== "contributed" && (
          <span className="live-dot" aria-hidden />
        )}
      </button>
    </Tooltip>
  );
}

/** The steward's dashed seat: a member with no prompt to copy. */
function StewardTab({
  seat,
  selected,
  onSelect,
}: {
  seat: StewardSeat;
  selected: boolean;
  onSelect: () => void;
}) {
  const nameCls = seat.contributed
    ? "text-emerald-300/70 line-through"
    : "font-semibold text-sky-300";
  return (
    <Tooltip
      content={
        <div className="space-y-1">
          <p className="font-mono text-foreground">{seat.name}</p>
          <p>
            Steward: routes the prompts and contributes directly; no prompt
            to copy.
          </p>
          <p>
            {seat.contributed
              ? "Their take is in."
              : "Their take is still needed this round."}
          </p>
          {seat.activity && !seat.contributed && (
            <p className="text-emerald-300">
              Heartbeating live right now (off-screen progress).
            </p>
          )}
        </div>
      }
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={onSelect}
        className={`-mb-px flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs font-mono transition-colors ${
          selected
            ? "border-foreground/70 bg-card text-foreground"
            : "border-transparent text-muted-foreground hover:bg-muted/40"
        }`}
      >
        {seat.contributed ? (
          <Check className="size-3 text-emerald-400" aria-hidden />
        ) : (
          <span className="size-2 rounded-full bg-sky-400" aria-hidden />
        )}
        <span className={nameCls}>{seat.name}</span>
        <span className="inline-flex items-center gap-0.5 rounded-sm border border-dashed border-muted-foreground/40 px-1 py-px text-[9px] uppercase tracking-wider text-muted-foreground/70">
          <UserCog className="size-2.5" aria-hidden />
          steward
        </span>
        {seat.activity && !seat.contributed && (
          <span className="live-dot" aria-hidden />
        )}
      </button>
    </Tooltip>
  );
}

/** Detail pane for the steward's seat. Explains the no-prompt seat instead of
 *  rendering a body, and carries the contribute command while their take is
 *  still missing. */
function StewardDetail({
  seat,
  councilId,
  currentRound,
}: {
  seat: StewardSeat;
  councilId?: string;
  currentRound?: number;
}) {
  const { binName } = useHostInfo();
  return (
    <div role="tabpanel" className="pt-3">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <AgentChip
          name={seat.name}
          className="text-xs font-mono font-semibold text-foreground"
        />
        <span className="inline-flex items-center gap-1 rounded-sm border border-dashed border-muted-foreground/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/80">
          <UserCog className="size-3" aria-hidden />
          steward
        </span>
        <HarnessBadge platform={seat.platform} model={seat.model} />
        {seat.contributed ? (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 bg-emerald-500/15 text-emerald-300 ring-emerald-500/30">
            <Check className="size-3" aria-hidden />
            contributed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 bg-sky-500/15 text-sky-300 ring-sky-500/30">
            take needed
          </span>
        )}
        {seat.activity && !seat.contributed && (
          <Tooltip
            content={`${seat.name}'s agent is heartbeating right now: live off-screen progress; watch for the contribution to land.`}
          >
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300 cursor-help">
              <span className="live-dot" aria-hidden />
              working
              {seat.activity.lastTool ? `: ${seat.activity.lastTool}` : ""}
              <span className="text-emerald-300/60 tabular-nums">
                · {formatRelativeAgo(seat.activity.lastSeen)}
              </span>
            </span>
          </Tooltip>
        )}
      </div>
      <div className="text-xs leading-relaxed px-3 py-2.5 rounded border border-dashed border-border/60 bg-background/60 text-muted-foreground space-y-1.5">
        <p>
          The steward drafts and routes the prompts above, then contributes
          their own take directly. There&apos;s no prompt to copy for this
          seat.
        </p>
        {seat.contributed ? (
          <p className="text-emerald-300/90">
            <Check className="inline size-3 -mt-0.5 mr-1" aria-hidden />
            {/* Single template literal; see the entity-whitespace trap in
                harnery/AGENTS.md § Web app. */}
            {`Their round${currentRound ? `-${currentRound}` : ""} take is in. It unlocks with everyone else's when the next round opens.`}
          </p>
        ) : (
          councilId && (
            <p>
              Still needed{currentRound ? ` for round ${currentRound}` : ""}.
              Ask them to run:{" "}
              <code className="font-mono text-[11px] rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-200/90 break-all">
                {`${binName} agents council contribute ${councilId} --file <their-take>.md`}
              </code>
            </p>
          )
        )}
      </div>
    </div>
  );
}

/** "Claude Code · claude-opus-4-8" pill: where the member's session lives. */
function HarnessBadge({
  platform,
  model,
}: {
  platform?: string | null;
  model?: string | null;
}) {
  if (!platform && !model) return null;
  return (
    <Tooltip
      content={
        <div className="space-y-1">
          {platform && (
            <p>
              <span className="text-foreground font-medium">
                {harnessLabel(platform)}
              </span>
              {`: the harness this member's session runs in. Paste their prompt there.`}
            </p>
          )}
          {model && (
            <p>
              <span className="font-mono text-foreground">{model}</span>
              {": the model their session last used."}
            </p>
          )}
        </div>
      }
    >
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ring-1 ring-border/60 bg-muted/40 text-muted-foreground cursor-help">
        {harnessLabel(platform)}
        {platform && model && <span className="text-muted-foreground/50">·</span>}
        {model && <span className="font-mono">{model}</span>}
      </span>
    </Tooltip>
  );
}

/** Small colour-coded dot for the strip, mirroring the Key. */
function StateDot({ state }: { state: CouncilPromptState }) {
  if (state === "active") return <span className="size-2 rounded-full bg-sky-400" aria-hidden />;
  if (state === "contributed")
    return <Check className="size-3 text-emerald-400" aria-hidden />;
  return (
    <span
      className="size-2 rounded-full border border-muted-foreground/60"
      aria-hidden
    />
  );
}

/** Coloured pill matching the Key, used in the detail header. */
function StateBadge({ state }: { state: CouncilPromptState }) {
  const map = {
    active: { cls: "bg-sky-500/15 text-sky-300 ring-sky-500/30", label: "active" },
    contributed: {
      cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
      label: "contributed",
    },
    queued: { cls: "bg-muted/60 text-muted-foreground ring-border/60", label: "queued" },
  } as const;
  const { cls, label } = map[state];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${cls}`}
    >
      {state === "contributed" && <Check className="size-3" aria-hidden />}
      {label}
    </span>
  );
}
