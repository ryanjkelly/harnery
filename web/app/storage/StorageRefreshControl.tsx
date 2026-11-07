"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * "Measure now" for the storage page, and the hook that re-renders the page
 * when a walk finishes.
 *
 * The POST starts a walk (or joins the one running) and answers when it ends,
 * so one request replaces polling. While `running` is true on mount, the
 * control joins the walk without forcing a new one; the page then re-renders
 * from the new snapshot. The globally mounted LiveRefresher covers the rare
 * case where a warm-handover peer holds the walk.
 */
export function StorageRefreshControl({ running }: { running: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const measure = useCallback(
    async (force: boolean) => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch("/api/storage/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          message?: string;
          error?: string;
        };
        if (!res.ok || !data.ok) setError(data.message ?? data.error ?? `HTTP ${res.status}`);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  useEffect(() => {
    if (running) void measure(false);
  }, [running, measure]);

  const busy = pending || running;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      {error ? <span className="max-w-xs text-xs text-destructive">{error}</span> : null}
      <Button
        size="sm"
        variant="outline"
        onClick={() => void measure(true)}
        disabled={busy}
        tooltip={
          busy
            ? "A measurement is running. The page updates when it finishes."
            : "Walk every registered root again now. On a large project this takes a minute or more; the current numbers stay on screen meanwhile."
        }
      >
        <RefreshCw className={busy ? "animate-spin" : undefined} aria-hidden />
        {busy ? "Measuring…" : "Measure now"}
      </Button>
    </span>
  );
}
