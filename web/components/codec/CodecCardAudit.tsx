"use client";

import { Camera, Download, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentChip } from "@/components/AgentChip";
import { type CodecCardAuditReport, captureCodecCards } from "@/lib/codec/card-audit";
import type { CodecScene } from "@/lib/codec/contracts";

const STORAGE_KEY = "harnery.codec.card-audits.v1";
const HISTORY_LIMIT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Both persisted history and network responses are untrusted browser inputs. */
export function isCodecCardAuditReport(value: unknown): value is CodecCardAuditReport {
  if (!isRecord(value) || !isRecord(value.capture) || !isRecord(value.summary)) return false;
  const capture = value.capture;
  const authority = value.authority_read_state;
  return (
    typeof capture.captured_at === "string" &&
    Number.isFinite(Date.parse(capture.captured_at)) &&
    typeof capture.scene_generated_at === "string" &&
    Array.isArray(capture.cards) &&
    capture.cards.every(
      (card) =>
        isRecord(card) &&
        ["instance_id", "display_name", "presence", "activity", "lifecycle", "updated_at"].every(
          (field) => typeof card[field] === "string",
        ) &&
        (card.machine === undefined || typeof card.machine === "string") &&
        (card.task === null || typeof card.task === "string") &&
        (card.ledger_state === null || typeof card.ledger_state === "string"),
    ) &&
    typeof value.checked_at === "string" &&
    isRecord(authority) &&
    (authority.ok === true || (authority.ok === false && typeof authority.reason === "string")) &&
    [value.summary.checked, value.summary.mismatches, value.summary.unverified].every(
      (count) => typeof count === "number" && Number.isInteger(count) && count >= 0,
    ) &&
    Array.isArray(value.findings) &&
    value.findings.every(
      (finding) =>
        isRecord(finding) &&
        ["instance_id", "display_name", "field", "explanation"].every(
          (field) => typeof finding[field] === "string",
        ) &&
        (finding.card === null || typeof finding.card === "string") &&
        (finding.known === null || typeof finding.known === "string") &&
        (finding.severity === "mismatch" || finding.severity === "unverified"),
    )
  );
}

export function codecCardAuditHistory(value: unknown): CodecCardAuditReport[] {
  return Array.isArray(value) ? value.filter(isCodecCardAuditReport).slice(0, HISTORY_LIMIT) : [];
}

export function CodecCardAudit({ scene }: { scene: CodecScene }) {
  const [reports, setReports] = useState<CodecCardAuditReport[]>([]);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      setReports(codecCardAuditHistory(saved));
    } catch {
      // Browsers may disable storage; current comparisons still work.
    }
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, []);

  async function compare(): Promise<void> {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setRunning(true);
    setError("");
    const capture = captureCodecCards(scene, new Date().toISOString());
    try {
      const response = await fetch("/api/codec-audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(capture),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Comparison failed (${response.status})`);
      const report: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!isCodecCardAuditReport(report)) throw new Error("Comparison returned an invalid report");
      const next = [report, ...reports].slice(0, HISTORY_LIMIT);
      setReports(next);
      setSelected(0);
      setOpen(true);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // A downloaded report remains available even when storage is full.
      }
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "Comparison failed");
      setOpen(true);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setRunning(false);
      }
    }
  }

  function download(report: CodecCardAuditReport): void {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `codec-card-snapshot-${report.capture.captured_at.replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const report = reports[selected];
  return (
    <section className="mt-2 text-xs text-zinc-200" aria-label="Codec card snapshots">
      <button
        type="button"
        onClick={() => void compare()}
        disabled={running}
        className="inline-flex items-center gap-1.5 rounded-md border border-cyan-400/40 bg-cyan-950/40 px-2.5 py-1.5 text-cyan-100 hover:bg-cyan-900/50 disabled:opacity-60"
      >
        {running ? (
          <RefreshCw aria-hidden className="size-3 animate-spin" />
        ) : (
          <Camera aria-hidden className="size-3" />
        )}
        {running ? "Comparing cards…" : "Snapshot and compare cards"}
      </button>
      {reports.length > 0 && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-2 underline underline-offset-2"
        >
          View snapshots ({reports.length})
        </button>
      )}
      {open && (
        <div
          className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-zinc-600 bg-zinc-950/95 p-3 shadow-xl"
          data-codec-card-audit
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Card snapshot comparison</h2>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close card comparison">
              <X aria-hidden className="size-4" />
            </button>
          </div>
          {error && (
            <p role="alert" className="text-rose-300">
              {error}
            </p>
          )}
          {report && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <label htmlFor="codec-audit-history">Snapshot</label>
                <select
                  id="codec-audit-history"
                  value={selected}
                  onChange={(event) => setSelected(Number(event.target.value))}
                  className="rounded border border-zinc-600 bg-zinc-900 px-1 py-0.5"
                >
                  {reports.map((item, index) => (
                    <option key={item.capture.captured_at} value={index}>
                      {new Date(item.capture.captured_at).toLocaleString()} ·{" "}
                      {item.summary.mismatches} differences
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => download(report)}
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  <Download aria-hidden className="size-3" /> Download JSON
                </button>
              </div>
              <p className="mb-2 text-zinc-400">
                {report.summary.checked} local cards checked · {report.summary.mismatches}{" "}
                differences · {report.summary.unverified} unverified. Remote cards are captured but
                require their source machine to verify them.
              </p>
              {report.findings.length === 0 ? (
                <p role="status" className="text-emerald-300">
                  The captured fields match the current known agent state.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {report.findings.map((finding) => (
                    <li
                      key={`${finding.instance_id}-${finding.field}-${finding.explanation}`}
                      className="rounded border border-zinc-700 p-2"
                    >
                      <span
                        className={
                          finding.severity === "mismatch" ? "text-amber-300" : "text-zinc-400"
                        }
                      >
                        {finding.severity === "mismatch" ? "Difference" : "Unverified"}
                      </span>
                      {" · "}
                      <AgentChip name={finding.display_name} prefix="" />
                      {" · "}
                      {finding.field}: card {finding.card ?? "—"}, known {finding.known ?? "—"}.{" "}
                      {finding.explanation}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
