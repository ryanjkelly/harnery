"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronRight,
  Trash2,
  UserCog,
} from "lucide-react";

import { AgentChip } from "@/components/AgentChip";
import {
  COUNCIL_ACTION_EVENT,
  type CouncilActionDetail,
} from "@/components/CouncilActionTrigger";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Action =
  | "advance"
  | "close"
  | "archive"
  | "unarchive"
  | "delete"
  | "set-steward"
  | null;

const AGENT_NAME_RE = /^agent-[A-Za-z][A-Za-z0-9_-]*$/;

export interface KnownAgent {
  name: string;
  state: "active" | "stale";
  last_seen: string;
}

/**
 * Council write actions surfaced on the detail page. Six actions: advance,
 * close, archive, unarchive, delete, set-steward. Each routes through an
 * API endpoint that shells to agent-coord under the same flock the bash CLI
 * uses, so the lifecycle semantics stay in one place.
 *
 * The recommended action gets a ring highlight + "next" tag:
 *   - active + collected + !exitCriterionMet → Advance
 *   - active + collected + exitCriterionMet  → Close
 *   - active + open-but-idle + exitCriterionMet → Close (the operator advanced
 *     past the finish line; nothing pending in the new round; see roundIdle)
 *   - closed                                 → Archive (after the steward's
 *                                                close-out handoff lands)
 */
