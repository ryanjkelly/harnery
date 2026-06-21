"use client";

import { useEffect, useMemo, useState } from "react";

import { useDateTimeFormat } from "@/components/DateTimeFormatProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CUSTOM_PRESET_ID,
  DEFAULT_PRESET_IDS,
  FORMAT_PRESETS,
  type FormatKind,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
  POPULAR_TIMEZONES,
  TZ_AUTO,
  isValidTimezone,
  templateForPreset,
} from "@/lib/format/prefs";
import { formatTemplate } from "@/lib/format/template";

const FORMAT_TABS: ReadonlyArray<FormatKind> = ["date", "datetime", "timestamp"];

/**
 * Display settings: datetime preferences. Lives behind the gear icon in
 * the top-right of [`NavBar`](./NavBar.tsx).
 *
 * Layout:
 *   - Timezone: native `<select>` (compact) + custom IANA input that appears
 *     when "Custom…" is chosen.
 *   - Format: tabs for Date / Date + Time / Timestamp; each tab shows the
 *     presets + a custom-template row for its kind.
 *   - Live preview: shows all three formats simultaneously applied to "now",
 *     so the operator sees how their choices land across the dashboard.
 *
 * State model: edits are *draft* state and only persist on **Apply**. Apply
 * commits + stays in the dialog (with a brief "Saved ✓" confirmation), so
 * the operator can iterate without bouncing the modal. The footer's status
 * line surfaces whether the draft diverges from saved state.
 *
 *   - **Reset to defaults**: snaps drafts back to the built-in defaults
 *     (still has to Apply to persist).
 *   - **Revert**: snaps drafts back to the currently-saved prefs without
 *     closing. Enabled only when dirty.
 *   - **Cancel**: discards drafts and closes. Always available.
 *   - **Apply**: writes drafts through the provider, stays open. Enabled
 *     only when dirty AND the chosen timezone is valid.
 *
 * Closing the dialog (Cancel, click outside, Escape) discards any unsaved
 * drafts. There's no "are you sure?" prompt; Revert exists for second
 * thoughts.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const prefs = useDateTimeFormat();

  // Draft state, only persisted on Apply.
  const [draftPreset, setDraftPreset] = useState<Record<FormatKind, string>>({
    date: prefs.date.presetId,
    datetime: prefs.datetime.presetId,
    timestamp: prefs.timestamp.presetId,
  });
  const [draftCustom, setDraftCustom] = useState<Record<FormatKind, string>>({
    date: prefs.date.customTemplate,
    datetime: prefs.datetime.customTemplate,
    timestamp: prefs.timestamp.customTemplate,
  });

  const isPopular = (tz: string) => POPULAR_TIMEZONES.some((p) => p.id === tz);
  const [draftTzMode, setDraftTzMode] = useState<"popular" | "custom">(
    isPopular(prefs.timezonePref) ? "popular" : "custom",
  );
  const [draftTz, setDraftTz] = useState<string>(
    isPopular(prefs.timezonePref) ? prefs.timezonePref : TZ_AUTO,
  );
  const [draftCustomTz, setDraftCustomTz] = useState<string>(
    isPopular(prefs.timezonePref) ? "" : prefs.timezonePref,
  );

  const [activeTab, setActiveTab] = useState<FormatKind>("datetime");

  // "Saved ✓" indicator shown for ~1.5s after Apply.
  const [recentlySaved, setRecentlySaved] = useState(false);
  useEffect(() => {
    if (!recentlySaved) return;
    const id = window.setTimeout(() => setRecentlySaved(false), 1500);
    return () => window.clearTimeout(id);
  }, [recentlySaved]);

  // Pull "the saved state" into a single shape so reverting + dirty-detection
  // can share one source of truth. Computed from `prefs` so it stays in sync
  // when Apply commits (or when another tab writes via cross-tab storage).
  const savedSnapshot = useMemo(
    () => ({
      preset: {
        date: prefs.date.presetId,
        datetime: prefs.datetime.presetId,
        timestamp: prefs.timestamp.presetId,
      } as Record<FormatKind, string>,
      custom: {
        date: prefs.date.customTemplate,
        datetime: prefs.datetime.customTemplate,
        timestamp: prefs.timestamp.customTemplate,
      } as Record<FormatKind, string>,
      tz: prefs.timezonePref,
    }),
    [
      prefs.date.presetId,
      prefs.datetime.presetId,
      prefs.timestamp.presetId,
      prefs.date.customTemplate,
      prefs.datetime.customTemplate,
      prefs.timestamp.customTemplate,
      prefs.timezonePref,
    ],
  );

  const revertDrafts = () => {
    setDraftPreset({ ...savedSnapshot.preset });
    setDraftCustom({ ...savedSnapshot.custom });
    const popular = isPopular(savedSnapshot.tz);
    setDraftTzMode(popular ? "popular" : "custom");
    setDraftTz(popular ? savedSnapshot.tz : TZ_AUTO);
    setDraftCustomTz(popular ? "" : savedSnapshot.tz);
  };

  // Re-baseline drafts whenever the dialog opens AND the provider has
  // hydrated saved prefs from localStorage. Two reasons this is necessary:
  //
  //   1. **Initial mount.** SettingsDialog is rendered by NavBar from the
  //      first paint, so its `useState` initializers fire BEFORE the
  //      provider's hydrate effect. Drafts capture the pre-hydration
  //      defaults; once hydration finishes, savedSnapshot reflects real
  //      saved state but drafts are stuck on the defaults, triggering a
  //      spurious "Unsaved changes" on first open. (The previous open-
  //      handler did this re-sync, but only when a child called
  //      `onOpenChange`; clicking the gear button in NavBar flips state
  //      directly and bypassed it.)
  //
  //   2. **Cross-tab edits.** A change applied in another tab updates the
  //      provider here via the `storage` event. Reopening this dialog
  //      should re-baseline against the new saved state.
  //
  // Effect deps are limited to `open` + `prefs.hydrated` so mid-edit prefs
  // updates (from another tab) don't blow away in-progress typing in this
  // dialog while it's already open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!open || !prefs.hydrated) return;
    revertDrafts();
    setRecentlySaved(false);
  }, [open, prefs.hydrated]);

  const draftTemplates = useMemo(
    () =>
      ({
        date: templateForPreset("date", draftPreset.date, draftCustom.date),
        datetime: templateForPreset("datetime", draftPreset.datetime, draftCustom.datetime),
        timestamp: templateForPreset("timestamp", draftPreset.timestamp, draftCustom.timestamp),
      }) as Record<FormatKind, string>,
    [draftPreset, draftCustom],
  );

  const draftEffectiveTz = draftTzMode === "custom" ? draftCustomTz.trim() : draftTz;
  const draftTzValid = isValidTimezone(draftEffectiveTz);
  const previewTz = draftEffectiveTz === TZ_AUTO ? prefs.timezone : draftEffectiveTz;

  const livePreview = useMemo(() => {
    if (!draftTzValid) {
      return {
        date: "(invalid timezone)",
        datetime: "(invalid timezone)",
        timestamp: "(invalid timezone)",
      };
    }
    const now = new Date();
    return {
      date: formatTemplate(now, draftTemplates.date, { timeZone: previewTz }),
      datetime: formatTemplate(now, draftTemplates.datetime, { timeZone: previewTz }),
      timestamp: formatTemplate(now, draftTemplates.timestamp, {
        timeZone: previewTz,
      }),
    };
  }, [draftTemplates, draftTzValid, previewTz]);

  // Dirty when any draft diverges from saved state. Recomputed on every
  // keystroke; cheap, three string compares plus the tz.
  const isDirty = useMemo(() => {
    for (const kind of FORMAT_TABS) {
      if (draftPreset[kind] !== savedSnapshot.preset[kind]) return true;
      if (draftCustom[kind] !== savedSnapshot.custom[kind]) return true;
    }
    if (draftEffectiveTz !== savedSnapshot.tz) return true;
    return false;
  }, [draftPreset, draftCustom, draftEffectiveTz, savedSnapshot]);

  const apply = () => {
    if (!draftTzValid || !isDirty) return;
    for (const kind of FORMAT_TABS) {
      prefs.setPreset(kind, draftPreset[kind]);
      // Always write the custom template so the operator's typing isn't
      // lost when they toggle back to "Custom" later, even if the active
      // selection isn't the custom row right now.
      prefs.setCustomTemplate(kind, draftCustom[kind]);
    }
    prefs.setTimezone(draftEffectiveTz);
    setRecentlySaved(true);
    // Dialog stays open intentionally; the operator can keep iterating.
  };

  const resetDefaults = () => {
    setDraftPreset({ ...DEFAULT_PRESET_IDS });
    setDraftCustom({ date: "", datetime: "", timestamp: "" });
    setDraftTzMode("popular");
    setDraftTz(TZ_AUTO);
    setDraftCustomTz("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="2xl">
      <DialogHeader>
        <DialogTitle>Display settings</DialogTitle>
        <DialogDescription>
          Set your preferred timezone and the format used for dates, full date + time, and dense log
          timestamps. Stored in this browser; syncs across open tabs.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5">
        {/* Timezone: compact select + optional custom input */}
        <section>
          <h3 className="text-sm font-semibold mb-2">Timezone</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={draftTzMode === "custom" ? "__custom__" : draftTz}
              onChange={(e) => {
                if (e.target.value === "__custom__") {
                  setDraftTzMode("custom");
                } else {
                  setDraftTzMode("popular");
                  setDraftTz(e.target.value);
                }
              }}
              className="bg-background border border-border rounded px-2 py-1.5 text-sm min-w-64"
            >
              {POPULAR_TIMEZONES.map((tz) => (
                <option key={tz.id} value={tz.id}>
                  {tz.label}
                </option>
              ))}
              <option value="__custom__">Custom IANA zone…</option>
            </select>
            {draftTzMode === "custom" && (
              <input
                type="text"
                value={draftCustomTz}
                onChange={(e) => setDraftCustomTz(e.target.value)}
                placeholder="e.g. America/Toronto"
                className="flex-1 min-w-48 bg-background border border-border rounded px-2 py-1.5 text-xs font-mono"
              />
            )}
          </div>
          {draftTzMode === "custom" &&
            draftCustomTz.trim() &&
            !isValidTimezone(draftCustomTz.trim()) && (
              <p className="text-xs text-destructive mt-1.5">
                Not a recognized IANA zone. Try <span className="font-mono">Continent/City</span>{" "}
                (e.g. <span className="font-mono">America/Toronto</span>).
              </p>
            )}
        </section>

        {/* Format: tabs for the three kinds */}
        <section>
          <h3 className="text-sm font-semibold mb-2">Format</h3>
          <div className="flex border-b border-border mb-3">
            {FORMAT_TABS.map((kind) => (
              <button
                type="button"
                key={kind}
                onClick={() => setActiveTab(kind)}
                className={`px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors ${
                  activeTab === kind
                    ? "border-primary text-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {KIND_LABELS[kind]}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mb-3 leading-snug">
            {KIND_DESCRIPTIONS[activeTab]}
          </p>
          <FormatPicker
            kind={activeTab}
            presetId={draftPreset[activeTab]}
            customTemplate={draftCustom[activeTab]}
            onPresetChange={(id) => setDraftPreset((prev) => ({ ...prev, [activeTab]: id }))}
            onCustomChange={(tpl) => setDraftCustom((prev) => ({ ...prev, [activeTab]: tpl }))}
          />
        </section>

        {/* Live preview: all three at once */}
        <section className="rounded border border-border bg-muted/30 p-3">
          <div className="text-xs text-muted-foreground mb-2">Live preview ({previewTz})</div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{KIND_LABELS.date}</dt>
            <dd className="font-mono">{livePreview.date}</dd>
            <dt className="text-muted-foreground">{KIND_LABELS.datetime}</dt>
            <dd className="font-mono">{livePreview.datetime}</dd>
            <dt className="text-muted-foreground">{KIND_LABELS.timestamp}</dt>
            <dd className="font-mono">{livePreview.timestamp}</dd>
          </dl>
        </section>
      </div>

      <DialogFooter className="justify-between items-center">
        <Button variant="ghost" size="sm" onClick={resetDefaults}>
          Reset to defaults
        </Button>
        <div className="flex items-center gap-3 flex-wrap">
          <SaveStatus dirty={isDirty} recentlySaved={recentlySaved} />
          <Button
            variant="ghost"
            size="sm"
            onClick={revertDrafts}
            disabled={!isDirty}
            title="Discard pending changes without closing"
          >
            Revert
          </Button>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={apply}
            disabled={!draftTzValid || !isDirty}
            title={
              !draftTzValid
                ? "Fix the invalid timezone first"
                : !isDirty
                  ? "No pending changes"
                  : "Save your changes"
            }
          >
            Apply
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Footer status line. Three states, mutually exclusive:
 *   - `recentlySaved` (dominates for ~1.5s after Apply) → green checkmark
 *   - `dirty` → amber dot with "Unsaved changes"
 *   - neither → empty (nothing to say)
 *
 * Sits between the Reset button and the Revert/Cancel/Apply trio so the
 * operator's eyes land on it on the way to Apply.
 */
function SaveStatus({
  dirty,
  recentlySaved,
}: {
  dirty: boolean;
  recentlySaved: boolean;
}) {
  if (recentlySaved) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-emerald-500">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="size-4"
        >
          <path
            fillRule="evenodd"
            d="M16.704 5.29a1 1 0 0 1 .006 1.414l-7.5 7.6a1 1 0 0 1-1.422.003l-3.5-3.5a1 1 0 1 1 1.414-1.414l2.79 2.79 6.793-6.887a1 1 0 0 1 1.42-.006Z"
            clipRule="evenodd"
          />
        </svg>
        Saved
      </span>
    );
  }
  if (dirty) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber-500">
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        Unsaved changes
      </span>
    );
  }
  return null;
}

/**
 * Per-kind preset picker. List of preset radios with their static examples,
 * plus a "Custom" row that activates a template input. Renders inside the
 * active tab.
 */
function FormatPicker({
  kind,
  presetId,
  customTemplate,
  onPresetChange,
  onCustomChange,
}: {
  kind: FormatKind;
  presetId: string;
  customTemplate: string;
  onPresetChange: (id: string) => void;
  onCustomChange: (tpl: string) => void;
}) {
  const presets = FORMAT_PRESETS[kind];
  // Four-column grid so example + template line up across every row. Click
  // the template to copy it into the Custom field as a starting point. This is
  // the explicit hint that makes "tweak a preset" a one-click flow.
  //
  // Label column is 12rem (192px) so the longest preset label we ship today
  // ("24-hour with millis + zone", ~26 chars) fits without truncating in the
  // standard sans-serif. Every text column also carries a `title` attribute
  // so any future label that's still too wide surfaces a native tooltip.
  //
  // The grid-cols-* class is written as a literal (not a template-built
  // string) so Tailwind's static class scanner picks up the arbitrary value.
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[auto_12rem_minmax(0,1fr)_minmax(0,1fr)] gap-3 px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">
        <span />
        <span>Preset</span>
        <span>Example output</span>
        <span>Template</span>
      </div>
      {presets.map((p) => (
        <label
          key={p.id}
          className="grid grid-cols-[auto_12rem_minmax(0,1fr)_minmax(0,1fr)] gap-3 items-center cursor-pointer hover:bg-muted/40 rounded px-2 py-1 text-sm"
        >
          <input
            type="radio"
            name={`preset-${kind}`}
            value={p.id}
            checked={presetId === p.id}
            onChange={() => onPresetChange(p.id)}
            className="accent-primary"
          />
          <span className="truncate min-w-0" title={p.label}>
            {p.label}
          </span>
          <span className="font-mono text-xs text-foreground/85 truncate min-w-0" title={p.example}>
            {p.example}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onCustomChange(p.template);
              onPresetChange(CUSTOM_PRESET_ID);
            }}
            title={`${p.template} (click to copy into the Custom row to tweak)`}
            className="font-mono text-[11px] text-muted-foreground truncate min-w-0 text-left hover:text-foreground hover:underline decoration-dotted underline-offset-2"
          >
            {p.template}
          </button>
        </label>
      ))}
      <label className="grid grid-cols-[auto_12rem_minmax(0,1fr)] gap-3 items-start cursor-pointer hover:bg-muted/40 rounded px-2 py-1 text-sm">
        <input
          type="radio"
          name={`preset-${kind}`}
          value={CUSTOM_PRESET_ID}
          checked={presetId === CUSTOM_PRESET_ID}
          onChange={() => onPresetChange(CUSTOM_PRESET_ID)}
          className="accent-primary mt-1"
        />
        <span className="truncate min-w-0 mt-1">Custom</span>
        <div className="min-w-0">
          <input
            type="text"
            value={customTemplate}
            onChange={(e) => {
              onCustomChange(e.target.value);
              onPresetChange(CUSTOM_PRESET_ID);
            }}
            placeholder="e.g. ddd, MMM D YYYY @ h:mm A"
            className="w-full bg-background border border-border rounded px-2 py-1 text-xs font-mono"
          />
          <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
            Tip: click any preset's template above to copy it here, then tweak.
            <br />
            Tokens: <code>YYYY YY</code> <code>MMMM MMM MM M</code> <code>DD D</code>{" "}
            <code>dddd ddd</code> <code>HH H hh h</code> <code>mm m</code> <code>ss s SSS</code>{" "}
            <code>A a</code> <code>z zzzz</code>. Wrap literals in <code>[brackets]</code>.
          </p>
        </div>
      </label>
    </div>
  );
}
