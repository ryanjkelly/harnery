"use client";

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  DEFAULT_PRESET_IDS,
  type FormatKind,
  LEGACY_CUSTOM_TEMPLATE_STORAGE_KEY,
  LEGACY_PRESET_STORAGE_KEY,
  TZ_AUTO,
  TZ_STORAGE_KEY,
  customTemplateStorageKey,
  defaultTemplate,
  presetStorageKey,
  resolveTimezone,
  templateForPreset,
} from "@/lib/format/prefs";

/**
 * Provides the user's datetime preferences (three independent format kinds
 * + one timezone) to every component in the tree. Mounted once at the root
 * in [`app/layout.tsx`](../app/layout.tsx); consumed by
 * [`FormattedDateTime`](./FormattedDateTime.tsx),
 * [`SettingsDialog`](./SettingsDialog.tsx), and
 * [`LogTimestamp`](./log-table/LogTimestamp.tsx).
 *
 * **Three format kinds:**
 *   - `dateTemplate`:      date-only labels.
 *   - `datetimeTemplate`:  full date + time. The default for `FormattedDateTime`.
 *   - `timestampTemplate`: dense time-of-day for log rows / streaming feeds.
 *
 * **SSR contract:** the first server render uses the canonical defaults
 * + UTC. A `useEffect` hydrates the user's localStorage values on mount.
 * One render of UTC labels on cold-load (visually a non-event ~16ms)
 * avoids the `suppressHydrationWarning` escape hatch.
 *
 * **Cross-tab sync:** subscribes to the `storage` event so changing a
 * preference in tab A propagates to tab B within a single tick.
 *
 * **One-time legacy migration:** older revs of this dialog stored a single
 * preset + custom template under `harnery.datetime.{preset,custom_template}`.
 * On first hydrate those values get copied into the `datetime.*` keys (so a
 * returning operator keeps their datetime choice) and the legacy keys are
 * cleared. Idempotent.
 */

interface KindPrefs {
  presetId: string;
  customTemplate: string;
  template: string;
}

export interface DateTimeFormatPrefs {
  /** Per-kind: preset id (or `"custom"`), custom template, resolved template. */
  date: KindPrefs;
  datetime: KindPrefs;
  timestamp: KindPrefs;

  /** Stored value: IANA zone or `"auto"`. */
  timezonePref: string;
  /** Resolved IANA zone. `"auto"` resolves to the browser zone. UTC on SSR. */
  timezone: string;
  /** True after the initial localStorage hydration tick. */
  hydrated: boolean;

  setPreset(kind: FormatKind, presetId: string): void;
  setCustomTemplate(kind: FormatKind, template: string): void;
  setTimezone(tz: string): void;
}

const DateTimeFormatContext = createContext<DateTimeFormatPrefs | null>(null);

const ALL_KINDS: ReadonlyArray<FormatKind> = ["date", "datetime", "timestamp"];

interface RawState {
  preset: Record<FormatKind, string>;
  custom: Record<FormatKind, string>;
  tz: string;
}

const initialRaw: RawState = {
  preset: {
    date: DEFAULT_PRESET_IDS.date,
    datetime: DEFAULT_PRESET_IDS.datetime,
    timestamp: DEFAULT_PRESET_IDS.timestamp,
  },
  custom: { date: "", datetime: "", timestamp: "" },
  tz: TZ_AUTO,
};