export function CouncilActions({
  councilId,
  status,
  roundStatus,
  pending,
  currentRound,
  steward,
  exitCriterionMet,
  consecutiveAllTrivialRounds,
  roundIdle,
  closeHandoffDone,
  knownAgents,
}: {
  councilId: string;
  status: "active" | "closed" | "archived";
  roundStatus: "open" | "collected";
  pending: string[];
  currentRound: number;
  steward: string;
  exitCriterionMet: boolean;
  consecutiveAllTrivialRounds: number;
  /**
   * Current round is open with zero prompts and zero contributions; nobody
   * has acted on it. Computed in page.tsx; with exitCriterionMet it means the
   * round was opened past the finish line and Close is still the right move.
   * Once a prompt or contribution lands, the operator has chosen to continue
   * and the normal Advance flow takes back over.
   */
  roundIdle: boolean;
  closeHandoffDone: boolean;
  knownAgents: KnownAgent[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Action>(null);
  const [busy, startTransition] = useTransition();
  const [forceAdvance, setForceAdvance] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const initialSelected = knownAgents.some((a) => a.name === steward)
    ? steward
    : null;
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [clearSteward, setClearSteward] = useState(false);
  const stewardCandidate = clearSteward ? null : selected;
  const stewardValid =
    clearSteward ||
    (stewardCandidate !== null && AGENT_NAME_RE.test(stewardCandidate));

  const hasPending = pending.length > 0;
  const collected = status === "active" && roundStatus === "collected";
  const openIdle = status === "active" && roundStatus === "open" && roundIdle;
  const closeRecommended = exitCriterionMet && (collected || openIdle);
  const advanceRecommended = collected && !exitCriterionMet;
  const archiveRecommended = status === "closed";

  // The next-action banner's "Advance to round N" / "Close the council"
  // triggers open the same confirmation dialogs this panel owns (see
  // CouncilActionTrigger.tsx).
  useEffect(() => {
    const onAction = (e: Event) => {
      const detail = (e as CustomEvent<CouncilActionDetail>).detail;
      if (status !== "active") return;
      if (detail?.action === "advance") setOpen("advance");
      if (detail?.action === "close") setOpen("close");
    };
    window.addEventListener(COUNCIL_ACTION_EVENT, onAction);
    return () => window.removeEventListener(COUNCIL_ACTION_EVENT, onAction);
  }, [status]);

  function fire(action: Exclude<Action, null>) {
    setFeedback(null);
    startTransition(async () => {
      try {
        const body =
          action === "advance"
            ? { force: forceAdvance }
            : action === "set-steward"
              ? { steward: clearSteward ? null : stewardCandidate }
              : {};
        const res = await fetch(
          `/api/councils/${encodeURIComponent(councilId)}/${action}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          stderr?: string;
        };
        if (!res.ok || !json.ok) {
          // Prefer the CLI's stderr: "advance_failed" alone tells the
          // operator nothing; "pending members in round 1 (incl. X)" does.
          const detail =
            json.stderr?.trim() || json.error || `HTTP ${res.status}`;
          setFeedback({
            ok: false,
            msg: `${action} failed: ${detail}`,
          });
          return;
        }
        setOpen(null);
        setForceAdvance(false);
        if (action === "delete") {
          router.push("/councils");
        } else {
          router.refresh();
        }
      } catch (err) {
        setFeedback({ ok: false, msg: (err as Error).message });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent>
        {closeRecommended && (
          <div className="mb-3 rounded-md border border-emerald-500/40 bg-emerald-500/[0.08] px-3 py-2 text-xs leading-relaxed space-y-1">
            <div>
              <strong className="text-emerald-300">
                Exit criterion met.
              </strong>{" "}
              The last {consecutiveAllTrivialRounds} consecutive rounds had no
              Substantive entries. Close the council to mark deliberation
              complete; no further rounds needed.
              {openIdle &&
                ` Round ${currentRound} is open but nothing is pending in it, so closing from here is safe and ends the empty round.`}
            </div>
            <div className="text-muted-foreground">
              After Close fires, the manifest is stamped{" "}
              <code className="font-mono text-[11px]">closed_at</code> and the
              council stays in the active list as read-only for inspection.
              Archive later when ready to move it to{" "}
              <code className="font-mono text-[11px]">
                .harnery/councils/archive/
              </code>
              .
            </div>
          </div>
        )}
        {advanceRecommended && (
          <div className="mb-3 rounded-md border border-primary/40 bg-primary/[0.06] px-3 py-2 text-xs leading-relaxed space-y-1">
            <div>
              <strong className="text-primary">
                Round {currentRound} complete.
              </strong>{" "}
              All members contributed. Advance to round {currentRound + 1} to
              continue routing, or Close if the exit criterion has been met
              (two consecutive all-Trivial rounds).
            </div>
            <div className="text-muted-foreground">
              After Advance fires, the steward
              {steward ? (
                <>
                  {" ("}
                  <AgentChip
                    name={steward}
                    className="font-mono text-foreground/80"
                  />
                  {")"}
                </>
              ) : null}{" "}
              drafts the round-{currentRound + 1} routing prompts via{" "}
              <code className="font-mono text-[11px]">
                harn agents council prompt
              </code>
              . The Routing prompts card below will sit empty until they land.
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 [&>button]:min-h-11 sm:[&>button]:min-h-0">
          <Button
            variant="default"
            size="sm"
            onClick={() => setOpen("advance")}
            disabled={status !== "active"}
            data-attention-target={advanceRecommended || undefined}
            className={
              advanceRecommended
                ? "ring-2 ring-primary/60 ring-offset-1 ring-offset-background"
                : undefined
            }
            tooltip={
              status !== "active"
                ? "Council must be active to advance."
                : hasPending
                  ? `${pending.length} pending member${pending.length === 1 ? "" : "s"} (${pending.join(", ")}). Advance with --force will drop them from this round.`
                  : advanceRecommended
                    ? `Round ${currentRound} collected; opens round ${currentRound + 1}.`
                    : `Open round ${currentRound + 1}.`
            }
          >
            <ChevronRight className="size-3" />
            Advance to round {currentRound + 1}
            {advanceRecommended && (
              <span className="ml-1 rounded bg-white/20 px-1 py-0.5 text-[10px] uppercase tracking-wide">
                next
              </span>
            )}
          </Button>
          <Button
            variant={closeRecommended ? "default" : "outline"}
            size="sm"
            onClick={() => setOpen("close")}
            disabled={status !== "active"}
            data-attention-target={closeRecommended || undefined}
            className={
              closeRecommended
                ? "ring-2 ring-emerald-500/60 ring-offset-1 ring-offset-background bg-emerald-600 hover:bg-emerald-700 text-emerald-50 border-emerald-500"
                : undefined
            }
            tooltip={
              status !== "active"
                ? "Already closed or archived."
                : closeRecommended
                  ? `Exit criterion met (${consecutiveAllTrivialRounds} consecutive all-Trivial rounds). Stamp closed_at and finalize this council.`
                  : "Mark deliberation complete and stamp closed_at."
            }
          >
            <CheckCircle2 className="size-3" />
            Close
            {closeRecommended && (
              <span className="ml-1 rounded bg-white/20 px-1 py-0.5 text-[10px] uppercase tracking-wide">
                next
              </span>
            )}
          </Button>
          <Button
            variant={archiveRecommended ? "default" : "destructive"}
            size="sm"
            onClick={() => setOpen("archive")}
            disabled={status === "archived"}
            data-attention-target={
              (archiveRecommended && closeHandoffDone) || undefined
            }
            className={
              archiveRecommended
                ? "ring-2 ring-emerald-500/60 ring-offset-1 ring-offset-background bg-emerald-600 hover:bg-emerald-700 text-emerald-50"
                : undefined
            }
            tooltip={
              status === "archived"
                ? "Already archived. Use Unarchive to restore it."
                : archiveRecommended
                  ? "Move to .harnery/councils/archive/ and mark 100% complete."
                  : "Move manifest + body dir to .harnery/councils/archive/."
            }
          >
            <Archive className="size-3" />
            Archive
            {archiveRecommended && (
              <span className="ml-1 rounded bg-white/20 px-1 py-0.5 text-[10px] uppercase tracking-wide">
                next
              </span>
            )}
          </Button>
          {/* Quiet outline on purpose: unarchive is an escape hatch, not a
              recommended next action. Archived is the terminal state
              and nothing here should pull the operator's eye. */}
          {status === "archived" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen("unarchive")}
              tooltip="Move manifest + body dir back from .harnery/councils/archive/ to the active list. Idempotent."
            >
              <ArchiveRestore className="size-3" />
              Unarchive
            </Button>
          )}
          {status === "archived" && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setOpen("delete")}
              tooltip="Permanently remove the manifest + body dir from .harnery/councils/archive/. Not reversible."
            >
              <Trash2 className="size-3" />
              Delete
            </Button>
          )}
          {status !== "archived" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen("set-steward")}
              tooltip="Reassign the steward: the agent that drafts per-round routing prompts."
            >
              <UserCog className="size-3" />
              Steward
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
          {status === "archived" ? (
            <>
              Council is <strong>archived</strong>. <strong>Unarchive</strong>{" "}
              moves manifest + body dir back from{" "}
              <code className="font-mono text-[11px]">
                .harnery/councils/archive/
              </code>{" "}
              to the active list and restores its prior status. Useful for
              testing the archive flow.
            </>
          ) : status === "closed" ? (
            closeHandoffDone ? (
              <>
                Council is <strong>closed</strong> and the steward&apos;s
                close-out handoff is in place. <strong>Archive</strong> moves
                manifest + body dir to{" "}
                <code className="font-mono text-[11px]">
                  .harnery/councils/archive/
                </code>
                , step 2 of 2 in the wrap-up above.
              </>
            ) : (
              <>
                Council is <strong>closed</strong>. After the steward&apos;s
                close-out handoff (step 1 in the wrap-up above),{" "}
                <strong>Archive</strong> moves manifest + body dir to{" "}
                <code className="font-mono text-[11px]">
                  .harnery/councils/archive/
                </code>
                .
              </>
            )
          ) : (
            <>
              <strong>Advance</strong> opens round {currentRound + 1} (members
              see round {currentRound}&apos;s transcript).{" "}
              <strong>Close</strong> marks the council as deliberation-complete
              but keeps it in the active list. <strong>Archive</strong> moves
              manifest + body dir to{" "}
              <code className="font-mono text-[11px]">
                .harnery/councils/archive/
              </code>{" "}
              and removes it from the active dashboard.
            </>
          )}
        </p>

        {feedback && (
          <p
            className={`text-xs mt-2 ${feedback.ok ? "text-emerald-400" : "text-red-400"}`}
          >
            {feedback.msg}
          </p>
        )}
      </CardContent>

      <Dialog
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(null);
            setForceAdvance(false);
            setClearSteward(false);
            setSelected(initialSelected);
          }
        }}
      >
        {open === "advance" && (
          <>
            <DialogHeader>
              <DialogTitle>
                Advance council to round {currentRound + 1}?
              </DialogTitle>
              <DialogDescription>
                Members will see round {currentRound}&apos;s transcript once
                the new round opens (round_visibility=next_round).
                {hasPending && (
                  <span className="mt-2 block rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
                    <strong className="text-amber-300">
                      {pending.length} pending member
                      {pending.length === 1 ? "" : "s"}:
                    </strong>{" "}
                    <code className="font-mono">{pending.join(", ")}</code>.
                    Advance with --force will drop{" "}
                    {pending.length === 1 ? "this member" : "these members"}{" "}
                    from THIS round&apos;s transcript; they can rejoin the
                    next round.
                  </span>
                )}
                {hasPending && (
                  <label className="mt-2 flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={forceAdvance}
                      onChange={(e) => setForceAdvance(e.target.checked)}
                    />
                    <span>Use --force (drop pending members)</span>
                  </label>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                onClick={() => fire("advance")}
                disabled={busy || (hasPending && !forceAdvance)}
              >
                {busy ? "Advancing…" : "Advance"}
              </Button>
            </DialogFooter>
          </>
        )}

        {open === "close" && (
          <>
            <DialogHeader>
              <DialogTitle>Close this council?</DialogTitle>
              <DialogDescription>
                Closing stamps <code className="font-mono">closed_at</code> and
                emits the transcript to the response. Council stays in the
                active list for inspection; use Archive separately when ready
                to move it.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                onClick={() => fire("close")}
                disabled={busy}
              >
                {busy ? "Closing…" : "Close council"}
              </Button>
            </DialogFooter>
          </>
        )}

        {open === "archive" && (
          <>
            <DialogHeader>
              <DialogTitle>Archive this council?</DialogTitle>
              <DialogDescription>
                Stamps <code className="font-mono">archived_at</code> and moves
                manifest + body dir to{" "}
                <code className="font-mono">.harnery/councils/archive/</code>.
                It&apos;ll disappear from the active dashboard. You can still
                view it via the archive section.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => fire("archive")}
                disabled={busy}
              >
                {busy ? "Archiving…" : "Archive"}
              </Button>
            </DialogFooter>
          </>
        )}

        {open === "unarchive" && (
          <>
            <DialogHeader>
              <DialogTitle>Unarchive this council?</DialogTitle>
              <DialogDescription>
                Drops <code className="font-mono">archived_at</code> and moves
                manifest + body dir back from{" "}
                <code className="font-mono">.harnery/councils/archive/</code>{" "}
                to the active councils dir. Status restores to{" "}
                <code className="font-mono">closed</code> when{" "}
                <code className="font-mono">closed_at</code> is set, otherwise{" "}
                <code className="font-mono">active</code>. Useful for testing
                the archive flow.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                onClick={() => fire("unarchive")}
                disabled={busy}
              >
                {busy ? "Unarchiving…" : "Unarchive"}
              </Button>
            </DialogFooter>
          </>
        )}

        {open === "delete" && (
          <>
            <DialogHeader>
              <DialogTitle>Delete this council?</DialogTitle>
              <DialogDescription>
                <span className="block">
                  Permanently removes the manifest and body dir at:
                </span>
                <span className="mt-2 block font-mono text-[11px] rounded bg-background/80 px-2 py-1 break-all">
                  .harnery/councils/archive/{councilId}.json
                </span>
                <span className="block font-mono text-[11px] rounded bg-background/80 px-2 py-1 break-all mt-1">
                  .harnery/councils/archive/{councilId}/
                </span>
                <span className="mt-2 block text-xs">
                  This cannot be undone. Delete is for clearing fixtures or
                  genuine mistakes. If there&apos;s any chance you&apos;ll
                  want to look at this council later, leave it archived.
                </span>
                <span className="block text-xs text-muted-foreground mt-1">
                  target_doc, close_handoff_path, and session-events.ndjson
                  are owned by separate authors and are left alone.
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => fire("delete")}
                disabled={busy}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </Button>
            </DialogFooter>
          </>
        )}

        {open === "set-steward" && (
          <>
            <DialogHeader>
              <DialogTitle>Reassign steward</DialogTitle>
              <DialogDescription>
                <span className="block">
                  The steward drafts per-round routing prompts. When unset,
                  readers fall back to the convener (
                  <code className="font-mono text-[11px]">{steward}</code>).
                </span>
                <span className="mt-2 block text-xs text-muted-foreground">
                  Picker shows currently-active heartbeats plus agents whose
                  sessions ended in the last 30 days.
                </span>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2 max-h-80 overflow-y-auto">
              {knownAgents.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No known agents. Open a Claude Code session for any agent
                  first, then come back.
                </p>
              ) : (
                knownAgents.map((a) => {
                  const isSelected = !clearSteward && selected === a.name;
                  return (
                    <button
                      key={a.name}
                      type="button"
                      onClick={() => {
                        setSelected(a.name);
                        setClearSteward(false);
                      }}
                      className={
                        "w-full text-left rounded-md border px-3 py-2 transition-colors " +
                        (isSelected
                          ? "border-primary/60 bg-primary/5 ring-2 ring-primary/40"
                          : "border-border hover:bg-muted/60")
                      }
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <span className="font-mono text-sm">{a.name}</span>
                        <span
                          className={
                            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 border text-[10px] " +
                            (a.state === "active"
                              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                              : "bg-muted/40 text-muted-foreground border-border/60")
                          }
                        >
                          <span
                            className={
                              "size-1.5 rounded-full " +
                              (a.state === "active"
                                ? "bg-emerald-400"
                                : "bg-muted-foreground/50")
                            }
                          />
                          {a.state}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
              <label className="flex items-center gap-2 text-xs cursor-pointer pt-1 mt-1 border-t border-border/60">
                <input
                  type="checkbox"
                  checked={clearSteward}
                  onChange={(e) => {
                    setClearSteward(e.target.checked);
                    if (e.target.checked) setSelected(null);
                  }}
                />
                <span>Clear steward: revert to default (the convener)</span>
              </label>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setOpen(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                onClick={() => fire("set-steward")}
                disabled={busy || !stewardValid}
              >
                {busy
                  ? "Saving…"
                  : clearSteward
                    ? "Clear steward"
                    : "Save steward"}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </Card>
  );
}
