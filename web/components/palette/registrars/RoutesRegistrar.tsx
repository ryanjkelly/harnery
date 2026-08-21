"use client";

/**
 * Registers the "Routes" section — every NavBar destination, searchable by
 * label plus the synonyms in the shared route registry (so "governors",
 * "durable goals", and "goals" all find the same page). Mounted once by the
 * root layout. Renders nothing.
 */

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { APP_ROUTES } from "@/lib/palette/routes";
import { type PaletteItem, useCommandPaletteSection } from "../PaletteProvider";

export function RoutesRegistrar() {
  const router = useRouter();

  const items = useMemo<PaletteItem[]>(
    () =>
      APP_ROUTES.map((r) => ({
        key: `route-${r.href}`,
        label: r.label,
        description: r.href,
        keywords: r.keywords,
        icon: <r.icon size={14} aria-hidden />,
        href: r.href,
        onSelect: () => router.push(r.href),
        recent: { title: r.label, href: r.href, kind: "route" as const },
      })),
    [router],
  );

  useCommandPaletteSection("Routes", items, 50);
  return null;
}
