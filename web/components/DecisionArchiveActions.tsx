"use client";

import { Archive } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Archive action for a reviewed decision — the graduation exit. Once you've
 * weighed in and the output has a canonical home (an ADR, AGENTS.md, a code
 * change), archiving closes the loop and moves the decision out of the review
 * feed into the searchable archive. `graduatedTo` records where it landed;
 * it's optional (a decision whose value was purely the deliberation can archive
 * bare). POSTs to the archive API, which shells `harn decision archive`.
 */
export function DecisionArchiveActions({ decisionId }: { decisionId: string }) {
  const router = useRouter();
  const [graduatedTo, setGraduatedTo] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/decisions/${encodeURIComponent(decisionId)}/archive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ graduatedTo: graduatedTo.trim() || undefined }),
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
    <Card className="border-border">
      <CardHeader>
        <CardTitle>Archive</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          The graduation exit. Point to where the output landed (an ADR, AGENTS.md, a code change),
          then archive — the decision leaves the review feed and stays searchable as precedent.
        </p>
        <input
          value={graduatedTo}
          onChange={(e) => setGraduatedTo(e.target.value)}
          placeholder="Graduated to (e.g. docs/decisions.md#foo) — optional"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={submit}
          className="min-h-11 sm:min-h-0"
          tooltip="Close this decision and move it to the searchable archive."
        >
          <Archive className="size-3.5" />
          Archive decision
        </Button>
        {error && <p className="text-xs text-red-400">archive failed: {error}</p>}
      </CardContent>
    </Card>
  );
}
