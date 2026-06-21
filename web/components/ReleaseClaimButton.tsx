"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Per-file-claim release. Confirm dialog warns the operator that releasing
 * mid-edit will trip the next PostToolUse E-guard. Mirrors the upstream app's
 * ReleaseClaimButton; uses the existing /api/actions/release-claim route.
 */
export function ReleaseClaimButton({
  instanceId,
  path,
  agentName,
}: {
  instanceId: string;
  path: string;
  agentName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  function handleConfirm() {
    setFeedback(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/actions/release-claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instance_id: instanceId, path }),
        });
        const data = (await res.json()) as
          | { ok: true; removed: boolean; remaining: number }
          | { error: string; stderr?: string };

        if (!res.ok || !("ok" in data)) {
          const msg =
            "error" in data
              ? data.error
              : `release failed (HTTP ${res.status})`;
          setFeedback({ ok: false, msg: `Release failed: ${msg}` });
          return;
        }

        setOpen(false);
        setFeedback({
          ok: true,
          msg: `Released. ${agentName} now holds ${data.remaining} claim${data.remaining === 1 ? "" : "s"}.`,
        });
        router.refresh();
      } catch (err) {
        setFeedback({
          ok: false,
          msg: `Release failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Release ${path}`}
        tooltip={`Release ${agentName}'s claim on this file.`}
        onClick={() => setOpen(true)}
        className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
      >
        <Trash2 className="text-muted-foreground hover:text-destructive transition-colors" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogHeader>
          <DialogTitle>Release file claim?</DialogTitle>
          <DialogDescription>
            <span className="block">
              Remove this path from{" "}
              <span className="font-mono">{agentName}</span>&apos;s
              files_touched array.
            </span>
            <code className="mt-2 block px-2 py-1 bg-muted rounded-md text-xs font-mono break-all">
              {path}
            </code>
            <span className="mt-2 block text-xs">
              The agent will lose its lock on this file immediately. If the
              agent is actively writing to it, the next PostToolUse hook will
              fail the E guard (peer-staged-file collision). Releasing while
              the owning agent is mid-edit is a recipe for surprise.
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "Releasing…" : "Release claim"}
          </Button>
        </DialogFooter>
      </Dialog>

      {feedback && (
        <p
          className={
            "text-[11px] mt-1 " +
            (feedback.ok ? "text-emerald-400" : "text-red-400")
          }
        >
          {feedback.msg}
        </p>
      )}
    </>
  );
}
