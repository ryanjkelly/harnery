"use client";

import { useState } from "react";

import { useHostInfo } from "@/components/HostInfoProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Operator nudge: appends a `handoff`-category entry to an agent's
 * scratchpad. The receiving agent reads its scratchpad at session start
 * and on `harn scratch read`, so a nudge surfaces in the next turn's recovery
 * cue or whenever the agent checks in. Mirrors the upstream app's NudgeBox; reuses
 * the existing /api/actions/ping route which goes through harnery's
 * appendEntry into .harnery/scratch/<owner>.md.
 */
export function NudgeBox({
  instanceId,
  agentName,
}: {
  instanceId: string;
  agentName: string;
}) {
  const { binName } = useHostInfo();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "ok" } | { kind: "error"; reason: string }
  >({ kind: "idle" });

  const presets = [
    {
      label: "/compact",
      msg: "Heads up: context is getting heavy. Consider /compact at a clean break.",
    },
    {
      label: "looping",
      msg: "Looks like you may be looping. Stop and re-evaluate before the next tool call.",
    },
    {
      label: "stop & ask",
      msg: "Pause and ask me. I want to weigh in before you keep going.",
    },
  ];

  async function send(text: string) {
    if (!text.trim()) return;
    setPending(true);
    setStatus({ kind: "idle" });
    try {
      const res = await fetch(`/api/actions/ping`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance_id: instanceId, message: text }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          stderr?: string;
        };
        setStatus({
          kind: "error",
          reason: data.error ?? data.stderr ?? `HTTP ${res.status}`,
        });
        return;
      }
      setStatus({ kind: "ok" });
      setMessage("");
    } catch (err) {
      setStatus({
        kind: "error",
        reason: err instanceof Error ? err.message : "send failed",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nudge {agentName}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Appends a <code>handoff</code> entry to {agentName}&apos;s scratchpad.
          Visible to the agent on next <code>{`${binName} scratch read`}</code> or
          SessionStart recovery cue.
        </p>

        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={pending}
              onClick={() => send(p.msg)}
              className="rounded-md border border-border/60 bg-background px-2.5 py-1 text-xs min-h-11 sm:min-h-0 text-foreground/80 hover:bg-muted/40 disabled:opacity-40"
            >
              {p.label}
            </button>
          ))}
        </div>

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          disabled={pending}
          placeholder="Type a custom nudge…"
          className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono resize-y disabled:opacity-50"
        />

        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {message.length} / 4000
          </span>
          <button
            type="button"
            disabled={pending || !message.trim()}
            onClick={() => send(message)}
            className="rounded-md border border-emerald-500/60 bg-emerald-500/10 px-3 py-1 text-xs min-h-11 sm:min-h-0 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
          >
            {pending ? "sending…" : "send nudge"}
          </button>
        </div>

        {status.kind === "ok" && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            ✓ nudge sent.
          </p>
        )}
        {status.kind === "error" && (
          <p className="text-xs text-rose-600 dark:text-rose-400 font-mono">
            ✗ {status.reason}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
