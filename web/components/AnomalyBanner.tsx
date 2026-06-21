import Link from "next/link";

import type { Anomaly } from "@/lib/anomalies";

/**
 * Top-of-page banner listing detected anomalies (loop patterns, stale tasks,
 * failed-command streaks). Server-rendered alongside the dashboard. The
 * LiveRefresher fires router.refresh() on coord-state changes so the banner
 * re-renders without polling. Mirrors the upstream app's AnomalyBanner.
 */
export function AnomalyBanner({ anomalies }: { anomalies: Anomaly[] }) {
  if (anomalies.length === 0) return null;

  const warnings = anomalies.filter((a) => a.severity === "warning");
  const infos = anomalies.filter((a) => a.severity === "info");
  const hasWarnings = warnings.length > 0;

  return (
    <div
      className={
        "mb-4 rounded-md border px-3 py-2 text-xs " +
        (hasWarnings
          ? "border-amber-500/40 bg-amber-500/[0.07]"
          : "border-sky-500/30 bg-sky-500/[0.05]")
      }
    >
      <div
        className={
          "font-semibold mb-1 " +
          (hasWarnings
            ? "text-amber-800 dark:text-amber-300"
            : "text-sky-800 dark:text-sky-300")
        }
      >
        {hasWarnings ? "⚠ " : "ⓘ "}
        {anomalies.length} anomal{anomalies.length === 1 ? "y" : "ies"} detected
      </div>
      <ul className="space-y-1">
        {[...warnings, ...infos].map((a) => (
          <li key={a.id} className="flex items-baseline gap-2">
            <span
              className={
                "shrink-0 uppercase text-[10px] tracking-wider " +
                (a.severity === "warning"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-sky-600 dark:text-sky-400")
              }
            >
              {a.kind.replace("_", " ")}
            </span>
            <span className="text-foreground/85">
              {a.agent_id ? (
                <Link
                  href={`/agents/${encodeURIComponent(a.agent_id)}`}
                  className="hover:underline"
                >
                  {a.message}
                </Link>
              ) : (
                a.message
              )}
              {a.detail && (
                <span className="ml-2 text-muted-foreground font-mono">
                  ({a.detail})
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
