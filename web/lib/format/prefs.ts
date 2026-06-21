/**
 * User-preferences model for datetime rendering: the one source of truth for
 * "how should every timestamp in the Harnery UI look right now."
 *
 * Three independent format kinds, picked per-surface:
 *
 *   - `"date"`:      date-only labels (e.g., column headers).
 *   - `"datetime"`:  full date + time (the most common surface: agent
 *                    cards, council manifests, scratchpad entries).
 *   - `"timestamp"`: dense time-of-day for log rows / streaming feeds.
 *
 * Each kind has its own preset catalog and its own localStorage key so the
 * operator can pick, say, ISO date + 12-hour datetime + 24-hour millisecond
 * timestamp without one choice overriding another.
 *
 * Persisted in `localStorage` under the keys exported below. The
 * [`DateTimeFormatProvider`](../../components/DateTimeFormatProvider.tsx)
 * hydrates from these keys on mount and broadcasts changes via React context;
 * the [`SettingsDialog`](../../components/SettingsDialog.tsx) is the operator
 * surface that writes them.
 */

/** Sentinel meaning "use the browser's detected IANA zone via `Intl`". */
export const TZ_AUTO = "auto";

/** localStorage key for the user-selected timezone (`"auto"` = browser IANA). */
export const TZ_STORAGE_KEY = "harnery.datetime.timezone";

/** Three independent format kinds. Each owns its own preset catalog +
 * default + storage keys. See top-of-file for what each renders. */
export type FormatKind = "date" | "datetime" | "timestamp";

/** Storage key shape: `harnery.datetime.<kind>.preset` / `.custom`. */
export function presetStorageKey(kind: FormatKind): string {
  return `harnery.datetime.${kind}.preset`;
}
export function customTemplateStorageKey(kind: FormatKind): string {
  return `harnery.datetime.${kind}.custom`;
}

/** Pre-v2 keys (single template + custom). Read once on hydrate, then
 * migrated into `datetime.*` keys. See the provider's hydrate effect. */
export const LEGACY_PRESET_STORAGE_KEY = "harnery.datetime.preset";
export const LEGACY_CUSTOM_TEMPLATE_STORAGE_KEY = "harnery.datetime.custom_template";

export interface FormatPreset {
  id: string;
  label: string;
  template: string;
  /** Static example string showing this preset for a fixed reference
   * instant. Lets the Settings UI render previews without re-formatting
   * every row on every keystroke. */
  example: string;
}

/** Sentinel preset id meaning "use the user's custom template". */
export const CUSTOM_PRESET_ID = "custom";

/** Default preset id per kind. The provider falls back to this if the
 * stored preset id no longer exists in the catalog. */
export const DEFAULT_PRESET_IDS: Record<FormatKind, string> = {
  date: "default",
  datetime: "default",
  timestamp: "default",
};

/**
 * Built-in preset catalogs. Reference instant for every `example` is
 * `Thu, May 28, 2026 at 08:56:23 CDT`. Update both fields together if you
 * change the reference instant.
 */
export const FORMAT_PRESETS: Record<FormatKind, ReadonlyArray<FormatPreset>> = {
  date: [
    {
      id: "default",
      label: "Default",
      template: "MMM D, YYYY",
      example: "May 28, 2026",
    },
    {
      id: "with-weekday",
      label: "With weekday",
      template: "ddd, MMM D, YYYY",
      example: "Thu, May 28, 2026",
    },
    {
      id: "iso",
      label: "ISO 8601",
      template: "YYYY-MM-DD",
      example: "2026-05-28",
    },
    {
      id: "us-slash",
      label: "US slash",
      template: "M/D/YYYY",
      example: "5/28/2026",
    },
    {
      id: "european",
      label: "European",
      template: "D MMM YYYY",
      example: "28 May 2026",
    },
    {
      id: "long-form",
      label: "Long-form",
      template: "dddd, MMMM D, YYYY",
      example: "Thursday, May 28, 2026",
    },
    {
      id: "compact",
      label: "Compact",
      template: "MMM D",
      example: "May 28",
    },
  ],
  datetime: [
    {
      id: "default",
      label: "Default",
      template: "MMM D, YYYY, h:mm A",
      example: "May 28, 2026, 8:56 AM",
    },
    {
      id: "with-seconds",
      label: "With seconds",
      template: "MMM D, YYYY, h:mm:ss A",
      example: "May 28, 2026, 8:56:23 AM",
    },
    {
      id: "with-zone",
      label: "With zone",
      template: "MMM D, YYYY, h:mm A z",
      example: "May 28, 2026, 8:56 AM CDT",
    },
    {
      id: "with-weekday",
      label: "With weekday",
      template: "ddd, MMM D, YYYY, h:mm A",
      example: "Thu, May 28, 2026, 8:56 AM",
    },
    {
      id: "short",
      label: "Short",
      template: "MMM D, h:mm A",
      example: "May 28, 8:56 AM",
    },
    {
      id: "iso",
      label: "ISO 8601",
      template: "YYYY-MM-DD HH:mm:ss",
      example: "2026-05-28 08:56:23",
    },
    {
      id: "iso-zone",
      label: "ISO with zone",
      template: "YYYY-MM-DD HH:mm:ss z",
      example: "2026-05-28 08:56:23 CDT",
    },
    {
      id: "24-hour",
      label: "24-hour",
      template: "MMM D, YYYY, HH:mm",
      example: "May 28, 2026, 08:56",
    },
    {
      id: "us-slash",
      label: "US slash-date",
      template: "M/D/YYYY h:mm A",
      example: "5/28/2026 8:56 AM",
    },
    {
      id: "european",
      label: "European",
      template: "D MMM YYYY, HH:mm",
      example: "28 May 2026, 08:56",
    },
    {
      id: "long-form",
      label: "Long-form",
      template: "dddd, MMMM D, YYYY [at] h:mm A z",
      example: "Thursday, May 28, 2026 at 8:56 AM CDT",
    },
  ],
  timestamp: [
    {
      id: "default",
      label: "Default",
      template: "HH:mm:ss.SSS",
      example: "08:56:23.123",
    },
    {
      id: "24-seconds",
      label: "24-hour",
      template: "HH:mm:ss",
      example: "08:56:23",
    },
    {
      id: "24-millis-zone",
      label: "24-hour with millis + zone",
      template: "HH:mm:ss.SSS z",
      example: "08:56:23.123 CDT",
    },
    {
      id: "24-seconds-zone",
      label: "24-hour with zone",
      template: "HH:mm:ss z",
      example: "08:56:23 CDT",
    },
    {
      id: "12-seconds",
      label: "12-hour",
      template: "h:mm:ss A",
      example: "8:56:23 AM",
    },
    {
      id: "12-millis",
      label: "12-hour with millis",
      template: "h:mm:ss.SSS A",
      example: "8:56:23.123 AM",
    },
    {
      id: "12-millis-zone",
      label: "12-hour with millis + zone",
      template: "h:mm:ss.SSS A z",
      example: "8:56:23.123 AM CDT",
    },
  ],
};

