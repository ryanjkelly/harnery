"use client";

/**
 * Section registry + shared plumbing for the global command palette.
 *
 * Pages and global registrars call `useCommandPaletteSection(label, items,
 * order)` with MEMOIZED items — the section re-registers whenever the array
 * reference changes, so an unmemoized literal re-registers every render.
 * The palette component consumes the same context to render.
 *
 * Also owns the file-open indirection: the palette's file results normally
 * open in the global file-viewer overlay, but a page that renders files
 * in-pane (/browse) registers an override so selection lands in its own pane
 * instead of popping the modal over it.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RecentEntry } from "@/lib/palette/recents";

/**
 * A drill-down prompt: activating an item that carries one pushes a sub-view
 * with a dedicated input + a contextual submit button. Enter with nothing
 * highlighted (or the submit button) runs `onSubmit`; arrowing to a live
 * suggestion and pressing Enter runs that result instead.
 */
export interface PalettePrompt {
  /** Heading for the sub-view. */
  title: string;
  placeholder: string;
  /** Label on the submit affordance (e.g. "Open", "Search"). */
  submitLabel: string;
  /** Hint shown under an empty prompt. */
  hint?: string;
  /** Synchronous live suggestions as the user types. */
  suggest?: (value: string) => PaletteItem[];
  /** Debounced async suggestions (e.g. a fetch-backed file search). */
  suggestAsync?: (value: string) => Promise<PaletteItem[]>;
  /** Runs on submit. Receives the raw input value. */
  onSubmit: (value: string) => void;
  /** Gate the submit affordance; defaults to "non-empty". */
  canSubmit?: (value: string) => boolean;
}

/**
 * One row in the palette. Rows either run `onSelect` (after the palette
 * closes), drill into a `prompt`, or drill into a `pushItems` pick-list.
 */
export interface PaletteItem {
  /** Stable identifier within the section. */
  key: string;
  /** Primary text (matched against query). */
  label: string;
  /** Secondary text (also matched). */
  description?: string;
  /** Second line under the label. */
  subtitle?: string;
  /** Extra search tokens (also matched). */
  keywords?: string[];
  /** Navigable target used by modified click and ⌘/Ctrl+Enter. */
  href?: string;
  /** Optional leading icon (defaults to a chevron). */
  icon?: ReactNode;
  /** Right-aligned slot (badge / kbd / metadata). Overrides the active arrow. */
  trailing?: ReactNode;
  /**
   * Rank hint (0–10) within the item's section. When a query matches several
   * items at the same match-quality tier, higher-priority items list first.
   * Clamped so priority can reorder adjacent tiers but never bury an exact
   * match. Default 0.
   */
  priority?: number;
  /** Action to run when activated. Omit when `prompt`/`pushItems` is set. */
  onSelect?: () => void;
  /** Drill-down into a text prompt sub-view. */
  prompt?: PalettePrompt;
  /** Drill-down into a small pick-list sub-view (e.g. timezone). */
  pushItems?: { title: string; items: PaletteItem[] };
  /** Recorded to Recents when activated (navigation targets). */
  recent?: RecentEntry;
}

export interface PaletteSection {
  label: string;
  items: PaletteItem[];
  /** Empty-query preview size. Search and Browse all retain the complete section. */
  initialLimit?: number;
  /** Sort weight among non-synthesized sections (lower = earlier). Routes sit
   * at 50; page-contextual sections default to 0; global catalogs register
   * >50 to fall below routes. Recents pin to -100 internally. */
  order?: number;
}

interface PaletteRegistry {
  register: (
    id: string,
    label: string,
    items: PaletteItem[],
    order?: number,
    initialLimit?: number,
  ) => void;
  unregister: (id: string) => void;
}

const PaletteRegistryContext = createContext<PaletteRegistry | null>(null);
export const PaletteSectionsContext = createContext<Record<string, PaletteSection>>({});

interface FileOpenApi {
  /** Route a repo-relative path to the page override or the global overlay. */
  openPath: (relPath: string) => void;
  /** Pages that render files in-pane register an override while mounted. */
  registerOverride: (fn: ((relPath: string) => void) | null) => void;
  /** The global fallback (file-viewer overlay), wired by CommandPalette. */
  setFallback: (fn: (relPath: string) => void) => void;
}

export const PaletteFileOpenContext = createContext<FileOpenApi | null>(null);

/**
 * Register a section of fast-search items in the global command palette.
 * **Memoize `items`** — re-registers whenever the array reference changes.
 * Pass `order` to position the section relative to Routes (50).
 */
export function useCommandPaletteSection(
  label: string,
  items: PaletteItem[],
  order = 0,
  initialLimit?: number,
): void {
  const registry = useContext(PaletteRegistryContext);
  const id = useId();
  useEffect(() => {
    if (!registry) return;
    registry.register(id, label, items, order, initialLimit);
    return () => registry.unregister(id);
  }, [registry, id, label, items, order, initialLimit]);
}

/** Route a file path through the page override or the overlay fallback. */
export function usePaletteFileOpen(): (relPath: string) => void {
  const api = useContext(PaletteFileOpenContext);
  return useCallback(
    (relPath: string) => {
      api?.openPath(relPath);
    },
    [api],
  );
}

/** Pages that render files in-pane (e.g. /browse) call this with a handler. */
export function usePaletteFileOpenOverride(handler: ((relPath: string) => void) | null): void {
  const api = useContext(PaletteFileOpenContext);
  useEffect(() => {
    if (!api) return;
    api.registerOverride(handler);
    return () => api.registerOverride(null);
  }, [api, handler]);
}

/**
 * Provider for the palette's section registry + file-open indirection. Wrap
 * once near the top of the app tree (the root layout does this).
 */
export function PaletteProvider({ children }: { children: ReactNode }) {
  const [sections, setSections] = useState<Record<string, PaletteSection>>({});

  // Stable callbacks — components registering sections don't re-fire their
  // effect when OTHER sections change.
  const register = useCallback(
    (id: string, label: string, items: PaletteItem[], order = 0, initialLimit?: number) => {
      setSections((s) => ({ ...s, [id]: { label, items, order, initialLimit } }));
    },
    [],
  );
  const unregister = useCallback((id: string) => {
    setSections((s) => {
      if (!(id in s)) return s;
      const next = { ...s };
      delete next[id];
      return next;
    });
  }, []);
  const registry = useMemo<PaletteRegistry>(
    () => ({ register, unregister }),
    [register, unregister],
  );

  const overrideRef = useRef<((relPath: string) => void) | null>(null);
  const fallbackRef = useRef<((relPath: string) => void) | null>(null);
  const fileOpen = useMemo<FileOpenApi>(
    () => ({
      openPath: (relPath: string) => {
        (overrideRef.current ?? fallbackRef.current)?.(relPath);
      },
      registerOverride: (fn) => {
        overrideRef.current = fn;
      },
      setFallback: (fn) => {
        fallbackRef.current = fn;
      },
    }),
    [],
  );

  return (
    <PaletteRegistryContext.Provider value={registry}>
      <PaletteFileOpenContext.Provider value={fileOpen}>
        <PaletteSectionsContext.Provider value={sections}>
          {children}
        </PaletteSectionsContext.Provider>
      </PaletteFileOpenContext.Provider>
    </PaletteRegistryContext.Provider>
  );
}
