/**
 * SectionIcon: lucide icon in a tinted square, used as the section-header
 * affordance for Acquisition / Back-End / Ecomm / Total cards. Mirrors
 * the upstream app's components/data-viz/section-icon.tsx.
 */

import {
  BarChart3,
  Headphones,
  type LucideIcon,
  Megaphone,
  ShoppingBag,
} from "lucide-react";

import { cn } from "@/lib/cn";

export type SectionTone = "acquisition" | "back-end" | "ecomm" | "total";

interface Props {
  tone: SectionTone;
  className?: string;
}

const ICON_FOR: Record<SectionTone, LucideIcon> = {
  acquisition: Megaphone,
  "back-end": Headphones,
  ecomm: ShoppingBag,
  total: BarChart3,
};

const TINT_BG: Record<SectionTone, string> = {
  acquisition: "bg-tone-acquisition/15",
  "back-end": "bg-tone-back-end/15",
  ecomm: "bg-tone-ecomm/15",
  total: "bg-tone-total/15",
};

const TINT_FG: Record<SectionTone, string> = {
  acquisition: "text-tone-acquisition",
  "back-end": "text-tone-back-end",
  ecomm: "text-tone-ecomm",
  total: "text-tone-total",
};

export function SectionIcon({ tone, className }: Props) {
  const Icon = ICON_FOR[tone];
  return (
    <span
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md",
        TINT_BG[tone],
        TINT_FG[tone],
        className,
      )}
      aria-hidden
    >
      <Icon size={14} strokeWidth={2.25} />
    </span>
  );
}
