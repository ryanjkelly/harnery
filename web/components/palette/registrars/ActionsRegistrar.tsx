"use client";

/**
 * Registers the "Actions" section — the *verb* half of the palette, as
 * opposed to Routes (navigation) and the catalogs (search). Drill-down verbs
 * (search files, search events, open a path) push a prompt sub-view;
 * pick-list verbs (timezone) push a small list; immediate verbs (copy link,
 * display settings) run inline. Mounted once by the root layout so ⌘K
 * exposes these anywhere. Renders nothing.
 */

import { Copy, FileText, Globe, ScrollText, Search, Settings } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import { useDateTimeFormat } from "@/components/DateTimeFormatProvider";
import { POPULAR_TIMEZONES } from "@/lib/format/prefs";
import { buildFileSearchPrompt } from "../file-search-prompt";
import { type PaletteItem, useCommandPaletteSection, usePaletteFileOpen } from "../PaletteProvider";

/** NavBar listens for this to open the display-settings dialog. */
export const OPEN_SETTINGS_EVENT = "harnery:open-settings";

export function ActionsRegistrar() {
  const router = useRouter();
  const pathname = usePathname();
  const prefs = useDateTimeFormat();
  const openFile = usePaletteFileOpen();

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [
      {
        key: "action-search-files",
        label: "Search files…",
        description: "Fuzzy search the repo file index",
        keywords: ["file", "find", "fuzzy", "path", "repo", "browse"],
        icon: <Search size={14} aria-hidden />,
        prompt: buildFileSearchPrompt(openFile),
      },
      {
        key: "action-open-path",
        label: "Open file by path…",
        description: "Exact repo-relative path",
        keywords: ["file", "path", "viewer", "open"],
        icon: <FileText size={14} aria-hidden />,
        prompt: {
          title: "Open file",
          placeholder: "docs/plans/example.md",
          submitLabel: "Open",
          hint: "Paste a repo-relative path, then press Enter.",
          onSubmit: (value: string) => {
            const q = value.trim();
            if (q) openFile(q.replace(/^\.?\//, ""));
          },
        },
      },
      {
        key: "action-search-events",
        label: "Search events…",
        description: "Free-text search of the event ledger",
        keywords: ["events", "ledger", "log", "grep", "history"],
        icon: <ScrollText size={14} aria-hidden />,
        prompt: {
          title: "Search events",
          placeholder: "intent, command, agent, or summary text",
          submitLabel: "Search",
          onSubmit: (value: string) => {
            router.push(`/events?q=${encodeURIComponent(value.trim())}`);
          },
        },
      },
      {
        key: "action-copy-link",
        label: "Copy link to this page",
        description: pathname ?? undefined,
        keywords: ["copy", "url", "link", "share", "clipboard"],
        icon: <Copy size={14} aria-hidden />,
        onSelect: () => {
          try {
            void navigator.clipboard.writeText(window.location.href);
          } catch {
            /* clipboard unavailable — best-effort */
          }
        },
      },
      {
        key: "action-timezone",
        label: "Change timezone",
        description: "Display timezone for every timestamp",
        keywords: ["timezone", "tz", "utc", "local", "time"],
        icon: <Globe size={14} aria-hidden />,
        pushItems: {
          title: "Timezone",
          items: POPULAR_TIMEZONES.map((tz) => ({
            key: `tz-${tz.id}`,
            label: tz.label,
            description: tz.id === prefs.timezonePref ? "current" : undefined,
            onSelect: () => prefs.setTimezone(tz.id),
          })),
        },
      },
      {
        key: "action-settings",
        label: "Display settings…",
        description: "Datetime format + timezone",
        keywords: ["settings", "format", "datetime", "preferences", "gear"],
        icon: <Settings size={14} aria-hidden />,
        onSelect: () => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT)),
      },
    ];
    return list;
  }, [router, pathname, prefs, openFile]);

  useCommandPaletteSection("Actions", items, 10);
  return null;
}
