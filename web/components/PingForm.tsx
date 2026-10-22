"use client";

import { useState } from "react";
import type { PingResult } from "@/lib/coord-writer";

export function pingOutcomeFeedback(result: PingResult): { ok: boolean; msg: string } {
  const child = result.child;
  const parent = result.parent_copy;
  if (!child) return { ok: false, msg: result.error ?? "Delivery result unavailable." };
  if (!child.ok) return { ok: false, msg: parent && "ok" in parent && parent.ok
    ? `Parent copy recorded; task delivery failed: ${child.message}` : child.message };
  if (parent && "ok" in parent && !parent.ok) return { ok: false,
    msg: `Message recorded for the task; parent copy failed: ${parent.message}` };
  if (!result.complete) return { ok: false, msg: "The complete delivery result is unavailable." };
  return { ok: true, msg: parent && "ok" in parent && parent.ok ? "Message recorded for the task and its parent." :
    parent && "reason" in parent ? `Message recorded for the task; parent copy skipped: ${parent.reason}` :
      "Message recorded for the task." };
}

export function PingForm({ instanceId }: { instanceId: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) {
      setFeedback({ ok: false, msg: "message required" });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/actions/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: instanceId, message: trimmed }),
      });
      const json = (await res.json()) as PingResult;
      const outcome = pingOutcomeFeedback(json);
      setFeedback(outcome);
      if (json.child?.ok) setMessage("");
    } catch (err) {
      setFeedback({ ok: false, msg: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Message for this exact task instance"
        rows={3}
        disabled={busy}
        className="w-full bg-background border border-border rounded p-2 text-sm font-mono disabled:opacity-50"
      />
      <div className="flex items-center justify-between gap-3">
        <button
          type="submit"
          disabled={busy || !message.trim()}
          className="px-3 py-1.5 text-sm rounded bg-primary hover:bg-primary/85 disabled:opacity-50"
        >
          {busy ? "sending…" : "ping"}
        </button>
        {feedback && (
          <span className={`text-xs ${feedback.ok ? "text-green-400" : "text-red-400"}`}>
            {feedback.msg}
          </span>
        )}
      </div>
    </form>
  );
}
