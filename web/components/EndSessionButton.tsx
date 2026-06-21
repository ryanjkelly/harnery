"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function EndSessionButton({ instanceId, name }: { instanceId: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  async function endIt(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/actions/end-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: instanceId }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (json.ok) {
        setFeedback({ ok: true, msg: "ended" });
        setTimeout(() => router.push("/"), 600);
      } else {
        setFeedback({ ok: false, msg: json.error ?? "failed" });
      }
    } catch (err) {
      setFeedback({ ok: false, msg: (err as Error).message });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span>End {name}'s session? (operator escape hatch, removes the heartbeat file)</span>
        <button
          type="button"
          onClick={endIt}
          disabled={busy}
          className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 disabled:opacity-50"
        >
          {busy ? "…" : "yes, end"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="px-2 py-1 rounded bg-muted hover:bg-muted/80"
        >
          cancel
        </button>
        {feedback && (
          <span className={feedback.ok ? "text-green-400" : "text-red-400"}>{feedback.msg}</span>
        )}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="text-xs px-2 py-1 rounded border border-red-900 hover:bg-destructive/15 text-red-300"
    >
      end session
    </button>
  );
}
