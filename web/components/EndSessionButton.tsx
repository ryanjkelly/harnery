"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  DashboardCommandRecovery,
  useDashboardCommand,
} from "@/components/DashboardCommandRecovery";

export function EndSessionButton({ instanceId, name }: { instanceId: string; name: string }) {
  const router = useRouter();
  const command = useDashboardCommand("end-session", { instance_id: instanceId });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  async function endIt(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      const json = await command.run<{
        ok: boolean;
        terminal_event_queued?: boolean;
        error?: string;
      }>({ instance_id: instanceId });
      if (json.ok) {
        setFeedback({ ok: true, msg: json.terminal_event_queued ? "end queued" : "ended" });
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
        <span>
          End {name}&apos;s session? (records now if idle, otherwise immediately after the current
          turn closes)
        </span>
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
        <DashboardCommandRecovery command={command} />
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-xs px-2 py-1 rounded border border-red-900 hover:bg-destructive/15 text-red-300"
      >
        end session
      </button>
      <DashboardCommandRecovery command={command} />
      {feedback && (
        <span className={feedback.ok ? "text-green-400" : "text-red-400"}>{feedback.msg}</span>
      )}
    </>
  );
}