export function DateTimeFormatProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = useState<RawState>(initialRaw);
  const [hydrated, setHydrated] = useState<boolean>(false);

  // Hydrate from localStorage on mount + migrate any legacy keys. The
  // `storage` listener catches updates from other tabs.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next: RawState = {
      preset: { ...initialRaw.preset },
      custom: { ...initialRaw.custom },
      tz: initialRaw.tz,
    };

    try {
      // Legacy migration: copy old keys into datetime.* if present, then
      // delete. Runs at most once per browser since the old keys vanish.
      const legacyPreset = window.localStorage.getItem(LEGACY_PRESET_STORAGE_KEY);
      const legacyCustom = window.localStorage.getItem(LEGACY_CUSTOM_TEMPLATE_STORAGE_KEY);
      if (legacyPreset !== null || legacyCustom !== null) {
        if (legacyPreset !== null) {
          // "canonical" is the old name for the datetime default.
          const mapped = legacyPreset === "canonical" ? "default" : legacyPreset;
          if (window.localStorage.getItem(presetStorageKey("datetime")) === null) {
            window.localStorage.setItem(presetStorageKey("datetime"), mapped);
          }
        }
        if (legacyCustom !== null) {
          if (window.localStorage.getItem(customTemplateStorageKey("datetime")) === null) {
            window.localStorage.setItem(customTemplateStorageKey("datetime"), legacyCustom);
          }
        }
        window.localStorage.removeItem(LEGACY_PRESET_STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_CUSTOM_TEMPLATE_STORAGE_KEY);
      }

      for (const kind of ALL_KINDS) {
        const p = window.localStorage.getItem(presetStorageKey(kind));
        const c = window.localStorage.getItem(customTemplateStorageKey(kind));
        if (p) next.preset[kind] = p;
        if (c) next.custom[kind] = c;
      }
      const tz = window.localStorage.getItem(TZ_STORAGE_KEY);
      if (tz) next.tz = tz;
    } catch {
      /* swallow; locked-down browsers fall back to defaults */
    }
    setRaw(next);
    setHydrated(true);

    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      for (const kind of ALL_KINDS) {
        if (e.key === presetStorageKey(kind)) {
          setRaw((prev) => ({
            ...prev,
            preset: { ...prev.preset, [kind]: e.newValue ?? DEFAULT_PRESET_IDS[kind] },
          }));
          return;
        }
        if (e.key === customTemplateStorageKey(kind)) {
          setRaw((prev) => ({
            ...prev,
            custom: { ...prev.custom, [kind]: e.newValue ?? "" },
          }));
          return;
        }
      }
      if (e.key === TZ_STORAGE_KEY) {
        setRaw((prev) => ({ ...prev, tz: e.newValue ?? TZ_AUTO }));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreset = useCallback((kind: FormatKind, id: string) => {
    setRaw((prev) => ({
      ...prev,
      preset: { ...prev.preset, [kind]: id },
    }));
    try {
      window.localStorage.setItem(presetStorageKey(kind), id);
    } catch {
      /* noop */
    }
  }, []);

  const setCustomTemplate = useCallback((kind: FormatKind, tpl: string) => {
    setRaw((prev) => ({
      ...prev,
      custom: { ...prev.custom, [kind]: tpl },
    }));
    try {
      window.localStorage.setItem(customTemplateStorageKey(kind), tpl);
    } catch {
      /* noop */
    }
  }, []);

  const setTimezone = useCallback((tz: string) => {
    setRaw((prev) => ({ ...prev, tz }));
    try {
      window.localStorage.setItem(TZ_STORAGE_KEY, tz);
    } catch {
      /* noop */
    }
  }, []);

  const value = useMemo<DateTimeFormatPrefs>(() => {
    const buildKind = (kind: FormatKind): KindPrefs => ({
      presetId: raw.preset[kind],
      customTemplate: raw.custom[kind],
      template: hydrated
        ? templateForPreset(kind, raw.preset[kind], raw.custom[kind])
        : defaultTemplate(kind),
    });
    return {
      date: buildKind("date"),
      datetime: buildKind("datetime"),
      timestamp: buildKind("timestamp"),
      timezonePref: raw.tz,
      // Pre-hydration we serve UTC so SSR + first client paint match exactly.
      timezone: hydrated ? resolveTimezone(raw.tz) : "UTC",
      hydrated,
      setPreset,
      setCustomTemplate,
      setTimezone,
    };
  }, [raw, hydrated, setPreset, setCustomTemplate, setTimezone]);

  return <DateTimeFormatContext.Provider value={value}>{children}</DateTimeFormatContext.Provider>;
}

/**
 * Read the current datetime prefs. Safe outside the provider: returns the
 * canonical-default object so callsites don't need null-checks (useful for
 * storybook / snapshot tests).
 */
export function useDateTimeFormat(): DateTimeFormatPrefs {
  const ctx = useContext(DateTimeFormatContext);
  if (ctx) return ctx;
  const buildKind = (kind: FormatKind): KindPrefs => ({
    presetId: DEFAULT_PRESET_IDS[kind],
    customTemplate: "",
    template: defaultTemplate(kind),
  });
  return {
    date: buildKind("date"),
    datetime: buildKind("datetime"),
    timestamp: buildKind("timestamp"),
    timezonePref: TZ_AUTO,
    timezone: "UTC",
    hydrated: false,
    setPreset: () => {},
    setCustomTemplate: () => {},
    setTimezone: () => {},
  };
}

/** Pull just the template for one kind. Convenience for tight callsites. */
export function useTemplate(kind: FormatKind): string {
  return useDateTimeFormat()[kind].template;
}
