"use client";

import { CheckCircle2, RotateCcw, TrendingDown, TrendingUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Verdict = "ratified" | "overridden" | "wrong-tier-high" | "wrong-tier-low";

const VERDICTS: {
  verdict: Verdict;
  label: string;
  hint: string;
  Icon: typeof CheckCircle2;
  cls: string;
}[] = [
  {
    verdict: "ratified",
    label: "Ratify",
    hint: "Correct call. No action.",
    Icon: CheckCircle2,
    cls: "bg-emerald-600 hover:bg-emerald-700 text-emerald-50 border-emerald-500",
  },
  {
    verdict: "overridden",
    label: "Override",
    hint: "Wrong call. This should spawn an unwind or redo.",
    Icon: RotateCcw,
    cls: "bg-red-600 hover:bg-red-700 text-red-50 border-red-500",
  },
  {
    verdict: "wrong-tier-low",
    label: "Didn't need me",
    hint: "Triage was too eager. I should not have seen this.",
    Icon: TrendingDown,
    cls: "border-amber-500/50 text-amber-300 hover:bg-amber-500/10",
  },
  {
    verdict: "wrong-tier-high",
    label: "Wanted this sooner",
    hint: "I should have seen this before it was enacted.",
    Icon: TrendingUp,
    cls: "border-amber-500/50 text-amber-300 hover:bg-amber-500/10",
  },
];

/**
 * Review actions for a resolved/enacted decision. Calibration, not approval:
 * the work already proceeded. Each verdict POSTs to the review API (which
 * shells `harn decision review`), then refreshes. wrong-tier-* verdicts are how
 * the triage boundary self-corrects over time.
 */
export function DecisionReviewActions({ decisionId }: { decisionId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(verdict: Verdict) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/decisions/${encodeURIComponent(decisionId)}/review`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verdict, note: note.trim() || undefined }),
        });
        const json = (await res.json()) as { ok?: boolean; error?: string; stderr?: string };
        if (!res.ok || !json.ok) {
          setError(json.stderr?.trim() || json.error || `HTTP ${res.status}`);
          return;
        }
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <Card className="border-sky-500/40">
      <CardHeader>
        <CardTitle>Review</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Calibration, not approval. The work already proceeded. Ratify if the call was right,
          override if it was wrong (spawns a redo), or flag the tier to retrain what reaches you.
        </p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (why you overrode, what to change)…"
          rows={2}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <div className="flex flex-wrap gap-2 [&>button]:min-h-11 sm:[&>button]:min-h-0">
          {VERDICTS.map(({ verdict, label, hint, Icon, cls }) => (
            <Button
              key={verdict}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => submit(verdict)}
              className={cls}
              tooltip={hint}
            >
              <Icon className="size-3.5" />
              {label}
            </Button>
          ))}
        </div>
        {error && <p className="text-xs text-red-400">review failed: {error}</p>}
      </CardContent>
    </Card>
  );
}
