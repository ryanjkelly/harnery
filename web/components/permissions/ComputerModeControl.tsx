"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { ComputerModeChoice, ModeChangeOutcome } from "@/lib/permissions";

export interface ComputerModeOption {
  value: ComputerModeChoice;
  label: string;
  meaning: string;
  /** True when choosing it gives agents more freedom than now, so the CLI asks first. */
  looser: boolean;
}

const OUTCOME_CLS: Record<ModeChangeOutcome["outcome"], string> = {
  changed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  declined: "border-border bg-muted/40 text-foreground",
  "timed-out": "border-border bg-muted/40 text-foreground",
  busy: "border-border bg-muted/40 text-foreground",
  unavailable: "border-destructive/40 bg-destructive/10 text-destructive",
  refused: "border-destructive/40 bg-destructive/10 text-destructive",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
};

/**
 * Lets the person choose their own computer-use mode for this project. The
 * server runs `harn computer mode`; loosening it shows a confirmation pop-up
 * on this computer's screen, so the request can take up to two minutes.
 */
export function ComputerModeControl({
  options,
  selected,
  confirmSeconds,
}: {
  options: ComputerModeOption[];
  /** The person's current choice for this project. */
  selected: ComputerModeChoice;
  confirmSeconds: number;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<ComputerModeChoice>(selected);
  const [pending, setPending] = useState<ComputerModeOption | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<ModeChangeOutcome | null>(null);

  // Follow the saved choice when the page data refreshes.
  useEffect(() => {
    if (!pending) setChoice(selected);
  }, [selected, pending]);

  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  async function apply() {
    const option = options.find((o) => o.value === choice);
    if (!option || pending) return;
    setResult(null);
    setPending(option);
    try {
      const res = await fetch("/api/permissions/computer-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: option.value }),
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
  return (
    <div className="py-2 text-sm">
      <div className="mb-1 text-muted-foreground">Change your mode for this project</div>
      <fieldset disabled={pending !== null} className="space-y-1">
        <legend className="sr-only">Your computer-use mode for this project</legend>
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50",
              choice === o.value && "bg-muted/60",
            )}
          >
            <input
              type="radio"
              name="computer-mode"
              value={o.value}
              checked={choice === o.value}
              onChange={() => setChoice(o.value)}
              className="mt-1 size-3 shrink-0 cursor-pointer"
            />
            <span>
              <span className="font-medium">{o.label}</span>
              {o.value === selected ? (
                <span className="text-xs text-muted-foreground">{" (current)"}</span>
              ) : null}
              <span className="block text-muted-foreground">{o.meaning}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={apply}
          disabled={pending !== null || choice === selected}
        >
          {pending ? "Waiting…" : "Change my mode"}
        </Button>
        {choice !== selected && !pending
          ? (() => {
              const o = options.find((x) => x.value === choice);
              return o?.looser ? (
                <span className="text-xs text-muted-foreground">
                  {"This gives agents more freedom, so a confirmation pop-up will ask you first."}
                </span>
              ) : null;
            })()
          : null}
      </div>
      {pending ? (
        <div
          role="status"
          className={cn(
            "mt-2 rounded-md border px-3 py-2",
            pending.looser
              ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
              : "border-border bg-muted/40 text-foreground",
          )}
        >
          {pending.looser
            ? `Answer the confirmation pop-up on this computer's screen: Yes makes the change, No keeps your current mode. It closes by itself in ${left} seconds, which also keeps your current mode.`
            : `Changing your mode. If a confirmation pop-up appears on this computer's screen, answer it there (${elapsed} seconds so far).`}
        </div>
      ) : result ? (
        <div
          role="status"
          className={cn("mt-2 rounded-md border px-3 py-2", OUTCOME_CLS[result.outcome])}
        >
          {result.message}
        </div>
      ) : null}
    </div>
  );
}
