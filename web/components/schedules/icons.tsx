import {
  Calendar,
  CalendarClock,
  CheckCircle2,
  Cog,
  MinusCircle,
  Radar,
  Repeat,
  SquareTerminal,
  TriangleAlert,
  XCircle,
  Zap,
} from "lucide-react";

import { BrandLogo } from "@/components/BrandLogo";
import { cn } from "@/lib/cn";
import type { ScheduleRunStatus, ScheduleSource, TriggerIcon } from "@/lib/schedules";
import { LAST_RUN_TONES } from "@/lib/schedules";
import { TONE } from "@/lib/tone";

/** A source's mark at 16px. Decorative: the label beside it names the source. */
export function SourceIcon({ source, className }: { source: ScheduleSource; className?: string }) {
  const cls = cn("size-4 shrink-0", className);
  switch (source) {
    case "harnery":
      // biome-ignore lint/performance/noImgElement: a static SVG from public/, as the nav bar uses it
      return <img src="/harnery-emblem.svg" alt="" width={16} height={16} className={cls} />;
    case "codex-app":
      return <BrandLogo brand="codex" className={cls} />;
    case "t3-code":
      return <SquareTerminal aria-hidden className={cn(cls, "text-muted-foreground")} />;
    case "captured":
      return <Radar aria-hidden className={cn(cls, TONE.accent.text)} />;
    case "os-timer":
      return <Cog aria-hidden className={cn(cls, "text-muted-foreground")} />;
  }
}

const TRIGGER_ICONS = {
  repeat: Repeat,
  calendar: CalendarClock,
  once: Calendar,
  event: Zap,
} as const;

export function TriggerGlyph({ icon, className }: { icon: TriggerIcon; className?: string }) {
  const Icon = TRIGGER_ICONS[icon];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

const STATUS_ICONS = {
  succeeded: CheckCircle2,
  failed: XCircle,
  attention: TriangleAlert,
  skipped: MinusCircle,
  unknown: MinusCircle,
} as const;

export function StatusGlyph({
  status,
  className,
}: {
  status: ScheduleRunStatus;
  className?: string;
}) {
  const Icon = STATUS_ICONS[status];
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", TONE[LAST_RUN_TONES[status]].text, className)}
    />
  );
}
