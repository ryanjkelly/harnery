"use client";

import { useState } from "react";

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
      const json = (await res.json()) as { ok: boolean; error?: string; bytes?: number };
      if (json.ok) {
        setFeedback({ ok: true, msg: `pinged · scratchpad now ${json.bytes ?? "?"} bytes` });
        setMessage("");
      } else {
        setFeedback({ ok: false, msg: json.error ?? "failed" });
      }
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
        placeholder="message to append to their scratchpad (prefixed with `from web-ui:`)"
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
