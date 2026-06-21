"use client";

import { useDateTimeFormat } from "@/components/DateTimeFormatProvider";
import { Tooltip } from "@/components/ui/tooltip";
import { formatTemplate } from "@/lib/format/template";

/**
 * Dense log-row timestamp. The visible cell renders with the user's
 * **Timestamp** template; the tooltip on hover carries the user's full
 * **Date + Time** template so the operator can resolve the row's date
 * without expanding the row.
 *
 * Default (both kinds at their built-in default), where the cell shows the
 * timestamp template and the tooltip shows the full date + time:
 *
 *   cell     → "8:56:23.123 AM CDT"
 *   tooltip  → "Thu, May 28, 2026, 8:56 AM CDT"
 *
 * Timezone comes from the parent table (`timeZone` prop) so every row in
 * one render uses an identical zone string, which avoids per-row `Intl` cache
 * misses. The parent supplies it via `useDateTimeFormat().timezone`.
 */
export function LogTimestamp({
  iso,
  timeZone,
}: {
  iso: string;
  /** Override the user's timezone (used by tables that pre-resolved it). */
  timeZone?: string;
}) {
  const prefs = useDateTimeFormat();
  const effectiveTz = timeZone ?? prefs.timezone;

  const display = formatTemplate(iso, prefs.timestamp.template, {
    timeZone: effectiveTz,
  });
  const canonical = formatTemplate(iso, prefs.datetime.template, {
    timeZone: effectiveTz,
  });

  const machineReadable = (() => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  })();
  return (
    <Tooltip content={<span className="font-mono">{canonical}</span>} side="right">
      <time dateTime={machineReadable} className="tabular-nums cursor-help">
        {display}
      </time>
    </Tooltip>
  );
}
