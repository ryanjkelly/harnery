"use client";

import { DatabaseZap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type HealKind = "cache";

const KIND_META: Record<
  HealKind,
  {
    label: string;
    helper: string;
    icon: typeof DatabaseZap;
    variant: "outline" | "destructive";
    title: string;
    description: string;
    confirmLabel: string;
  }
> = {
  cache: {
    label: "Rebuild V2 cache",
    helper: "Rebuild the disposable coordination cache from the authoritative V2 generation.",
    icon: DatabaseZap,
    variant: "outline",
    title: "Rebuild this agent's V2 cache?",
    description:
      "Recreates the generation-bound local cache from the authority-safe V2 ledger. This cannot create, revive, or terminate a session; it only repairs disposable derived state.",
    confirmLabel: "Rebuild cache",
  },
};

/**
 * Operator card surfaced on the agent detail page. The repair action shells
 * to harnery/bin/agent-coord and leave lifecycle authority in the V2 ledger.
 * via /api/agents/[id]/heal. Mirrors the upstream app's HealActions byte-for-byte;
 * tooltip prop drives the custom <Tooltip> popover (no native browser
 * tooltips on the buttons).
 */
export function HealActions({ instanceId, agentName }: { instanceId: string; agentName: string }) {
  const router = useRouter();
  const [activeKind, setActiveKind] = useState<HealKind | null>(null);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  function handleConfirm(kind: HealKind) {
    setFeedback(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(instanceId)}/heal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind }),
        });
        const data = (await res.json()) as
          | { ok: true; action: string }
          | { error: string; stderr?: string };

        if (!res.ok || !("ok" in data)) {
          const msg = "error" in data ? data.error : `heal failed (HTTP ${res.status})`;
          setFeedback({
            ok: false,
            msg: `${KIND_META[kind].label} failed: ${msg}`,
          });
          return;
        }

        setActiveKind(null);
        setFeedback({
          ok: true,
          msg: `${KIND_META[kind].label} OK for ${agentName}: ${data.action}`,
        });
        router.refresh();
      } catch (err) {
        setFeedback({
          ok: false,
          msg: `Heal failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Heal actions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2 [&>button]:min-h-11 sm:[&>button]:min-h-0">
          {(Object.keys(KIND_META) as HealKind[]).map((kind) => {
            const meta = KIND_META[kind];
            const Icon = meta.icon;
            return (
              <Button
                key={kind}
                variant={meta.variant}
                size="sm"
                onClick={() => setActiveKind(kind)}
                tooltip={meta.helper}
              >
                <Icon />
                {meta.label}
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
          This repairs disposable derived state only. Use End session for an authoritative lifecycle
          change.
        </p>
        {feedback && (
          <p className={"text-xs mt-2 " + (feedback.ok ? "text-emerald-400" : "text-red-400")}>
            {feedback.msg}
          </p>
        )}
      </CardContent>

      <Dialog
        open={activeKind !== null}
        onOpenChange={(next) => {
          if (!next) setActiveKind(null);
        }}
      >
        {activeKind && (
          <>
            <DialogHeader>
              <DialogTitle>{KIND_META[activeKind].title}</DialogTitle>
              <DialogDescription>
                <span className="block mb-2">
                  Target:{" "}
                  <span className="font-mono font-semibold text-foreground">{agentName}</span>
                </span>
                <span className="block">{KIND_META[activeKind].description}</span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setActiveKind(null)} disabled={pending}>
                Cancel
              </Button>
              <Button
                variant={KIND_META[activeKind].variant}
                onClick={() => handleConfirm(activeKind)}
                disabled={pending}
              >
                {pending ? "Running…" : KIND_META[activeKind].confirmLabel}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </Card>
  );
}
