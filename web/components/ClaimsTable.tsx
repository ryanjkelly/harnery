"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ClaimRow } from "@/lib/coord-reader";
import { NO_DATA } from "@/lib/format/no-data";

export function ClaimsTable({ claims }: { claims: ClaimRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ key: string; msg: string; ok: boolean } | null>(null);

  if (claims.length === 0) {
    return <p className="text-muted text-sm italic">No file claims.</p>;
  }

  async function release(c: ClaimRow): Promise<void> {
    const key = `${c.instance_id}:${c.path}`;
    setBusy(key);
    setFeedback(null);
    try {
      const res = await fetch("/api/actions/release-claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: c.instance_id, path: c.path }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string; remaining?: number };
      setFeedback({
        key,
        msg: json.ok
          ? `released; ${json.remaining ?? 0} claim(s) remain`
          : (json.error ?? "failed"),
        ok: json.ok,
      });
      if (json.ok) router.refresh();
    } catch (err) {
      setFeedback({ key, msg: (err as Error).message, ok: false });
    } finally {
      setBusy(null);
    }
  }

  return (
    <table className="w-full table-fixed text-sm sm:table-auto">
      <thead className="text-xs text-muted uppercase tracking-wider border-b border-border">
        <tr>
          <th className="w-[52%] px-2 py-2 text-left font-normal sm:w-auto sm:px-3">Path</th>
          <th className="w-[24%] px-2 py-2 text-left font-normal sm:w-auto sm:px-3">Agent</th>
          <th className="hidden px-3 py-2 text-left font-normal sm:table-cell">Platform</th>
          <th className="w-[24%] px-2 py-2 text-right font-normal sm:w-auto sm:px-3" />
        </tr>
      </thead>
      <tbody>
        {claims.map((c) => {
          const key = `${c.instance_id}:${c.path}`;
          return (
            <tr key={key} className="border-b border-border/40 hover:bg-card">
              <td className="break-all px-2 py-2 font-mono text-xs sm:px-3">{c.path}</td>
              <td className="break-words px-2 py-2 sm:px-3">{c.name}</td>
              <td className="hidden px-3 py-2 text-muted sm:table-cell">
                {c.platform ?? NO_DATA}
              </td>
              <td className="px-2 py-2 text-right sm:px-3">
                <button
                  type="button"
                  onClick={() => release(c)}
                  disabled={busy === key}
                  className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80 disabled:opacity-50"
                >
                  {busy === key ? "…" : "release"}
                </button>
                {feedback?.key === key && (
                  <span
                    className={`ml-2 text-xs ${feedback.ok ? "text-green-400" : "text-red-400"}`}
                  >
                    {feedback.msg}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
