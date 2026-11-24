import {
  Calendar,
  CalendarClock,
  CheckCircle2,
  Clock,
  MinusCircle,
  Radar,
  Repeat,
  TriangleAlert,
  XCircle,
  Zap,
} from "lucide-react";

import { BrandLogo } from "@/components/BrandLogo";
import { cn } from "@/lib/cn";
import type { ScheduleRunStatus, ScheduleSource, TriggerIcon } from "@/lib/schedules";
import { LAST_RUN_TONES } from "@/lib/schedules";
import { TONE } from "@/lib/tone";

/**
 * T3 Code's mark (public domain, from the T3 Code repository's
 * assets/prod/logo.svg). The tile takes the text colour and the letters the
 * page background, so it reads in both light and dark themes.
 */
function T3CodeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 128 128" aria-hidden className={className} fill="none">
      <rect width="128" height="128" rx="10" fill="currentColor" />
      <path
        fill="var(--background)"
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
      />
    </svg>
  );
}

/** systemd's bracketed-dot mark: two brackets in the text colour around its green dot. */
function SystemdMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none">
      <path
        d="M7 4H3.5v16H7M17 4h3.5v16H17"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="square"
      />
      <circle cx="12" cy="12" r="3.5" fill="#30D475" />
    </svg>
  );
}

/**
 * A source's mark at 16px. Decorative: the label beside it names the source.
 * Pass the record id to tell a systemd timer from a crontab line.
 */
export function SourceIcon({
  source,
  recordId,
  className,
}: {
  source: ScheduleSource;
  recordId?: string;
  className?: string;
}) {
  const cls = cn("size-4 shrink-0", className);
  switch (source) {
    case "harnery":
      // biome-ignore lint/performance/noImgElement: a static SVG from public/, as the nav bar uses it
      return <img src="/harnery-emblem.svg" alt="" width={16} height={16} className={cls} />;
    case "codex-app":
      return <BrandLogo brand="codex" className={cls} />;
    case "t3-code":
      return <T3CodeMark className={cn(cls, "text-foreground")} />;
    case "captured":
      return <Radar aria-hidden className={cn(cls, TONE.accent.text)} />;
    case "os-timer":
      return recordId?.startsWith("crontab:") ? (
        <Clock aria-hidden className={cn(cls, "text-muted-foreground")} />
      ) : (
        <SystemdMark className={cn(cls, "text-muted-foreground")} />
      );
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
