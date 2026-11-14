"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type {
  BrowserAttachChoice,
  ComputerModeChoice,
  ModeChangeOutcome,
  SignInChoice,
} from "@/lib/permissions";
import { TONE } from "@/lib/tone";

export interface ComputerModeOption {
  value: ComputerModeChoice | SignInChoice | BrowserAttachChoice;
  label: string;
  meaning: string;
  /** True when choosing it gives agents more freedom than now, so the CLI asks first. */
  looser: boolean;
  /** True for the project's default mode, which the control marks. */
  projectDefault?: boolean;
  /** Why this one choice cannot be picked now; the others stay available. */
  unavailable?: string;
}

const OUTCOME_TONE: Record<ModeChangeOutcome["outcome"], keyof typeof TONE> = {
  changed: "done",
  declined: "neutral",
  "timed-out": "neutral",
  busy: "neutral",
  unavailable: "danger",
  refused: "danger",
  failed: "danger",
};

/**
 * Your own computer-use mode for this project, as one row of buttons: a click
 * changes it. The server runs `harn computer mode`; loosening it shows a
 * confirmation pop-up on this computer's screen, so a change can take up to
 * two minutes. `reset` offers a way back to the project's default when the
 * person chose a mode of their own.
 */
export function ComputerModeControl({
  options,
  selected,
  reset,
  disabledReason,
  confirmSeconds,
  endpoint = "/api/permissions/computer-mode",
  field = "mode",
  legend = "Your computer-use mode for this project",
  keepWords = "keeps your current mode",
}: {
  options: ComputerModeOption[];
  /** The mode in effect for this person now. */
  selected: ComputerModeChoice;
  /** The "follow the project's default" choice, offered only when it would change something. */
  reset?: ComputerModeOption;
  /** Set when this browser may not change the mode; the buttons are then read-only. */
  disabledReason?: string;
  confirmSeconds: number;
  /** Where a click posts { [field]: value }; the computer-use mode by default. */
  endpoint?: string;
  field?: string;
  legend?: string;
  /** How the pop-up's No is described: "keeps your current mode". */
  keepWords?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<ComputerModeOption | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<ModeChangeOutcome | null>(null);

  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  async function apply(option: ComputerModeOption) {
    if (pending || disabledReason) return;
    setResult(null);
    setPending(option);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: option.value }),
      });
      let data: ModeChangeOutcome;
      try {
        data = (await res.json()) as ModeChangeOutcome;
      } catch {
        data = {
          outcome: "failed",
          message: `Not changed: the dashboard answered HTTP ${res.status}.`,
        };
      }
      setResult(data);
    } catch (err) {
      setResult({
        outcome: "failed",
        message: `Not changed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setPending(null);
      router.refresh();
    }
  }

  const left = Math.max(0, confirmSeconds - elapsed);
  const shown = pending?.value ?? selected;
  const locked = pending !== null || Boolean(disabledReason);
  return (
    <div className="space-y-2">
      <fieldset
        disabled={locked}
        className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-1 sm:inline-grid sm:grid-flow-col sm:grid-cols-none"
      >
        <legend className="sr-only">{legend}</legend>
        {options.map((o) => {
          const active = shown === o.value;
          const blocked = Boolean(o.unavailable) && !active;
          const hint = blocked
            ? `${o.meaning} ${o.unavailable}`
            : `${o.meaning}${o.looser ? " Choosing it asks you to confirm in a pop-up on this computer's screen." : ""}`;
          return (
            <Tooltip key={o.value} content={hint} triggerClassName="flex">
              <button
                type="button"
                aria-pressed={active}
                disabled={blocked}
                onClick={() => (active ? undefined : apply(o))}
                className={cn(
                  "flex w-full flex-col items-center justify-center rounded-md border px-3 py-1.5 text-xs font-medium leading-tight transition-colors disabled:cursor-not-allowed",
                  active
                    ? o.value === "on"
                      ? TONE.warn.pill
                      : "border-border bg-background text-foreground shadow-sm"
                    : "border-transparent text-muted-foreground enabled:hover:bg-background/60 enabled:hover:text-foreground",
                  pending?.value === o.value && "animate-pulse",
                )}
              >
                <span>{o.label}</span>
                {o.projectDefault ? (
                  <span className="text-[10px] font-normal opacity-75">project default</span>
                ) : null}
              </button>
            </Tooltip>
          );
        })}
      </fieldset>
      {disabledReason ? <p className="text-xs text-muted-foreground">{disabledReason}</p> : null}
      {reset && !disabledReason ? (
        <p className="text-xs text-muted-foreground">
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => apply(reset)}
            className="underline underline-offset-2 hover:text-foreground disabled:cursor-not-allowed"
          >
            {reset.label}
          </button>
          {reset.looser ? " (asks you to confirm in a pop-up first)" : ""}
        </p>
      ) : null}
      {pending ? (
        <div
          role="status"
          className={cn(
            "rounded-md border px-3 py-2",
            pending.looser ? TONE.act.surface : TONE.neutral.surface,
          )}
        >
          {pending.looser
            ? `Answer the confirmation pop-up on this computer's screen: Yes makes the change, No ${keepWords}. It closes by itself in ${left} seconds, which also ${keepWords}.`
            : `Changing it. If a confirmation pop-up appears on this computer's screen, answer it there (${elapsed} seconds so far).`}
        </div>
      ) : result ? (
        <div
          role="status"
          className={cn("rounded-md border px-3 py-2", TONE[OUTCOME_TONE[result.outcome]].surface)}
        >
          {result.outcome === "changed" ? "Changed." : result.message}
        </div>
      ) : null}
    </div>
  );
}
