"use client";

import { useDateTimeFormat } from "@/components/DateTimeFormatProvider";
import { type FormatDateTimeOpts, formatDateTime } from "@/lib/format/datetime";
import type { FormatKind } from "@/lib/format/prefs";
import { formatTemplate } from "@/lib/format/template";

/**
 * Render an ISO timestamp using one of the user's preferred templates +
 * their timezone, both sourced from
 * [`DateTimeFormatProvider`](./DateTimeFormatProvider.tsx).
 *
 * Pick which template via `kind`:
 *
 *   - `"date"`:      date-only labels.
 *   - `"datetime"`:  full date + time (the default, and the most common surface).
 *   - `"timestamp"`: dense time-of-day for log rows / streaming feeds.
 *
 * Default usage, with `kind` omitted, renders in the user's chosen Date + Time
 * template (see [`SettingsDialog`](./SettingsDialog.tsx) for the picker):
 *
 *   <FormattedDateTime iso={hb.last_heartbeat} />
 *     → e.g. "Thu, May 28, 2026, 8:56 AM CDT"
 *
 * For a date-only label:
 *
 *   <FormattedDateTime iso={council.created_at} kind="date" />
 *     → e.g. "Thu, May 28, 2026"
 *
 * Explicit overrides: pass `template` and/or `timeZone` to bypass the user
 * preference entirely (rare; used by tooltips that need a deterministic shape):
 *
 *   <FormattedDateTime iso={...} template="YYYY-MM-DD HH:mm:ss" />
 *   <FormattedDateTime iso={...} timeZone="UTC" />
 *
 * Legacy structured opts (`withYear`, `withSeconds`, `withZoneName`,
 * `hour12`, `monthFormat`, `withWeekday`) are accepted for back-compat with
 * pre-prefs callsites but **ignored at runtime**: the user's template now
 * controls every field. Do not add new uses.
 *
 * SSR-safe: server-side and the first client paint render with the canonical
 * defaults + UTC. A `useEffect` in the provider swaps to the user's stored
 * prefs once the page hydrates.
 */
export function FormattedDateTime({
  iso,
  kind = "datetime",
  template,
  timeZone,
  className,
}: {
  iso: string | Date | null | undefined;
  /** Which user-pref template to consume. Defaults to `"datetime"`. */
  kind?: FormatKind;
  /** Explicit template override; bypasses the user pref. */
  template?: string;
  /** Explicit IANA zone override; bypasses the user pref. */
  timeZone?: string;
  className?: string;
} & DeprecatedLegacyOpts) {
  const prefs = useDateTimeFormat();
  const effectiveTemplate = template ?? prefs[kind].template;
  const effectiveTz = timeZone ?? prefs.timezone;

  const dt = typeof iso === "string" ? new Date(iso) : iso instanceof Date ? iso : null;
  const machineReadable = dt && !Number.isNaN(dt.getTime()) ? dt.toISOString() : undefined;

  const formatted = formatTemplate(iso ?? null, effectiveTemplate, {
    timeZone: effectiveTz,
  });

  return (
    <time dateTime={machineReadable} className={className}>
      {formatted}
    </time>
  );
}

/**
 * Pre-prefs API surface, kept on the prop type so existing callsites
 * compile during the migration. Runtime ignores these fields; remove the
 * usage at each callsite to clean up. See [`FormattedDateTime`](./FormattedDateTime.tsx) jsdoc.
 *
 * @deprecated The user's selected template controls these fields. Drop the prop.
 */
type DeprecatedLegacyOpts = Partial<Omit<FormatDateTimeOpts, "timeZone">>;

/**
 * Helper for code that needs to format a timestamp using the user's prefs
 * outside JSX (e.g. tooltips that take a string content). Reads context, so
 * call from inside a React component.
 *
 * Example:
 *
 *   const fmt = useFormatDateTime();
 *   const label = fmt(iso);                              // user datetime + tz
 *   const label = fmt(iso, { kind: "date" });            // date-only
 *   const label = fmt(iso, { template: "HH:mm:ss" });    // explicit override
 *
 * For non-React contexts (server actions, utilities), import `formatTemplate`
 * directly and supply both the template + timezone.
 */
export function useFormatDateTime() {
  const prefs = useDateTimeFormat();
  return (
    iso: string | Date | null | undefined,
    opts: { kind?: FormatKind; template?: string; timeZone?: string } = {},
  ): string => {
    const kind = opts.kind ?? "datetime";
    const tpl = opts.template ?? prefs[kind].template;
    const tz = opts.timeZone ?? prefs.timezone;
    return formatTemplate(iso ?? null, tpl, { timeZone: tz });
  };
}

// Re-export so callsites that still want the structured-opts builder can
// reach it without importing from the lib path. `formatDateTime` stays
// available as the legacy structured-opts formatter; `formatTemplate` is
// the template-driven path the prefs system uses.
export { formatDateTime, formatTemplate };