/** Resolve a preset id (or `"custom"`) to a template string. Falls back to
 * the kind's default preset if `presetId` doesn't match anything. */
export function templateForPreset(
  kind: FormatKind,
  presetId: string,
  customTemplate: string,
): string {
  if (presetId === CUSTOM_PRESET_ID) {
    return customTemplate.trim() || defaultTemplate(kind);
  }
  const preset = FORMAT_PRESETS[kind].find((p) => p.id === presetId);
  return preset?.template ?? defaultTemplate(kind);
}

/** The default template for the given kind. */
export function defaultTemplate(kind: FormatKind): string {
  const presets = FORMAT_PRESETS[kind];
  const defaultPreset = presets.find((p) => p.id === DEFAULT_PRESET_IDS[kind]);
  return defaultPreset?.template ?? presets[0].template;
}

/** Title for each format kind, shown in the Settings dialog tabs + previews. */
export const KIND_LABELS: Record<FormatKind, string> = {
  date: "Date",
  datetime: "Date + Time",
  timestamp: "Timestamp",
};

/** One-line description for each format kind, shown beside the tab content
 * so the operator understands where each setting takes effect. */
export const KIND_DESCRIPTIONS: Record<FormatKind, string> = {
  date: "Date-only labels (when no time is needed).",
  datetime:
    "Full date + time. Used in agent cards, council manifests, and most timestamps across the dashboard.",
  timestamp:
    "Dense time-of-day for log rows and streaming feeds. The full date + time form shows on hover.",
};

/**
 * Popular IANA timezones offered in the dropdown. Custom IANA strings are
 * allowed too; see [`SettingsDialog`](../../components/SettingsDialog.tsx)
 * for the custom-input row. Labels are operator-facing English; ids are IANA.
 */
export interface TimezoneOption {
  id: string;
  label: string;
}

export const POPULAR_TIMEZONES: ReadonlyArray<TimezoneOption> = [
  { id: TZ_AUTO, label: "Auto (browser-detected)" },
  { id: "America/Chicago", label: "Central, Chicago (CST/CDT)" },
  { id: "America/New_York", label: "Eastern, New York (EST/EDT)" },
  { id: "America/Denver", label: "Mountain, Denver (MST/MDT)" },
  { id: "America/Los_Angeles", label: "Pacific, Los Angeles (PST/PDT)" },
  { id: "America/Phoenix", label: "Arizona, Phoenix (no DST)" },
  { id: "America/Anchorage", label: "Alaska, Anchorage" },
  { id: "Pacific/Honolulu", label: "Hawaii, Honolulu" },
  { id: "UTC", label: "UTC" },
  { id: "Europe/London", label: "London" },
  { id: "Europe/Paris", label: "Paris" },
  { id: "Europe/Berlin", label: "Berlin" },
  { id: "Asia/Tokyo", label: "Tokyo" },
  { id: "Asia/Shanghai", label: "Shanghai" },
  { id: "Asia/Kolkata", label: "Kolkata" },
  { id: "Australia/Sydney", label: "Sydney" },
];

/** True if the string parses as a valid IANA zone (uses Intl as the oracle). */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  if (tz === TZ_AUTO) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Resolve `"auto"` to the browser's IANA zone (or `"UTC"` as last resort). */
export function resolveTimezone(stored: string): string {
  if (stored && stored !== TZ_AUTO) return stored;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
