"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Activity, Heart, Skull } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type HealKind = "pidmap" | "heartbeat" | "kill";

const KIND_META: Record<
  HealKind,
  {
    label: string;
    helper: string;
    icon: typeof Activity;
    variant: "outline" | "destructive";
    title: string;
    description: string;
    confirmLabel: string;
  }
> = {
  pidmap: {
    label: "PIDMAP heal",
    helper: "Rebuild .pidmap from active heartbeats. Safe to run any time.",
    icon: Activity,
    variant: "outline",
    title: "Run PIDMAP_HEAL?",
    description:
      "Walks .harnery/active/*.json and rewrites .harnery/.pidmap so each session id points to the correct instance. Safe to run any time; does not affect heartbeats or claims. Cheap.",
    confirmLabel: "Heal pidmap",
  },
  heartbeat: {
    label: "Heartbeat heal",
    helper:
      "Recreate heartbeat if missing. Corrective: use only when you know the agent is actually alive.",
    icon: Heart,
    variant: "outline",
    title: "Run HEARTBEAT_HEAL?",
    description:
      "If the heartbeat file is missing (agent was killed, prematurely cleaned up, etc.), recreates it from the session_id + resolved name. No-op when the file already exists; this is recovery, not a timestamp refresh. To bump last_heartbeat on a live agent, use the agent's own next hook (or its `scratch add`) instead.",
    confirmLabel: "Heal heartbeat",
  },
  kill: {
    label: "Kill heartbeat",
    helper:
      "Delete the heartbeat file; agent disappears from the active list.",
    icon: Skull,
    variant: "destructive",
    title: "Kill this agent's heartbeat?",
    description:
      "Deletes the heartbeat file: the agent disappears from the active list and the coord layer treats it as dead. The agent's process is not signalled; it'll re-register on its next hook call. Use when an agent stopped cleanly but didn't clear its file, OR when you want to revoke all of its claims at once.",
    confirmLabel: "Kill heartbeat",
  },
};

/**
 * Operator card surfaced on the agent detail page. Three actions (pidmap
 * heal, heartbeat heal, kill), each shelling to harnery/bin/agent-coord
 * via /api/agents/[id]/heal. Mirrors the upstream app's HealActions byte-for-byte;
 * tooltip prop drives the custom <Tooltip> popover (no native browser
 * tooltips on the buttons).
 */
export function HealActions({
  instanceId,
  agentName,
}: {
  instanceId: string;
  agentName: string;
}) {
  const router = useRouter();
  const [activeKind, setActiveKind] = useState<HealKind | null>(null);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  function handleConfirm(kind: HealKind) {
    setFeedback(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(instanceId)}/heal`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind }),
          },
        );
        const data = (await res.json()) as
          | { ok: true; action: string }
          | { error: string; stderr?: string };

        if (!res.ok || !("ok" in data)) {
          const msg =
            "error" in data
              ? data.error
              : `heal failed (HTTP ${res.status})`;
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
          PIDMAP heal is cheap and safe. Heartbeat heal is corrective (use only
          when you know the agent is actually alive). Kill removes the heartbeat
          file entirely; the agent will re-register on its next hook.
        </p>
        {feedback && (
          <p
            className={
              "text-xs mt-2 " +
              (feedback.ok ? "text-emerald-400" : "text-red-400")
            }
          >
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
                  <span className="font-mono font-semibold text-foreground">
                    {agentName}
                  </span>
                </span>
                <span className="block">
                  {KIND_META[activeKind].description}
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setActiveKind(null)}
                disabled={pending}
              >
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
