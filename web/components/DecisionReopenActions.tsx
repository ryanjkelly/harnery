"use client";

import { ArchiveRestore } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

/**
 * Reopen action for an archived decision — the inverse of archive. The escape
 * hatch for a mis-archive (wrong decision, fat-fingered graduated-to): pulls it
 * back to `reviewed` so you can re-review or re-archive with the right ref.
 * POSTs to the reopen API, which shells `harn decision reopen`.
 */
export function DecisionReopenActions({ decisionId }: { decisionId: string }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/decisions/${encodeURIComponent(decisionId)}/reopen`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
    <div className="mt-2 flex items-center gap-3">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={submit}
        className="min-h-11 text-muted-foreground hover:text-foreground sm:min-h-0"
        tooltip="Pull this decision back to reviewed, out of the archive."
      >
        <ArchiveRestore className="size-3.5" />
        Reopen
      </Button>
      {error && <p className="text-xs text-red-400">reopen failed: {error}</p>}
    </div>
  );
}
