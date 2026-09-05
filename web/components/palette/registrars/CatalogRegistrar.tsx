"use client";

/**
 * Registers the entity catalogs — Agents (above routes: they're what this
 * dashboard is about) plus Councils / Decisions / Work / Workflows / Goals
 * (below routes). One `/api/palette` fetch covers all six; it re-runs when
 * the palette opens, rate-limited so rapid open/close cycles don't hammer
 * the readers. Renders nothing.
 */

import { Briefcase, Scale, Target, User, Users, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PaletteCatalog, PaletteEntry } from "@/app/api/palette/route";
import type { RecentKind } from "@/lib/palette/recents";
import { COMMAND_PALETTE_OPENED_EVENT } from "../CommandPalette";
import { type PaletteItem, useCommandPaletteSection } from "../PaletteProvider";

/** Skip the palette-open revalidation when the catalog is younger than this. */
const REFETCH_MIN_AGE_MS = 30_000;

const EMPTY: PaletteCatalog = {
  agents: [],
  councils: [],
  decisions: [],
  work: [],
  workflows: [],
  goals: [],
};

/** Live/urgent states float above finished ones within a section. */
const STATE_PRIORITY: Record<string, number> = {
  // agents
  working: 6,
  idle: 3,
  // workflows
  running: 6,
  parked: 5,
  stale: 2,
  failed: 2,
  // decisions
  filed: 6,
  triaged: 5,
  deliberating: 5,
  resolved: 3,
  enacted: 3,
  // councils / work
  active: 6,
  open: 6,
  ready: 5,
  awaiting_approval: 5,
  in_review: 4,
  blocked: 4,
  closed: 2,
  archived: 1,
  succeeded: 2,
  done: 2,
  cancelled: 1,
};

function toItems(
  entries: PaletteEntry[],
  kind: RecentKind,
  icon: React.ReactNode,
  push: (href: string) => void,
): PaletteItem[] {
  return entries.map((e) => ({
    key: `${kind}-${e.id}`,
    label: e.label,
    description: e.sublabel !== e.label ? e.sublabel : undefined,
    subtitle: undefined,
    keywords: e.state ? [e.state, e.id] : [e.id],
    icon,
    href: e.href,
    priority: STATE_PRIORITY[e.state ?? ""] ?? 0,
    trailing: e.state ? (
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
        {e.state}
      </span>
    ) : undefined,
    onSelect: () => push(e.href),
    recent: { title: e.label, href: e.href, kind },
  }));
}

export function CatalogRegistrar() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<PaletteCatalog>(EMPTY);
  const fetchedAtRef = useRef(0);

  // Load when the palette opens, then revalidate on later opens (rate-limited).
  // Catalog scans must not compete with the page the user is navigating to.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchedAtRef.current = Date.now();
      fetch("/api/palette", { headers: { Accept: "application/json" }, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : EMPTY))
        .then((d: PaletteCatalog) => {
          if (!cancelled) setCatalog(d ?? EMPTY);
        })
        .catch(() => {
          /* offline / server restart — leave the sections as they were */
        });
    };
    const onPaletteOpen = () => {
      if (Date.now() - fetchedAtRef.current >= REFETCH_MIN_AGE_MS) load();
    };
    window.addEventListener(COMMAND_PALETTE_OPENED_EVENT, onPaletteOpen);
    return () => {
      cancelled = true;
      window.removeEventListener(COMMAND_PALETTE_OPENED_EVENT, onPaletteOpen);
    };
  }, []);

  const push = useMemo(() => (href: string) => router.push(href), [router]);

  const agents = useMemo(
    () => toItems(catalog.agents, "agent", <User size={14} aria-hidden />, push),
    [catalog.agents, push],
  );
  const councils = useMemo(
    () => toItems(catalog.councils, "council", <Users size={14} aria-hidden />, push),
    [catalog.councils, push],
  );
  const decisions = useMemo(
    () => toItems(catalog.decisions, "decision", <Scale size={14} aria-hidden />, push),
    [catalog.decisions, push],
  );
  const work = useMemo(
    () => toItems(catalog.work, "work", <Briefcase size={14} aria-hidden />, push),
    [catalog.work, push],
  );
  const workflows = useMemo(
    () => toItems(catalog.workflows, "workflow", <Workflow size={14} aria-hidden />, push),
    [catalog.workflows, push],
  );
  const goals = useMemo(
    () => toItems(catalog.goals, "goal", <Target size={14} aria-hidden />, push),
    [catalog.goals, push],
  );

  useCommandPaletteSection("Agents", agents, 0, 6);
  useCommandPaletteSection("Councils", councils, 60, 4);
  useCommandPaletteSection("Decisions", decisions, 61, 4);
  useCommandPaletteSection("Work", work, 62, 4);
  useCommandPaletteSection("Workflows", workflows, 63, 4);
  useCommandPaletteSection("Goals", goals, 64, 4);
  return null;
}
